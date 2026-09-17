/**
 * Sync-refresh signal shared by the client surfaces.
 *
 * The host writes synced providers through the settings service, and DSH
 * forwards the resulting `settings/document-updated` / `llm/adapters-updated`
 * events to every client. This store turns those events into a React-visible
 * revision counter, so the settings card and the composer badge re-read the
 * moment cc-switch syncs — no reopening, no waiting for a poll tick.
 */
import { useSyncExternalStore } from 'react'

let revision = 0
const listeners = new Set<() => void>()

/** Bump the revision and wake every subscribed component. */
export function bumpSyncRevision(): void {
  revision += 1
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // a broken subscriber must not block the others
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getRevision = (): number => revision

/** Current sync revision; changes whenever DSH reports a model-input change. */
export function useSyncRevision(): number {
  return useSyncExternalStore(subscribe, getRevision)
}
