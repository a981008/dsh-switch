/**
 * dsh-switch host plugin: bridges cc-switch (https://github.com/farion1231/cc-switch)
 * into DeepSeek Harness.
 *
 * - reads ~/.cc-switch/cc-switch.db read-only (node:sqlite, zero native deps)
 * - watches the cc-switch database files: the moment cc-switch saves a
 *   provider, it is mirrored into the DSH `llm-pi-ai` settings namespace
 *   (Claude, Codex/GPT, Gemini relays, OpenClaw) — a slow signature poll
 *   remains as a safety net; the cc-switch current provider drives
 *   `agent-default-model`
 * - "plan" queries the Volcano Ark plan quota via the management-plane OpenAPI
 */
import z from 'schemastery'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { resolveDbPath } from './ccswitch-db.ts'
import { makeRoutes, syncDepsFrom, type LlmReader, type RouteDeps } from './routes.ts'
import { mountOnce } from './mount-once.ts'
import { startSyncLoop } from './loop.ts'

/**
 * Re-exported for the test suite: the automatic loop and the route deps mapping
 * are the two halves that must stay in agreement (see `syncDepsFrom`).
 */
export { syncDepsFrom } from './routes.ts'
export { startSyncLoop } from './loop.ts'

/** Settings namespace owned by this plugin. */
export const CC_SWITCH_NAMESPACE = 'cc-switch'

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch: when false the routes report disabled and sync pauses. */
  enabled?: boolean
  /** Override path of the cc-switch SQLite database (default ~/.cc-switch/cc-switch.db). */
  dbPath?: string
  /**
   * Safety-net poll interval in seconds (1–3600, default 30). Saving in
   * cc-switch triggers a sync immediately via the file watcher; the poll only
   * covers events the watcher might have missed.
   */
  syncInterval?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  dbPath: z.string().default(''),
  syncInterval: z.number().step(1).min(1).max(3600).default(30),
})

/** webServer is required; settings and credentials arrive via ctx.inject when ready. */
export const inject = ['webServer']

/**
 * Tell DSH that the set of servable models changed, so every client refreshes
 * its model catalog at once. `llm/adapters-updated` is the host event DSH
 * forwards to clients for exactly this purpose (mode: emit, no payload);
 * emitting it when nothing changed would only cost a redundant catalog read.
 */
function announceModelInputsChanged(ctx: any): void {
  try {
    ctx?.emit?.('llm/adapters-updated')
  } catch {
    // no event bus (or a listener threw): the client refresh is best-effort
  }
}

export const apply = mountOnce('dsh-switch', applyImpl)

function applyImpl(ctx: any, config?: Config): void {
  // Live settings source: the settings service once it is up, the composition
  // entry otherwise (mirrors the task-board pattern). Also captures the
  // service handle for the route handlers.
  let current: () => Config = () => config ?? {}
  let settingsService: unknown
  let credentialsService: unknown
  let llmService: LlmReader | null = null
  ctx.inject?.(['settings'], (settingsCtx: any) => {
    const settings = settingsCtx?.settings
    settingsService = settings
    try {
      if (typeof settings?.installSection === 'function') {
        settings.installSection(ctx, CC_SWITCH_NAMESPACE, Config, config ?? {}, {
          setSource: (source: () => Config) => {
            current = source
          },
        })
      } else if (typeof settings?.register === 'function') {
        const scope = settings.register(CC_SWITCH_NAMESPACE, Config, { base: config ?? {} })
        current = () => scope?.get?.() ?? (config ?? {})
        scope?.watch?.(() => {})
      }
    } catch {
      // Settings surface differences must not break the routes.
    }
  })
  ctx.inject?.(['credentials'], (credentialsCtx: any) => {
    credentialsService = credentialsCtx?.credentials
  })
  // The DSH model registry, read-only: lets /state report whether a synced
  // route is already live in the model picker (not just present in settings).
  ctx.inject?.(['llm'], (llmCtx: any) => {
    const llm = llmCtx?.llm
    llmService = llm !== null && typeof llm === 'object' && typeof llm.listProviders === 'function' ? (llm as LlmReader) : null
  })

  const deps: RouteDeps = {
    dbPath: () => current()?.dbPath ?? '',
    enabled: () => current()?.enabled ?? true,
    settingsService: () => settingsService,
    credentialsService: () => credentialsService,
    llmService: () => llmService,
    announceModelInputsChanged: () => announceModelInputsChanged(ctx),
  }

  const routes: WebRoute[] = makeRoutes(deps)
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      for (const route of routes) disposers.push(ctx.webServer.register(route))
    } catch (error) {
      for (const dispose of disposers) dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-switch: cc-switch bridge routes')

  // Event-driven sync: file watching delivers cc-switch saves immediately; a
  // slow poll remains as the safety net. The loop builds the sync engine's deps
  // through syncDepsFrom — the one mapping the manual route also uses.
  ctx.effect(() => startSyncLoop(syncDepsFrom(deps), {
    intervalMs: safeIntervalMs(current),
    announce: () => deps.announceModelInputsChanged(),
    onError: (error) => {
      // Never silent: a swallowed failure here is invisible in the UI.
      ctx.logger?.error?.(error)
    },
  }), 'dsh-switch: sync loop')
}

/** The poll period from live settings, clamped, with a safe fallback. */
function safeIntervalMs(current: () => Config): number {
  try {
    const seconds = Math.floor(Number(current()?.syncInterval ?? 30))
    if (!Number.isFinite(seconds)) return 30_000
    return Math.min(3600, Math.max(1, seconds)) * 1000
  } catch {
    return 30_000
  }
}
