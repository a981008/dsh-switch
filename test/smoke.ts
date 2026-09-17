/**
 * Smoke test for dsh-switch core logic (no cordis runtime needed):
 *  - cc-switch DB reading (providers, views, usage)
 *  - apply logic against mock settings/credentials services
 * Run: ELECTRON_RUN_AS_NODE=1 <electron> test/smoke.mjs (after esbuild transpiles test/entry)
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  withDb,
  listProviders,
  toProviderViews,
  findProvider,
  parseClaudeEnv,
  parseProviderConfig,
  parseUsageScript,
  parseCodexToml,
  resolveDbPath,
  type CcProviderRow,
} from '../src/ccswitch-db.ts'
import { dshRouteFor, envNameFor, readSyncState, writeSyncState, emptySyncState, planSync, signatureOf, keyHashOf, runSync, watchCcSwitchDb, type SyncState } from '../src/sync.ts'
import { detectBalanceProvider, parseMinimaxPlan, queryProviderUsage, queryBuiltinBalance, substitute, type FetchLike } from '../src/usage.ts'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.error(`FAIL  ${name} ${detail}`)
  }
}

// --- DB reading against the real (read-only) cc-switch database ---
const dbPath = resolveDbPath('')
console.log('db:', dbPath)
const rows = withDb(dbPath, (db) => listProviders(db))
check('providers listed', rows.length > 0, `got ${rows.length}`)
const claudeRows = rows.filter((r) => r.appType === 'claude')
check('claude providers exist', claudeRows.length > 0)
const currentRow = claudeRows.find((r) => r.isCurrent)
check('one current claude provider', currentRow !== undefined)

const views = toProviderViews(rows)
const currentView = views.find((v) => v.id === currentRow?.id)
check('view exposes baseUrl', (currentView?.baseUrl ?? '').startsWith('https://'), currentView?.baseUrl)
check('view exposes models', (currentView?.models.length ?? 0) > 0, JSON.stringify(currentView?.models))
check('view exposes tokenTail only', typeof currentView?.tokenTail === 'string' && currentView.tokenTail.length === 4)
const realToken = (() => {
  try { return JSON.parse(currentRow.settingsConfig)?.env?.ANTHROPIC_AUTH_TOKEN ?? '' } catch { return '' }
})()
check('view never exposes the token', realToken === '' || !JSON.stringify(views).includes(realToken))

const found = withDb(dbPath, (db) => findProvider(db, currentRow.id, 'claude'))
check('findProvider by id+appType', found !== undefined && found.id === currentRow.id)
const missing = withDb(dbPath, (db) => findProvider(db, 'no-such-id'))
check('findProvider missing → undefined', missing === undefined)

// --- parse edge cases ---
const parsed = parseClaudeEnv(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://x.example', ANTHROPIC_AUTH_TOKEN: 'sk-test', ANTHROPIC_DEFAULT_SONNET_MODEL: 'm1[1M]', ANTHROPIC_MODEL: 'm2' } }))
check('[1M] marker stripped', parsed?.models.join(',') === 'm2,m1', parsed?.models.join(','))
check('token from AUTH_TOKEN', parsed?.token === 'sk-test')
check('parse junk → null', parseClaudeEnv('not json') === null)

// --- sync engine against mock services ---
const tmp = mkdtempSync(join(tmpdir(), 'dsh-switch-test-'))
process.env['HOME'] = tmp // redirect the state file writes into the temp home

// Multi-type parsing fixtures (pure functions, no DB needed).
function fakeRow(overrides: Partial<CcProviderRow>): CcProviderRow {
  return { id: '00000000-0000-0000-0000-000000000000', appType: 'claude', name: 'x', category: null, isCurrent: false, websiteUrl: null, settingsConfig: '{}', ...overrides }
}
const claudeParsed = parseProviderConfig(fakeRow({ settingsConfig: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://a.example', ANTHROPIC_AUTH_TOKEN: 'sk-a', ANTHROPIC_MODEL: 'm-a' } }) }))
check('parse claude → anthropic-messages', claudeParsed.kind === 'ok' && claudeParsed.config.api === 'anthropic-messages' && claudeParsed.config.apiKey === 'sk-a' && claudeParsed.config.models[0] === 'm-a', JSON.stringify(claudeParsed))

const codexRow = fakeRow({
  appType: 'codex',
  settingsConfig: JSON.stringify({
    auth: { OPENAI_API_KEY: 'sk-oa' },
    config: 'model = "gpt-5.2"\nmodel_provider = "custom"\n\n[model_providers.custom]\nbase_url = "https://relay.example/v1"\nwire_api = "responses"\n',
  }),
})
const codexParsed = parseProviderConfig(codexRow)
check('parse codex → openai-responses', codexParsed.kind === 'ok' && codexParsed.config.api === 'openai-responses' && codexParsed.config.baseUrl === 'https://relay.example/v1' && codexParsed.config.models[0] === 'gpt-5.2', JSON.stringify(codexParsed))
const codexChat = parseProviderConfig(fakeRow({ appType: 'codex', settingsConfig: JSON.stringify({ auth: { OPENAI_API_KEY: 'k' }, config: 'model = "m"\n[model_providers.p]\nbase_url = "https://x/v1"\nwire_api = "chat"' }) }))
check('parse codex wire_api=chat → openai-completions', codexChat.kind === 'ok' && codexChat.config.api === 'openai-completions')
const codexOAuth = parseProviderConfig(fakeRow({ appType: 'codex', settingsConfig: '{"auth":{},"config":""}' }))
check('parse codex OAuth → skipped with reason', codexOAuth.kind === 'skip' && codexOAuth.reason.length > 0)
const tomlDirect = parseCodexToml('model = "m2"\n[model_providers.fallback]\nbase_url = "https://fb/v1"\nwire_api = "chat"')
check('codex toml without model_provider → first section', tomlDirect.section.baseUrl === 'https://fb/v1' && tomlDirect.model === 'm2')

const geminiRelay = parseProviderConfig(fakeRow({ appType: 'gemini', settingsConfig: JSON.stringify({ env: { GEMINI_API_KEY: 'g-key', GOOGLE_GEMINI_BASE_URL: 'https://relay.example', GEMINI_MODEL: 'gemini-3-pro' } }) }))
check('parse gemini relay → openai-completions', geminiRelay.kind === 'ok' && geminiRelay.config.api === 'openai-completions' && geminiRelay.config.models[0] === 'gemini-3-pro')
const geminiNative = parseProviderConfig(fakeRow({ appType: 'gemini', settingsConfig: JSON.stringify({ env: { GEMINI_API_KEY: 'g-key' } }) }))
check('parse gemini native → skipped', geminiNative.kind === 'skip' && geminiNative.reason.length > 0)

const openclawRow = fakeRow({
  appType: 'openclaw',
  settingsConfig: JSON.stringify({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions', models: [{ id: 'glm-5', name: 'GLM-5' }], apiKey: 'zk-live' }),
})
const openclawParsed = parseProviderConfig(openclawRow)
check('parse openclaw dsh-shaped → ok', openclawParsed.kind === 'ok' && openclawParsed.config.api === 'openai-completions' && openclawParsed.config.models[0] === 'glm-5')
const openclawNoKey = parseProviderConfig(fakeRow({ appType: 'openclaw', settingsConfig: JSON.stringify({ baseUrl: 'https://x', api: 'openai-completions', models: [{ id: 'm' }] }) }))
check('parse openclaw without key → skipped', openclawNoKey.kind === 'skip')
check('parse opencode → skipped', parseProviderConfig(fakeRow({ appType: 'opencode', settingsConfig: '{}' })).kind === 'skip')

// usage_script meta parsing (cc-switch stores per-provider usage query config)
function metaRow(meta: unknown, overrides: Partial<CcProviderRow> = {}): CcProviderRow {
  return fakeRow({ meta: JSON.stringify(meta), ...overrides })
}
check('usage_script: volcengine token_plan → credentials', (() => {
  const script = parseUsageScript(metaRow({ usage_script: { enabled: true, templateType: 'token_plan', codingPlanProvider: 'volcengine', accessKeyId: 'AKTEST', secretAccessKey: 'SKTEST' } }))
  return script !== null && script.templateType === 'token_plan' && script.accessKeyId === 'AKTEST'
})())
check('usage_script: disabled → null', parseUsageScript(metaRow({ usage_script: { enabled: false, templateType: 'token_plan' } })) === null)
check('usage_script: minimax token_plan parsed', parseUsageScript(metaRow({ usage_script: { enabled: true, templateType: 'token_plan', codingPlanProvider: 'minimax' } }))?.templateType === 'token_plan')
check('usage_script: general/newapi parsed but type-tagged', parseUsageScript(metaRow({ usage_script: { enabled: true, templateType: 'general' } }))?.templateType === 'general' && parseUsageScript(metaRow({ usage_script: { enabled: true, templateType: 'newapi' } }))?.templateType === 'newapi')
check('usage_script: junk meta → null', parseUsageScript(fakeRow({ meta: 'not-json' })) === null && parseUsageScript(fakeRow({ meta: undefined })) === null)

// planSync diff behavior with mock settings
const state: SyncState = emptySyncState()
const mockSettings: { get(ns: string): unknown; update(ns: string, patch: unknown): Promise<void>; mutate?(ns: string, ops: unknown[]): Promise<void> } = {
  get(ns) {
    if (ns === 'llm-pi-ai') return { providers: {} }
    return undefined
  },
  async update() {},
}
const planRows = [codexRow, fakeRow({ id: '11111111-1111-1111-1111-111111111111', name: 'Relay A', settingsConfig: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://a', ANTHROPIC_AUTH_TOKEN: 'k1', ANTHROPIC_MODEL: 'm-a1' } }) })]
const plan2 = planSync(planRows, state, mockSettings)
check('planSync: claude + codex planned', plan2.items.length === 2 && plan2.items.every((item) => /^ccs-[a-z0-9]{1,8}$/.test(item.route)), JSON.stringify(plan2.items.map((i) => i.route)))
check('planSync: env names unique', new Set(plan2.items.map((i) => i.envName)).size === plan2.items.length)
const colliding = planSync([
  fakeRow({ id: '22222222-2222-2222-2222-222222222222', name: 'Same', settingsConfig: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://a', ANTHROPIC_AUTH_TOKEN: 'k1', ANTHROPIC_MODEL: 'm1' } }) }),
  fakeRow({ id: '33333333-3333-3333-3333-333333333333', name: 'same', settingsConfig: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://b', ANTHROPIC_AUTH_TOKEN: 'k2', ANTHROPIC_MODEL: 'm2' } }) }),
], state, mockSettings)
check('planSync: name collision → unique route-based refs', new Set(colliding.items.map((i) => i.envName)).size === 2, JSON.stringify(colliding.items.map((i) => i.envName)))
check('planSync: signature stable', signatureOf(planRows) === signatureOf([...planRows].reverse()))
check('planSync: signature sensitive', signatureOf(planRows) !== signatureOf(planRows.map((r) => (r.id === '11111111-1111-1111-1111-111111111111' ? { ...r, name: 'renamed' } : r))))
check('keyHashOf stable + sensitive', keyHashOf('a') === keyHashOf('a') && keyHashOf('a') !== keyHashOf('b'))

// env name generation edge cases
check('envNameFor cjk name → fallback', /^CCS_[A-Z0-9_]+_API_KEY$/.test(envNameFor('火山Agentplan', '99999999-9999-9999-9999-999999999999')), envNameFor('火山Agentplan', '99999999-9999-9999-9999-999999999999'))
check('envNameFor ascii name', envNameFor('DeepSeek', 'x') === 'CCS_DEEPSEEK_API_KEY')
check('route naming stable', dshRouteFor('29939f1e-8be1-444f-9f93-2b6133201e5b') === 'ccs-29939f1e')

// runSync end-to-end against mock services — the settings mock is a real
// in-memory store (get reads what mutate/update wrote) so the live-settings
// reconciliation is exercised.
process.env['HOME'] = tmp
let writtenOps: Array<Record<string, unknown>> = []
const updates: Array<{ ns: string; patch: unknown }> = []
const credSets: Array<{ ref: string; value: string }> = []
const credStore = new Map<string, string>()
const nsStore = new Map<string, Record<string, unknown>>()
function mergePatch(section: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...section }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && section[key] !== null && typeof section[key] === 'object' && !Array.isArray(section[key])) {
      merged[key] = mergePatch(section[key] as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      merged[key] = value
    }
  }
  return merged
}
const runSettings = {
  get(ns: string) {
    return nsStore.get(ns)
  },
  async update(ns: string, patch: unknown) {
    updates.push({ ns, patch })
    nsStore.set(ns, mergePatch(nsStore.get(ns) ?? {}, patch as Record<string, unknown>))
  },
  async mutate(ns: string, ops: Array<Record<string, unknown>>) {
    if (ns !== 'llm-pi-ai') return
    writtenOps.push(...ops)
    let section = { ...(nsStore.get(ns) ?? {}) }
    let providers = { ...((section['providers'] as Record<string, unknown>) ?? {}) }
    for (const op of ops) {
      if (op.op === 'set' && Array.isArray(op.path) && op.path[0] === 'providers' && typeof op.path[1] === 'string') {
        providers[op.path[1]] = op.value
      } else if (op.op === 'unset' && Array.isArray(op.path) && op.path[0] === 'providers' && typeof op.path[1] === 'string') {
        delete providers[op.path[1]]
      }
    }
    section = { ...section, providers }
    nsStore.set(ns, section)
  },
}
const runCreds = {
  async set(ref: string, value: string) { credSets.push({ ref, value }); credStore.set(ref, value) },
  async unset(ref: string) { credStore.delete(ref) },
}
const deps = { dbPath: () => 'unused-in-mock', enabled: () => true, settings: () => runSettings, credentials: () => runCreds }

// runSync reads rows from the DB — use the real cc-switch DB via deps.dbPath
const realDbPath = resolveDbPath('')
const liveDeps = { dbPath: () => realDbPath, enabled: () => true, settings: () => runSettings, credentials: () => runCreds }
const first = await runSync(liveDeps, { force: true })
check('runSync first pass ok', first.ok === true && first.applied.length > 0, JSON.stringify(first).slice(0, 200))
check('runSync wrote llm-pi-ai mutate sets', writtenOps.filter((op) => op.op === 'set').length === first.applied.length)
check('runSync set credentials', credSets.length > 0 && credSets.every((c) => /^CCS_[A-Z0-9_]+_API_KEY$/.test(c.ref)))
check('runSync recorded signature', readSyncState().signature === signatureOf(withDb(realDbPath, (db) => listProviders(db))))
check('runSync currents tracked', Object.keys(readSyncState().currents).length > 0, JSON.stringify(readSyncState().currents))

const second = await runSync(liveDeps, { force: false })
check('runSync unchanged → no-op', second.ok === true && second.changed === false && second.applied.length === 0)
const opsAfterSecond = writtenOps.length
const third = await runSync(liveDeps, { force: true })
check('runSync forced no-change → no writes', third.ok === true && writtenOps.length === opsAfterSecond, `${opsAfterSecond} → ${writtenOps.length}`)

// Self-healing: an externally lost settings entry is repaired on the next
// tick WITHOUT force and WITHOUT any cc-switch change (signature unchanged).
{
  const managedRoutes = Object.keys(readSyncState().managed)
  const victim = managedRoutes[0]
  const providers = ((nsStore.get('llm-pi-ai') ?? {})['providers'] ?? {}) as Record<string, unknown>
  delete providers[victim]
  nsStore.set('llm-pi-ai', { providers })
  const repair = await runSync(liveDeps, { force: false })
  check('runSync self-heal: lost entry repaired on plain tick', repair.ok === true && repair.applied.includes(victim), JSON.stringify({ applied: repair.applied, err: repair.error }))
  check('runSync self-heal: settings store has the entry again', ((nsStore.get('llm-pi-ai') ?? {})['providers'] as Record<string, unknown>)[victim] !== undefined)
  check('runSync self-heal: credential re-stamped', credStore.has(readSyncState().managed[victim]?.envName ?? '___'))
  const afterRepair = await runSync(liveDeps, { force: false })
  check('runSync self-heal: repaired state is stable (no write loop)', afterRepair.changed === false && afterRepair.applied.length === 0, JSON.stringify(afterRepair))

  // Orphan cleanup: a ccs-* route in settings that the plan does not cover goes away.
  const providers2 = ((nsStore.get('llm-pi-ai') ?? {})['providers'] ?? {}) as Record<string, unknown>
  providers2['ccs-deadbee'] = { displayName: 'Ghost', api: 'anthropic-messages', baseURL: 'https://ghost', models: [{ id: 'g', name: 'g' }], apiKeyEnv: 'CCS_GHOST_API_KEY' }
  nsStore.set('llm-pi-ai', { providers: providers2 })
  const cleanup = await runSync(liveDeps, { force: false })
  check('runSync orphan cleanup: unknown ccs-* route removed', cleanup.removed.includes('ccs-deadbee') && ((nsStore.get('llm-pi-ai') ?? {})['providers'] as Record<string, unknown>)['ccs-deadbee'] === undefined, JSON.stringify(cleanup.removed))
}

// state file roundtrip (v2)
const st = readSyncState()
st.managed['ccs-test'] = { ccSwitchId: 'x', appType: 'claude', name: 'T', envName: 'CCS_T_API_KEY', model: 'm', keyHash: 'h', entry: { displayName: 'T', api: 'anthropic-messages', baseURL: 'https://t', models: [{ id: 'm', name: 'm' }] }, syncedAt: new Date().toISOString() }
writeSyncState(st)
check('sync state roundtrip', readSyncState().managed['ccs-test']?.ccSwitchId === 'x')

// ── usage engine ──────────────────────────────────────────────────────────────
{
  const rowWith = (meta: Record<string, unknown>, env: Record<string, string> = {}): Parameters<typeof queryProviderUsage>[0] => ({
    id: 'test-id',
    appType: 'claude',
    name: 'Test',
    isCurrent: false,
    settingsConfig: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-live', ANTHROPIC_BASE_URL: 'https://relay.example', ...env } }),
    meta: JSON.stringify(meta),
  })

  // placeholder substitution
  check('usage substitute', substitute('B={{baseUrl}} K={{apiKey}} A={{accessToken}} U={{userId}} X={{nope}}', { baseUrl: 'https://b', apiKey: 'k', accessToken: 'a' }) === 'B=https://b K=k A=a U= X={{nope}}')

  // MiniMax plan parsing (general tier; weekly only when status===1)
  const minimaxBody = {
    base_resp: { status_code: 0 },
    model_remains: [
      { model_name: 'video', current_interval_remaining_percent: 10 },
      { model_name: 'general', current_interval_remaining_percent: 80.25, end_time: 1758150000000, current_weekly_status: 1, current_weekly_remaining_percent: 55.5, weekly_end_time: 1758200000000 },
    ],
  }
  const minimaxWindows = parseMinimaxPlan(minimaxBody)
  check('usage minimax plan windows', minimaxWindows !== null && minimaxWindows['fiveHour']?.percent === 19.75 && minimaxWindows['weekly']?.percent === 44.5 && minimaxWindows['fiveHour']?.resetsAt !== null)
  check('usage minimax weekly disabled', parseMinimaxPlan({ model_remains: [{ model_name: 'general', current_interval_remaining_percent: 50, current_weekly_status: 3 }] })?.['weekly'] === undefined)
  check('usage minimax base_resp error', parseMinimaxPlan({ base_resp: { status_code: 1004 } }) === null)

  // general script end-to-end with injected fetch
  const generalScript = `({
    request: {
      url: "{{baseUrl}}/user/balance",
      method: "GET",
      headers: { "Authorization": "Bearer {{apiKey}}", "User-Agent": "cc-switch/1.0" }
    },
    extractor: function(response) {
      return { isValid: response.is_active || true, remaining: response.balance, unit: "USD" };
    }
  })`
  let seenUrl = ''
  let seenHeaders: Record<string, string> = {}
  const fakeFetch: FetchLike = async (url, init) => {
    seenUrl = url
    seenHeaders = init.headers
    return { ok: true, status: 200, text: async () => JSON.stringify({ is_active: true, balance: 12.34 }) }
  }
  const generalResult = await queryProviderUsage(rowWith({ usage_script: { enabled: true, templateType: 'general', language: 'javascript', code: generalScript, timeout: 10, autoQueryInterval: 5 } }), fakeFetch)
  check('usage general url+headers substituted', seenUrl === 'https://relay.example/user/balance' && seenHeaders['Authorization'] === 'Bearer sk-live')
  check('usage general balance result', generalResult.kind === 'balance' && generalResult.remaining === 12.34 && generalResult.unit === 'USD')

  // newapi script: invalid account path + accessToken/userId from script config
  const newapiScript = `({
    request: { url: "{{baseUrl}}/api/user/self", method: "GET", headers: { "Authorization": "Bearer {{accessToken}}", "New-Api-User": "{{userId}}" } },
    extractor: function (response) {
      if (response.success && response.data) return { planName: response.data.group, remaining: response.data.quota / 500000, unit: "USD" };
      return { isValid: false, invalidMessage: response.message || "查询失败" };
    },
  })`
  const newapiResult = await queryProviderUsage(rowWith({ usage_script: { enabled: true, templateType: 'newapi', language: 'javascript', code: newapiScript, timeout: 10, autoQueryInterval: 5, baseUrl: 'https://muy.example/', accessToken: 'at-1', userId: '42' } }), async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: false, message: '无权进行此操作' }) }))
  check('usage newapi invalid path', newapiResult.kind === 'error' && newapiResult.error === '无权进行此操作')

  const newapiOk = await queryProviderUsage(rowWith({ usage_script: { enabled: true, templateType: 'newapi', language: 'javascript', code: newapiScript, timeout: 10, autoQueryInterval: 5, baseUrl: 'https://muy.example/', accessToken: 'at-1', userId: '42' } }), async (_url, init) => {
    check('usage newapi headers', init.headers['Authorization'] === 'Bearer at-1' && init.headers['New-Api-User'] === '42')
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: { group: 'vip', quota: 2_500_000, used_quota: 500_000 } }) }
  })
  check('usage newapi balance', newapiOk.kind === 'balance' && newapiOk.remaining === 5 && newapiOk.planName === 'vip')

  // script sandbox: no host globals, vm timeout on infinite extractor
  const evilScript = `({ request: { url: "{{baseUrl}}/x", method: "GET", headers: {} }, extractor: function () { while (true) {} } })`
  const evilResult = await queryProviderUsage(rowWith({ usage_script: { enabled: true, templateType: 'general', language: 'javascript', code: evilScript, timeout: 1, autoQueryInterval: 5 } }), fakeFetch)
  check('usage extractor sandbox timeout', evilResult.kind === 'error')

  const processScript = `({ request: { url: "{{baseUrl}}/x", method: "GET", headers: {} }, extractor: function () { return { remaining: typeof process === 'undefined' ? 1 : -1, unit: "sandboxed" } } })`
  const sandboxResult = await queryProviderUsage(rowWith({ usage_script: { enabled: true, templateType: 'general', language: 'javascript', code: processScript, timeout: 1, autoQueryInterval: 5 } }), fakeFetch)
  check('usage extractor sandbox has no process', sandboxResult.kind === 'balance' && sandboxResult.remaining === 1)

  // volcengine token_plan without AK → clear error; minimax without key → error
  const noAk = await queryProviderUsage(rowWith({ usage_script: { enabled: true, templateType: 'token_plan', codingPlanProvider: 'volcengine' } }))
  check('usage volcengine missing ak', noAk.kind === 'error' && noAk.error.includes('AK/SK'))
  const noKey = await queryProviderUsage(rowWith({ usage_script: { enabled: true, templateType: 'token_plan', codingPlanProvider: 'minimax' } }, { ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: 'https://api.minimaxi.com' }))
  check('usage minimax missing key', noKey.kind === 'error')

  // no usage query at all
  const none = await queryProviderUsage(rowWith({}))
  check('usage none configured', none.kind === 'error')

  // ── built-in balance templates (DeepSeek etc.) ──
  check('balance detect: deepseek', detectBalanceProvider('https://api.deepseek.com/anthropic') === 'deepseek')
  check('balance detect: variants', detectBalanceProvider('https://api.siliconflow.com/v1') === 'siliconflow-en' && detectBalanceProvider('https://openrouter.ai/api/v1') === 'openrouter' && detectBalanceProvider('https://example.com') === null)

  // DeepSeek: balance_infos with string amounts, is_available false → error
  const deepseekResult = await queryBuiltinBalance('deepseek', 'sk-ds', 10, async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.50' }, { currency: 'USD', total_balance: '8.00' }] }) }))
  check('balance deepseek parse', deepseekResult.kind === 'balance' && deepseekResult.remaining === 110.5 && deepseekResult.unit === 'CNY' && deepseekResult.extra === 'USD 8')
  const deepseekUnavailable = await queryBuiltinBalance('deepseek', 'sk-ds', 10, async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] }) })).then((value) => value).catch((cause: unknown) => ({ kind: 'error' as const, error: cause instanceof Error ? cause.message : String(cause) }))
  check('balance deepseek unavailable → error', deepseekUnavailable.kind === 'error' && deepseekUnavailable.error === 'Insufficient balance')

  // auth failure path (shared fetchJson)
  const authFail = await queryBuiltinBalance('stepfun', 'sk-bad', 10, async () => ({ ok: false, status: 401, text: async () => '{"error":"auth"}' })).then((value) => value).catch((cause: unknown) => ({ kind: 'error' as const, error: cause instanceof Error ? cause.message : String(cause) }))
  check('balance auth 401 → error', authFail.kind === 'error' && authFail.error.includes('Authentication failed'))

  // OpenRouter: credits − usage; zero → error
  const openrouterResult = await queryBuiltinBalance('openrouter', 'sk-or', 10, async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: { total_credits: 10.25, total_usage: 4.05 } }) }))
  check('balance openrouter math', openrouterResult.kind === 'balance' && openrouterResult.remaining === 6.2 && openrouterResult.total === 10.25 && openrouterResult.used === 4.05 && openrouterResult.unit === 'USD')

  // end-to-end via queryProviderUsage with the real DeepSeek row shape
  const deepseekE2E = await queryProviderUsage(rowWith({ usage_script: { enabled: true, templateType: 'balance', language: 'javascript', code: '', timeout: 10, autoQueryInterval: 5 } }, { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }), async (url) => {
    check('balance e2e hits deepseek endpoint', url === 'https://api.deepseek.com/user/balance')
    return { ok: true, status: 200, text: async () => JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '42.00' }] }) }
  })
  check('balance template end-to-end', deepseekE2E.kind === 'balance' && deepseekE2E.remaining === 42 && deepseekE2E.planName === 'CNY', JSON.stringify(deepseekE2E).slice(0, 120))

  // balance template with unrecognized base_url → clear error
  const unknownBalance = await queryProviderUsage(rowWith({ usage_script: { enabled: true, templateType: 'balance', language: 'javascript', code: '', timeout: 10, autoQueryInterval: 5 } }, { ANTHROPIC_BASE_URL: 'https://relay.example' }), async () => ({ ok: true, status: 200, text: async () => '{}' }))
  check('balance unknown endpoint → error', unknownBalance.kind === 'error' && unknownBalance.error.includes('does not recognize'))
}

// File watcher: db/wal writes trigger the callback (debounced), unrelated files do not.
{
  const { writeFileSync: touch } = await import('node:fs')
  const watchDir = mkdtempSync(join(tmpdir(), 'dsh-switch-watch-'))
  const dbFile = join(watchDir, 'cc-switch.db')
  writeFileSync(dbFile, 'x')
  let calls = 0
  const dispose = watchCcSwitchDb(dbFile, () => { calls += 1 })
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  writeFileSync(dbFile, 'y') // main db write
  await sleep(1200)
  check('watcher: db write triggers callback', calls >= 1, `calls=${calls}`)
  writeFileSync(join(watchDir, 'cc-switch.db-wal'), 'w') // WAL write
  await sleep(1200)
  check('watcher: wal write triggers callback', calls >= 2, `calls=${calls}`)
  const before = calls
  writeFileSync(join(watchDir, 'settings.json'), '{}') // unrelated file
  await sleep(500)
  check('watcher: unrelated file ignored', calls === before, `calls=${before} → ${calls}`)
  dispose()
  const afterDispose = calls
  writeFileSync(dbFile, 'z')
  await sleep(600)
  check('watcher: disposed stops callbacks', calls === afterDispose, `calls=${afterDispose} → ${calls}`)
}

// Regression: empty dbPath config must resolve to ~/.cc-switch/cc-switch.db.
// (The old bug passed '' straight to SQLite, which opens a private temporary
// database → "no such table: providers". DEFAULT_DB_PATH is fixed at module
// load (before the HOME redirect), so this runs against the real cc-switch
// database; the assertion is about path resolution, not content.)
{
  const emptyPathDeps = { dbPath: () => '', enabled: () => true, settings: () => runSettings, credentials: () => runCreds }
  const outcome = await runSync(emptyPathDeps, { force: true })
  check('runSync empty dbPath → default db resolved (no "no such table")', outcome.ok === true && outcome.error === undefined, JSON.stringify({ err: outcome.error, applied: outcome.applied.length }))
  writeSyncState(emptySyncState()) // clean up so later checks see a pristine state
}

// --- Volcano Ark plan: signing + parsing ---
import { volcengineAuthorization, parseVolcenginePlanUsage, queryArkPlanUsage } from '../src/ark-plan.ts'

const SIGN_INPUT = { accessKeyId: 'AKTPAAAAAAAAAAAA', secretAccessKey: 'sk-test-secret', datetime: '20260917T120000Z' }
const signed = volcengineAuthorization(SIGN_INPUT)
check('sign: X-Date passthrough', signed['X-Date'] === '20260917T120000Z')
check('sign: X-Content-Sha256 of empty body', signed['X-Content-Sha256'] === createHash('sha256').update('').digest('hex'))
check('sign: authorization shape', /^HMAC-SHA256 Credential=AKTPAAAAAAAAAAAA\/20260917\/cn-beijing\/ark\/request, SignedHeaders=host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/.test(signed.Authorization), signed.Authorization)
check('sign: deterministic', volcengineAuthorization(SIGN_INPUT).Authorization === signed.Authorization)
check('sign: sensitive to secret', volcengineAuthorization({ ...SIGN_INPUT, secretAccessKey: 'other' }).Authorization !== signed.Authorization)
check('sign: sensitive to action', volcengineAuthorization({ ...SIGN_INPUT, query: { Action: 'A', Version: 'v' } }).Authorization !== volcengineAuthorization({ ...SIGN_INPUT, query: { Action: 'B', Version: 'v' } }).Authorization)

// Equivalence with the installed dsh-cost-meter implementation (when present).
// coding-plans.js re-exports custom-balance.js (which needs the host-only
// @deepseek-ai/dsh-credentials package), so copy coding-plans.js + net.js into
// a sandbox, drop that one re-export line, and import the pristine copy.
try {
  const cmLib = '/Users/wang/.dsh/profiles/desktop/node_modules/dsh-cost-meter/lib'
  const cmSandbox = join(tmp, 'cm')
  mkdirSync(cmSandbox, { recursive: true })
  const source = readFileSync(join(cmLib, 'coding-plans.js'), 'utf8').split('\n').filter((line) => !line.startsWith('export { CUSTOM_BALANCE_ADAPTER_ID')).join('\n')
  writeFileSync(join(cmSandbox, 'coding-plans.js'), source)
  copyFileSync(join(cmLib, 'net.js'), join(cmSandbox, 'net.js'))
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ volcengineAuthorization: typeof volcengineAuthorization }>
  const cm = await dynamicImport(pathToFileURL(join(cmSandbox, 'coding-plans.js')).href)
  const cmSigned = cm.volcengineAuthorization({ accessKeyId: 'AKTEST', secretAccessKey: 'sktest', query: { Action: 'GetCodingPlanUsage', Version: '2024-01-01' }, datetime: '20260917T010203Z' })
  const mine = volcengineAuthorization({ accessKeyId: 'AKTEST', secretAccessKey: 'sktest', query: { Action: 'GetCodingPlanUsage', Version: '2024-01-01' }, datetime: '20260917T010203Z' })
  check('sign: byte-identical to dsh-cost-meter', cmSigned.Authorization === mine.Authorization && cmSigned['X-Date'] === mine['X-Date'], `${cmSigned.Authorization}\n${mine.Authorization}`)
} catch (cause) {
  console.log(`  --  dsh-cost-meter equivalence check skipped: ${cause instanceof Error ? cause.message : String(cause)}`)
}

// Parser: official CodingPlan form
const official = parseVolcenginePlanUsage({
  ResponseMetadata: { RequestId: 'x', Action: 'GetCodingPlanUsage', Version: '2024-01-01', Service: 'ark', Region: 'cn-beijing', Error: null },
  Result: {
    QuotaUsage: [
      { Level: 'session', Percent: 32, ResetTimestamp: 1766000000, Cap: 100 },
      { Level: 'weekly', Percent: 8, ResetTimestamp: null },
      { Level: 'monthly', Percent: 51.4, ResetTimestamp: 1767225600000 },
    ],
  },
})
check('parse: official QuotaUsage windows', official !== null && official['fiveHour']?.percent === 32 && official['weekly']?.percent === 8 && Math.abs((official['monthly']?.percent ?? 0) - 51.4) < 0.001, JSON.stringify(official))
check('parse: reset seconds→ISO', typeof official?.['fiveHour']?.resetsAt === 'string' && !Number.isNaN(Date.parse(official['fiveHour'].resetsAt)))

// Parser: UsageDetails form with used/total
const details = parseVolcenginePlanUsage({
  Result: { UsageDetails: [{ QuotaType: 'weekly', Total: 1000, Used: 250, Remaining: 750, ResetTime: '2026-09-22T00:00:00Z' }] },
})
check('parse: UsageDetails derived percent', details?.['weekly']?.percent === 25, JSON.stringify(details))

// Parser: flat windows
const flat = parseVolcenginePlanUsage({ fiveHour: { percent: 10 }, monthly: { percent: 90 } })
check('parse: flat windows', flat?.['fiveHour']?.percent === 10 && flat?.['monthly']?.percent === 90)

// Parser: rejects junk
check('parse: junk → null', parseVolcenginePlanUsage({ hello: 'world' }) === null && parseVolcenginePlanUsage(null) === null && parseVolcenginePlanUsage('x') === null)

// Live query path (network): only when creds are provided via env — skipped by default.
if (process.env['DSH_SWITCH_TEST_AK'] !== undefined && process.env['DSH_SWITCH_TEST_SK'] !== undefined) {
  try {
    const live = await queryArkPlanUsage(process.env['DSH_SWITCH_TEST_AK'], process.env['DSH_SWITCH_TEST_SK'], 10_000)
    check('live: plan windows fetched', Object.keys(live.windows).length > 0, JSON.stringify(live))
  } catch (cause) {
    check('live: plan query', false, cause instanceof Error ? cause.message : String(cause))
  }
} else {
  console.log('  --  set DSH_SWITCH_TEST_AK/SK to exercise the live Volcengine query')
}

rmSync(tmp, { recursive: true, force: true })

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
