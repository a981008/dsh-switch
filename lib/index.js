// src/index.ts
import z from "schemastery";

// src/ccswitch-db.ts
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
var CTX_MARKER = /\[1M\]\s*$/u;
var DEFAULT_DB_PATH = join(homedir(), ".cc-switch", "cc-switch.db");
var SYNCABLE_PROTOCOLS = ["anthropic-messages", "openai-responses", "openai-completions"];
var CcSwitchUnavailableError = class extends Error {
};
function resolveDbPath(configured) {
  const p = (configured ?? "").trim();
  return p === "" ? DEFAULT_DB_PATH : p;
}
function openReadOnly(path) {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    throw new CcSwitchUnavailableError(
      `cannot open cc-switch database at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
}
function str(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function parseClaudeEnv(settingsConfig) {
  let parsed;
  try {
    parsed = JSON.parse(settingsConfig);
  } catch {
    return null;
  }
  const envRaw = parsed?.env;
  if (envRaw === null || typeof envRaw !== "object") return null;
  const env = {};
  for (const [k, v] of Object.entries(envRaw)) {
    if (typeof v === "string") env[k] = v;
  }
  const baseUrl = env["ANTHROPIC_BASE_URL"] ?? "";
  const token = env["ANTHROPIC_AUTH_TOKEN"] ?? env["ANTHROPIC_API_KEY"] ?? "";
  const candidates = [
    env["ANTHROPIC_MODEL"],
    env["ANTHROPIC_DEFAULT_SONNET_MODEL"],
    env["ANTHROPIC_DEFAULT_OPUS_MODEL"],
    env["ANTHROPIC_DEFAULT_HAIKU_MODEL"]
  ];
  const models = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim() === "") continue;
    const id = candidate.replace(CTX_MARKER, "").trim();
    if (id !== "" && !models.includes(id)) models.push(id);
  }
  return { baseUrl, token, models, env };
}
function listProviders(db) {
  const rows = db.prepare(
    `SELECT id, app_type, name, category, is_current, website_url, settings_config, meta
       FROM providers
       ORDER BY app_type, COALESCE(sort_index, 1 << 30), name`
  ).all();
  return rows.map((row) => ({
    id: String(row["id"]),
    appType: String(row["app_type"]),
    name: String(row["name"] ?? ""),
    category: str(row["category"]),
    isCurrent: Number(row["is_current"] ?? 0) === 1 || row["is_current"] === 1,
    websiteUrl: str(row["website_url"]),
    settingsConfig: String(row["settings_config"] ?? "{}"),
    meta: str(row["meta"])
  }));
}
function parseJsonObject(settingsConfig) {
  try {
    const parsed = JSON.parse(settingsConfig);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
function dshRouteFor(providerId) {
  const slug = providerId.toLowerCase().replace(/[^a-z0-9-]/gu, "").slice(0, 8);
  return `ccs-${slug === "" ? "unknown" : slug}`;
}
function parseUsageScript(row) {
  let meta;
  try {
    const parsed = JSON.parse(row.meta ?? "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    meta = parsed;
  } catch {
    return null;
  }
  const raw = meta["usage_script"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const script = raw;
  if (script["enabled"] !== true) return null;
  if (typeof script["templateType"] !== "string") return null;
  const str2 = (key) => {
    const value = script[key];
    return typeof value === "string" && value !== "" ? value : void 0;
  };
  return {
    enabled: true,
    templateType: script["templateType"],
    ...typeof script["codingPlanProvider"] === "string" && script["codingPlanProvider"] !== "" ? { codingPlanProvider: script["codingPlanProvider"] } : {},
    ...str2("accessKeyId") !== void 0 ? { accessKeyId: script["accessKeyId"] } : {},
    ...str2("secretAccessKey") !== void 0 ? { secretAccessKey: script["secretAccessKey"] } : {},
    code: typeof script["code"] === "string" ? script["code"] : "",
    language: typeof script["language"] === "string" ? script["language"] : "javascript",
    timeoutSec: typeof script["timeout"] === "number" && script["timeout"] > 0 ? script["timeout"] : 10,
    autoQueryIntervalMin: typeof script["autoQueryInterval"] === "number" && script["autoQueryInterval"] >= 0 ? script["autoQueryInterval"] : 5,
    ...str2("baseUrl") !== void 0 ? { baseUrl: script["baseUrl"] } : {},
    ...str2("accessToken") !== void 0 ? { accessToken: script["accessToken"] } : {},
    ...str2("userId") !== void 0 ? { userId: script["userId"] } : {}
  };
}
function stringEnv(raw) {
  const out = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
function dedupeModels(candidates) {
  const models = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const id = candidate.replace(CTX_MARKER, "").trim();
    if (id !== "" && !models.includes(id)) models.push(id);
  }
  return models;
}
function parseCodexToml(config) {
  const model = /^\s*model\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  const providerName = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  const section = {};
  if (providerName !== void 0) {
    const header = new RegExp(`^[\\t ]*\\[model_providers\\.${providerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][^\\S\\n]*$`, "m");
    const start = config.search(header);
    if (start >= 0) {
      const rest = config.slice(start);
      const end = rest.slice(1).search(/^\s*\[/m);
      const block = end === -1 ? rest : rest.slice(0, end + 1);
      section.baseUrl = /^[ \t]*base_url\s*=\s*"([^"]+)"/m.exec(block)?.[1];
      section.wireApi = /^[ \t]*wire_api\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    }
  }
  if (section.baseUrl === void 0) {
    const start = config.search(/^\s*\[model_providers\.[^\]]+\]/m);
    if (start >= 0) {
      const rest = config.slice(start);
      const end = rest.slice(1).search(/^\s*\[/m);
      const block = end === -1 ? rest : rest.slice(0, end + 1);
      section.baseUrl = /^[ \t]*base_url\s*=\s*"([^"]+)"/m.exec(block)?.[1];
      section.wireApi = /^[ \t]*wire_api\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    }
  }
  return { model, providerName, section };
}
function parseCodex(row) {
  const parsed = parseJsonObject(row.settingsConfig);
  if (parsed === null) return { kind: "skip", reason: "config is not readable" };
  const auth = parsed["auth"] !== void 0 && parsed["auth"] !== null && typeof parsed["auth"] === "object" && !Array.isArray(parsed["auth"]) ? parsed["auth"] : {};
  const apiKey = typeof auth["OPENAI_API_KEY"] === "string" ? auth["OPENAI_API_KEY"].trim() : "";
  const config = typeof parsed["config"] === "string" ? parsed["config"] : "";
  if (apiKey === "") return { kind: "skip", reason: "no API key (ChatGPT/OAuth login cannot be used by DSH)" };
  if (config.trim() === "") return { kind: "skip", reason: "empty config.toml" };
  const { model, section } = parseCodexToml(config);
  if (section.baseUrl === void 0 || section.baseUrl === "") return { kind: "skip", reason: "no base_url in config.toml" };
  if (model === void 0 || model === "") return { kind: "skip", reason: "no model in config.toml" };
  return {
    kind: "ok",
    config: {
      baseUrl: section.baseUrl,
      apiKey,
      api: section.wireApi === "chat" ? "openai-completions" : "openai-responses",
      models: [model]
    }
  };
}
function parseGemini(row) {
  const parsed = parseJsonObject(row.settingsConfig);
  if (parsed === null) return { kind: "skip", reason: "config is not readable" };
  const env = stringEnv(parsed["env"]);
  const apiKey = (env["GEMINI_API_KEY"] ?? env["GOOGLE_API_KEY"] ?? env["GOOGLE_GENAI_API_KEY"] ?? "").trim();
  const baseUrl = (env["GOOGLE_GEMINI_BASE_URL"] ?? env["GEMINI_BASE_URL"] ?? "").trim();
  const model = (env["GEMINI_MODEL"] ?? "").trim();
  if (apiKey === "") return { kind: "skip", reason: "no API key (Google OAuth login cannot be used by DSH)" };
  if (baseUrl === "" || /googleapis\.com/u.test(baseUrl)) {
    return { kind: "skip", reason: "DSH has no native Gemini protocol; only OpenAI-compatible relays can be synced" };
  }
  if (model === "") return { kind: "skip", reason: "no GEMINI_MODEL configured" };
  return { kind: "ok", config: { baseUrl, apiKey, api: "openai-completions", models: [model] } };
}
function parseOpenclaw(row) {
  const parsed = parseJsonObject(row.settingsConfig);
  if (parsed === null) return { kind: "skip", reason: "config is not readable" };
  const baseUrl = typeof parsed["baseUrl"] === "string" ? parsed["baseUrl"] : "";
  const api = typeof parsed["api"] === "string" ? parsed["api"] : "";
  const apiKey = typeof parsed["apiKey"] === "string" ? parsed["apiKey"] : "";
  const rawModels = Array.isArray(parsed["models"]) ? parsed["models"] : [];
  const models = dedupeModels(rawModels.map((model) => model !== null && typeof model === "object" && typeof model["id"] === "string" ? model["id"] : void 0));
  if (baseUrl === "") return { kind: "skip", reason: "no baseUrl in config" };
  if (!SYNCABLE_PROTOCOLS.includes(api)) return { kind: "skip", reason: `protocol "${api || "?"}" is not supported by DSH routes` };
  if (models.length === 0) return { kind: "skip", reason: "no models in config" };
  if (apiKey === "") return { kind: "skip", reason: "config carries no API key (live-managed providers keep it outside cc-switch)" };
  return { kind: "ok", config: { baseUrl, apiKey, api, models } };
}
function parseProviderConfig(row) {
  switch (row.appType) {
    case "claude": {
      const parsed = parseClaudeEnv(row.settingsConfig);
      if (parsed === null) return { kind: "skip", reason: "config is not readable" };
      if (parsed.baseUrl === "") return { kind: "skip", reason: "no ANTHROPIC_BASE_URL" };
      if (parsed.token === "") return { kind: "skip", reason: "no ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY" };
      return { kind: "ok", config: { baseUrl: parsed.baseUrl, apiKey: parsed.token, api: "anthropic-messages", models: parsed.models } };
    }
    case "codex":
      return parseCodex(row);
    case "gemini":
      return parseGemini(row);
    case "openclaw":
      return parseOpenclaw(row);
    default:
      return { kind: "skip", reason: `app type "${row.appType}" is not supported` };
  }
}
function withDb(path, job) {
  const db = openReadOnly(path);
  try {
    return job(db);
  } finally {
    try {
      db.close();
    } catch {
    }
  }
}

// src/sync.ts
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { basename, dirname, join as join2 } from "node:path";
var REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
function envNameFor(name, providerId) {
  const fromName = name.toUpperCase().replace(/[^A-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  const base = fromName.length >= 2 ? fromName : providerId.replace(/[^A-Za-z0-9]/gu, "").toUpperCase();
  const candidate = `CCS_${base === "" ? "PROVIDER" : base}_API_KEY`;
  return REF_PATTERN.test(candidate) ? candidate : `CCS_${dshRouteFor(providerId).toUpperCase().replaceAll("-", "_")}_API_KEY`;
}
function routeEnvName(route) {
  return `CCS_${route.toUpperCase().replaceAll("-", "_")}_API_KEY`;
}
function keyHashOf(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}
function stateFile() {
  return join2(homedir2(), ".dsh", "plugins", "dsh-switch", "state.json");
}
function emptySyncState() {
  return { version: 2, managed: {}, currents: {}, signature: "", lastSyncAt: null, lastError: null };
}
function readSyncState() {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), "utf8"));
    if (parsed["version"] === 2 && typeof parsed["managed"] === "object" && parsed["managed"] !== null) {
      const raw = parsed;
      return {
        version: 2,
        managed: raw.managed ?? {},
        currents: raw.currents ?? {},
        signature: typeof raw.signature === "string" ? raw.signature : "",
        lastSyncAt: typeof raw.lastSyncAt === "string" ? raw.lastSyncAt : null,
        lastError: typeof raw.lastError === "string" ? raw.lastError : null
      };
    }
    const legacy = parsed["applied"];
    const managed = {};
    for (const [route, value] of Object.entries(legacy ?? {})) {
      if (typeof value?.ccSwitchId !== "string" || typeof value?.envName !== "string") continue;
      managed[route] = {
        ccSwitchId: value.ccSwitchId,
        appType: value.appType ?? "claude",
        name: value.name ?? route,
        envName: value.envName,
        model: value.model ?? "",
        keyHash: "",
        entry: { displayName: value.name ?? route, api: "anthropic-messages", baseURL: "", models: [] },
        syncedAt: ""
      };
    }
    return { ...emptySyncState(), managed };
  } catch {
    return emptySyncState();
  }
}
function writeSyncState(state) {
  try {
    const file = stateFile();
    mkdirSync(dirname(file), { recursive: true, mode: 448 });
    writeFileSync(file, JSON.stringify(state, null, 2), { mode: 384 });
  } catch (cause) {
    throw new Error(`cannot persist dsh-switch state: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
function canonicalJson(value) {
  return JSON.stringify(value, (_key, val) => {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return val;
  });
}
function signatureOf(rows) {
  const sorted = [...rows].sort((a, b) => a.appType === b.appType ? a.id < b.id ? -1 : 1 : a.appType < b.appType ? -1 : 1);
  return createHash("sha256").update(canonicalJson(sorted.map((row) => ({ id: row.id, appType: row.appType, name: row.name, isCurrent: row.isCurrent, settingsConfig: row.settingsConfig })))).digest("hex").slice(0, 32);
}
function existingEnvName(settings, route) {
  try {
    const section = settings?.get("llm-pi-ai");
    const value = section?.providers?.[route]?.apiKeyEnv;
    if (typeof value === "string" && REF_PATTERN.test(value)) return value;
    const nested = value;
    if (typeof nested?.name === "string" && REF_PATTERN.test(nested.name)) return nested.name;
    if (typeof nested?.ref === "string" && REF_PATTERN.test(nested.ref)) return nested.ref;
    return void 0;
  } catch {
    return void 0;
  }
}
function planSync(rows, state, settings) {
  const items = [];
  const skips = [];
  const claimedEnvNames = /* @__PURE__ */ new Set();
  const staged = [];
  for (const row of rows) {
    const outcome = parseProviderConfig(row);
    if (outcome.kind === "skip") {
      skips.push({ name: row.name, appType: row.appType, reason: outcome.reason });
      continue;
    }
    const parsed = outcome.config;
    if (parsed.models.length === 0) {
      skips.push({ name: row.name, appType: row.appType, reason: "no models" });
      continue;
    }
    const route = dshRouteFor(row.id);
    const model = parsed.models[0];
    const entry = {
      displayName: row.name,
      api: parsed.api,
      baseURL: parsed.baseUrl,
      models: parsed.models.map((id) => ({ id, name: id }))
    };
    const preferred = existingEnvName(settings, route) ?? envNameFor(row.name, row.id);
    staged.push({ row, route, envName: preferred, preferredEnvName: preferred, entry, key: parsed.apiKey, model, keyHash: keyHashOf(parsed.apiKey) });
  }
  for (const item of staged) {
    if (!claimedEnvNames.has(item.preferredEnvName)) {
      claimedEnvNames.add(item.preferredEnvName);
      item.envName = item.preferredEnvName;
    } else {
      item.envName = routeEnvName(item.route);
      claimedEnvNames.add(item.envName);
    }
    if (item.entry.apiKeyEnv !== item.envName) {
      if (item.envName === "") delete item.entry.apiKeyEnv;
      else item.entry.apiKeyEnv = item.envName;
    }
    items.push(item);
  }
  const currents = {};
  for (const item of items) {
    if (item.row.isCurrent && currents[item.row.appType] === void 0) currents[item.row.appType] = item.route;
  }
  return { items, skips, currents, signature: signatureOf(rows) };
}
function asSettings(service) {
  if (service === null || typeof service !== "object") return null;
  const candidate = service;
  if (typeof candidate.get !== "function" || typeof candidate.update !== "function") return null;
  return candidate;
}
function asCredentials(service) {
  if (service === null || typeof service !== "object") return null;
  const candidate = service;
  if (typeof candidate.set !== "function" || typeof candidate.unset !== "function") return null;
  return candidate;
}
function readDshDefaultModel(settings) {
  try {
    return settings.get("agent-default-model") ?? {};
  } catch {
    return {};
  }
}
function entriesEqual(a, b) {
  if (a === void 0) return false;
  return canonicalJson(a) === canonicalJson(b);
}
function readLiveProviderMap(settings) {
  try {
    const section = settings.get("llm-pi-ai");
    const providers = section?.providers;
    if (providers === null || providers === void 0 || typeof providers !== "object" || Array.isArray(providers)) return {};
    return providers;
  } catch {
    return null;
  }
}
function liveEntryMatches(live, target) {
  if (live === null || typeof live !== "object" || Array.isArray(live)) return false;
  const entry = live;
  if (entry["apiKeyEnv"] !== target.apiKeyEnv) return false;
  if (entry["displayName"] !== target.displayName) return false;
  if (entry["api"] !== target.api) return false;
  if (entry["baseURL"] !== target.baseURL) return false;
  const models = entry["models"];
  if (!Array.isArray(models) || models.length !== target.models.length) return false;
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const want = target.models[index];
    if (model === null || typeof model !== "object" || Array.isArray(model)) return false;
    const record = model;
    if (record["id"] !== want.id || record["name"] !== want.name) return false;
  }
  return true;
}
async function runSync(deps, options = {}) {
  const state = readSyncState();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const finish = (outcome2, error) => {
    const next = {
      version: 2,
      managed: outcome2.ok ? state.managed : state.managed,
      currents: outcome2.ok ? state.currents ?? {} : state.currents,
      signature: outcome2.ok ? state.signature ?? "" : state.signature,
      lastSyncAt: outcome2.ok ? now : state.lastSyncAt,
      lastError: error ?? null
    };
    try {
      writeSyncState(next);
    } catch {
    }
    return { ...outcome2, lastSyncAt: next.lastSyncAt, ...error === void 0 ? {} : { error } };
  };
  const settings = asSettings(deps.settings());
  const credentials = asCredentials(deps.credentials());
  if (settings === null || credentials === null) {
    return finish({ ok: false, changed: false, applied: [], removed: [], defaultChanged: false, skipped: [] }, "DSH settings/credentials service is not available yet");
  }
  let rows;
  try {
    rows = withDb(resolveDbPath(deps.dbPath()), (db) => listProviders(db));
  } catch (cause) {
    return finish({ ok: false, changed: false, applied: [], removed: [], defaultChanged: false, skipped: [] }, cause instanceof Error ? cause.message : String(cause));
  }
  const signature = signatureOf(rows);
  const plan = planSync(rows, state, settings);
  const liveProviders = readLiveProviderMap(settings);
  const setOps = [];
  const applied = [];
  const appliedRoutes = /* @__PURE__ */ new Set();
  for (const item of plan.items) {
    const prev = state.managed[item.route];
    const snapshotMatches = prev !== void 0 && prev.ccSwitchId === item.row.id && prev.keyHash === item.keyHash && prev.envName === item.envName && entriesEqual(prev.entry, item.entry);
    const liveMatches = liveProviders === null ? true : liveEntryMatches(liveProviders[item.route], item.entry);
    if (snapshotMatches && liveMatches) continue;
    setOps.push({ op: "set", path: ["providers", item.route], value: item.entry });
    applied.push(item.route);
    appliedRoutes.add(item.route);
  }
  const plannedRoutes = new Set(plan.items.map((item) => item.route));
  const unsetSet = /* @__PURE__ */ new Set();
  for (const route of Object.keys(state.managed)) {
    if (!plannedRoutes.has(route)) unsetSet.add(route);
  }
  if (liveProviders !== null) {
    for (const route of Object.keys(liveProviders)) {
      if (route.startsWith("ccs-") && !plannedRoutes.has(route)) unsetSet.add(route);
    }
  }
  const unsetRoutes = [...unsetSet];
  const signatureUnchanged = !options.force && signature !== "" && signature === state.signature;
  if (signatureUnchanged && setOps.length === 0 && unsetRoutes.length === 0) {
    return { ok: true, changed: false, applied: [], removed: [], defaultChanged: false, skipped: [], lastSyncAt: state.lastSyncAt };
  }
  try {
    for (const item of plan.items) {
      if (!appliedRoutes.has(item.route) || item.key === "") continue;
      const prev = state.managed[item.route];
      const live = liveProviders === null ? void 0 : liveProviders[item.route];
      const liveRefMatches = live !== null && live !== void 0 && typeof live === "object" && live["apiKeyEnv"] === item.envName;
      const needsWrite = prev === void 0 || prev.keyHash !== item.keyHash || prev.envName !== item.envName || !liveRefMatches;
      if (needsWrite) await credentials.set(item.envName, item.key);
    }
    if (setOps.length > 0 || unsetRoutes.length > 0) {
      const ops = [
        ...setOps,
        ...unsetRoutes.map((route) => ({ op: "unset", path: ["providers", route] }))
      ];
      if (typeof settings.mutate === "function") {
        await settings.mutate("llm-pi-ai", ops);
      } else {
        const patch = {};
        for (const op of setOps) patch[op.path[1]] = op.value;
        if (setOps.length > 0) await settings.update("llm-pi-ai", { providers: patch });
      }
    }
    for (const route of unsetRoutes) {
      const envName = state.managed[route]?.envName;
      if (envName !== void 0) await credentials.unset(envName);
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return finish({ ok: false, changed: false, applied: [], removed: [], defaultChanged: false, skipped: plan.skips }, message);
  }
  const managed = { ...state.managed };
  for (const item of plan.items) {
    if (!applied.includes(item.route)) continue;
    managed[item.route] = {
      ccSwitchId: item.row.id,
      appType: item.row.appType,
      name: item.row.name,
      envName: item.envName,
      model: item.model,
      keyHash: item.keyHash,
      entry: item.entry,
      syncedAt: now
    };
  }
  for (const route of unsetRoutes) delete managed[route];
  let defaultChanged = false;
  const nextCurrents = { ...state.currents };
  const switched = [];
  const currentDefault = readDshDefaultModel(settings);
  for (const [appType, route] of Object.entries(plan.currents)) {
    const prev = state.currents[appType];
    if (prev !== void 0 && prev !== route) switched.push(appType);
    nextCurrents[appType] = route;
  }
  const pickSwitch = (() => {
    const preferred = switched.find((appType) => appType === "claude") ?? switched[0];
    if (preferred === void 0) return null;
    const route = plan.currents[preferred];
    return plan.items.find((item) => item.route === route) ?? null;
  })();
  const fallbackItem = (() => {
    const route = plan.currents["claude"] ?? Object.values(plan.currents)[0] ?? plan.items[0]?.route;
    return route === void 0 ? null : plan.items.find((item) => item.route === route) ?? null;
  })();
  let nextDefault = null;
  const defaultProvider = typeof currentDefault.provider === "string" ? currentDefault.provider : "";
  const defaultIsOurs = defaultProvider.startsWith("ccs-");
  if (!defaultIsOurs && defaultProvider !== "") {
  } else if (pickSwitch !== null) {
    nextDefault = { provider: pickSwitch.route, model: pickSwitch.model };
  } else if (defaultProvider === "" || !plannedRoutes.has(defaultProvider)) {
    const item = fallbackItem;
    if (item !== null && currentDefault.provider !== item.route) nextDefault = { provider: item.route, model: item.model };
  }
  if (nextDefault !== null) {
    await settings.update("agent-default-model", nextDefault);
    defaultChanged = true;
  }
  state.managed = managed;
  state.currents = nextCurrents;
  state.signature = signature;
  const outcome = finish(
    { ok: true, changed: applied.length > 0 || unsetRoutes.length > 0 || defaultChanged, applied, removed: unsetRoutes, defaultChanged, skipped: plan.skips }
  );
  return outcome;
}
var WATCH_DEBOUNCE_MS = 250;
function watchCcSwitchDb(dbPath, onChange) {
  const directory = dirname(dbPath);
  const base = basename(dbPath);
  const matches = (filename) => {
    if (filename === null) return true;
    const name = filename.split(/[\\/]/).pop() ?? "";
    return name === base || name.startsWith(`${base}-`);
  };
  let timer = null;
  let watcher = null;
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, WATCH_DEBOUNCE_MS);
    if (typeof timer.unref === "function") timer.unref();
  };
  try {
    watcher = watch(directory, { persistent: false, recursive: true }, (_event, filename) => {
      if (matches(filename)) schedule();
    });
    watcher.on("error", () => {
    });
  } catch {
    return () => {
    };
  }
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    watcher?.close();
    watcher = null;
  };
}

// src/usage.ts
import vm from "node:vm";

// src/ark-plan.ts
import { createHash as createHash2, createHmac } from "node:crypto";
var VOLCENGINE_HOST = "open.volcengineapi.com";
var VOLCENGINE_SERVICE = "ark";
var VOLCENGINE_REGION = "cn-beijing";
var VOLCENGINE_VERSION = "2024-01-01";
var VOLCENGINE_ACTIONS = ["GetCodingPlanUsage", "GetAFPUsage", "GetUsageDetails", "GetPersonalPlan"];
function hmacSha256(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}
function hashHex(data) {
  return createHash2("sha256").update(data, "utf8").digest("hex");
}
function uriEscape(str2) {
  return encodeURIComponent(str2).replace(/\*/g, "%2A").replace(/%7E/g, "~");
}
function queryParamsToString(params) {
  return Object.keys(params).sort().map((key) => `${uriEscape(key)}=${uriEscape(params[key])}`).join("&");
}
function volcengineDateTimeNow() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
}
function volcengineAuthorization(input) {
  const {
    accessKeyId,
    secretAccessKey,
    method = "GET",
    host = VOLCENGINE_HOST,
    path = "/",
    query = {},
    body = "",
    region = VOLCENGINE_REGION,
    service = VOLCENGINE_SERVICE,
    datetime
  } = input;
  const xDate = datetime ?? volcengineDateTimeNow();
  const date = xDate.slice(0, 8);
  const bodySha = hashHex(body);
  const signedHeaders = "host;x-content-sha256;x-date";
  const canonicalHeaders = `host:${host}
x-content-sha256:${bodySha}
x-date:${xDate}`;
  const qs = queryParamsToString(query);
  const canonicalRequest = [method.toUpperCase(), path, qs, `${canonicalHeaders}
`, signedHeaders, bodySha].join("\n");
  const credentialScope = [date, region, service, "request"].join("/");
  const stringToSign = ["HMAC-SHA256", xDate, credentialScope, hashHex(canonicalRequest)].join("\n");
  const kDate = hmacSha256(secretAccessKey, date);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "request");
  const signature = hmacSha256(kSigning, stringToSign).toString("hex");
  return {
    "X-Date": xDate,
    "X-Content-Sha256": bodySha,
    Host: host,
    Authorization: `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
}
function clampPct(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
function normalizeResetAt(raw) {
  if (raw === null || raw === void 0 || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw * 1e3;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const text = String(raw);
  const asNumber = Number(text);
  if (Number.isFinite(asNumber) && text.trim() !== "") return normalizeResetAt(asNumber);
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
function windowName(raw) {
  const s = String(raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (s.includes("5h") || s.includes("fivehour") || s === "session" || s === "rolling") return "fiveHour";
  if (s.includes("week") || s === "7d") return "weekly";
  if (s.includes("month") || s === "30d") return "monthly";
  if (s.includes("daily") || s === "day" || s === "1d") return "daily";
  const text = String(raw ?? "").trim();
  if (text.length > 0 && text.length < 32) return text.replace(/\s+/g, "_");
  return null;
}
function windowEntry(nameRaw, entry) {
  const name = windowName(nameRaw);
  if (name === null) return null;
  const percentRaw = entry["Percent"] ?? entry["percent"] ?? entry["percentage"] ?? entry["Percentage"] ?? entry["utilization"];
  let pct = Number(percentRaw);
  if (!Number.isFinite(pct)) {
    const total = Number(entry["Total"] ?? entry["total"] ?? entry["Limit"] ?? entry["limit"] ?? entry["Quota"] ?? entry["quota"] ?? entry["Cap"] ?? entry["cap"]);
    const used = Number(entry["Used"] ?? entry["used"] ?? entry["Usage"] ?? entry["usage"] ?? entry["Consumed"] ?? entry["consumed"]);
    const remain = Number(entry["Remaining"] ?? entry["remaining"] ?? entry["Remain"] ?? entry["remain"] ?? entry["Available"] ?? entry["available"]);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(used)) pct = used / total * 100;
    else if (Number.isFinite(total) && total > 0 && Number.isFinite(remain)) pct = (total - remain) / total * 100;
    else return null;
  }
  if (!Number.isFinite(pct)) return null;
  const resetsAt = normalizeResetAt(
    entry["ResetTimestamp"] ?? entry["resetTimestamp"] ?? entry["ResetTime"] ?? entry["resetTime"] ?? entry["ResetAt"] ?? entry["resetAt"] ?? entry["EndTime"] ?? entry["endTime"]
  );
  return { name, win: { percent: clampPct(pct), resetsAt } };
}
function parseVolcenginePlanUsage(data) {
  if (data === null || typeof data !== "object") return null;
  const root = data;
  const result = root["Result"] ?? root["result"];
  const quotaList = result?.["QuotaUsage"] ?? result?.["quotaUsage"] ?? result?.["UsageDetails"] ?? result?.["usageDetails"];
  if (Array.isArray(quotaList)) {
    const windows = {};
    for (const raw of quotaList) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw;
      const nameRaw = entry["Level"] ?? entry["level"] ?? entry["QuotaType"] ?? entry["quotaType"] ?? entry["Type"] ?? entry["type"] ?? entry["Label"] ?? entry["label"];
      const parsed = windowEntry(nameRaw, entry);
      if (parsed !== null && windows[parsed.name] === void 0) windows[parsed.name] = parsed.win;
    }
    if (Object.keys(windows).length > 0) return windows;
  }
  for (const candidate of [result, root]) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const windows = {};
    for (const [name, raw] of Object.entries(candidate)) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      if (name === "ResponseMetadata" || name === "ResponseDetails") continue;
      const parsed = windowEntry(name, raw);
      if (parsed !== null) windows[parsed.name] = parsed.win;
    }
    if (Object.keys(windows).length > 0) return windows;
  }
  return null;
}
function responseError(data) {
  if (data === null || typeof data !== "object") return null;
  const meta = data["ResponseMetadata"];
  const error = meta?.["Error"];
  if (error !== void 0 && error !== null) {
    return `${String(error["Code"] ?? "UnknownError")}: ${String(error["Message"] ?? "")}`.trim();
  }
  return null;
}
async function tryAction(action, ak, sk, timeoutMs) {
  const query = { Action: action, Version: VOLCENGINE_VERSION };
  const headers = volcengineAuthorization({ accessKeyId: ak, secretAccessKey: sk, query });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://${VOLCENGINE_HOST}/?${queryParamsToString(query)}`, {
      method: "GET",
      headers,
      signal: controller.signal
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      return { windows: null, error: `HTTP ${response.status} (non-JSON response)` };
    }
    const apiError = responseError(body);
    if (!response.ok || apiError !== null) {
      return { windows: null, error: apiError ?? `HTTP ${response.status}` };
    }
    const windows = parseVolcenginePlanUsage(body);
    return { windows, error: windows === null ? "unrecognized response shape" : null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { windows: null, error: message === "This operation was aborted" ? "request timeout" : message };
  } finally {
    clearTimeout(timer);
  }
}
async function queryArkPlanUsage(accessKeyId, secretAccessKey, timeoutMs = 15e3) {
  let firstError = null;
  for (const action of VOLCENGINE_ACTIONS) {
    const { windows, error } = await tryAction(action, accessKeyId, secretAccessKey, timeoutMs);
    if (windows !== null && Object.keys(windows).length > 0) return { windows, action };
    if (error !== null && firstError === null) firstError = error;
    if (windows !== null) firstError = "no recognizable usage windows in the response";
  }
  throw new Error(firstError ?? "all Volcengine usage actions failed");
}

// src/usage.ts
var SUBSTITUTION_KEYS = ["baseUrl", "apiKey", "accessToken", "userId"];
function substitute(template, vars) {
  let out = template;
  for (const key of SUBSTITUTION_KEYS) {
    out = out.replaceAll(`{{${key}}}`, vars[key] ?? "");
  }
  return out;
}
function substituteDeep(value, vars) {
  if (typeof value === "string") return substitute(value, vars);
  if (Array.isArray(value)) return value.map((item) => substituteDeep(item, vars));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = substituteDeep(item, vars);
    return out;
  }
  return value;
}
function compileScript(code, timeoutSec) {
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  const script = new vm.Script(`(${code})`, { filename: "cc-switch-usage-script.js" });
  const value = script.runInContext(context, { timeout: Math.min(2e3, timeoutSec * 1e3) });
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("usage script did not evaluate to an object");
  const holder = value;
  const request = holder["request"];
  const extractor = holder["extractor"];
  if (request === null || typeof request !== "object" || Array.isArray(request)) throw new Error("usage script has no request object");
  if (typeof extractor !== "function") throw new Error("usage script has no extractor function");
  return {
    request,
    // Re-enter the vm for the extractor call so its timeout applies.
    extractor: (response) => {
      const call = new vm.Script("(__extractor)(__response)", { filename: "cc-switch-usage-extractor.js" });
      const runContext = vm.createContext({ __extractor: extractor, __response: response }, { codeGeneration: { strings: false, wasm: false } });
      return call.runInContext(runContext, { timeout: Math.min(2e3, timeoutSec * 1e3) });
    }
  };
}
async function executeRequest(request, extractor, timeoutSec, fetchImpl) {
  const url = typeof request["url"] === "string" ? request["url"] : "";
  if (!/^https?:\/\//u.test(url)) return { kind: "error", error: `invalid usage query url: ${url === "" ? "(empty)" : url}` };
  const method = typeof request["method"] === "string" ? request["method"].toUpperCase() : "GET";
  const headers = {};
  const rawHeaders = request["headers"];
  if (rawHeaders !== null && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value === "string") headers[key] = value;
    }
  }
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), Math.max(1, timeoutSec) * 1e3);
  try {
    const response = await fetchImpl(url, { method, headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) return { kind: "error", error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { kind: "error", error: "usage response is not JSON" };
    }
    const extracted = extractor(body);
    if (extracted === null || typeof extracted !== "object" || Array.isArray(extracted)) return { kind: "error", error: "extractor returned no object" };
    const record = extracted;
    if (record["isValid"] === false) {
      const message = typeof record["invalidMessage"] === "string" ? record["invalidMessage"] : "account invalid";
      return { kind: "error", error: message };
    }
    const num = (key) => {
      const value = record[key];
      return typeof value === "number" && Number.isFinite(value) ? value : void 0;
    };
    const str2 = (key) => {
      const value = record[key];
      return typeof value === "string" && value !== "" ? value : void 0;
    };
    return {
      kind: "balance",
      ...num("remaining") !== void 0 ? { remaining: record["remaining"] } : {},
      ...num("used") !== void 0 ? { used: record["used"] } : {},
      ...num("total") !== void 0 ? { total: record["total"] } : {},
      ...str2("unit") !== void 0 ? { unit: record["unit"] } : {},
      ...str2("planName") !== void 0 ? { planName: record["planName"] } : {},
      ...str2("extra") !== void 0 ? { extra: record["extra"] } : {}
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { kind: "error", error: message === "This operation was aborted" ? `request timed out after ${timeoutSec}s` : message };
  } finally {
    clearTimeout(abort);
  }
}
function parseMinimaxPlan(body) {
  if (body === null || typeof body !== "object") return null;
  const record = body;
  if (record["base_resp"] !== null && typeof record["base_resp"] === "object") {
    const base = record["base_resp"];
    if (base["status_code"] !== 0) return null;
  }
  const modelRemains = record["model_remains"];
  if (!Array.isArray(modelRemains)) return null;
  const item = modelRemains.find((entry) => entry["model_name"] === "general");
  if (item === void 0) return null;
  const windows = {};
  const millisToIso = (value) => typeof value === "number" && value > 0 ? new Date(value).toISOString() : null;
  const remaining = item["current_interval_remaining_percent"];
  if (typeof remaining === "number" && Number.isFinite(remaining)) {
    windows["fiveHour"] = { percent: Math.max(0, Math.min(100, 100 - remaining)), resetsAt: millisToIso(item["end_time"]) };
  }
  if (item["current_weekly_status"] === 1) {
    const weeklyRemaining = item["current_weekly_remaining_percent"];
    if (typeof weeklyRemaining === "number" && Number.isFinite(weeklyRemaining)) {
      windows["weekly"] = { percent: Math.max(0, Math.min(100, 100 - weeklyRemaining)), resetsAt: millisToIso(item["weekly_end_time"]) };
    }
  }
  return Object.keys(windows).length > 0 ? windows : null;
}
function detectBalanceProvider(baseUrl) {
  const url = baseUrl.toLowerCase();
  if (url.includes("api.deepseek.com")) return "deepseek";
  if (url.includes("api.stepfun.ai") || url.includes("api.stepfun.com")) return "stepfun";
  if (url.includes("api.siliconflow.cn")) return "siliconflow-cn";
  if (url.includes("api.siliconflow.com")) return "siliconflow-en";
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("api.novita.ai")) return "novita";
  return null;
}
function parseF64Field(record, key) {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return void 0;
}
async function fetchJson(url, apiKey, timeoutSec, fetchImpl, extraHeaders = {}) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", ...extraHeaders },
    signal: AbortSignal.timeout(Math.max(1, timeoutSec) * 1e3)
  });
  const text = await response.text();
  if (response.status === 401 || response.status === 403) throw new Error(`Authentication failed (HTTP ${response.status})`);
  if (!response.ok) throw new Error(`API error (HTTP ${response.status}): ${text.slice(0, 200)}`);
  const body = JSON.parse(text);
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("unexpected response shape");
  return body;
}
var balance = (remaining, rest = {}) => ({ kind: "balance", ...remaining !== void 0 ? { remaining } : {}, ...rest });
async function queryBuiltinBalance(kind, apiKey, timeoutSec, fetchImpl) {
  if (apiKey === "") throw new Error("usage query is missing the provider API key");
  switch (kind) {
    case "deepseek": {
      const body = await fetchJson("https://api.deepseek.com/user/balance", apiKey, timeoutSec, fetchImpl);
      const isAvailable = typeof body["is_available"] === "boolean" ? body["is_available"] : true;
      const infos = Array.isArray(body["balance_infos"]) ? body["balance_infos"] : [];
      if (infos.length === 0) throw new Error("response had no balance_infos");
      const first = infos[0];
      const currency = typeof first["currency"] === "string" ? first["currency"] : "CNY";
      if (!isAvailable) throw new Error("Insufficient balance");
      const extras = infos.slice(1).map((info) => `${typeof info["currency"] === "string" ? info["currency"] : "?"} ${parseF64Field(info, "total_balance") ?? "?"}`);
      return balance(parseF64Field(first, "total_balance"), {
        unit: currency,
        planName: currency,
        ...extras.length > 0 ? { extra: extras.join(" \xB7 ") } : {}
      });
    }
    case "stepfun": {
      const body = await fetchJson("https://api.stepfun.com/v1/accounts", apiKey, timeoutSec, fetchImpl);
      return balance(parseF64Field(body, "balance") ?? 0, { unit: "CNY", planName: "StepFun" });
    }
    case "siliconflow-cn":
    case "siliconflow-en": {
      const domain = kind === "siliconflow-cn" ? "api.siliconflow.cn" : "api.siliconflow.com";
      const body = await fetchJson(`https://${domain}/v1/user/info`, apiKey, timeoutSec, fetchImpl);
      const data = body["data"];
      if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("Missing 'data' field in response");
      return balance(parseF64Field(data, "totalBalance") ?? 0, {
        unit: kind === "siliconflow-cn" ? "CNY" : "USD",
        planName: kind === "siliconflow-cn" ? "SiliconFlow" : "SiliconFlow (EN)"
      });
    }
    case "openrouter": {
      const body = await fetchJson("https://openrouter.ai/api/v1/credits", apiKey, timeoutSec, fetchImpl);
      const data = body["data"];
      const source = data !== null && typeof data === "object" && !Array.isArray(data) ? data : body;
      const totalCredits = parseF64Field(source, "total_credits") ?? 0;
      const totalUsage = parseF64Field(source, "total_usage") ?? 0;
      const remaining = totalCredits - totalUsage;
      if (remaining <= 0) throw new Error("No credits remaining");
      return balance(remaining, { total: totalCredits, used: totalUsage, unit: "USD", planName: "OpenRouter" });
    }
    case "novita": {
      const body = await fetchJson("https://api.novita.ai/v3/user/balance", apiKey, timeoutSec, fetchImpl);
      const available = (parseF64Field(body, "availableBalance") ?? 0) / 1e4;
      if (available <= 0) throw new Error("No balance remaining");
      return balance(available, { unit: "USD", planName: "Novita AI" });
    }
  }
}
async function queryProviderUsage(row, fetchImpl = fetch) {
  const script = parseUsageScript(row);
  if (script === null) return { kind: "error", error: "no usage query configured" };
  let config;
  try {
    const parsed = JSON.parse(row.settingsConfig ?? "{}");
    const env = parsed.env ?? {};
    const read = (key) => typeof env[key] === "string" ? env[key] : "";
    config = { apiKey: read("ANTHROPIC_AUTH_TOKEN"), baseUrl: read("ANTHROPIC_BASE_URL") };
  } catch {
    config = { apiKey: "", baseUrl: "" };
  }
  if (script.templateType === "token_plan" && script.codingPlanProvider === "volcengine") {
    if (script.accessKeyId === void 0 || script.secretAccessKey === void 0) return { kind: "error", error: "usage query is missing the Volcano AK/SK" };
    try {
      const usage = await queryArkPlanUsage(script.accessKeyId, script.secretAccessKey);
      return { kind: "plan", windows: usage.windows, ...usage.action !== void 0 ? { action: usage.action } : {} };
    } catch (cause) {
      return { kind: "error", error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  if (script.templateType === "token_plan" && script.codingPlanProvider === "minimax") {
    const isCn = config.baseUrl.toLowerCase().includes("api.minimaxi.com");
    const host = isCn ? "api.minimaxi.com" : "api.minimax.io";
    const url = `https://${host}/v1/api/openplatform/coding_plan/remains`;
    if (config.apiKey === "") return { kind: "error", error: "usage query is missing the provider API key" };
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(Math.max(1, script.timeoutSec) * 1e3)
      });
      const text = await response.text();
      if (!response.ok) return { kind: "error", error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      const body = JSON.parse(text);
      if (body !== null && typeof body === "object") {
        const baseResp = body["base_resp"];
        if (baseResp !== null && typeof baseResp === "object") {
          const statusCode = baseResp["status_code"];
          const statusMsg = baseResp["status_msg"];
          if (statusCode !== void 0 && statusCode !== 0) {
            return { kind: "error", error: `MiniMax error ${String(statusCode)}: ${typeof statusMsg === "string" ? statusMsg : "unknown"}` };
          }
        }
      }
      const windows = parseMinimaxPlan(body);
      if (windows === null) return { kind: "error", error: "usage response had no plan tiers" };
      return { kind: "plan", windows };
    } catch (cause) {
      return { kind: "error", error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  if (script.templateType === "general" || script.templateType === "newapi") {
    if (script.language !== "javascript") return { kind: "error", error: `unsupported usage script language: ${script.language}` };
    if (script.code.trim() === "") return { kind: "error", error: "usage script is empty" };
    const vars = {
      baseUrl: script.baseUrl ?? config.baseUrl,
      apiKey: config.apiKey,
      accessToken: script.accessToken ?? "",
      userId: script.userId ?? ""
    };
    const { request, extractor } = compileScript(script.code, script.timeoutSec);
    const substituted = substituteDeep(request, vars);
    return executeRequest(substituted, extractor, script.timeoutSec, fetchImpl);
  }
  if (script.templateType === "balance") {
    const kind = detectBalanceProvider(config.baseUrl);
    if (kind === null) return { kind: "error", error: `balance query does not recognize the provider endpoint: ${config.baseUrl}` };
    try {
      return await queryBuiltinBalance(kind, config.apiKey, script.timeoutSec, fetchImpl);
    } catch (cause) {
      return { kind: "error", error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  return { kind: "error", error: `unsupported usage template: ${script.templateType}` };
}

// src/routes.ts
var API_PREFIX = "/api/cc-switch";
function syncDepsFrom(deps) {
  return {
    dbPath: () => deps.dbPath(),
    enabled: () => deps.enabled(),
    settings: () => deps.settingsService(),
    credentials: () => deps.credentialsService()
  };
}
async function probeLiveRoutes(llm) {
  if (llm === null) return null;
  let ids;
  try {
    if (typeof llm.listProviders !== "function") return null;
    ids = llm.listProviders().map((entry) => String(entry?.id ?? "")).filter((id) => id.startsWith("ccs-"));
  } catch {
    return null;
  }
  const routes = /* @__PURE__ */ new Map();
  for (const id of ids) routes.set(id, { routable: true, models: 0 });
  if (typeof llm.listModels === "function") {
    await Promise.all(ids.map(async (id) => {
      try {
        const models = await llm.listModels(id);
        routes.set(id, { routable: true, models: Array.isArray(models) ? models.length : 0 });
      } catch {
      }
    }));
  }
  return routes;
}
function writeJson(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  res.end(payload);
}
function sameOriginBrowserRequest(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  const secFetchSite = req.headers["sec-fetch-site"];
  if (secFetchSite !== void 0) {
    return secFetchSite === "same-origin" || secFetchSite === "none";
  }
  if (typeof origin !== "string" || typeof host !== "string") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
function makeRoutes(deps) {
  const guard = (req, res) => {
    if (sameOriginBrowserRequest(req)) return true;
    writeJson(res, 403, { ok: false, error: "forbidden" });
    return false;
  };
  const state = {
    kind: "exact",
    path: `${API_PREFIX}/state`,
    handler: async (req, res) => {
      if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
      if (!guard(req, res)) return;
      if (!deps.enabled()) return writeJson(res, 200, { ok: true, enabled: false, ccSwitch: { available: false, providers: [] }, dsh: { managedRoutes: [] } });
      const dbPath = resolveDbPath(deps.dbPath());
      const syncState = readSyncState();
      const dshModel = readDshModelState(deps.settingsService());
      const liveRoutes = await probeLiveRoutes(deps.llmService());
      let providers;
      let available = true;
      let error;
      try {
        const rows = withDb(dbPath, (db) => listProviders(db));
        providers = rows.map((row) => {
          const route = dshRouteFor(row.id);
          const outcome = parseProviderConfig(row);
          const managed = syncState.managed[route];
          const parsed = outcome.kind === "ok" ? outcome.config : null;
          const live = liveRoutes === null ? void 0 : liveRoutes.get(route);
          return {
            id: row.id,
            appType: row.appType,
            name: row.name,
            isCurrent: row.isCurrent,
            route,
            status: managed !== void 0 && managed.entry.baseURL !== "" ? "synced" : "skipped",
            reason: outcome.kind === "skip" ? outcome.reason : void 0,
            baseUrl: parsed?.baseUrl ?? null,
            models: parsed?.models ?? [],
            envName: managed?.envName ?? null,
            tokenTail: parsed !== null && parsed.apiKey.length >= 4 ? parsed.apiKey.slice(-4) : null,
            hasKey: parsed !== null && parsed.apiKey.length > 0,
            usageConfigured: parseUsageScript(row) !== null,
            // When the llm service answered, every route gets an explicit
            // verdict: live routes report their model count, the rest report
            // routable:false so the card can say "awaiting DSH". Only an
            // unreachable llm service leaves both fields out.
            ...liveRoutes === null ? {} : { routable: live !== void 0 && live.routable, liveModels: live?.models ?? 0 }
          };
        });
      } catch (cause) {
        available = false;
        error = cause instanceof CcSwitchUnavailableError ? cause.message : `${cause instanceof Error ? cause.message : String(cause)}`;
        providers = [];
      }
      writeJson(res, 200, {
        ok: true,
        enabled: true,
        dbPath,
        ccSwitch: { available, ...error === void 0 ? {} : { error }, providers },
        sync: {
          lastSyncAt: syncState.lastSyncAt,
          lastError: syncState.lastError,
          managedRoutes: Object.keys(syncState.managed)
        },
        dsh: {
          defaultModel: dshModel.defaultModel,
          managedRoutes: Object.keys(syncState.managed),
          ...liveRoutes === null ? {} : { routableRoutes: [...liveRoutes.keys()] }
        }
      });
    }
  };
  const usageCache = /* @__PURE__ */ new Map();
  const usageRoute = {
    kind: "exact",
    path: `${API_PREFIX}/usage`,
    handler: async (req, res) => {
      if (req.method !== "GET") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
      if (!guard(req, res)) return;
      if (!deps.enabled()) return writeJson(res, 503, { ok: false, error: "dsh-switch is disabled in settings" });
      const url = new URL(req.url ?? "/api/cc-switch/usage", `http://${req.headers.host ?? "localhost"}`);
      const dshModel = readDshModelState(deps.settingsService());
      const requested = url.searchParams.get("route") ?? (typeof dshModel.defaultModel?.provider === "string" ? dshModel.defaultModel.provider : "");
      if (requested === "") return writeJson(res, 200, { ok: true, configured: false, reason: "no model in use" });
      const cached = usageCache.get(requested);
      if (cached !== void 0 && Date.now() - cached.at < cached.ttlMs) {
        return writeJson(res, 200, cached.value);
      }
      const respond = (value2, ttlMs2) => {
        usageCache.set(requested, { at: Date.now(), ttlMs: ttlMs2, value: value2 });
        writeJson(res, 200, value2);
      };
      const rows = withDb(resolveDbPath(deps.dbPath()), (db) => listProviders(db));
      const row = rows.find((candidate) => dshRouteFor(candidate.id) === requested);
      if (row === void 0) {
        return respond({ ok: true, route: requested, configured: false, reason: "provider is not managed by cc-switch sync" }, 6e4);
      }
      const script = parseUsageScript(row);
      if (script === null) {
        return respond({ ok: true, route: requested, provider: row.name, configured: false, reason: "no usage query configured for this provider" }, 6e4);
      }
      let result = await queryProviderUsage(row);
      if (result.kind === "error") {
        const secrets = /* @__PURE__ */ new Set();
        const consider = (value2) => {
          if (typeof value2 === "string" && value2.length >= 4) secrets.add(value2);
        };
        consider(script.accessKeyId);
        consider(script.secretAccessKey);
        consider(script.accessToken);
        try {
          const parsed = JSON.parse(row.settingsConfig ?? "{}");
          const env = parsed.env ?? {};
          for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) consider(typeof env[key] === "string" ? env[key] : void 0);
        } catch {
        }
        let message = result.error;
        for (const secret of secrets) message = message.replaceAll(secret, "***");
        result = { ...result, error: message };
      }
      const checkedAt = (/* @__PURE__ */ new Date()).toISOString();
      const ttlMs = result.kind === "error" ? 6e4 : Math.max(6e4, script.autoQueryIntervalMin * 6e4);
      const value = { ok: true, route: requested, provider: row.name, configured: true, result, checkedAt };
      respond(value, ttlMs);
    }
  };
  const sync = {
    kind: "exact",
    path: `${API_PREFIX}/sync`,
    handler: async (req, res) => {
      if (req.method !== "POST") return writeJson(res, 405, { ok: false, error: "method-not-allowed" });
      if (!guard(req, res)) return;
      if (!deps.enabled()) return writeJson(res, 503, { ok: false, error: "dsh-switch is disabled in settings" });
      try {
        const outcome = await runSync(syncDepsFrom(deps), { force: true });
        if (outcome.changed) deps.announceModelInputsChanged();
        writeJson(res, 200, { ...outcome });
      } catch (cause) {
        writeJson(res, 500, { ok: false, error: cause instanceof Error ? cause.message : String(cause) });
      }
    }
  };
  return [state, usageRoute, sync];
}
function readDshModelState(settingsService) {
  try {
    if (settingsService === null || typeof settingsService !== "object") return { defaultModel: null };
    const get = settingsService.get;
    if (typeof get !== "function") return { defaultModel: null };
    const adm = get.call(settingsService, "agent-default-model");
    const defaultModel = typeof adm?.provider === "string" && typeof adm?.model === "string" ? { provider: adm.provider, model: adm.model } : null;
    return { defaultModel };
  } catch {
    return { defaultModel: null };
  }
}

// src/mount-once.ts
var MOUNTED = /* @__PURE__ */ Symbol.for("dsh-web.mounted-plugins");
function mountedSet() {
  const registry = globalThis;
  return registry[MOUNTED] ??= /* @__PURE__ */ new Set();
}
function mountOnce(packageName, fn) {
  return ((...args) => {
    const mounted = mountedSet();
    if (mounted.has(packageName)) return;
    mounted.add(packageName);
    const ctx = args[0];
    ctx?.effect?.(() => () => {
      mounted.delete(packageName);
    });
    return fn(...args);
  });
}

// src/loop.ts
function startSyncLoop(deps, options) {
  const { intervalMs, announce, onError } = options;
  let busy = false;
  let pending = false;
  let failures = 0;
  const run = () => {
    if (busy) {
      pending = true;
      return;
    }
    try {
      if (!deps.enabled()) return;
    } catch (error) {
      report(error);
      return;
    }
    busy = true;
    void runSync(deps, { force: false }).then((outcome) => {
      if (outcome.changed) announce?.();
    }).catch((error) => {
      report(error);
    }).finally(() => {
      busy = false;
      if (pending) {
        pending = false;
        run();
      }
    });
  };
  const report = (error) => {
    failures += 1;
    if (failures === 1) onError?.(error);
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  let unwatch = () => {
  };
  try {
    unwatch = watchCcSwitchDb(resolveDbPath(deps.dbPath()), run);
  } catch (error) {
    report(error);
  }
  run();
  return () => {
    clearInterval(timer);
    unwatch();
  };
}

// src/index.ts
var CC_SWITCH_NAMESPACE = "cc-switch";
var Config = z.object({
  enabled: z.boolean().default(true),
  dbPath: z.string().default(""),
  syncInterval: z.number().step(1).min(1).max(3600).default(30)
});
var inject = ["webServer"];
function announceModelInputsChanged(ctx) {
  try {
    ctx?.emit?.("llm/adapters-updated");
  } catch {
  }
}
var apply = mountOnce("dsh-switch", applyImpl);
function applyImpl(ctx, config) {
  let current = () => config ?? {};
  let settingsService;
  let credentialsService;
  let llmService = null;
  ctx.inject?.(["settings"], (settingsCtx) => {
    const settings = settingsCtx?.settings;
    settingsService = settings;
    try {
      if (typeof settings?.installSection === "function") {
        settings.installSection(ctx, CC_SWITCH_NAMESPACE, Config, config ?? {}, {
          setSource: (source) => {
            current = source;
          }
        });
      } else if (typeof settings?.register === "function") {
        const scope = settings.register(CC_SWITCH_NAMESPACE, Config, { base: config ?? {} });
        current = () => scope?.get?.() ?? (config ?? {});
        scope?.watch?.(() => {
        });
      }
    } catch {
    }
  });
  ctx.inject?.(["credentials"], (credentialsCtx) => {
    credentialsService = credentialsCtx?.credentials;
  });
  ctx.inject?.(["llm"], (llmCtx) => {
    const llm = llmCtx?.llm;
    llmService = llm !== null && typeof llm === "object" && typeof llm.listProviders === "function" ? llm : null;
  });
  const deps = {
    dbPath: () => current()?.dbPath ?? "",
    enabled: () => current()?.enabled ?? true,
    settingsService: () => settingsService,
    credentialsService: () => credentialsService,
    llmService: () => llmService,
    announceModelInputsChanged: () => announceModelInputsChanged(ctx)
  };
  const routes = makeRoutes(deps);
  ctx.effect(() => {
    const disposers = [];
    try {
      for (const route of routes) disposers.push(ctx.webServer.register(route));
    } catch (error) {
      for (const dispose of disposers) dispose();
      throw error;
    }
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "dsh-switch: cc-switch bridge routes");
  ctx.effect(() => startSyncLoop(syncDepsFrom(deps), {
    intervalMs: safeIntervalMs(current),
    announce: () => deps.announceModelInputsChanged(),
    onError: (error) => {
      ctx.logger?.error?.(error);
    }
  }), "dsh-switch: sync loop");
}
function safeIntervalMs(current) {
  try {
    const seconds = Math.floor(Number(current()?.syncInterval ?? 30));
    if (!Number.isFinite(seconds)) return 3e4;
    return Math.min(3600, Math.max(1, seconds)) * 1e3;
  } catch {
    return 3e4;
  }
}
export {
  CC_SWITCH_NAMESPACE,
  Config,
  apply,
  inject,
  runSync,
  startSyncLoop,
  syncDepsFrom
};
