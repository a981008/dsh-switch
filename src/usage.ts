/**
 * Generic cc-switch usage-query engine: turns a provider's `usage_script`
 * configuration into a normalized usage result.
 *
 * Three shapes are supported (mirroring cc-switch):
 * - token_plan / volcengine → Volcano Ark management-plane query (ark-plan.ts)
 * - token_plan / minimax    → MiniMax coding-plan remains API
 * - general | newapi        → run the script's `request` spec + `extractor`
 *                             inside a node:vm sandbox
 */
import vm from 'node:vm'
import { parseUsageScript, type CcProviderRow } from './ccswitch-db.ts'
import { queryArkPlanUsage, type PlanWindow } from './ark-plan.ts'

/** One normalized usage result, whatever the underlying template. */
export type UsageResult =
  | { kind: 'plan'; windows: Record<string, PlanWindow>; action?: string }
  | { kind: 'balance'; remaining?: number; used?: number; total?: number; unit?: string; planName?: string; extra?: string }
  | { kind: 'error'; error: string }

/** The slice of a cc-switch provider needed to execute its usage query. */
export interface UsageContext {
  apiKey: string
  baseUrl: string
}

const SUBSTITUTION_KEYS = ['baseUrl', 'apiKey', 'accessToken', 'userId'] as const

export function substitute(template: string, vars: Record<string, string>): string {
  let out = template
  for (const key of SUBSTITUTION_KEYS) {
    out = out.replaceAll(`{{${key}}}`, vars[key] ?? '')
  }
  return out
}

/** Deep-substitute placeholders inside a JSON value (urls, headers, …). */
function substituteDeep(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string') return substitute(value, vars)
  if (Array.isArray(value)) return value.map((item) => substituteDeep(item, vars))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = substituteDeep(item, vars)
    return out
  }
  return value
}

/** Evaluate the script source `({ request, extractor })` in a bare vm sandbox. */
function compileScript(code: string, timeoutSec: number): { request: Record<string, unknown>; extractor: (response: unknown) => unknown } {
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } })
  const script = new vm.Script(`(${code})`, { filename: 'cc-switch-usage-script.js' })
  const value = script.runInContext(context, { timeout: Math.min(2000, timeoutSec * 1000) })
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('usage script did not evaluate to an object')
  const holder = value as Record<string, unknown>
  const request = holder['request']
  const extractor = holder['extractor']
  if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new Error('usage script has no request object')
  if (typeof extractor !== 'function') throw new Error('usage script has no extractor function')
  return {
    request: request as Record<string, unknown>,
    // Re-enter the vm for the extractor call so its timeout applies.
    extractor: (response: unknown): unknown => {
      const call = new vm.Script('(__extractor)(__response)', { filename: 'cc-switch-usage-extractor.js' })
      const runContext = vm.createContext({ __extractor: extractor, __response: response }, { codeGeneration: { strings: false, wasm: false } })
      return call.runInContext(runContext, { timeout: Math.min(2000, timeoutSec * 1000) })
    },
  }
}

export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }): Promise<{
    ok: boolean
    status: number
    text(): Promise<string>
  }>
}

async function executeRequest(
  request: Record<string, unknown>,
  extractor: (response: unknown) => unknown,
  timeoutSec: number,
  fetchImpl: FetchLike,
): Promise<UsageResult> {
  const url = typeof request['url'] === 'string' ? request['url'] : ''
  if (!/^https?:\/\//u.test(url)) return { kind: 'error', error: `invalid usage query url: ${url === '' ? '(empty)' : url}` }
  const method = typeof request['method'] === 'string' ? request['method'].toUpperCase() : 'GET'
  const headers: Record<string, string> = {}
  const rawHeaders = request['headers']
  if (rawHeaders !== null && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
    for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value === 'string') headers[key] = value
    }
  }
  const controller = new AbortController()
  const abort = setTimeout(() => controller.abort(), Math.max(1, timeoutSec) * 1000)
  try {
    const response = await fetchImpl(url, { method, headers, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) return { kind: 'error', error: `HTTP ${response.status}: ${text.slice(0, 200)}` }
    let body: unknown
    try {
      body = JSON.parse(text) as unknown
    } catch {
      return { kind: 'error', error: 'usage response is not JSON' }
    }
    const extracted = extractor(body)
    if (extracted === null || typeof extracted !== 'object' || Array.isArray(extracted)) return { kind: 'error', error: 'extractor returned no object' }
    const record = extracted as Record<string, unknown>
    if (record['isValid'] === false) {
      const message = typeof record['invalidMessage'] === 'string' ? record['invalidMessage'] : 'account invalid'
      return { kind: 'error', error: message }
    }
    const num = (key: string): number | undefined => {
      const value = record[key]
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    }
    const str = (key: string): string | undefined => {
      const value = record[key]
      return typeof value === 'string' && value !== '' ? value : undefined
    }
    return {
      kind: 'balance',
      ...(num('remaining') !== undefined ? { remaining: record['remaining'] as number } : {}),
      ...(num('used') !== undefined ? { used: record['used'] as number } : {}),
      ...(num('total') !== undefined ? { total: record['total'] as number } : {}),
      ...(str('unit') !== undefined ? { unit: record['unit'] as string } : {}),
      ...(str('planName') !== undefined ? { planName: record['planName'] as string } : {}),
      ...(str('extra') !== undefined ? { extra: record['extra'] as string } : {}),
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return { kind: 'error', error: message === 'This operation was aborted' ? `request timed out after ${timeoutSec}s` : message }
  } finally {
    clearTimeout(abort)
  }
}

/** MiniMax coding-plan tiers: model_remains[] entry named "general", remaining% → used%. */
export function parseMinimaxPlan(body: unknown): Record<string, PlanWindow> | null {
  if (body === null || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  if (record['base_resp'] !== null && typeof record['base_resp'] === 'object') {
    const base = record['base_resp'] as Record<string, unknown>
    if (base['status_code'] !== 0) return null
  }
  const modelRemains = record['model_remains']
  if (!Array.isArray(modelRemains)) return null
  const item = modelRemains.find((entry) => (entry as Record<string, unknown>)['model_name'] === 'general') as Record<string, unknown> | undefined
  if (item === undefined) return null
  const windows: Record<string, PlanWindow> = {}
  const millisToIso = (value: unknown): string | null =>
    typeof value === 'number' && value > 0 ? new Date(value).toISOString() : null
  const remaining = item['current_interval_remaining_percent']
  if (typeof remaining === 'number' && Number.isFinite(remaining)) {
    windows['fiveHour'] = { percent: Math.max(0, Math.min(100, 100 - remaining)), resetsAt: millisToIso(item['end_time']) }
  }
  if (item['current_weekly_status'] === 1) {
    const weeklyRemaining = item['current_weekly_remaining_percent']
    if (typeof weeklyRemaining === 'number' && Number.isFinite(weeklyRemaining)) {
      windows['weekly'] = { percent: Math.max(0, Math.min(100, 100 - weeklyRemaining)), resetsAt: millisToIso(item['weekly_end_time']) }
    }
  }
  return Object.keys(windows).length > 0 ? windows : null
}

// ── built-in balance templates (cc-switch templateType 'balance') ───────────
// Mirrors cc-switch's services/balance.rs: DeepSeek, StepFun, SiliconFlow
// (CN/EN), OpenRouter, Novita AI — provider detected from the base_url.

type BalanceKind = 'deepseek' | 'stepfun' | 'siliconflow-cn' | 'siliconflow-en' | 'openrouter' | 'novita'

export function detectBalanceProvider(baseUrl: string): BalanceKind | null {
  const url = baseUrl.toLowerCase()
  if (url.includes('api.deepseek.com')) return 'deepseek'
  if (url.includes('api.stepfun.ai') || url.includes('api.stepfun.com')) return 'stepfun'
  if (url.includes('api.siliconflow.cn')) return 'siliconflow-cn'
  if (url.includes('api.siliconflow.com')) return 'siliconflow-en'
  if (url.includes('openrouter.ai')) return 'openrouter'
  if (url.includes('api.novita.ai')) return 'novita'
  return null
}

/** cc-switch parse_f64_field: JSON fields may be numbers or numeric strings. */
function parseF64Field(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

async function fetchJson(url: string, apiKey: string, timeoutSec: number, fetchImpl: FetchLike, extraHeaders: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...extraHeaders },
    signal: AbortSignal.timeout(Math.max(1, timeoutSec) * 1000),
  })
  const text = await response.text()
  if (response.status === 401 || response.status === 403) throw new Error(`Authentication failed (HTTP ${response.status})`)
  if (!response.ok) throw new Error(`API error (HTTP ${response.status}): ${text.slice(0, 200)}`)
  const body = JSON.parse(text) as unknown
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('unexpected response shape')
  return body as Record<string, unknown>
}

const balance = (remaining: number | undefined, rest: Partial<{ total: number; used: number; unit: string; planName: string; extra: string }> = {}): UsageResult =>
  ({ kind: 'balance', ...(remaining !== undefined ? { remaining } : {}), ...rest })

/** Query one built-in balance provider. Throws on transport/parse errors. */
export async function queryBuiltinBalance(kind: BalanceKind, apiKey: string, timeoutSec: number, fetchImpl: FetchLike): Promise<UsageResult> {
  if (apiKey === '') throw new Error('usage query is missing the provider API key')
  switch (kind) {
    case 'deepseek': {
      // { balance_infos: [{ currency, total_balance, ... }], is_available }
      const body = await fetchJson('https://api.deepseek.com/user/balance', apiKey, timeoutSec, fetchImpl)
      const isAvailable = typeof body['is_available'] === 'boolean' ? body['is_available'] : true
      const infos = Array.isArray(body['balance_infos']) ? (body['balance_infos'] as Record<string, unknown>[]) : []
      if (infos.length === 0) throw new Error('response had no balance_infos')
      const first = infos[0]
      const currency = typeof first['currency'] === 'string' ? first['currency'] : 'CNY'
      if (!isAvailable) throw new Error('Insufficient balance')
      const extras = infos.slice(1).map((info) => `${typeof info['currency'] === 'string' ? info['currency'] : '?'} ${parseF64Field(info, 'total_balance') ?? '?'}`)
      return balance(parseF64Field(first, 'total_balance'), {
        unit: currency,
        planName: currency,
        ...(extras.length > 0 ? { extra: extras.join(' · ') } : {}),
      })
    }
    case 'stepfun': {
      // { balance, total_cash_balance, total_voucher_balance }
      const body = await fetchJson('https://api.stepfun.com/v1/accounts', apiKey, timeoutSec, fetchImpl)
      return balance(parseF64Field(body, 'balance') ?? 0, { unit: 'CNY', planName: 'StepFun' })
    }
    case 'siliconflow-cn':
    case 'siliconflow-en': {
      // { code, data: { balance, chargeBalance, totalBalance, status } }
      const domain = kind === 'siliconflow-cn' ? 'api.siliconflow.cn' : 'api.siliconflow.com'
      const body = await fetchJson(`https://${domain}/v1/user/info`, apiKey, timeoutSec, fetchImpl)
      const data = body['data']
      if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error("Missing 'data' field in response")
      return balance(parseF64Field(data as Record<string, unknown>, 'totalBalance') ?? 0, {
        unit: kind === 'siliconflow-cn' ? 'CNY' : 'USD',
        planName: kind === 'siliconflow-cn' ? 'SiliconFlow' : 'SiliconFlow (EN)',
      })
    }
    case 'openrouter': {
      // { data: { total_credits, total_usage } }
      const body = await fetchJson('https://openrouter.ai/api/v1/credits', apiKey, timeoutSec, fetchImpl)
      const data = body['data']
      const source = data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : body
      const totalCredits = parseF64Field(source, 'total_credits') ?? 0
      const totalUsage = parseF64Field(source, 'total_usage') ?? 0
      const remaining = totalCredits - totalUsage
      if (remaining <= 0) throw new Error('No credits remaining')
      return balance(remaining, { total: totalCredits, used: totalUsage, unit: 'USD', planName: 'OpenRouter' })
    }
    case 'novita': {
      // { availableBalance, ... } — amounts are in 0.0001 USD
      const body = await fetchJson('https://api.novita.ai/v3/user/balance', apiKey, timeoutSec, fetchImpl)
      const available = (parseF64Field(body, 'availableBalance') ?? 0) / 10000
      if (available <= 0) throw new Error('No balance remaining')
      return balance(available, { unit: 'USD', planName: 'Novita AI' })
    }
  }
}

/**
 * Run one provider's usage query. `fetchImpl` is injectable for tests.
 * Returns null-shaped `configured:false` decisions happen at the route layer;
 * this function only throws nothing — every failure becomes kind:'error'.
 */
export async function queryProviderUsage(row: CcProviderRow, fetchImpl: FetchLike = fetch): Promise<UsageResult> {
  const script = parseUsageScript(row)
  if (script === null) return { kind: 'error', error: 'no usage query configured' }

  let config: { apiKey: string; baseUrl: string }
  try {
    const parsed = JSON.parse(row.settingsConfig ?? '{}') as { env?: Record<string, unknown> }
    const env = parsed.env ?? {}
    const read = (key: string): string => (typeof env[key] === 'string' ? (env[key] as string) : '')
    config = { apiKey: read('ANTHROPIC_AUTH_TOKEN'), baseUrl: read('ANTHROPIC_BASE_URL') }
  } catch {
    config = { apiKey: '', baseUrl: '' }
  }

  if (script.templateType === 'token_plan' && script.codingPlanProvider === 'volcengine') {
    if (script.accessKeyId === undefined || script.secretAccessKey === undefined) return { kind: 'error', error: 'usage query is missing the Volcano AK/SK' }
    try {
      const usage = await queryArkPlanUsage(script.accessKeyId, script.secretAccessKey)
      return { kind: 'plan', windows: usage.windows, ...(usage.action !== undefined ? { action: usage.action } : {}) }
    } catch (cause) {
      return { kind: 'error', error: cause instanceof Error ? cause.message : String(cause) }
    }
  }

  if (script.templateType === 'token_plan' && script.codingPlanProvider === 'minimax') {
    const isCn = config.baseUrl.toLowerCase().includes('api.minimaxi.com')
    const host = isCn ? 'api.minimaxi.com' : 'api.minimax.io'
    const url = `https://${host}/v1/api/openplatform/coding_plan/remains`
    if (config.apiKey === '') return { kind: 'error', error: 'usage query is missing the provider API key' }
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(Math.max(1, script.timeoutSec) * 1000),
      })
      const text = await response.text()
      if (!response.ok) return { kind: 'error', error: `HTTP ${response.status}: ${text.slice(0, 200)}` }
      const body = JSON.parse(text) as unknown
      // Surface the MiniMax business error (e.g. 2062 "no active token plan subscription").
      if (body !== null && typeof body === 'object') {
        const baseResp = (body as Record<string, unknown>)['base_resp']
        if (baseResp !== null && typeof baseResp === 'object') {
          const statusCode = (baseResp as Record<string, unknown>)['status_code']
          const statusMsg = (baseResp as Record<string, unknown>)['status_msg']
          if (statusCode !== undefined && statusCode !== 0) {
            return { kind: 'error', error: `MiniMax error ${String(statusCode)}: ${typeof statusMsg === 'string' ? statusMsg : 'unknown'}` }
          }
        }
      }
      const windows = parseMinimaxPlan(body)
      if (windows === null) return { kind: 'error', error: 'usage response had no plan tiers' }
      return { kind: 'plan', windows }
    } catch (cause) {
      return { kind: 'error', error: cause instanceof Error ? cause.message : String(cause) }
    }
  }

  if (script.templateType === 'general' || script.templateType === 'newapi') {
    if (script.language !== 'javascript') return { kind: 'error', error: `unsupported usage script language: ${script.language}` }
    if (script.code.trim() === '') return { kind: 'error', error: 'usage script is empty' }
    const vars: Record<string, string> = {
      baseUrl: script.baseUrl ?? config.baseUrl,
      apiKey: config.apiKey,
      accessToken: script.accessToken ?? '',
      userId: script.userId ?? '',
    }
    const { request, extractor } = compileScript(script.code, script.timeoutSec)
    const substituted = substituteDeep(request, vars) as Record<string, unknown>
    return executeRequest(substituted, extractor, script.timeoutSec, fetchImpl)
  }

  if (script.templateType === 'balance') {
    const kind = detectBalanceProvider(config.baseUrl)
    if (kind === null) return { kind: 'error', error: `balance query does not recognize the provider endpoint: ${config.baseUrl}` }
    try {
      return await queryBuiltinBalance(kind, config.apiKey, script.timeoutSec, fetchImpl)
    } catch (cause) {
      return { kind: 'error', error: cause instanceof Error ? cause.message : String(cause) }
    }
  }

  return { kind: 'error', error: `unsupported usage template: ${script.templateType}` }
}
