/**
 * Minimal ambient declarations for the DSH runtime modules this plugin imports.
 *
 * They are provided by the host at runtime (and by the desktop app's own
 * dependencies when it loads us), so they are not npm dependencies here. Only
 * the surface this plugin actually touches is declared — that is enough for
 * `tsc --noEmit` to typecheck our own modules against each other, which is
 * where a wrong-shaped dependency object once slipped through unnoticed.
 */
declare module '@deepseek-ai/dsh-host-webserver' {
  import type { IncomingMessage, ServerResponse } from 'node:http'

  export interface WebRoute {
    kind: 'exact' | 'prefix'
    path: string
    handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  }
}

declare module '@deepseek-ai/cordis' {
  /** A registered client slot; the returned callback unregisters it. */
  export interface SlotRegistry {
    inject(name: string, callback: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): () => void
  }

  export interface LocaleRegistry {
    register(namespace: string, dictionaries: unknown): unknown
  }

  export interface RemoteFace {
    $on?(event: string, listener: (...args: never[]) => void): unknown
  }

  /**
   * The cordis context. The core faces are declared present: a plugin only
   * applies once the services it declares in `inject` are available, and the
   * client half declares `['slots', 'locale']`. `logger` stays optional because
   * not every host generation exposes one.
   */
  export interface Context {
    effect(callback: () => unknown, label?: string): unknown
    inject(deps: string[], callback: (scope: Record<string, unknown>) => void): unknown
    emit(event: string, ...args: unknown[]): unknown
    on(event: string, listener: (...args: never[]) => void): unknown
    logger?: { error?(error: unknown): void; warn?(message: string): void }
    slots: SlotRegistry
    locale: LocaleRegistry
    remote: RemoteFace
    [key: string]: unknown
  }
}
