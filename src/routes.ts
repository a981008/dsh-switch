/**
 * Host web routes under /api/cc-switch, guarded to same-origin browser
 * requests (the DSH web GUI is loopback-only by default; the guard keeps a
 * bare local curl from exercising the sync-writing routes).
 *
 * GET  /api/cc-switch/state            providers + per-provider sync status
 * GET  /api/cc-switch/usage            quota/balance for a provider (cached)
 * POST /api/cc-switch/sync             force a sync pass now
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  CcSwitchUnavailableError,
  listProviders,
  parseProviderConfig,
  parseUsageScript,
  resolveDbPath,
  withDb,
} from './ccswitch-db.ts'
import { dshRouteFor, readSyncState, runSync } from './sync.ts'
import { queryProviderUsage, type UsageResult } from './usage.ts'

/** Response body of GET /api/cc-switch/usage. */
export interface UsageRouteResponse {
  ok: boolean
  route: string
  provider?: string
  configured: boolean
  reason?: string
  result?: UsageResult
  checkedAt?: string
}

export const API_PREFIX = '/api/cc-switch'

export interface RouteDeps {
  dbPath(): string
  enabled(): boolean
  settingsService(): unknown
  credentialsService(): unknown
  /**
   * The DSH llm service (`ctx.llm`), when the host has one. Used to report
   * whether a synced route is already live in the DSH model list — the one
   * thing the settings file alone cannot tell us.
   */
  llmService(): LlmReader | null
  /**
   * Announce that DSH's model inputs changed, so clients refresh their model
   * catalog at once instead of on the next unrelated event.
   */
  announceModelInputsChanged(): void
}

/** The slice of `ctx.llm` this plugin reads (advisory provider/model catalog). */
export interface LlmReader {
  listProviders(): Array<{ id?: unknown }>
  listModels(provider: string): Promise<Array<{ id?: unknown }>> | Array<{ id?: unknown }>
}

interface CredentialsReader {
  resolve(ref: string): Promise<{ value: string; source?: string } | undefined>
  set(ref: string, value: string): Promise<void> | void
  unset(ref: string): Promise<void> | void
}

function asCredentials(service: unknown): CredentialsReader | null {
  if (service === null || typeof service !== 'object') return null
  const candidate = service as Partial<CredentialsReader>
  if (typeof candidate.resolve !== 'function' || typeof candidate.set !== 'function' || typeof candidate.unset !== 'function') return null
  return candidate as CredentialsReader
}

/**
 * Ask the DSH llm service which `ccs-*` routes are live and how many models it
 * lists for each. Returns null when the service is absent or unreadable, so the
 * settings card can distinguish "not live yet" from "cannot tell".
 */
async function probeLiveRoutes(llm: LlmReader | null): Promise<Map<string, { routable: boolean; models: number }> | null> {
  if (llm === null) return null
  let ids: string[]
  try {
    if (typeof llm.listProviders !== 'function') return null
    ids = llm.listProviders().map((entry) => String((entry as { id?: unknown } | null)?.id ?? '')).filter((id) => id.startsWith('ccs-'))
  } catch {
    return null
  }
  const routes = new Map<string, { routable: boolean; models: number }>()
  for (const id of ids) routes.set(id, { routable: true, models: 0 })
  if (typeof llm.listModels === 'function') {
    await Promise.all(ids.map(async (id) => {
      try {
        const models = await llm.listModels(id)
        routes.set(id, { routable: true, models: Array.isArray(models) ? models.length : 0 })
      } catch {
        // route registered but its catalog is unreadable: still routable
      }
    }))
  }
  return routes
}

function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.writableEnded) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}


/** Same-origin browser request check (mirrors the DSH web GUI's own origin). */
function sameOriginBrowserRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  const secFetchSite = req.headers['sec-fetch-site']
  if (secFetchSite !== undefined) {
    return secFetchSite === 'same-origin' || secFetchSite === 'none'
  }
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export function makeRoutes(deps: RouteDeps): WebRoute[] {
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (sameOriginBrowserRequest(req)) return true
    writeJson(res, 403, { ok: false, error: 'forbidden' })
    return false
  }

  const state: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/state`,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      if (!deps.enabled()) return writeJson(res, 200, { ok: true, enabled: false, ccSwitch: { available: false, providers: [] }, dsh: { managedRoutes: [] } })
      const dbPath = resolveDbPath(deps.dbPath())
      const syncState = readSyncState()
      const dshModel = readDshModelState(deps.settingsService())
      // What DSH actually serves right now: the settings file is the input, the
      // llm registry is the output, and only the registry feeds the model picker.
      const liveRoutes = await probeLiveRoutes(deps.llmService())
      let providers: unknown
      let available = true
      let error: string | undefined
      try {
        const rows = withDb(dbPath, (db) => listProviders(db))
        providers = rows.map((row) => {
          const route = dshRouteFor(row.id)
          const outcome = parseProviderConfig(row)
          const managed = syncState.managed[route]
          const parsed = outcome.kind === 'ok' ? outcome.config : null
          const live = liveRoutes === null ? undefined : liveRoutes.get(route)
          return {
            id: row.id,
            appType: row.appType,
            name: row.name,
            isCurrent: row.isCurrent,
            route,
            status: managed !== undefined && managed.entry.baseURL !== '' ? 'synced' : 'skipped',
            reason: outcome.kind === 'skip' ? outcome.reason : undefined,
            baseUrl: parsed?.baseUrl ?? null,
            models: parsed?.models ?? [],
            envName: managed?.envName ?? null,
            tokenTail: parsed !== null && parsed.apiKey.length >= 4 ? parsed.apiKey.slice(-4) : null,
            hasKey: parsed !== null && parsed.apiKey.length > 0,
            usageConfigured: parseUsageScript(row) !== null,
            // undefined = DSH's llm service was not reachable to ask
            ...(live === undefined ? {} : { routable: live.routable, liveModels: live.models }),
          }
        })
      } catch (cause) {
        available = false
        error = cause instanceof CcSwitchUnavailableError ? cause.message : `${cause instanceof Error ? cause.message : String(cause)}`
        providers = []
      }
      writeJson(res, 200, {
        ok: true,
        enabled: true,
        dbPath,
        ccSwitch: { available, ...(error === undefined ? {} : { error }), providers },
        sync: {
          lastSyncAt: syncState.lastSyncAt,
          lastError: syncState.lastError,
          managedRoutes: Object.keys(syncState.managed),
        },
        dsh: {
          defaultModel: dshModel.defaultModel,
          managedRoutes: Object.keys(syncState.managed),
          ...(liveRoutes === null ? {} : { routableRoutes: [...liveRoutes.keys()] }),
        },
      })
    },
  }

  // ── usage: quota/balance for the model in use (or ?route=ccs-…) ────────────
  // Resolves the route to a cc-switch provider row, then runs that provider's
  // configured usage query (Volcano/MultiMax token plan or the cc-switch JS
  // script). Results are cached per route honoring the script's configured
  // auto-query interval; secrets never reach the response.
  const usageCache = new Map<string, { at: number; ttlMs: number; value: UsageRouteResponse }>()
  const usageRoute: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/usage`,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      if (!deps.enabled()) return writeJson(res, 503, { ok: false, error: 'dsh-switch is disabled in settings' })
      const url = new URL(req.url ?? '/api/cc-switch/usage', `http://${req.headers.host ?? 'localhost'}`)
      const dshModel = readDshModelState(deps.settingsService())
      const requested = url.searchParams.get('route') ?? (typeof dshModel.defaultModel?.provider === 'string' ? dshModel.defaultModel.provider : '')
      if (requested === '') return writeJson(res, 200, { ok: true, configured: false, reason: 'no model in use' })
      const cached = usageCache.get(requested)
      if (cached !== undefined && Date.now() - cached.at < cached.ttlMs) {
        return writeJson(res, 200, cached.value)
      }
      const respond = (value: UsageRouteResponse, ttlMs: number): void => {
        usageCache.set(requested, { at: Date.now(), ttlMs, value })
        writeJson(res, 200, value)
      }
      const rows = withDb(resolveDbPath(deps.dbPath()), (db) => listProviders(db))
      const row = rows.find((candidate) => dshRouteFor(candidate.id) === requested)
      if (row === undefined) {
        return respond({ ok: true, route: requested, configured: false, reason: 'provider is not managed by cc-switch sync' }, 60_000)
      }
      const script = parseUsageScript(row)
      if (script === null) {
        return respond({ ok: true, route: requested, provider: row.name, configured: false, reason: 'no usage query configured for this provider' }, 60_000)
      }
      let result = await queryProviderUsage(row)
      // Volcano/relay error bodies echo credentials — scrub every secret this row
      // contributed before the response leaves the process.
      if (result.kind === 'error') {
        const secrets = new Set<string>()
        const consider = (value: string | undefined): void => {
          if (typeof value === 'string' && value.length >= 4) secrets.add(value)
        }
        consider(script.accessKeyId)
        consider(script.secretAccessKey)
        consider(script.accessToken)
        try {
          const parsed = JSON.parse(row.settingsConfig ?? '{}') as { env?: Record<string, unknown> }
          const env = parsed.env ?? {}
          for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) consider(typeof env[key] === 'string' ? (env[key] as string) : undefined)
        } catch {
          // no env to scrub
        }
        let message = result.error
        for (const secret of secrets) message = message.replaceAll(secret, '***')
        result = { ...result, error: message }
      }
      const checkedAt = new Date().toISOString()
      // Honor the script's auto-query interval (minutes); failures retry sooner.
      const ttlMs = result.kind === 'error' ? 60_000 : Math.max(60_000, script.autoQueryIntervalMin * 60_000)
      const value: UsageRouteResponse = { ok: true, route: requested, provider: row.name, configured: true, result, checkedAt }
      respond(value, ttlMs)
    },
  }

  const sync: WebRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/sync`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      if (!deps.enabled()) return writeJson(res, 503, { ok: false, error: 'dsh-switch is disabled in settings' })
      try {
        const outcome = await runSync(
          { dbPath: deps.dbPath, enabled: deps.enabled, settings: deps.settingsService, credentials: deps.credentialsService },
          { force: true },
        )
        if (outcome.changed) deps.announceModelInputsChanged()
        writeJson(res, 200, { ok: outcome.ok, ...outcome })
      } catch (cause) {
        writeJson(res, 500, { ok: false, error: cause instanceof Error ? cause.message : String(cause) })
      }
    },
  }

  return [state, usageRoute, sync]
}

interface DshModelView {
  provider?: unknown
  model?: unknown
}

function readDshModelState(settingsService: unknown): { defaultModel: { provider: string; model: string } | null; appliedProviders?: string[] } {
  try {
    if (settingsService === null || typeof settingsService !== 'object') return { defaultModel: null }
    const get = (settingsService as { get?: unknown }).get
    if (typeof get !== 'function') return { defaultModel: null }
    const adm = (get as (ns: string) => unknown).call(settingsService, 'agent-default-model') as DshModelView | undefined
    const defaultModel = typeof adm?.provider === 'string' && typeof adm?.model === 'string'
      ? { provider: adm.provider, model: adm.model }
      : null
    return { defaultModel }
  } catch {
    return { defaultModel: null }
  }
}
