window.__ModuleLoader__.load({
	id: "dsh-switch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/CcSwitchSection.tsx
var import_react2 = require("react");

// src/client/api.ts
async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `${url} failed: ${response.status}`);
  return body;
}
async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const parsed = await response.json();
  if (!response.ok || parsed.ok === false) throw new Error(parsed.error ?? `${url} failed: ${response.status}`);
  return parsed;
}
async function fetchState() {
  return getJson("/api/cc-switch/state");
}
async function syncNow() {
  return postJson("/api/cc-switch/sync", {});
}
async function fetchUsage(route) {
  return getJson(`/api/cc-switch/usage${route !== void 0 && route !== "" ? `?route=${encodeURIComponent(route)}` : ""}`);
}

// src/client/format.ts
function hostOf(url) {
  if (url === null || url === "") return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// src/client/refresh.ts
var import_react = require("react");
var revision = 0;
var listeners = /* @__PURE__ */ new Set();
function bumpSyncRevision() {
  revision += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
    }
  }
}
function subscribe(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
var getRevision = () => revision;
function useSyncRevision() {
  return (0, import_react.useSyncExternalStore)(subscribe, getRevision);
}

// src/client/locales.ts
var NS = "cc-switch";
var zh = {
  unavailable: "\u672A\u627E\u5230 cc-switch \u6570\u636E\u5E93\uFF1A{message}",
  notAvailable: "cc-switch \u4E0D\u53EF\u7528",
  syncTitle: "cc-switch \u5B9E\u65F6\u540C\u6B65",
  syncNow: "\u7ACB\u5373\u540C\u6B65",
  syncing: "\u540C\u6B65\u4E2D\u2026",
  syncStatus: "\u81EA\u52A8\u540C\u6B65\u5DF2\u5F00\u542F \xB7 \u4E0A\u6B21\u540C\u6B65 {time}",
  syncPending: "\u81EA\u52A8\u540C\u6B65\u5DF2\u5F00\u542F\uFF0C\u7B49\u5F85\u9996\u6B21\u540C\u6B65\u2026",
  syncLastError: "\u540C\u6B65\u51FA\u9519\uFF1A{message}\uFF08\u5C06\u81EA\u52A8\u91CD\u8BD5\uFF09",
  syncDone: "\u540C\u6B65\u5B8C\u6210\uFF1A\u66F4\u65B0 {applied} \u4E2A\u4F9B\u5E94\u5546\u3001\u79FB\u9664 {removed} \u4E2A\uFF0C{default}",
  syncDefaultFollowed: "\u9ED8\u8BA4\u6A21\u578B\u5DF2\u8DDF\u968F cc-switch \u5207\u6362",
  syncDefaultUntouched: "\u9ED8\u8BA4\u6A21\u578B\u672A\u53D8\u5316",
  syncFailed: "\u540C\u6B65\u5931\u8D25\uFF1A{message}",
  current: "cc-switch \u5F53\u524D",
  noProviders: "cc-switch \u4E2D\u6CA1\u6709\u4F9B\u5E94\u5546\u914D\u7F6E\u3002",
  appType_claude: "Claude",
  appType_codex: "Codex/GPT",
  appType_gemini: "Gemini",
  appType_openclaw: "OpenClaw",
  baseUrl: "\u63A5\u53E3\u5730\u5740",
  models: "\u6A21\u578B",
  tokenTail: "\u5BC6\u94A5\u5C3E\u53F7",
  dshDefault: "DSH \u5F53\u524D\u9ED8\u8BA4\u6A21\u578B\uFF1A{provider} / {model}",
  planWindow5h: "5h",
  planWindowWeekly: "\u5468",
  planWindowMonthly: "\u6708",
  planWindowDaily: "\u65E5",
  usage5h: "5h",
  usageWeekly: "\u5468",
  usageMonthly: "\u6708",
  usageRemaining: "\u4F59",
  usageUsed: "\u5DF2\u7528",
  usageResets: "\u91CD\u7F6E",
  usageLoading: "\u7528\u91CF\u67E5\u8BE2\u4E2D\u2026",
  usageRefresh: "\u5237\u65B0\u7528\u91CF",
  usageQueryFailed: "\u7528\u91CF\u67E5\u8BE2\u5931\u8D25",
  usageCheckedAt: "\u67E5\u8BE2\u4E8E",
  liveInDsh: "\u5DF2\u5728 DSH \u751F\u6548",
  liveInDshPending: "\u5F85 DSH \u6CE8\u518C",
  liveInDshPendingHint: "\u5DF2\u5199\u5165 DSH \u8BBE\u7F6E\uFF0C\u4F46 DSH \u7684\u6A21\u578B\u5217\u8868\u5C1A\u672A\u6CE8\u518C\u8BE5\u8DEF\u7531\uFF08\u4E0B\u4E00\u6B21\u540C\u6B65\u6216\u91CD\u542F\u540E\u4F1A\u751F\u6548\uFF09",
  liveModelsInDsh: "DSH \u5DF2\u52A0\u8F7D {count} \u4E2A"
};
var en = {
  unavailable: "cc-switch database not found: {message}",
  notAvailable: "cc-switch unavailable",
  syncTitle: "cc-switch live sync",
  syncNow: "Sync now",
  syncing: "Syncing\u2026",
  syncStatus: "Auto-sync on \xB7 last synced {time}",
  syncPending: "Auto-sync on, waiting for the first sync\u2026",
  syncLastError: "Sync error: {message} (will retry automatically)",
  syncDone: "Sync finished: {applied} provider(s) updated, {removed} removed; {default}",
  syncDefaultFollowed: "default model followed the cc-switch switch",
  syncDefaultUntouched: "default model unchanged",
  syncFailed: "Sync failed: {message}",
  current: "current in cc-switch",
  noProviders: "No providers configured in cc-switch.",
  appType_claude: "Claude",
  appType_codex: "Codex/GPT",
  appType_gemini: "Gemini",
  appType_openclaw: "OpenClaw",
  baseUrl: "Base URL",
  models: "Models",
  tokenTail: "Key tail",
  dshDefault: "DSH default model: {provider} / {model}",
  planWindow5h: "5h",
  planWindowWeekly: "Wk",
  planWindowMonthly: "Mo",
  planWindowDaily: "Day",
  usage5h: "5h",
  usageWeekly: "Wk",
  usageMonthly: "Mo",
  usageRemaining: "Left",
  usageUsed: "Used",
  usageResets: "resets",
  usageLoading: "querying usage\u2026",
  usageRefresh: "refresh usage",
  usageQueryFailed: "usage query failed",
  usageCheckedAt: "checked",
  liveInDsh: "live in DSH",
  liveInDshPending: "awaiting DSH",
  liveInDshPendingHint: "Written to DSH settings, but the DSH model list has not registered this route yet (the next sync or a restart picks it up)",
  liveModelsInDsh: "{count} loaded in DSH"
};
var dictionaries = { zh, en };

// src/client/CcSwitchSection.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var COLORS = {
  input: "#4a8fd9",
  cacheRead: "#8f8f96",
  cacheWrite: "#d99a3a",
  output: "#43a25a"
};
var APP_TYPE_COLORS = {
  claude: "#d99a3a",
  codex: "#4a8fd9",
  gemini: "#43a25a",
  openclaw: "#a06fd9"
};
var CARD = {
  border: "1px solid rgba(128,128,128,0.25)",
  borderRadius: 10,
  padding: "10px 12px",
  margin: "8px 0"
};
var BADGE = (color) => ({
  display: "inline-block",
  fontSize: 11,
  lineHeight: "16px",
  padding: "0 8px",
  borderRadius: 999,
  border: `1px solid ${color}`,
  color,
  marginLeft: 6,
  verticalAlign: "middle"
});
var BUTTON = {
  fontSize: 12,
  padding: "3px 12px",
  borderRadius: 6,
  border: "1px solid rgba(128,128,128,0.45)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer"
};
function fallbackT() {
  return (key, params) => {
    let text = en[key] ?? key;
    if (params !== void 0) {
      for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };
}
function interpolate(t, key, params) {
  return t(key, params);
}
var PLAN_WINDOW_LABEL_KEYS = {
  fiveHour: "planWindow5h",
  weekly: "planWindowWeekly",
  monthly: "planWindowMonthly",
  daily: "planWindowDaily"
};
function planWindowLabel(t, name) {
  const key = PLAN_WINDOW_LABEL_KEYS[name];
  return key === void 0 ? name : t(key);
}
function ProviderUsageRow(props) {
  const { t, route } = props;
  const [usage, setUsage] = (0, import_react2.useState)(null);
  const [tick, setTick] = (0, import_react2.useState)(0);
  (0, import_react2.useEffect)(() => {
    let disposed = false;
    void (async () => {
      try {
        const response = await fetchUsage(route);
        if (!disposed) setUsage(response);
      } catch {
      }
    })();
    return () => {
      disposed = true;
    };
  }, [route, tick]);
  if (usage === null) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { opacity: 0.45, fontSize: 12, marginTop: 2 }, children: t("usageLoading") });
  if (usage.configured !== true || usage.result === void 0) return null;
  const result = usage.result;
  const refresh = /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "button",
    {
      type: "button",
      title: t("usageRefresh"),
      onClick: () => setTick((value) => value + 1),
      style: { border: "none", background: "transparent", cursor: "pointer", opacity: 0.5, padding: "0 2px", fontSize: 11 },
      children: "\u27F3"
    }
  );
  let text;
  let color = "inherit";
  if (result.kind === "error") {
    text = `${t("usageQueryFailed")}: ${result.error}`;
    color = "#d96a4a";
  } else if (result.kind === "plan") {
    text = Object.entries(result.windows).map(([name, win]) => `${planWindowLabel(t, name)} ${win.percent.toFixed(1)}%`).join(" \xB7 ");
  } else {
    const fmt = (value) => value === void 0 ? "?" : value >= 100 ? value.toFixed(0) : value.toFixed(2);
    text = result.remaining !== void 0 ? `${t("usageRemaining")} ${fmt(result.remaining)}${result.unit !== void 0 ? ` ${result.unit}` : ""}${result.planName !== void 0 ? ` \xB7 ${result.planName}` : ""}` : result.extra !== void 0 ? result.extra : `${t("usageQueryFailed")}: empty`;
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { fontSize: 12, marginTop: 2, color, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
      "\u{1F4CA} ",
      text
    ] }),
    refresh,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { opacity: 0.45 }, children: usage.checkedAt !== void 0 ? `\xB7 ${t("usageCheckedAt")} ${new Date(usage.checkedAt).toLocaleTimeString()}` : null })
  ] });
}
function CcSwitchSection(props) {
  const t = props.t ?? fallbackT();
  const syncRevision = useSyncRevision();
  const [state, setState] = (0, import_react2.useState)({ status: "loading" });
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const [message, setMessage] = (0, import_react2.useState)(null);
  const loadState = (0, import_react2.useCallback)(async () => {
    try {
      const data2 = await fetchState();
      setState({ status: "ready", data: data2 });
    } catch (cause) {
      setState({ status: "ready", error: cause instanceof Error ? cause.message : String(cause) });
    }
  }, []);
  (0, import_react2.useEffect)(() => {
    void loadState();
  }, [loadState, syncRevision]);
  const onSync = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await syncNow();
      setMessage({
        kind: "ok",
        text: interpolate(t, "syncDone", {
          applied: result.applied.length,
          removed: result.removed.length,
          default: result.defaultChanged ? t("syncDefaultFollowed") : t("syncDefaultUntouched")
        })
      });
      await loadState();
    } catch (cause) {
      setMessage({ kind: "err", text: interpolate(t, "syncFailed", { message: cause instanceof Error ? cause.message : String(cause) }) });
    } finally {
      setBusy(false);
    }
  };
  const data = state.data;
  const cc = data?.ccSwitch;
  const sync = data?.sync;
  const providers = cc?.providers ?? [];
  const defaultModel = data?.dsh.defaultModel;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { fontSize: 13, maxWidth: 860 }, children: [
    cc !== void 0 && !cc.available ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { opacity: 0.8 }, children: cc.error !== void 0 && cc.error !== "" ? interpolate(t, "unavailable", { message: cc.error }) : t("notAvailable") }) : null,
    message !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { color: message.kind === "ok" ? COLORS.output : "#d96a4a", whiteSpace: "pre-wrap" }, children: message.text }) : null,
    cc?.available ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: CARD, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t("syncTitle") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { opacity: 0.6, fontSize: 12 }, children: data?.dbPath }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: BUTTON, onClick: () => void onSync(), disabled: busy, children: busy ? t("syncing") : t("syncNow") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { opacity: 0.6, fontSize: 12, margin: "6px 0" }, children: sync?.lastError !== null && sync?.lastError !== void 0 && sync.lastError !== "" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "#d96a4a" }, children: interpolate(t, "syncLastError", { message: sync.lastError }) }) : sync?.lastSyncAt !== null && sync?.lastSyncAt !== void 0 ? interpolate(t, "syncStatus", { time: new Date(sync.lastSyncAt).toLocaleString() }) : t("syncPending") }),
      providers.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { opacity: 0.7 }, children: t("noProviders") }) : null,
      providers.map((provider) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { borderTop: "1px solid rgba(128,128,128,0.14)", padding: "8px 0" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: BADGE(APP_TYPE_COLORS[provider.appType] ?? "rgba(128,128,128,0.5)"), children: t(`appType_${provider.appType}`) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: provider.name }),
          provider.isCurrent ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: BADGE(COLORS.input), children: t("current") }) : null,
          provider.routable === true ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: BADGE(COLORS.output), children: t("liveInDsh") }) : null,
          provider.routable === false ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: BADGE(COLORS.cacheWrite), title: t("liveInDshPendingHint"), children: t("liveInDshPending") }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
          provider.status === "synced" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { opacity: 0.6, fontSize: 12 }, children: provider.route }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { opacity: 0.55, fontSize: 12 }, title: provider.reason, children: [
            "\u26A0 ",
            provider.reason
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { opacity: 0.7, fontSize: 12, marginTop: 2 }, children: [
          provider.baseUrl !== null ? `${t("baseUrl")}: ${hostOf(provider.baseUrl)}` : null,
          provider.hasKey ? ` \xB7 ${t("tokenTail")} \u2026${provider.tokenTail ?? ""}` : null,
          provider.envName !== null ? ` \xB7 ${provider.envName}` : null
        ] }),
        provider.models.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { opacity: 0.7, fontSize: 12, marginTop: 2 }, children: [
          t("models"),
          ": ",
          provider.models.join(", "),
          provider.routable === true && provider.liveModels !== void 0 ? ` \xB7 ${interpolate(t, "liveModelsInDsh", { count: provider.liveModels })}` : null
        ] }) : null,
        provider.usageConfigured ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ProviderUsageRow, { route: provider.route, t }) : null
      ] }, `${provider.appType}:${provider.id}`)),
      defaultModel !== void 0 && defaultModel !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { opacity: 0.6, fontSize: 12, margin: "6px 0 0" }, children: interpolate(t, "dshDefault", { provider: defaultModel.provider, model: defaultModel.model }) }) : null
    ] }) }) : null
  ] });
}

// src/client/ConversationUsage.tsx
var import_react3 = require("react");
var import_jsx_runtime2 = require("react/jsx-runtime");
var REFRESH_MS = 6e4;
var NOOP_SUBSCRIBE = () => () => {
};
var NOOP_SNAPSHOT = () => null;
var usageCache = /* @__PURE__ */ new Map();
var CACHE_FRESH_MS = 6e4;
var cacheKeyOf = (route) => route ?? "__default__";
var BADGE2 = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontSize: 11,
  lineHeight: "18px",
  padding: "0 8px",
  borderRadius: 999,
  border: "1px solid rgba(128,128,128,0.35)",
  opacity: 0.85,
  whiteSpace: "nowrap",
  verticalAlign: "middle"
};
var OK = "#43a25a";
var WARN = "#d99a3a";
var HOT = "#d96a4a";
var heat = (percent) => percent >= 90 ? HOT : percent >= 70 ? WARN : OK;
function summarize(data, t) {
  if (data.configured !== true || data.result === void 0) return null;
  const result = data.result;
  if (result.kind === "error") return { text: "\u26A0", color: WARN, title: result.error };
  if (result.kind === "plan") {
    const windows = result.windows;
    const parts = [];
    const five = windows["fiveHour"];
    if (five !== void 0) parts.push(`${t("usage5h")} ${five.percent.toFixed(1)}%`);
    const weekly = windows["weekly"];
    if (weekly !== void 0) parts.push(`${t("usageWeekly")} ${weekly.percent.toFixed(1)}%`);
    const monthly = windows["monthly"];
    if (monthly !== void 0) parts.push(`${t("usageMonthly")} ${monthly.percent.toFixed(1)}%`);
    if (parts.length === 0) return null;
    const worst = Math.max(...Object.values(windows).map((window) => window.percent));
    const resetParts = Object.values(windows).map((window) => window.resetsAt).filter((value) => value !== null);
    const title = `${data.provider ?? ""} \xB7 ${parts.join(" \xB7 ")}${resetParts.length > 0 ? ` \xB7 ${t("usageResets")} ${new Date(resetParts[0]).toLocaleString()}` : ""}`;
    return { text: parts.join(" \xB7 "), color: heat(worst), title };
  }
  const unit = result.unit ?? "";
  const fmt = (value) => value === void 0 ? "?" : value >= 100 ? value.toFixed(0) : value.toFixed(2);
  if (result.remaining !== void 0) {
    const total = result.total;
    const percent = total !== void 0 && total > 0 && result.used !== void 0 ? result.used / total * 100 : void 0;
    const text = `${t("usageRemaining")} ${fmt(result.remaining)}${unit === "" ? "" : ` ${unit}`}`;
    const title = `${data.provider ?? ""}${result.planName !== void 0 ? ` \xB7 ${result.planName}` : ""}${percent !== void 0 ? ` \xB7 ${t("usageUsed")} ${percent.toFixed(1)}%` : ""}`;
    return { text, color: percent !== void 0 ? heat(percent) : OK, title };
  }
  if (result.extra !== void 0) return { text: result.extra, color: OK, title: data.provider ?? result.extra };
  return null;
}
function ConversationUsage(props = {}) {
  const t = (key) => en[key] ?? key;
  const store = props.directory;
  const selection = (0, import_react3.useSyncExternalStore)(
    store === void 0 ? NOOP_SUBSCRIBE : (listener) => store.subscribe(listener),
    store === void 0 ? NOOP_SNAPSHOT : () => store.getSnapshot()
  );
  const route = store === void 0 ? void 0 : selection?.current?.provider ?? void 0;
  const syncRevision = useSyncRevision();
  const [usage, setUsage] = (0, import_react3.useState)(null);
  const [pending, setPending] = (0, import_react3.useState)(false);
  const requestSeq = (0, import_react3.useRef)(0);
  const load = (0, import_react3.useCallback)(async (options) => {
    const seq = ++requestSeq.current;
    const key = cacheKeyOf(route);
    if (options?.silent !== true) {
      const cached = usageCache.get(key);
      if (cached !== void 0 && Date.now() - cached.at < CACHE_FRESH_MS) {
        setUsage(cached.value);
        setPending(false);
      } else {
        setUsage(null);
        setPending(true);
      }
    }
    try {
      const response = await fetchUsage(route);
      usageCache.set(key, { at: Date.now(), value: response });
      if (requestSeq.current === seq) {
        setUsage(response);
        setPending(false);
      }
    } catch {
      if (requestSeq.current === seq) setPending(false);
    }
  }, [route]);
  (0, import_react3.useEffect)(() => {
    void load();
    const timer = setInterval(() => void load({ silent: true }), REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load({ silent: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);
  const seenRevision = (0, import_react3.useRef)(syncRevision);
  (0, import_react3.useEffect)(() => {
    if (seenRevision.current === syncRevision) return;
    seenRevision.current = syncRevision;
    void load({ silent: true });
  }, [syncRevision, load]);
  const summary = usage === null ? null : summarize(usage, t);
  if (summary === null) {
    return pending ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: { ...BADGE2, opacity: 0.5 }, children: [
      "\u{1F4CA} ",
      t("usageLoading")
    ] }) : null;
  }
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: BADGE2, title: summary.title, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { width: 6, height: 6, borderRadius: 999, background: summary.color, display: "inline-block" } }),
    summary.text
  ] });
}

// src/client/index.tsx
var inject = ["slots", "locale"];
var APPLY_CLAIM = /* @__PURE__ */ Symbol.for("dsh-switch.client.applied");
var modelDirectories = null;
function directoryStoreFor(sessionId) {
  if (sessionId === void 0 || modelDirectories === null) return void 0;
  try {
    return modelDirectories.directoryFor(sessionId)?.store;
  } catch {
    return void 0;
  }
}
function apply(ctx) {
  const registry = globalThis;
  if (registry[APPLY_CLAIM] === true) return;
  registry[APPLY_CLAIM] = true;
  ctx.effect?.(() => () => {
    registry[APPLY_CLAIM] = false;
  }, "dsh-switch: apply claim");
  try {
    ctx.inject(["modelDirectories"], (scope) => {
      modelDirectories = scope?.modelDirectories ?? null;
    });
  } catch {
  }
  try {
    ctx.inject(["remote"], (scope) => {
      const remote = scope?.remote;
      if (typeof remote?.$on !== "function") return;
      remote.$on("llm/adapters-updated", () => {
        bumpSyncRevision();
      });
      remote.$on("settings/document-updated", (ns) => {
        if (ns === "llm-pi-ai" || ns === "agent-default-model" || ns === void 0) bumpSyncRevision();
      });
    });
  } catch {
  }
  try {
    ctx.effect(() => {
      try {
        return ctx.locale.register(NS, dictionaries);
      } catch {
        return () => {
        };
      }
    }, "dsh-switch: dictionaries");
  } catch {
  }
  try {
    ctx.slots.inject("settings.section", () => {
      try {
        const unregister = ctx.slots.register(
          { name: "settings.section", id: "cc-switch", order: 40, label: "CC Switch", locale: NS, inject: () => ({}) },
          CcSwitchSection
        );
        return () => {
          unregister();
        };
      } catch (error) {
        console.error("[dsh-switch] settings.section registration failed:", error);
        return () => {
        };
      }
    });
  } catch (error) {
    console.error("[dsh-switch] settings.section slot unavailable:", error);
  }
  try {
    ctx.slots.inject("conversation.input.right", () => {
      try {
        const unregister = ctx.slots.register(
          { name: "conversation.input.right", id: "cc-switch-usage", order: 10, locale: NS, inject: (sessionId) => ({ sessionId, directory: directoryStoreFor(sessionId) }) },
          ConversationUsage
        );
        return () => {
          unregister();
        };
      } catch (error) {
        console.error("[dsh-switch] conversation usage registration failed:", error);
        return () => {
        };
      }
    });
  } catch (error) {
    console.error("[dsh-switch] conversation.input.right slot unavailable:", error);
  }
}

		return module.exports;
	}
});
