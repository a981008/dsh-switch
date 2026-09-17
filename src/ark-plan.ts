/**
 * Volcano Ark (火山方舟) plan usage via the management-plane OpenAPI.
 *
 * The Coding/Agent Plan quota lives behind `open.volcengineapi.com` Actions
 * signed with IAM AccessKey/SecretKey (HMAC-SHA256, SigV4-style) — the ARK_API_KEY
 * bearer token cannot read it. Official reference:
 * https://www.volcengine.com/docs/82379/1298459
 *
 * Response shapes tolerated (first non-empty wins):
 * - GetCodingPlanUsage: { Result: { QuotaUsage: [{Level:'session'|'weekly'|'monthly', Percent, ResetTimestamp}] } }
 * - GetAFPUsage (AgentPlan): similar Result wrappers / UsageDetails rows
 * - flat window objects { fiveHour: {percent|used/limit, reset} }
 *
 * Signing constants and the action whitelist mirror the community-verified
 * behavior (dsh-cost-meter issue #60/#71): GetCodingPlanUsage first
 * (CodingPlan official), GetAFPUsage second (AgentPlan), then generic
 * fallbacks that need extra params and usually 400.
 */
import { createHash, createHmac } from 'node:crypto'

export const VOLCENGINE_HOST = 'open.volcengineapi.com'
export const VOLCENGINE_SERVICE = 'ark'
export const VOLCENGINE_REGION = 'cn-beijing'
export const VOLCENGINE_VERSION = '2024-01-01'
export const VOLCENGINE_ACTIONS = ['GetCodingPlanUsage', 'GetAFPUsage', 'GetUsageDetails', 'GetPersonalPlan'] as const

export interface PlanWindow {
  percent: number
  resetsAt: string | null
}

export interface PlanUsage {
  windows: Record<string, PlanWindow>
  action: string
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function hashHex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

function uriEscape(str: string): string {
  return encodeURIComponent(str)
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
}

function queryParamsToString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${uriEscape(key)}=${uriEscape(params[key])}`)
    .join('&')
}

function volcengineDateTimeNow(): string {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
}

export interface SignInput {
  accessKeyId: string
  secretAccessKey: string
  method?: string
  host?: string
  path?: string
  query?: Record<string, string>
  body?: string
  region?: string
  service?: string
  datetime?: string
}

/** Volcengine OpenAPI HMAC-SHA256 Authorization header (signed: host;x-content-sha256;x-date). */
export function volcengineAuthorization(input: SignInput): Record<string, string> {
  const {
    accessKeyId,
    secretAccessKey,
    method = 'GET',
    host = VOLCENGINE_HOST,
    path = '/',
    query = {},
    body = '',
    region = VOLCENGINE_REGION,
    service = VOLCENGINE_SERVICE,
    datetime,
  } = input
  const xDate = datetime ?? volcengineDateTimeNow()
  const date = xDate.slice(0, 8)
  const bodySha = hashHex(body)
  const signedHeaders = 'host;x-content-sha256;x-date'
  const canonicalHeaders = `host:${host}\nx-content-sha256:${bodySha}\nx-date:${xDate}`
  const qs = queryParamsToString(query)
  const canonicalRequest = [method.toUpperCase(), path, qs, `${canonicalHeaders}\n`, signedHeaders, bodySha].join('\n')
  const credentialScope = [date, region, service, 'request'].join('/')
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, hashHex(canonicalRequest)].join('\n')
  const kDate = hmacSha256(secretAccessKey, date)
  const kRegion = hmacSha256(kDate, region)
  const kService = hmacSha256(kRegion, service)
  const kSigning = hmacSha256(kService, 'request')
  const signature = hmacSha256(kSigning, stringToSign).toString('hex')
  return {
    'X-Date': xDate,
    'X-Content-Sha256': bodySha,
    Host: host,
    Authorization: `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

function normalizeResetAt(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw * 1000
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  const text = String(raw)
  const asNumber = Number(text)
  if (Number.isFinite(asNumber) && text.trim() !== '') return normalizeResetAt(asNumber)
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

function windowName(raw: unknown): string | null {
  const s = String(raw ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (s.includes('5h') || s.includes('fivehour') || s === 'session' || s === 'rolling') return 'fiveHour'
  if (s.includes('week') || s === '7d') return 'weekly'
  if (s.includes('month') || s === '30d') return 'monthly'
  if (s.includes('daily') || s === 'day' || s === '1d') return 'daily'
  const text = String(raw ?? '').trim()
  if (text.length > 0 && text.length < 32) return text.replace(/\s+/g, '_')
  return null
}

function windowEntry(nameRaw: unknown, entry: Record<string, unknown>): { name: string; win: PlanWindow } | null {
  const name = windowName(nameRaw)
  if (name === null) return null
  const percentRaw = entry['Percent'] ?? entry['percent'] ?? entry['percentage'] ?? entry['Percentage'] ?? entry['utilization']
  let pct = Number(percentRaw)
  if (!Number.isFinite(pct)) {
    const total = Number(entry['Total'] ?? entry['total'] ?? entry['Limit'] ?? entry['limit'] ?? entry['Quota'] ?? entry['quota'] ?? entry['Cap'] ?? entry['cap'])
    const used = Number(entry['Used'] ?? entry['used'] ?? entry['Usage'] ?? entry['usage'] ?? entry['Consumed'] ?? entry['consumed'])
    const remain = Number(entry['Remaining'] ?? entry['remaining'] ?? entry['Remain'] ?? entry['remain'] ?? entry['Available'] ?? entry['available'])
    if (Number.isFinite(total) && total > 0 && Number.isFinite(used)) pct = (used / total) * 100
    else if (Number.isFinite(total) && total > 0 && Number.isFinite(remain)) pct = ((total - remain) / total) * 100
    else return null
  }
  if (!Number.isFinite(pct)) return null
  const resetsAt = normalizeResetAt(
    entry['ResetTimestamp'] ?? entry['resetTimestamp'] ?? entry['ResetTime'] ?? entry['resetTime'] ?? entry['ResetAt'] ?? entry['resetAt'] ?? entry['EndTime'] ?? entry['endTime'],
  )
  return { name, win: { percent: clampPct(pct), resetsAt } }
}

/** Parse one Volcengine usage response body into normalized windows (null when unrecognized). */
export function parseVolcenginePlanUsage(data: unknown): Record<string, PlanWindow> | null {
  if (data === null || typeof data !== 'object') return null
  const root = data as Record<string, unknown>

  // Official CodingPlan form: Result.QuotaUsage[] with Level/Percent/ResetTimestamp.
  const result = (root['Result'] ?? root['result']) as Record<string, unknown> | undefined
  const quotaList = (result?.['QuotaUsage'] ?? result?.['quotaUsage'] ?? result?.['UsageDetails'] ?? result?.['usageDetails']) as unknown
  if (Array.isArray(quotaList)) {
    const windows: Record<string, PlanWindow> = {}
    for (const raw of quotaList) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const entry = raw as Record<string, unknown>
      const nameRaw = entry['Level'] ?? entry['level'] ?? entry['QuotaType'] ?? entry['quotaType'] ?? entry['Type'] ?? entry['type'] ?? entry['Label'] ?? entry['label']
      const parsed = windowEntry(nameRaw, entry)
      if (parsed !== null && windows[parsed.name] === undefined) windows[parsed.name] = parsed.win
    }
    if (Object.keys(windows).length > 0) return windows
  }

  // Fallback: flat window objects directly on Result or the root.
  for (const candidate of [result, root]) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const windows: Record<string, PlanWindow> = {}
    for (const [name, raw] of Object.entries(candidate)) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      if (name === 'ResponseMetadata' || name === 'ResponseDetails') continue
      const parsed = windowEntry(name, raw as Record<string, unknown>)
      if (parsed !== null) windows[parsed.name] = parsed.win
    }
    if (Object.keys(windows).length > 0) return windows
  }
  return null
}

function responseError(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null
  const meta = (data as Record<string, unknown>)['ResponseMetadata'] as Record<string, unknown> | undefined
  const error = meta?.['Error'] as Record<string, unknown> | undefined
  if (error !== undefined && error !== null) {
    return `${String(error['Code'] ?? 'UnknownError')}: ${String(error['Message'] ?? '')}`.trim()
  }
  return null
}

async function tryAction(
  action: string,
  ak: string,
  sk: string,
  timeoutMs: number,
): Promise<{ windows: Record<string, PlanWindow> | null; error: string | null }> {
  const query = { Action: action, Version: VOLCENGINE_VERSION }
  const headers = volcengineAuthorization({ accessKeyId: ak, secretAccessKey: sk, query })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`https://${VOLCENGINE_HOST}/?${queryParamsToString(query)}`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      return { windows: null, error: `HTTP ${response.status} (non-JSON response)` }
    }
    const apiError = responseError(body)
    if (!response.ok || apiError !== null) {
      return { windows: null, error: apiError ?? `HTTP ${response.status}` }
    }
    const windows = parseVolcenginePlanUsage(body)
    return { windows, error: windows === null ? 'unrecognized response shape' : null }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return { windows: null, error: message === 'This operation was aborted' ? 'request timeout' : message }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Query the plan usage trying every whitelisted Action; the first non-empty
 * window set wins (CodingPlan uses GetCodingPlanUsage, AgentPlan answers on
 * GetAFPUsage). Returns an error string only when every action failed.
 */
export async function queryArkPlanUsage(accessKeyId: string, secretAccessKey: string, timeoutMs = 15_000): Promise<PlanUsage> {
  let firstError: string | null = null
  for (const action of VOLCENGINE_ACTIONS) {
    const { windows, error } = await tryAction(action, accessKeyId, secretAccessKey, timeoutMs)
    if (windows !== null && Object.keys(windows).length > 0) return { windows, action }
    if (error !== null && firstError === null) firstError = error
    if (windows !== null) firstError = 'no recognizable usage windows in the response'
  }
  throw new Error(firstError ?? 'all Volcengine usage actions failed')
}
