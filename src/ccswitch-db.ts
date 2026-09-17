/**
 * Read-only access to the cc-switch SQLite database (~/.cc-switch/cc-switch.db).
 *
 * cc-switch (https://github.com/farion1231/cc-switch) is a Tauri app whose
 * single source of truth is this database. Relevant table:
 *
 * - providers(id, app_type, name, settings_config, category, is_current, ...)
 *   settings_config JSON for `claude` providers: { env: { ANTHROPIC_BASE_URL,
 *   ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_*_MODEL, ... } }
 *
 * We never return secret values to the caller; only a short tail for display.
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Claude-style model ids may carry the Claude Code `[1M]` context marker. */
const CTX_MARKER = /\[1M\]\s*$/u

export const DEFAULT_DB_PATH = join(homedir(), '.cc-switch', 'cc-switch.db')

export interface CcProviderRow {
  id: string
  appType: string
  name: string
  category: string | null
  isCurrent: boolean
  websiteUrl: string | null
  settingsConfig: string
  /** Provider meta JSON — carries the usage_script (usage query) configuration. */
  meta: string | null
}

export interface ClaudeProviderEnv {
  baseUrl: string
  token: string
  models: string[]
  env: Record<string, string>
}

/** The llm-pi-ai protocols a hand-declared DSH route can serve. */
export type SyncableApi = 'anthropic-messages' | 'openai-responses' | 'openai-completions'

/** Connection facts extracted from one provider row, ready to mirror into DSH. */
export interface ParsedProviderConfig {
  baseUrl: string
  apiKey: string
  api: SyncableApi
  models: string[]
}

/** parseProviderConfig outcome: usable config or a user-facing skip reason. */
export type ParseOutcome =
  | { kind: 'ok'; config: ParsedProviderConfig }
  | { kind: 'skip'; reason: string }

const SYNCABLE_PROTOCOLS = ['anthropic-messages', 'openai-responses', 'openai-completions'] as const

/** Public (secret-free) projection of the provider list for the client. */
export interface ProviderView {
  id: string
  appType: string
  name: string
  category: string | null
  isCurrent: boolean
  websiteUrl: string | null
  baseUrl: string | null
  models: string[]
  /** last 4 chars of the auth key, for display only */
  tokenTail: string | null
  hasToken: boolean
}

export class CcSwitchUnavailableError extends Error {}

export function resolveDbPath(configured?: string): string {
  const p = (configured ?? '').trim()
  return p === '' ? DEFAULT_DB_PATH : p
}

function openReadOnly(path: string): DatabaseSync {
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch (cause) {
    throw new CcSwitchUnavailableError(
      `cannot open cc-switch database at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Parse a claude-type settings_config into connection facts (never exposes the token). */
export function parseClaudeEnv(settingsConfig: string): ClaudeProviderEnv | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(settingsConfig)
  } catch {
    return null
  }
  const envRaw = (parsed as { env?: unknown } | null)?.env
  if (envRaw === null || typeof envRaw !== 'object') return null
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(envRaw as Record<string, unknown>)) {
    if (typeof v === 'string') env[k] = v
  }
  const baseUrl = env['ANTHROPIC_BASE_URL'] ?? ''
  const token = env['ANTHROPIC_AUTH_TOKEN'] ?? env['ANTHROPIC_API_KEY'] ?? ''
  const candidates = [
    env['ANTHROPIC_MODEL'],
    env['ANTHROPIC_DEFAULT_SONNET_MODEL'],
    env['ANTHROPIC_DEFAULT_OPUS_MODEL'],
    env['ANTHROPIC_DEFAULT_HAIKU_MODEL'],
  ]
  const models: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    const id = candidate.replace(CTX_MARKER, '').trim()
    if (id !== '' && !models.includes(id)) models.push(id)
  }
  return { baseUrl, token, models, env }
}

export function listProviders(db: DatabaseSync): CcProviderRow[] {
  const rows = db
    .prepare(
      `SELECT id, app_type, name, category, is_current, website_url, settings_config, meta
       FROM providers
       ORDER BY app_type, COALESCE(sort_index, 1 << 30), name`,
    )
    .all() as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row['id']),
    appType: String(row['app_type']),
    name: String(row['name'] ?? ''),
    category: str(row['category']),
    isCurrent: Number(row['is_current'] ?? 0) === 1 || row['is_current'] === 1,
    websiteUrl: str(row['website_url']),
    settingsConfig: String(row['settings_config'] ?? '{}'),
    meta: str(row['meta']),
  }))
}

/** Public (secret-free) projection of the provider list for the client. */
export function toProviderViews(rows: CcProviderRow[]): ProviderView[] {
  return rows.map((row) => {
    const outcome = parseProviderConfig(row)
    const parsed = outcome.kind === 'ok' ? outcome.config : null
    return {
      id: row.id,
      appType: row.appType,
      name: row.name,
      category: row.category,
      isCurrent: row.isCurrent,
      websiteUrl: row.websiteUrl,
      baseUrl: parsed?.baseUrl ?? null,
      models: parsed?.models ?? [],
      tokenTail: parsed !== null && parsed.apiKey.length >= 4 ? parsed.apiKey.slice(-4) : null,
      hasToken: parsed !== null && parsed.apiKey.length > 0,
    }
  })
}

export function findProvider(db: DatabaseSync, providerId: string, appType?: string): CcProviderRow | undefined {
  const wanted = appType === undefined
    ? db
        .prepare('SELECT id, app_type, name, category, is_current, website_url, settings_config, meta FROM providers WHERE id = ?')
        .all(providerId)
    : db
        .prepare('SELECT id, app_type, name, category, is_current, website_url, settings_config, meta FROM providers WHERE id = ? AND app_type = ?')
        .all(providerId, appType)
  const row = (wanted as Array<Record<string, unknown>>)[0]
  if (row === undefined) return undefined
  return {
    id: String(row['id']),
    appType: String(row['app_type']),
    name: String(row['name'] ?? ''),
    category: str(row['category']),
    isCurrent: Number(row['is_current'] ?? 0) === 1 || row['is_current'] === 1,
    websiteUrl: str(row['website_url']),
    settingsConfig: String(row['settings_config'] ?? '{}'),
    meta: str(row['meta']),
  }
}

function utcDateDaysAgo(days: number): string {
  const now = new Date()
  const past = new Date(now.getTime() - Math.max(0, days - 1) * 86_400_000)
  return past.toISOString().slice(0, 10)
}

// ── multi-app-type parsing ───────────────────────────────────────────────────

function parseJsonObject(settingsConfig: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(settingsConfig) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** Stable DSH route id for one cc-switch provider (plugin-owned ccs-* namespace). */
export function dshRouteFor(providerId: string): string {
  const slug = providerId.toLowerCase().replace(/[^a-z0-9-]/gu, '').slice(0, 8)
  return `ccs-${slug === '' ? 'unknown' : slug}`
}

// ── usage_script (per-provider usage query configured inside cc-switch) ─────

/** The slice of cc-switch's per-provider `usage_script` meta this plugin understands. */
export interface UsageScript {
  enabled: boolean
  templateType: string
  codingPlanProvider?: string
  accessKeyId?: string
  secretAccessKey?: string
  /** Custom / template script source (empty for built-in token_plan templates). */
  code: string
  language: string
  /** Request timeout in seconds (cc-switch default 10). */
  timeoutSec: number
  /** Auto-refresh interval in minutes (cc-switch default 5; 0 = manual only). */
  autoQueryIntervalMin: number
  /** Script context values (New API etc.). */
  baseUrl?: string
  accessToken?: string
  userId?: string
}

/** Extract the usage_script block from a provider row's meta JSON (null when absent/unusable). */
export function parseUsageScript(row: CcProviderRow): UsageScript | null {
  let meta: Record<string, unknown>
  try {
    const parsed = JSON.parse(row.meta ?? '{}') as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    meta = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const raw = meta['usage_script']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const script = raw as Record<string, unknown>
  if (script['enabled'] !== true) return null
  if (typeof script['templateType'] !== 'string') return null
  const str = (key: string): string | undefined => {
    const value = script[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  return {
    enabled: true,
    templateType: script['templateType'],
    ...(typeof script['codingPlanProvider'] === 'string' && script['codingPlanProvider'] !== '' ? { codingPlanProvider: script['codingPlanProvider'] } : {}),
    ...(str('accessKeyId') !== undefined ? { accessKeyId: script['accessKeyId'] as string } : {}),
    ...(str('secretAccessKey') !== undefined ? { secretAccessKey: script['secretAccessKey'] as string } : {}),
    code: typeof script['code'] === 'string' ? script['code'] : '',
    language: typeof script['language'] === 'string' ? script['language'] : 'javascript',
    timeoutSec: typeof script['timeout'] === 'number' && script['timeout'] > 0 ? script['timeout'] : 10,
    autoQueryIntervalMin: typeof script['autoQueryInterval'] === 'number' && script['autoQueryInterval'] >= 0 ? script['autoQueryInterval'] : 5,
    ...(str('baseUrl') !== undefined ? { baseUrl: script['baseUrl'] as string } : {}),
    ...(str('accessToken') !== undefined ? { accessToken: script['accessToken'] as string } : {}),
    ...(str('userId') !== undefined ? { userId: script['userId'] as string } : {}),
  }
}

/** Volcano Ark plan credentials discovered inside cc-switch (never leaves the host). */

function stringEnv(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function dedupeModels(candidates: Array<string | undefined>): string[] {
  const models: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const id = candidate.replace(CTX_MARKER, '').trim()
    if (id !== '' && !models.includes(id)) models.push(id)
  }
  return models
}

interface CodexProviderSection {
  baseUrl?: string
  wireApi?: string
}

/** Minimal config.toml read: top-level model/model_provider + the named model_provider section. */
export function parseCodexToml(config: string): { model?: string; providerName?: string; section: CodexProviderSection } {
  const model = /^\s*model\s*=\s*"([^"]+)"/m.exec(config)?.[1]
  const providerName = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(config)?.[1]
  const section: CodexProviderSection = {}
  if (providerName !== undefined) {
    const header = new RegExp(`^[\\t ]*\\[model_providers\\.${providerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][^\\S\\n]*$`, 'm')
    const start = config.search(header)
    if (start >= 0) {
      const rest = config.slice(start)
      const end = rest.slice(1).search(/^\s*\[/m)
      const block = end === -1 ? rest : rest.slice(0, end + 1)
      section.baseUrl = /^[ \t]*base_url\s*=\s*"([^"]+)"/m.exec(block)?.[1]
      section.wireApi = /^[ \t]*wire_api\s*=\s*"([^"]+)"/m.exec(block)?.[1]
    }
  }
  if (section.baseUrl === undefined) {
    // fall back to the first model_providers block in the file
    const start = config.search(/^\s*\[model_providers\.[^\]]+\]/m)
    if (start >= 0) {
      const rest = config.slice(start)
      const end = rest.slice(1).search(/^\s*\[/m)
      const block = end === -1 ? rest : rest.slice(0, end + 1)
      section.baseUrl = /^[ \t]*base_url\s*=\s*"([^"]+)"/m.exec(block)?.[1]
      section.wireApi = /^[ \t]*wire_api\s*=\s*"([^"]+)"/m.exec(block)?.[1]
    }
  }
  return { model, providerName, section }
}

function parseCodex(row: CcProviderRow): ParseOutcome {
  const parsed = parseJsonObject(row.settingsConfig)
  if (parsed === null) return { kind: 'skip', reason: 'config is not readable' }
  const auth = parsed['auth'] !== undefined && parsed['auth'] !== null && typeof parsed['auth'] === 'object' && !Array.isArray(parsed['auth'])
    ? parsed['auth'] as Record<string, unknown>
    : {}
  const apiKey = typeof auth['OPENAI_API_KEY'] === 'string' ? auth['OPENAI_API_KEY'].trim() : ''
  const config = typeof parsed['config'] === 'string' ? parsed['config'] : ''
  if (apiKey === '') return { kind: 'skip', reason: 'no API key (ChatGPT/OAuth login cannot be used by DSH)' }
  if (config.trim() === '') return { kind: 'skip', reason: 'empty config.toml' }
  const { model, section } = parseCodexToml(config)
  if (section.baseUrl === undefined || section.baseUrl === '') return { kind: 'skip', reason: 'no base_url in config.toml' }
  if (model === undefined || model === '') return { kind: 'skip', reason: 'no model in config.toml' }
  return {
    kind: 'ok',
    config: {
      baseUrl: section.baseUrl,
      apiKey,
      api: section.wireApi === 'chat' ? 'openai-completions' : 'openai-responses',
      models: [model],
    },
  }
}

function parseGemini(row: CcProviderRow): ParseOutcome {
  const parsed = parseJsonObject(row.settingsConfig)
  if (parsed === null) return { kind: 'skip', reason: 'config is not readable' }
  const env = stringEnv(parsed['env'])
  const apiKey = (env['GEMINI_API_KEY'] ?? env['GOOGLE_API_KEY'] ?? env['GOOGLE_GENAI_API_KEY'] ?? '').trim()
  const baseUrl = (env['GOOGLE_GEMINI_BASE_URL'] ?? env['GEMINI_BASE_URL'] ?? '').trim()
  const model = (env['GEMINI_MODEL'] ?? '').trim()
  if (apiKey === '') return { kind: 'skip', reason: 'no API key (Google OAuth login cannot be used by DSH)' }
  if (baseUrl === '' || /googleapis\.com/u.test(baseUrl)) {
    return { kind: 'skip', reason: 'DSH has no native Gemini protocol; only OpenAI-compatible relays can be synced' }
  }
  if (model === '') return { kind: 'skip', reason: 'no GEMINI_MODEL configured' }
  return { kind: 'ok', config: { baseUrl, apiKey, api: 'openai-completions', models: [model] } }
}

function parseOpenclaw(row: CcProviderRow): ParseOutcome {
  const parsed = parseJsonObject(row.settingsConfig)
  if (parsed === null) return { kind: 'skip', reason: 'config is not readable' }
  const baseUrl = typeof parsed['baseUrl'] === 'string' ? parsed['baseUrl'] : ''
  const api = typeof parsed['api'] === 'string' ? parsed['api'] : ''
  const apiKey = typeof parsed['apiKey'] === 'string' ? parsed['apiKey'] : ''
  const rawModels = Array.isArray(parsed['models']) ? parsed['models'] : []
  const models = dedupeModels(rawModels.map((model) => (model !== null && typeof model === 'object' && typeof (model as Record<string, unknown>)['id'] === 'string' ? (model as Record<string, unknown>)['id'] as string : undefined)))
  if (baseUrl === '') return { kind: 'skip', reason: 'no baseUrl in config' }
  if (!(SYNCABLE_PROTOCOLS as readonly string[]).includes(api)) return { kind: 'skip', reason: `protocol "${api || '?'}" is not supported by DSH routes` }
  if (models.length === 0) return { kind: 'skip', reason: 'no models in config' }
  if (apiKey === '') return { kind: 'skip', reason: 'config carries no API key (live-managed providers keep it outside cc-switch)' }
  return { kind: 'ok', config: { baseUrl, apiKey, api: api as SyncableApi, models } }
}

/**
 * Parse any cc-switch provider row into DSH-syncable connection facts.
 * Rows that DSH cannot serve (OAuth logins, native Gemini, unsupported
 * protocols, empty placeholders) return a user-facing skip reason instead.
 */
export function parseProviderConfig(row: CcProviderRow): ParseOutcome {
  switch (row.appType) {
    case 'claude': {
      const parsed = parseClaudeEnv(row.settingsConfig)
      if (parsed === null) return { kind: 'skip', reason: 'config is not readable' }
      if (parsed.baseUrl === '') return { kind: 'skip', reason: 'no ANTHROPIC_BASE_URL' }
      if (parsed.token === '') return { kind: 'skip', reason: 'no ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY' }
      return { kind: 'ok', config: { baseUrl: parsed.baseUrl, apiKey: parsed.token, api: 'anthropic-messages', models: parsed.models } }
    }
    case 'codex':
      return parseCodex(row)
    case 'gemini':
      return parseGemini(row)
    case 'openclaw':
      return parseOpenclaw(row)
    default:
      return { kind: 'skip', reason: `app type "${row.appType}" is not supported` }
  }
}

/** Open the database read-only and run one job; always closes. */
export function withDb<T>(path: string, job: (db: DatabaseSync) => T): T {
  const db = openReadOnly(path)
  try {
    return job(db)
  } finally {
    try {
      db.close()
    } catch {
      // close is best-effort
    }
  }
}
