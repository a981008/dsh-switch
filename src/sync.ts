/**
 * Real-time cc-switch → DSH sync engine.
 *
 * Replaces the old one-click "apply": the plugin polls the cc-switch database
 * (cheap signature query every few seconds) and mirrors every usable provider
 * — Claude, Codex/GPT and Gemini-shaped relays — into the DSH `llm-pi-ai`
 * settings namespace. When the current provider changes in cc-switch, the DSH
 * `agent-default-model` follows.
 *
 * Write mechanics (DSH settings service):
 * - provider entries are added/updated/removed with path-addressed `mutate`
 *   ops (`{op:'set'|'unset', path:['providers', route]}`), so user-owned
 *   provider entries (non `ccs-*`) are never touched;
 * - API keys live only in the credentials service; settings carry the ref
 *   name (`CCS_*_API_KEY`).
 *
 * Change detection: the full provider table is hashed into a signature; when
 * it is unchanged since the last sync nothing is written. A per-route
 * snapshot (config + key hash, never the key itself) in the state file keeps
 * repeated syncs idempotent.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { dshRouteFor, listProviders, withDb, resolveDbPath, parseProviderConfig, type CcProviderRow } from './ccswitch-db.ts'

export { dshRouteFor } from './ccswitch-db.ts'

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** llm-pi-ai protocols a hand-declared DSH route can serve. */
export const SYNCABLE_API = ['anthropic-messages', 'openai-responses', 'openai-completions'] as const
export type SyncableApi = (typeof SYNCABLE_API)[number]

/** The provider entry shape written into `llm-pi-ai.providers`. */
export interface ProviderEntry {
  apiKeyEnv?: string
  displayName: string
  api: SyncableApi
  baseURL: string
  models: Array<{ id: string; name: string }>
}

// ── naming ───────────────────────────────────────────────────────────────────

/** cc-switch uuid → stable readable DSH provider route, e.g. `ccs-29939f1e`. */
/** Human-readable env var name derived from the provider display name. */
export function envNameFor(name: string, providerId: string): string {
  const fromName = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
  const base = fromName.length >= 2 ? fromName : providerId.replace(/[^A-Za-z0-9]/gu, '').toUpperCase()
  const candidate = `CCS_${base === '' ? 'PROVIDER' : base}_API_KEY`
  return REF_PATTERN.test(candidate) ? candidate : `CCS_${dshRouteFor(providerId).toUpperCase().replaceAll('-', '_')}_API_KEY`
}

/** Route-derived env ref used to break name collisions between providers. */
function routeEnvName(route: string): string {
  return `CCS_${route.toUpperCase().replaceAll('-', '_')}_API_KEY`
}

/** SHA-256 fingerprint of a credential value (never the value itself). */
export function keyHashOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

// ── state file ───────────────────────────────────────────────────────────────

/** What the engine last wrote for one route (snapshot, key values hashed). */
export interface ManagedEntry {
  ccSwitchId: string
  appType: string
  name: string
  envName: string
  model: string
  keyHash: string
  entry: ProviderEntry
  syncedAt: string
}

export interface SyncState {
  version: 2
  /** route → last written snapshot */
  managed: Record<string, ManagedEntry>
  /** appType → route of the cc-switch current provider at last sync */
  currents: Record<string, string>
  signature: string
  lastSyncAt: string | null
  lastError: string | null
}

/** State directory resolved per call (keeps tests able to redirect HOME). */
function stateFile(): string {
  return join(homedir(), '.dsh', 'plugins', 'dsh-switch', 'state.json')
}

export function emptySyncState(): SyncState {
  return { version: 2, managed: {}, currents: {}, signature: '', lastSyncAt: null, lastError: null }
}

export function readSyncState(): SyncState {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf8')) as Record<string, unknown>
    if (parsed['version'] === 2 && typeof parsed['managed'] === 'object' && parsed['managed'] !== null) {
      const raw = parsed as unknown as SyncState
      return {
        version: 2,
        managed: raw.managed ?? {},
        currents: raw.currents ?? {},
        signature: typeof raw.signature === 'string' ? raw.signature : '',
        lastSyncAt: typeof raw.lastSyncAt === 'string' ? raw.lastSyncAt : null,
        lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
      }
    }
    // Legacy v1 {applied: {route: {ccSwitchId, appType, name, envName, model}}}:
    // seed managed names so previously applied routes keep their env refs.
    const legacy = parsed['applied'] as Record<string, { ccSwitchId?: string; appType?: string; name?: string; envName?: string; model?: string }> | undefined
    const managed: Record<string, ManagedEntry> = {}
    for (const [route, value] of Object.entries(legacy ?? {})) {
      if (typeof value?.ccSwitchId !== 'string' || typeof value?.envName !== 'string') continue
      managed[route] = {
        ccSwitchId: value.ccSwitchId,
        appType: value.appType ?? 'claude',
        name: value.name ?? route,
        envName: value.envName,
        model: value.model ?? '',
        keyHash: '',
        entry: { displayName: value.name ?? route, api: 'anthropic-messages', baseURL: '', models: [] },
        syncedAt: '',
      }
    }
    return { ...emptySyncState(), managed }
  } catch {
    return emptySyncState()
  }
}

export function writeSyncState(state: SyncState): void {
  try {
    const file = stateFile()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 })
  } catch (cause) {
    throw new Error(`cannot persist dsh-switch state: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

// ── service faces ────────────────────────────────────────────────────────────

export interface SettingsService {
  get(namespace: string): unknown
  update(namespace: string, patch: unknown): Promise<void> | void
  mutate?(namespace: string, ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>): Promise<void> | void
}

export interface CredentialsService {
  set(ref: string, value: string): Promise<void> | void
  unset(ref: string): Promise<void> | void
}

export interface SyncDeps {
  dbPath(): string
  enabled(): boolean
  settings(): unknown
  credentials(): unknown
}

// ── planning ─────────────────────────────────────────────────────────────────

export interface SyncItem {
  row: CcProviderRow
  route: string
  envName: string
  entry: ProviderEntry
  key: string
  model: string
  keyHash: string
}

export interface SyncSkip {
  name: string
  appType: string
  reason: string
}

export interface SyncPlan {
  items: SyncItem[]
  skips: SyncSkip[]
  /** appType → route of the cc-switch current provider (syncable ones only) */
  currents: Record<string, string>
  signature: string
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    }
    return val
  })
}

/** Stable hash over every field the sync mirrors. */
export function signatureOf(rows: CcProviderRow[]): string {
  const sorted = [...rows].sort((a, b) => (a.appType === b.appType ? (a.id < b.id ? -1 : 1) : a.appType < b.appType ? -1 : 1))
  return createHash('sha256')
    .update(canonicalJson(sorted.map((row) => ({ id: row.id, appType: row.appType, name: row.name, isCurrent: row.isCurrent, settingsConfig: row.settingsConfig }))))
    .digest('hex')
    .slice(0, 32)
}

function existingEnvName(settings: SettingsService | null, route: string): string | undefined {
  try {
    const section = settings?.get('llm-pi-ai') as { providers?: Record<string, { apiKeyEnv?: unknown }> } | undefined
    const value = section?.providers?.[route]?.apiKeyEnv
    if (typeof value === 'string' && REF_PATTERN.test(value)) return value
    const nested = value as { name?: unknown; ref?: unknown } | undefined
    if (typeof nested?.name === 'string' && REF_PATTERN.test(nested.name)) return nested.name
    if (typeof nested?.ref === 'string' && REF_PATTERN.test(nested.ref)) return nested.ref
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Turn cc-switch rows into a sync plan: usable providers become planned
 * writes, everything else carries a user-facing skip reason.
 */
export function planSync(rows: CcProviderRow[], state: SyncState, settings: SettingsService | null): SyncPlan {
  const items: SyncItem[] = []
  const skips: SyncSkip[] = []
  const claimedEnvNames = new Set<string>()

  // Pass 1 — parse and build desired entries (env refs minted, collisions deferred).
  const staged: Array<SyncItem & { preferredEnvName: string }> = []
  for (const row of rows) {
    const outcome = parseProviderConfig(row)
    if (outcome.kind === 'skip') {
      skips.push({ name: row.name, appType: row.appType, reason: outcome.reason })
      continue
    }
    const parsed = outcome.config
    if (parsed.models.length === 0) {
      skips.push({ name: row.name, appType: row.appType, reason: 'no models' })
      continue
    }
    const route = dshRouteFor(row.id)
    const model = parsed.models[0]
    const entry: ProviderEntry = {
      displayName: row.name,
      api: parsed.api,
      baseURL: parsed.baseUrl,
      models: parsed.models.map((id) => ({ id, name: id })),
    }
    const preferred = existingEnvName(settings, route) ?? envNameFor(row.name, row.id)
    staged.push({ row, route, envName: preferred, preferredEnvName: preferred, entry, key: parsed.apiKey, model, keyHash: keyHashOf(parsed.apiKey) })
  }

  // Pass 2 — break env-ref collisions (duplicate display names) with route refs.
  for (const item of staged) {
    if (!claimedEnvNames.has(item.preferredEnvName)) {
      claimedEnvNames.add(item.preferredEnvName)
      item.envName = item.preferredEnvName
    } else {
      item.envName = routeEnvName(item.route)
      claimedEnvNames.add(item.envName)
    }
    if (item.entry.apiKeyEnv !== item.envName) {
      if (item.envName === '') delete item.entry.apiKeyEnv
      else item.entry.apiKeyEnv = item.envName
    }
    items.push(item)
  }

  // Current provider per app type (syncable rows only — the DSH default must
  // always be able to point at a usable route).
  const currents: Record<string, string> = {}
  for (const item of items) {
    if (item.row.isCurrent && currents[item.row.appType] === undefined) currents[item.row.appType] = item.route
  }

  return { items, skips, currents, signature: signatureOf(rows) }
}

// ── engine ───────────────────────────────────────────────────────────────────

export interface SyncOutcome {
  ok: boolean
  changed: boolean
  applied: string[]
  removed: string[]
  defaultChanged: boolean
  skipped: SyncSkip[]
  lastSyncAt: string | null
  error?: string
}

function asSettings(service: unknown): SettingsService | null {
  if (service === null || typeof service !== 'object') return null
  const candidate = service as Partial<SettingsService>
  if (typeof candidate.get !== 'function' || typeof candidate.update !== 'function') return null
  return candidate as SettingsService
}

function asCredentials(service: unknown): CredentialsService | null {
  if (service === null || typeof service !== 'object') return null
  const candidate = service as Partial<CredentialsService>
  if (typeof candidate.set !== 'function' || typeof candidate.unset !== 'function') return null
  return candidate as CredentialsService
}

function readDshDefaultModel(settings: SettingsService): { provider?: unknown; model?: unknown } {
  try {
    return (settings.get('agent-default-model') ?? {}) as { provider?: unknown; model?: unknown }
  } catch {
    return {}
  }
}

function entriesEqual(a: ProviderEntry | undefined, b: ProviderEntry): boolean {
  if (a === undefined) return false
  return canonicalJson(a) === canonicalJson(b)
}

/**
 * Read the live `llm-pi-ai.providers` map from the settings service. Returns
 * null when the service cannot be read — reconciliation then falls back to
 * the snapshot-only diff (never rewrites blindly).
 */
function readLiveProviderMap(settings: SettingsService): Record<string, unknown> | null {
  try {
    const section = settings.get('llm-pi-ai') as { providers?: unknown } | undefined
    const providers = section?.providers
    if (providers === null || providers === undefined || typeof providers !== 'object' || Array.isArray(providers)) return {}
    return providers as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Compare the plugin-managed fields of a live settings entry against the
 * target. Extra fields the user (or the schema) added are ignored so the
 * comparison never fights customizations — and never loops.
 */
function liveEntryMatches(live: unknown, target: ProviderEntry): boolean {
  if (live === null || typeof live !== 'object' || Array.isArray(live)) return false
  const entry = live as Record<string, unknown>
  if (entry['apiKeyEnv'] !== target.apiKeyEnv) return false
  if (entry['displayName'] !== target.displayName) return false
  if (entry['api'] !== target.api) return false
  if (entry['baseURL'] !== target.baseURL) return false
  const models = entry['models']
  if (!Array.isArray(models) || models.length !== target.models.length) return false
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]
    const want = target.models[index]
    if (model === null || typeof model !== 'object' || Array.isArray(model)) return false
    const record = model as Record<string, unknown>
    if (record['id'] !== want.id || record['name'] !== want.name) return false
  }
  return true
}

/**
 * Run one sync pass. The cc-switch signature gates the bulk of the work: an
 * unchanged signature with an intact settings mirror is a no-op (unless
 * `force`). Every pass first reconciles the live settings against the plan,
 * so externally lost or edited `ccs-*` entries are repaired within one tick
 * even when cc-switch itself has not changed. Errors are recorded on the
 * state file and surfaced in the outcome instead of thrown.
 */
export async function runSync(deps: SyncDeps, options: { force?: boolean } = {}): Promise<SyncOutcome> {
  const state = readSyncState()
  const now = new Date().toISOString()
  const finish = (outcome: Omit<SyncOutcome, 'lastSyncAt'>, error?: string): SyncOutcome => {
    const next: SyncState = {
      version: 2,
      managed: outcome.ok ? (state.managed as Record<string, ManagedEntry>) : state.managed,
      currents: outcome.ok ? (state.currents ?? {}) : state.currents,
      signature: outcome.ok ? (state.signature ?? '') : state.signature,
      lastSyncAt: outcome.ok ? now : state.lastSyncAt,
      lastError: error ?? null,
    }
    try {
      writeSyncState(next)
    } catch {
      // state persistence failures must not break the sync outcome
    }
    return { ...outcome, lastSyncAt: next.lastSyncAt, ...(error === undefined ? {} : { error }) }
  }

  const settings = asSettings(deps.settings())
  const credentials = asCredentials(deps.credentials())
  if (settings === null || credentials === null) {
    return finish({ ok: false, changed: false, applied: [], removed: [], defaultChanged: false, skipped: [] }, 'DSH settings/credentials service is not available yet')
  }

  let rows: CcProviderRow[]
  try {
    // Resolve here too: the configured path may be empty (→ the default
    // ~/.cc-switch/cc-switch.db). An empty string handed straight to SQLite
    // would open a private temporary database without any tables.
    rows = withDb(resolveDbPath(deps.dbPath()), (db) => listProviders(db))
  } catch (cause) {
    return finish({ ok: false, changed: false, applied: [], removed: [], defaultChanged: false, skipped: [] }, cause instanceof Error ? cause.message : String(cause))
  }

  const signature = signatureOf(rows)
  const plan = planSync(rows, state, settings)
  const liveProviders = readLiveProviderMap(settings)

  // Diff against BOTH the last-synced snapshot (cc-switch content changes)
  // and the live settings (external edits / lost writes) — the sync is
  // self-healing: whatever diverges from cc-switch is repaired on the next
  // tick, even when the cc-switch signature itself is unchanged.
  const setOps: Array<{ op: 'set'; path: string[]; value: ProviderEntry }> = []
  const applied: string[] = []
  const appliedRoutes = new Set<string>()

  for (const item of plan.items) {
    const prev = state.managed[item.route]
    const snapshotMatches = prev !== undefined && prev.ccSwitchId === item.row.id && prev.keyHash === item.keyHash && prev.envName === item.envName && entriesEqual(prev.entry, item.entry)
    const liveMatches = liveProviders === null ? true : liveEntryMatches(liveProviders[item.route], item.entry)
    if (snapshotMatches && liveMatches) continue
    setOps.push({ op: 'set', path: ['providers', item.route], value: item.entry })
    applied.push(item.route)
    appliedRoutes.add(item.route)
  }
  const plannedRoutes = new Set(plan.items.map((item) => item.route))
  const unsetSet = new Set<string>()
  for (const route of Object.keys(state.managed)) {
    if (!plannedRoutes.has(route)) unsetSet.add(route)
  }
  // Orphaned ccs-* routes in the live settings (state lost or rewritten):
  // the plugin owns the ccs-* namespace, so anything it does not plan goes.
  if (liveProviders !== null) {
    for (const route of Object.keys(liveProviders)) {
      if (route.startsWith('ccs-') && !plannedRoutes.has(route)) unsetSet.add(route)
    }
  }
  const unsetRoutes = [...unsetSet]

  const signatureUnchanged = !options.force && signature !== '' && signature === state.signature
  if (signatureUnchanged && setOps.length === 0 && unsetRoutes.length === 0) {
    return { ok: true, changed: false, applied: [], removed: [], defaultChanged: false, skipped: [], lastSyncAt: state.lastSyncAt }
  }

  try {
    // Credentials first so refs resolve the moment llm-pi-ai reloads. Every
    // written entry re-stamps its credential: idempotent, and it repairs
    // credentials that were lost alongside a lost settings entry.
    for (const item of plan.items) {
      if (!appliedRoutes.has(item.route) || item.key === '') continue
      const prev = state.managed[item.route]
      const live = liveProviders === null ? undefined : liveProviders[item.route]
      const liveRefMatches = live !== null && live !== undefined && typeof live === 'object' && (live as Record<string, unknown>)['apiKeyEnv'] === item.envName
      const needsWrite = prev === undefined || prev.keyHash !== item.keyHash || prev.envName !== item.envName || !liveRefMatches
      if (needsWrite) await credentials.set(item.envName, item.key)
    }
    if (setOps.length > 0 || unsetRoutes.length > 0) {
      const ops = [
        ...setOps,
        ...unsetRoutes.map((route) => ({ op: 'unset' as const, path: ['providers', route] })),
      ]
      if (typeof settings.mutate === 'function') {
        await settings.mutate('llm-pi-ai', ops)
      } else {
        // Fallback for settings services without path ops: apply sets via
        // merge; removals are not expressible and are skipped.
        const patch: Record<string, ProviderEntry> = {}
        for (const op of setOps) patch[op.path[1]] = op.value
        if (setOps.length > 0) await settings.update('llm-pi-ai', { providers: patch })
      }
    }
    for (const route of unsetRoutes) {
      const envName = state.managed[route]?.envName
      if (envName !== undefined) await credentials.unset(envName)
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return finish({ ok: false, changed: false, applied: [], removed: [], defaultChanged: false, skipped: plan.skips }, message)
  }

  // Update the managed snapshot for everything that was written.
  const managed = { ...state.managed }
  for (const item of plan.items) {
    if (!applied.includes(item.route)) continue
    managed[item.route] = {
      ccSwitchId: item.row.id,
      appType: item.row.appType,
      name: item.row.name,
      envName: item.envName,
      model: item.model,
      keyHash: item.keyHash,
      entry: item.entry,
      syncedAt: now,
    }
  }
  for (const route of unsetRoutes) delete managed[route]

  // Default-model follow: react to cc-switch current-provider switches.
  let defaultChanged = false
  const nextCurrents = { ...state.currents }
  const switched: string[] = []
  const currentDefault = readDshDefaultModel(settings)
  for (const [appType, route] of Object.entries(plan.currents)) {
    const prev = state.currents[appType]
    if (prev !== undefined && prev !== route) switched.push(appType)
    nextCurrents[appType] = route
  }
  const pickSwitch = ((): SyncItem | null => {
    const preferred = switched.find((appType) => appType === 'claude') ?? switched[0]
    if (preferred === undefined) return null
    const route = plan.currents[preferred]
    return plan.items.find((item) => item.route === route) ?? null
  })()
  const fallbackItem = ((): SyncItem | null => {
    const route = plan.currents['claude'] ?? Object.values(plan.currents)[0] ?? plan.items[0]?.route
    return route === undefined ? null : plan.items.find((item) => item.route === route) ?? null
  })()
  let nextDefault: { provider: string; model: string } | null = null
  if (pickSwitch !== null) {
    nextDefault = { provider: pickSwitch.route, model: pickSwitch.model }
  } else if (typeof currentDefault.provider !== 'string' || !plannedRoutes.has(currentDefault.provider)) {
    const item = fallbackItem
    if (item !== null && currentDefault.provider !== item.route) nextDefault = { provider: item.route, model: item.model }
  }
  if (nextDefault !== null) {
    await settings.update('agent-default-model', nextDefault)
    defaultChanged = true
  }

  state.managed = managed
  state.currents = nextCurrents
  state.signature = signature
  const outcome = finish(
    { ok: true, changed: applied.length > 0 || unsetRoutes.length > 0 || defaultChanged, applied, removed: unsetRoutes, defaultChanged, skipped: plan.skips },
  )
  return outcome
}

/** Debounce window coalescing the burst of events one SQLite commit produces. */
const WATCH_DEBOUNCE_MS = 250

/**
 * Watch the cc-switch database for changes and invoke `onChange` (debounced)
 * right after cc-switch saves — callback-style immediacy instead of waiting
 * for the next poll. SQLite may write the main file, the WAL, or a journal,
 * so every `cc-switch.db*` file in the directory counts; other files
 * (settings.json, logs, backups) are ignored. Returns a disposer. Watching
 * is best-effort: on failure the caller still has the periodic poll.
 */
export function watchCcSwitchDb(dbPath: string, onChange: () => void): () => void {
  const directory = dirname(dbPath)
  const base = basename(dbPath)
  const matches = (filename: string | null): boolean => {
    if (filename === null) return true // platform did not name the file — sync anyway, the signature check makes it cheap
    const name = filename.split(/[\\/]/).pop() ?? ''
    return name === base || name.startsWith(`${base}-`)
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null
  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      onChange()
    }, WATCH_DEBOUNCE_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }
  try {
    watcher = watch(directory, { persistent: false, recursive: true }, (_event, filename) => {
      if (matches(filename)) schedule()
    })
    watcher.on('error', () => {
      // e.g. the directory disappeared; the periodic poll remains the net
    })
  } catch {
    return () => {}
  }
  return () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    watcher?.close()
    watcher = null
  }
}
