/**
 * The automatic sync loop: cc-switch saves are picked up by the file watch,
 * and a slow poll remains the safety net. Both paths share one busy-guard with
 * a pending flag so a change landing mid-sync re-runs right after.
 *
 * This lives in its own module (rather than inline in the plugin body) so the
 * automatic path can be driven end-to-end by a test — the deps it hands to
 * `runSync` must be the sync engine's shape, which is exactly the mistake that
 * once left the automatic sync silently doing nothing.
 */
import { runSync, watchCcSwitchDb, type SyncDeps } from './sync.ts'
import { resolveDbPath } from './ccswitch-db.ts'

export interface SyncLoopOptions {
  /** Safety-net poll period. */
  intervalMs: number
  /** Called after a pass that changed DSH's model inputs. */
  announce?: () => void
  /**
   * Where a failed pass is reported. A silent failure here once hid a
   * wrong-shaped deps object for the whole life of the plugin, so the default
   * is to surface it rather than swallow it.
   */
  onError?: (error: unknown) => void
}

/**
 * Start the automatic sync and return its disposer.
 *
 * @param deps - sync-engine deps (see `syncDepsFrom` for the route deps mapping)
 * @param options - poll period, change announcement and error sink
 */
export function startSyncLoop(deps: SyncDeps, options: SyncLoopOptions): () => void {
  const { intervalMs, announce, onError } = options
  let busy = false
  let pending = false
  let failures = 0

  const run = (): void => {
    if (busy) {
      pending = true
      return
    }
    try {
      if (!deps.enabled()) return
    } catch (error) {
      report(error)
      return
    }
    busy = true
    void runSync(deps, { force: false })
      .then((outcome) => {
        if (outcome.changed) announce?.()
      })
      .catch((error) => {
        report(error)
      })
      .finally(() => {
        busy = false
        if (pending) {
          pending = false
          run()
        }
      })
  }

  const report = (error: unknown): void => {
    failures += 1
    // The first failure is the interesting one; later ticks would only repeat it.
    if (failures === 1) onError?.(error)
  }

  const timer = setInterval(run, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  let unwatch: () => void = () => {}
  try {
    // Resolve here: an unset db path means the default ~/.cc-switch/cc-switch.db,
    // and watching "" would watch the process's working directory.
    unwatch = watchCcSwitchDb(resolveDbPath(deps.dbPath()), run)
  } catch (error) {
    // A db path that cannot be resolved yet (settings still loading) must not
    // cost us the poll: the next tick retries the read itself.
    report(error)
  }
  run()

  return () => {
    clearInterval(timer)
    unwatch()
  }
}
