/**
 * Integration test: load the built lib/index.js, simulate the cordis apply
 * with a fake ctx (webServer + settings + credentials), then drive the
 * registered route handlers with fake req/res objects.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Redirect the plugin's state-file writes into a temp home. The cc-switch DB
// path is passed explicitly via plugin config (the real DB lives under the
// real HOME).
const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-switch-it-'))
process.env['HOME'] = tmpHome
const REAL_DB = '/Users/wang/.cc-switch/cc-switch.db'

// Work on a consistent copy of the real database with every usage_script
// block stripped from the provider meta: cc-switch stores real Volcano IAM
// keys there, and the plan-route tests must never exercise them (a live
// query would leak quota numbers into test output and hit the API).
const SCRUBBED_DB = join(tmpHome, 'cc-switch-scrubbed.db')
{
  const { DatabaseSync } = await import('node:sqlite')
  const source = new DatabaseSync(REAL_DB, { readOnly: true })
  try {
    source.exec(`VACUUM INTO '${SCRUBBED_DB}'`)
  } catch {
    source.close()
    copyFileSync(REAL_DB, SCRUBBED_DB)
  }
  if (source.open) source.close()
  const db = new DatabaseSync(SCRUBBED_DB)
  const rows = db.prepare('SELECT id, app_type, meta FROM providers').all()
  const update = db.prepare('UPDATE providers SET meta = ? WHERE id = ? AND app_type = ?')
  let scrubbed = 0
  for (const row of rows) {
    if (row.meta === null || row.meta === '') continue
    try {
      const meta = JSON.parse(row.meta)
      if (meta.usage_script === undefined) continue
      delete meta.usage_script
      update.run(JSON.stringify(meta), row.id, row.app_type)
      scrubbed += 1
    } catch { /* leave malformed meta untouched */ }
  }
  db.close()
  console.log(`  --  scrubbed usage_script from ${scrubbed} provider(s) in the test DB copy`)
}
const PLUGIN_DB = SCRUBBED_DB

const mod = await import('../lib/index.js')

let failures = 0
/** Poll a condition so a background sync settling cannot race the assertions. */
async function waitFor(cond, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try { if (cond()) return true } catch { /* keep polling */ }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.error(`FAIL  ${name} ${detail}`)
  }
}

const registered = []
const settingsCalls = []
const credentialCalls = []
const credentialStore = new Map()
// Small in-memory settings store: update() merges like the real service;
// mutate() applies path ops like the real service.
const nsStore = new Map()
function deepMerge(prev, patch) {
  const merged = { ...prev }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && prev[key] !== null && typeof prev[key] === 'object' && !Array.isArray(prev[key])) {
      merged[key] = deepMerge(prev[key], value)
    } else {
      merged[key] = value
    }
  }
  return merged
}
const mockSettings = {
  get(ns) {
    return nsStore.get(ns)
  },
  async update(ns, patch) {
    settingsCalls.push({ ns, patch, mode: 'update' })
    nsStore.set(ns, deepMerge(nsStore.get(ns) ?? {}, patch))
  },
  async replace(ns, section) {
    settingsCalls.push({ ns, patch: section, mode: 'replace' })
    nsStore.set(ns, section)
  },
  async mutate(ns, ops) {
    settingsCalls.push({ ns, patch: ops, mode: 'mutate' })
    let section = { ...(nsStore.get(ns) ?? {}) }
    for (const op of ops) {
      const [head, ...rest] = op.path
      if (rest.length === 0) {
        if (op.op === 'set') section = { ...section, [head]: op.value }
        else {
          const { [head]: _removed, ...kept } = section
          section = kept
        }
      } else {
        const child = section[head] ?? {}
        const inner = { ...child }
        if (op.op === 'set') inner[rest[0]] = op.value
        else delete inner[rest[0]]
        section = { ...section, [head]: inner }
      }
    }
    nsStore.set(ns, section)
  },
}
const mockCredentials = {
  async set(ref, value) {
    credentialCalls.push({ ref, value })
    credentialStore.set(ref, value)
  },
  async unset(ref) {
    credentialStore.delete(ref)
  },
  async resolve(ref) {
    const value = credentialStore.get(ref)
    return value === undefined ? undefined : { value, source: 'memory' }
  },
  async describe(ref) {
    return { configured: credentialStore.has(ref), writable: true }
  },
}

/**
 * Stand-in for `ctx.llm`: only the first cc-switch route is "registered", so
 * /state must report routable:true for it and routable:false for the rest.
 */
let llmLive = true
const mockLlm = {
  listProviders: () => (llmLive ? [{ id: 'ccs-29939f1e', name: '火山' }] : []),
  listModels: async (provider: string) => (provider === 'ccs-29939f1e' ? [{ id: 'a' }, { id: 'b' }] : []),
}

const emitted: string[] = []
const ctx = {
  webServer: { register: (route) => { registered.push(route); return () => {} } },
  inject: (deps, cb) => { cb({ settings: mockSettings, credentials: mockCredentials, llm: mockLlm }) },
  effect: (fn, label) => { fn(); return () => {} },
  emit: (event) => { emitted.push(event) },
}

mod.apply(ctx, { dbPath: PLUGIN_DB })
check('three routes registered', registered.length === 3, JSON.stringify(registered.map((r) => r.path)))
check('route paths', registered.map((r) => r.path).join(',') === '/api/cc-switch/state,/api/cc-switch/usage,/api/cc-switch/sync')

const route = (path) => registered.find((r) => r.path === path)

function fakeReq({ method = 'GET', url = '/', headers = {} } = {}) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {},
  }
}

function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: '', ended: false }
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers ?? {} }
  res.end = (payload) => { res.ended = true; res.body = payload ?? '' }
  return res
}

const BROWSER_HEADERS = {
  origin: 'http://127.0.0.1:43110',
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
}

// 1. state with browser headers
{
  const res = fakeRes()
  await route('/api/cc-switch/state').handler(fakeReq({ url: '/api/cc-switch/state', headers: BROWSER_HEADERS }), res)
  const body = JSON.parse(res.body)
  check('state 200', res.statusCode === 200, String(res.statusCode))
  check('state ok + cc-switch available', body.ok === true && body.ccSwitch.available === true, JSON.stringify(body).slice(0, 200))
  check('state providers listed', body.ccSwitch.providers.length > 0)
  check('state has sync fields', body.sync !== undefined && Array.isArray(body.sync.managedRoutes) && 'lastSyncAt' in body.sync)
  check('state has dsh default field', body.dsh !== undefined && 'defaultModel' in body.dsh)
  check('state never leaks settings_config', !res.body.includes('ANTHROPIC_AUTH_TOKEN'))
  check('state exposes per-provider usageConfigured flag', body.ccSwitch.providers.every((p) => typeof p.usageConfigured === 'boolean'), JSON.stringify(body.ccSwitch.providers.map((p) => [p.name, p.usageConfigured])))
  const live = body.ccSwitch.providers.find((p) => p.route === 'ccs-29939f1e')
  const other = body.ccSwitch.providers.find((p) => p.route !== 'ccs-29939f1e' && p.status === 'synced')
  check('state reports a route as live in DSH', live?.routable === true && live?.liveModels === 2, JSON.stringify(live))
  check('state reports an unregistered route as not live', other === undefined || other.routable === false, JSON.stringify(other))
  check('state lists routable routes', Array.isArray(body.dsh.routableRoutes) && body.dsh.routableRoutes.includes('ccs-29939f1e'), JSON.stringify(body.dsh.routableRoutes))
}

// 1b. llm service unreachable → the fields are omitted, never wrong
{
  llmLive = false
  const res = fakeRes()
  await route('/api/cc-switch/state').handler(fakeReq({ url: '/api/cc-switch/state', headers: BROWSER_HEADERS }), res)
  const body = JSON.parse(res.body)
  const anyProvider = body.ccSwitch.providers.find((p) => p.status === 'synced')
  check('state reports routable:false when DSH serves nothing', anyProvider === undefined || (anyProvider.routable === false && anyProvider.liveModels === 0), JSON.stringify(anyProvider))
  llmLive = true
}

// 2. bare curl → 403
{
  const res = fakeRes()
  await route('/api/cc-switch/state').handler(fakeReq(), res)
  check('state bare request 403', res.statusCode === 403, String(res.statusCode))
}

// 3. sync through the route (mock services behind it) — mirrors every usable provider
// The plugin's own boot sync works now (it used to reject silently), so let it
// settle and then clear the document: this block is about what the route does.
{
  await waitFor(() => Object.keys(nsStore.get('llm-pi-ai')?.providers ?? {}).length > 0)
  nsStore.clear()
  settingsCalls.length = 0
  credentialCalls.length = 0
  emitted.length = 0
  const res = fakeRes()
  await route('/api/cc-switch/sync').handler(
    fakeReq({ method: 'POST', url: '/api/cc-switch/sync', headers: BROWSER_HEADERS }),
    res,
  )
  const body = JSON.parse(res.body)
  check('sync 200 ok', res.statusCode === 200 && body.ok === true, res.body.slice(0, 200))
  check('sync applied claude providers', body.applied.length >= 1, JSON.stringify(body.applied))
  check('sync used llm-pi-ai mutate sets', settingsCalls.some((c) => c.ns === 'llm-pi-ai' && c.mode === 'mutate' && c.patch.some((op) => op.op === 'set' && String(op.path?.[0]) === 'providers')))
  const setOps = settingsCalls.filter((c) => c.ns === 'llm-pi-ai' && c.mode === 'mutate').flatMap((c) => c.patch.filter((op) => op.op === 'set'))
  check('sync entries carry apiKeyEnv + api + baseURL', setOps.length > 0 && setOps.every((op) => typeof op.value?.apiKeyEnv === 'string' && typeof op.value?.api === 'string' && String(op.value?.baseURL).startsWith('https://')), JSON.stringify(setOps[0]))
  check('sync stored credentials for applied providers', credentialCalls.length >= body.applied.length)
  check('sync followed current provider as default', body.defaultChanged === true || nsStore.get('agent-default-model')?.provider !== undefined, JSON.stringify(nsStore.get('agent-default-model')))
  check('sync recorded skip reasons', Array.isArray(body.skipped), JSON.stringify(body.skipped).slice(0, 200))

  // 4. state reflects managed routes + default model after sync
  const res3 = fakeRes()
  await route('/api/cc-switch/state').handler(fakeReq({ url: '/api/cc-switch/state', headers: BROWSER_HEADERS }), res3)
  const body3 = JSON.parse(res3.body)
  check('state shows managed routes', body3.dsh.managedRoutes.length === body.applied.length, JSON.stringify(body3.dsh.managedRoutes))
  check('state shows default model', body3.dsh.defaultModel?.provider === nsStore.get('agent-default-model')?.provider)
  check('state marks synced providers', body3.ccSwitch.providers.filter((p) => p.status === 'synced').length === body.applied.length)
  check('state provider tokens never leak', !res3.body.includes(credentialStore.get(body3.dsh.defaultModel?.provider ?? '') ?? '\u0000'))

  // 5. second sync with no cc-switch change → no-op
  const res4 = fakeRes()
  await route('/api/cc-switch/sync').handler(fakeReq({ method: 'POST', url: '/api/cc-switch/sync', headers: BROWSER_HEADERS }), res4)
  const body4 = JSON.parse(res4.body)
  check('sync unchanged → no-op', body4.ok === true && body4.changed === false && body4.applied.length === 0, res4.body.slice(0, 200))
  const after = emitted.length
  check('changed sync announces model-input change', emitted.includes('llm/adapters-updated'), JSON.stringify(emitted))
  check('unchanged sync announces nothing', after === emitted.length, JSON.stringify(emitted))
}

// ── usage route fixture ──────────────────────────────────────────────────────
// 4. Inject a token_plan/volcengine usage_script (fake keys) into the scrubbed
//    DB's current provider, so the usage route exercises the real cc-switch
//    auto-read path: the live query fails with the fake keys (error surfaced,
//    no crash) and the response never echoes them.
{
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(PLUGIN_DB)
  const current = db.prepare("SELECT id, app_type, meta FROM providers WHERE app_type = 'claude' AND is_current = 1 LIMIT 1").get()
  check('usage fixture: current claude row found', current !== undefined)
  const meta = current.meta && current.meta !== '' ? JSON.parse(current.meta) : {}
  meta.usage_script = { enabled: true, templateType: 'token_plan', codingPlanProvider: 'volcengine', accessKeyId: 'AKTEST-CCS', secretAccessKey: 'SKTEST-CCS', timeout: 10 }
  db.prepare('UPDATE providers SET meta = ? WHERE id = ? AND app_type = ?').run(JSON.stringify(meta), current.id, current.app_type)
  db.close()
}
// 5. bare curl on the usage route → 403 guard
{
  const res3 = fakeRes()
  await route('/api/cc-switch/usage').handler(fakeReq({ url: '/api/cc-switch/usage' }), res3)
  check('usage bare request 403', res3.statusCode === 403)
}
// 6. usage: resolves the model in use (agent-default-model → ccs route from the
//    earlier sync), runs that provider's usage query; fake AK never echoes
{
  const res = fakeRes()
  await route('/api/cc-switch/usage').handler(fakeReq({ url: '/api/cc-switch/usage', headers: BROWSER_HEADERS }), res)
  const body = JSON.parse(res.body)
  check('usage default route resolves model in use', res.statusCode === 200 && body.ok === true && body.route === 'ccs-29939f1e' && body.configured === true && typeof body.provider === 'string' && body.provider.length > 0, res.body.slice(0, 240))
  check('usage error surfaced, AK scrubbed', body.result?.kind === 'error' && typeof body.result.error === 'string' && !res.body.includes('AKTEST-CCS') && !res.body.includes('SKTEST-CCS'), res.body.slice(0, 240))
  check('usage caches per route (second call serves cache)', (async () => {
    const res2 = fakeRes()
    await route('/api/cc-switch/usage').handler(fakeReq({ url: '/api/cc-switch/usage', headers: BROWSER_HEADERS }), res2)
    return JSON.parse(res2.body).checkedAt === body.checkedAt
  })(), 'cache miss')

  // explicit route that exists in the scrubbed DB but has no usage query → configured:false with provider name
  const stateRes = fakeRes()
  await route('/api/cc-switch/state').handler(fakeReq({ url: '/api/cc-switch/state', headers: BROWSER_HEADERS }), stateRes)
  const firstProvider = JSON.parse(stateRes.body).ccSwitch.providers.find((p) => p.appType === 'claude')
  const res2 = fakeRes()
  await route('/api/cc-switch/usage').handler(fakeReq({ url: `/api/cc-switch/usage?route=${firstProvider.route}`, headers: BROWSER_HEADERS }), res2)
  const body2 = JSON.parse(res2.body)
  check('usage known route, no query configured', res2.statusCode === 200 && body2.ok === true && body2.configured === false && body2.provider === firstProvider.name, res2.body.slice(0, 200))

  // unknown route
  const res3 = fakeRes()
  await route('/api/cc-switch/usage').handler(fakeReq({ url: '/api/cc-switch/usage?route=ccs-doesnot1', headers: BROWSER_HEADERS }), res3)
  const body3 = JSON.parse(res3.body)
  check('usage unknown route', res3.statusCode === 200 && body3.configured === false, res3.body.slice(0, 200))

  // disabled plugin → 503
  // (covered by the shared disable test if present; skipped here to keep the store state intact)
}

// ── automatic sync loop ──────────────────────────────────────────────────────
// Regression: the loop used to hand its RouteDeps straight to runSync, whose
// deps are named settings/credentials — every automatic pass then rejected with
// "deps.settings is not a function", the rejection was swallowed by a bare
// .catch, and only the manual POST /sync button ever wrote anything.
{
  const { syncDepsFrom, startSyncLoop } = mod

  // The one mapping both callers must use.
  const mapped = syncDepsFrom({
    dbPath: () => PLUGIN_DB,
    enabled: () => true,
    settingsService: () => mockSettings,
    credentialsService: () => mockCredentials,
    llmService: () => null,
    announceModelInputsChanged: () => {},
  })
  check('syncDepsFrom exposes callable sync deps', typeof mapped.settings === 'function' && typeof mapped.credentials === 'function' && mapped.settings() === mockSettings, Object.keys(mapped).join(','))
  check('syncDepsFrom keeps dbPath/enabled', mapped.dbPath() === PLUGIN_DB && mapped.enabled() === true)

  // Drive the real loop against its own DB copy and settings store.
  const loopHome = mkdtempSync(join(tmpdir(), 'dsh-switch-loop-'))
  const loopDb = join(loopHome, 'cc-switch.db')
  copyFileSync(PLUGIN_DB, loopDb)
  const loopStore = new Map()
  const loopWrites = []
  const loopSettings = {
    get: (ns) => loopStore.get(ns),
    async mutate(ns, ops) {
      let section = { ...(loopStore.get(ns) ?? {}) }
      for (const op of ops) {
        const head = op.path[0]
        const rest = op.path[1]
        const inner = { ...(section[head] ?? {}) }
        if (op.op === 'set') inner[rest] = op.value
        else delete inner[rest]
        section = { ...section, [head]: inner }
        loopWrites.push(`${op.op} ${rest}`)
      }
      loopStore.set(ns, section)
    },
    async update(ns, patch) { loopStore.set(ns, { ...(loopStore.get(ns) ?? {}), ...patch }) },
  }
  const loopCredentials = { set: async () => {}, unset: async () => {}, resolve: async () => undefined }
  const loopErrors = []
  let announced = 0

  const dispose = startSyncLoop(
    {
      dbPath: () => loopDb,
      enabled: () => true,
      settings: () => loopSettings,
      credentials: () => loopCredentials,
    },
    { intervalMs: 20, announce: () => { announced += 1 }, onError: (error) => loopErrors.push(error) },
  )

  // Let the first pass land, then change cc-switch behind the loop's back.
  await new Promise((resolve) => setTimeout(resolve, 120))
  check('automatic loop syncs without any manual trigger', loopWrites.length > 0, JSON.stringify(loopWrites.slice(0, 4)))
  check('automatic loop reports no failures', loopErrors.length === 0, loopErrors.map((e) => String(e)).join(' | '))

  {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(loopDb)
    const row = db.prepare("SELECT id, app_type, name FROM providers WHERE app_type='claude' ORDER BY sort_index LIMIT 1").get()
    db.prepare('UPDATE providers SET name = ? WHERE id = ? AND app_type = ?').run(`${row.name}·auto`, row.id, row.app_type)
    db.close()
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  const applied = Object.entries(loopStore.get('llm-pi-ai')?.providers ?? {})
  check('automatic loop picks up a cc-switch change by itself', applied.some(([, entry]) => String(entry.displayName).endsWith('·auto')), JSON.stringify(applied.map(([route, entry]) => [route, entry.displayName])))
  check('automatic loop announced the model-input change', announced > 0, String(announced))
  dispose()
  check('automatic loop still reported no failures', loopErrors.length === 0, loopErrors.map((e) => String(e)).join(' | '))
  rmSync(loopHome, { recursive: true, force: true })
}

rmSync(tmpHome, { recursive: true, force: true })
console.log(failures === 0 ? '\nAll integration checks passed.' : `\n${failures} integration check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
