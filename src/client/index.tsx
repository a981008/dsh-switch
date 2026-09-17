/**
 * dsh-switch client half (browser cordis plugin): registers the settings
 * section card and the composer usage badge. Failure policy mirrors the
 * community plugins — mounting problems are logged, never thrown, so the web
 * shell never fails its boot because of this plugin.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { CcSwitchSection } from './CcSwitchSection.tsx'
import { ConversationUsage, type DirectoryStore } from './ConversationUsage.tsx'
import { bumpSyncRevision } from './refresh.ts'
import { NS, dictionaries } from './locales.ts'

export const inject = ['slots', 'locale']

/** Apply-once guard (the module loader dedupes by package name; belt and braces). */
const APPLY_CLAIM = Symbol.for('dsh-switch.client.applied')

/**
 * The ui-model-selection service (`ctx.modelDirectories`): the per-session model
 * selection directory. Captured lazily so the composer badge can follow the
 * session's model the instant it changes; when it is unavailable the badge
 * falls back to the host-resolved default model.
 */
let modelDirectories: { directoryFor(sessionId: string): { store: DirectoryStore } } | null = null

function directoryStoreFor(sessionId: string | undefined): DirectoryStore | undefined {
  if (sessionId === undefined || modelDirectories === null) return undefined
  try {
    return modelDirectories.directoryFor(sessionId)?.store
  } catch {
    // unknown/unscoped sessions (e.g. subagent addresses) have no directory
    return undefined
  }
}

export function apply(ctx: ClientContext): void {
  const registry = globalThis as { [APPLY_CLAIM]?: boolean }
  if (registry[APPLY_CLAIM] === true) return
  registry[APPLY_CLAIM] = true
  ctx.effect?.(() => () => {
    registry[APPLY_CLAIM] = false
  }, 'dsh-switch: apply claim')

  try {
    ctx.inject(['modelDirectories'], (scope: { modelDirectories?: typeof modelDirectories }) => {
      modelDirectories = scope?.modelDirectories ?? null
    })
  } catch {
    // older shells without the service: the badge keeps the default-model path
  }

  // Model inputs changed on the host (cc-switch sync wrote providers, a route
  // was added or removed, a key landed) → every surface re-reads immediately.
  // DSH forwards both events to clients; the namespaces we care about are the
  // ones our sync writes.
  try {
    ctx.inject(['remote'], (scope: { remote?: { $on?: (event: string, listener: (...args: unknown[]) => void) => unknown } }) => {
      const remote = scope?.remote
      if (typeof remote?.$on !== 'function') return
      remote.$on('llm/adapters-updated', () => {
        bumpSyncRevision()
      })
      remote.$on('settings/document-updated', (ns?: unknown) => {
        if (ns === 'llm-pi-ai' || ns === 'agent-default-model' || ns === undefined) bumpSyncRevision()
      })
    })
  } catch {
    // No remote event face (older shell): surfaces keep their own polling.
  }

  try {
    ctx.effect(() => {
      try {
        return ctx.locale.register(NS, dictionaries)
      } catch {
        return () => {}
      }
    }, 'dsh-switch: dictionaries')
  } catch {
    // Locale service missing: the components fall back to English copy.
  }

  try {
    ctx.slots.inject('settings.section', () => {
      try {
        const unregister = ctx.slots.register(
          { name: 'settings.section', id: 'cc-switch', order: 40, label: 'CC Switch', locale: NS, inject: () => ({}) },
          CcSwitchSection,
        )
        return () => {
          unregister()
        }
      } catch (error) {
        console.error('[dsh-switch] settings.section registration failed:', error)
        return () => {}
      }
    })
  } catch (error) {
    console.error('[dsh-switch] settings.section slot unavailable:', error)
  }

  try {
    ctx.slots.inject('conversation.input.right', () => {
      try {
        const unregister = ctx.slots.register(
          { name: 'conversation.input.right', id: 'cc-switch-usage', order: 10, locale: NS, inject: (sessionId?: string) => ({ sessionId, directory: directoryStoreFor(sessionId) }) },
          ConversationUsage,
        )
        return () => {
          unregister()
        }
      } catch (error) {
        console.error('[dsh-switch] conversation usage registration failed:', error)
        return () => {}
      }
    })
  } catch (error) {
    console.error('[dsh-switch] conversation.input.right slot unavailable:', error)
  }
}
