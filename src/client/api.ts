/** Fetch helpers against the host routes (same-origin). */

export interface ProviderView {
  id: string
  appType: string
  name: string
  isCurrent: boolean
  route: string
  status: 'synced' | 'skipped'
  reason?: string
  baseUrl: string | null
  models: string[]
  envName: string | null
  /** last 4 chars of the auth key, for display only */
  tokenTail: string | null
  hasKey: boolean
  /** true when the provider has a usage query enabled in cc-switch */
  usageConfigured: boolean
}

export interface StateResponse {
  ok: boolean
  enabled: boolean
  dbPath?: string
  ccSwitch: { available: boolean; providers: ProviderView[]; error?: string }
  sync: {
    lastSyncAt: string | null
    lastError: string | null
    managedRoutes: string[]
  }
  dsh: {
    defaultModel?: { provider: string; model: string } | null
    managedRoutes?: string[]
  }
}

export interface SyncResponse {
  ok: boolean
  changed: boolean
  applied: string[]
  removed: string[]
  defaultChanged: boolean
  skipped: Array<{ name: string; appType: string; reason: string }>
  lastSyncAt: string | null
  error?: string
}


async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' })
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `${url} failed: ${response.status}`)
  return body
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = (await response.json()) as T & { error?: string }
  if (!response.ok || parsed.ok === false) throw new Error(parsed.error ?? `${url} failed: ${response.status}`)
  return parsed
}

export async function fetchState(): Promise<StateResponse> {
  return getJson<StateResponse>('/api/cc-switch/state')
}

export async function syncNow(): Promise<SyncResponse> {
  return postJson<SyncResponse>('/api/cc-switch/sync', {})
}


export interface UsageWindow {
  percent: number
  resetsAt: string | null
}

export type UsageResult =
  | { kind: 'plan'; windows: Record<string, UsageWindow>; action?: string }
  | { kind: 'balance'; remaining?: number; used?: number; total?: number; unit?: string; planName?: string; extra?: string }
  | { kind: 'error'; error: string }

export interface UsageResponse {
  ok: boolean
  route: string
  provider?: string
  configured: boolean
  reason?: string
  result?: UsageResult
  checkedAt?: string
}

/** Usage for the model currently in use (default) or a specific ccs-* route. */
export async function fetchUsage(route?: string): Promise<UsageResponse> {
  return getJson<UsageResponse>(`/api/cc-switch/usage${route !== undefined && route !== '' ? `?route=${encodeURIComponent(route)}` : ''}`)
}

