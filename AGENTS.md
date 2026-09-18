# AGENTS.md

Guidance for coding agents (and humans) changing this repository. Read this
before the first edit; it encodes decisions and past failures that are not
obvious from the code.

**What this is.** `dsh-switch` is a DeepSeek Harness (DSH) plugin that bridges
[cc-switch](https://github.com/farion1231/cc-switch): it mirrors every usable
cc-switch provider into DSH's `llm-pi-ai` settings namespace the moment you hit
save (fs.watch + a 30 s signature poll as fallback), and surfaces each
provider's quota/balance — plan windows, account balance, or cc-switch's custom
usage script — as a composer badge and a settings card. Distribution is this
GitHub repo only; the DSH plugin market installs it as
`dsh plugin --profile web add github:a981008/dsh-switch`.

## Commands

```sh
pnpm install            # first checkout (run on a real Node, see below)
node build.mjs          # bundle src/ → lib/ (esbuild, target node24)
node test/run.mjs       # THE gate: tsc --noEmit first, then smoke + integration
pnpm typecheck          # tsc --noEmit alone
```

- Run `node test/run.mjs` after **every** change. It prints one `ok`/`FAIL`
  line per check; everything must pass. The suite is all-or-nothing.
- The typecheck step is not decoration: esbuild strips types without checking
  them, and a wrong-shaped dependency object once shipped as a silently dead
  automatic sync (see invariants §1). `tsc --noEmit` is the gate that catches
  interface-shape mistakes; never bypass it.
- Node >= 24 is required (`engines.node`). On a machine without a matching
  system Node, the DSH Desktop binary can act as one:
  `ELECTRON_RUN_AS_NODE=1 "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop" test/run.mjs`
  (the host bundles Node 24.x / Electron 43).
- Conversely, **never** run `pnpm` under `ELECTRON_RUN_AS_NODE` — package
  management needs a real Node; use the system one.
- After changing anything in `src/`, rebuild AND commit `lib/` together with
  the source (see invariants §7). The tarball
  (`npm pack --dry-run`) must always contain `lib/index.js`, `lib/client.js`,
  `cordis.patch.yml`.

## Architecture

```
cc-switch SQLite (READ-ONLY)                              ~/.cc-switch/cc-switch.db
   │  fs.watch on the db directory (250 ms debounce, ~300 ms latency)
   │  + signature poll (configurable, default 30 s, safety net)
   ▼
sync engine  src/sync.ts  runSync(deps, {force})
   │  plans set/unset ops against the LIVE settings map (self-healing diff,
   │  not snapshot-only), writes state snapshots, follows default-model switches
   ▼
DSH settings service                    llm-pi-ai.providers[ccs-*] + agent-default-model
DSH credentials service                 CCS_*_API_KEY  (values never in settings.yaml)
   │  announce: ctx.emit('llm/adapters-updated') — CHANGED syncs only
   ▼
DSH re-registers adapters → model catalog refresh → picker updates (~1 s)
   + DSH forwards 'llm/adapters-updated' / 'settings/document-updated' to the web client
   ▼
client  src/client/*  settings card (CcSwitchSection) + composer badge (ConversationUsage)
        both re-render via useSyncRevision() and re-fetch through src/routes.ts HTTP routes
```

Host-facing HTTP routes (mounted in `src/routes.ts`, prefix `/api/cc-switch`):
`GET /state` (merge state.json with the live registry: `routable`, `liveModels`),
`POST /sync` (force a sync now), `GET /usage?route=&model=` (query one provider's
usage; honors the per-route cache). Same-origin guarded by the host webserver.

### File map

| File | Role |
|---|---|
| `src/index.ts` | Plugin entry: config schema (`enabled`, `dbPath`, `syncInterval`), mounts routes, starts the sync loop via `ctx.effect`, emits the announce |
| `src/routes.ts` | HTTP route handlers, `syncDepsFrom(deps)` — **the single deps-shape mapping** — and `announceModelInputsChanged` |
| `src/loop.ts` | `startSyncLoop`: busy/pending guard, immediate first pass, watch + poll, first-failure reporting |
| `src/sync.ts` | `runSync` engine: plan/diff/apply, default-model follow, per-route snapshots, `watchCcSwitchDb` |
| `src/ccswitch-db.ts` | Read-only SQLite access (`DatabaseSync(path, { readOnly: true })`), provider parsing, `dshRouteFor` → `ccs-*` ids |
| `src/usage.ts` | Usage queries: built-in `balance` templates (DeepSeek/StepFun/SiliconFlow/OpenRouter/Novita…), `general`/`newapi` scripts inside a `node:vm` sandbox (no eval/wasm, 2 s cap), per-route cache |
| `src/ark-plan.ts` | Volcano Ark / MiniMax `token_plan` plan-window queries, CN/Intl detected from the base URL |
| `src/mount-once.ts` | Single-instance guard: the composition may load the package twice; the second mount must not re-register routes |
| `src/host-modules.d.ts` | Ambient types for host modules the plugin touches (`@deepseek-ai/*`, cordis) |
| `src/client/index.tsx` | Client entry: slot registration, `remote.$on` subscriptions, model-directory injection |
| `src/client/CcSwitchSection.tsx` | Settings card: provider rows, sync badges (`live in DSH` / `awaiting DSH`), usage lines |
| `src/client/ConversationUsage.tsx` | Composer badge: follows the SESSION's model selection (subscribes to the model store), paints cache first, silent refresh on sync |
| `src/client/api.ts` | Typed client for the HTTP routes |
| `src/client/refresh.ts` | `bumpSyncRevision` / `useSyncRevision` — module-level revision store that re-renders both surfaces |
| `src/client/locales.ts` | All user-visible strings, zh + en |
| `test/run.mjs` | Typecheck gate + bundler + runner |
| `test/integration.ts` | End-to-end suite: harness injects `{settings, credentials, llm}` mocks, records emitted events, drives loop/watch/route paths |
| `market/a981008__dsh-switch.yml` | The catalog entry submitted to awesome-dsh-plugin (one file, keep in sync with reality) |

## Hard invariants

Breaking any of these has either shipped a bug or would leak secrets. Tests
cover most of them; keep it that way.

1. **Deps shape.** `runSync` / `startSyncLoop` take `SyncDeps`
   (`dbPath()`, `enabled()`, `settings()`, `credentials()`). The plugin's
   `RouteDeps` expose differently-named accessors. Always map through
   `syncDepsFrom(deps)` (`src/routes.ts`) — never pass `RouteDeps` as-is.
   This exact mistake made every automatic sync throw
   `deps.settings is not a function` inside a swallowed `.catch`, so only the
   manual button worked. `tsc --noEmit` flags it; keep the gate.
2. **Namespace ownership.** Only ever create/update/remove provider entries
   under the `ccs-*` namespace and credential refs named `CCS_*_API_KEY`.
   User-owned provider entries (non-`ccs-*`) are never touched.
3. **Default-model ownership.** Write `agent-default-model` only when it is
   unset, or when it already points at one of our `ccs-*` routes (bootstrap and
   vanish-repair). A default pinned anywhere else — the user's own provider, or
   a third-party wrapper of our route such as modlens's `modlens-ccs-…`
   "(modlens vision)" twin — must survive syncs untouched. Covered by four
   named integration cases ("default model: …").
4. **Announce semantics.** Emit `llm/adapters-updated` only when a sync actually
   changed something (applied/removed/defaultChanged), from both the loop and
   the manual route. Emit with NO arguments — the host's forwarded-event
   marshalling rejects non-JSON args. A no-op sync announces nothing (tested).
5. **Secrets.** API keys live only in the DSH credentials service; settings
   carry the ref name. Never log a key; usage errors are scrubbed of every
   credential the row contributed; the UI shows at most the last 4 characters.
   The cc-switch DB is opened `readOnly: true` — never write to it.
6. **Self-healing diff, not blind writes.** `runSync` diffs the plan against the
   LIVE `llm-pi-ai.providers` map (`liveEntryMatches` compares
   displayName/api/apiKeyEnv/baseURL and the full models array). This is what
   repairs externally-lost or stale entries — e.g. a model removed in cc-switch
   disappears from DSH on the next pass. Do not weaken the live check into a
   snapshot-only diff.
7. **`lib/` is committed, no `prepare` script.** Git/market installs must work
   without a build step (pnpm would otherwise prompt to approve build scripts).
   Changing `src/` without rebuilding + committing `lib/` ships stale bundles —
   the running host keeps loading `lib/`, not `src/`.
8. **Single mount.** The host may load the package twice (link + copy). Routes
   and the loop register through `src/mount-once.ts`'s guard; a second mount
   must be a no-op, not a route collision.
9. **Client events.** The client subscribes via `remote.$on` to
   `llm/adapters-updated` and to `settings/document-updated` (namespaces
   `llm-pi-ai`, `agent-default-model`, or undefined) → `bumpSyncRevision()`.
   All client state reads go through that revision so both surfaces stay in
   lockstep; `useSyncExternalStore` is the pattern.
10. **Slots.** `ctx.slots.register(options, component)` takes exactly TWO
    arguments. Current slots: `settings.section` id `cc-switch` (order 40) and
    `conversation.input.right` id `cc-switch-usage` (order 10, injected with
    `sessionId` + the session's model-directory store).

## Debugging

- Plugin state: `~/.dsh/plugins/dsh-switch/state.json` — `{version, managed,
  currents, signature, lastSyncAt, lastError}`. `lastError` is the first loop
  failure (reported once, not spammed).
- DSH-side truth: `~/.dsh/settings.yaml` namespaces `llm-pi-ai` and
  `agent-default-model`; credentials in `~/.dsh/.credentials.yaml`.
- The loop triggers on: boot (immediate pass), a cc-switch DB file event
  (~300 ms), and the poll tick. If a change does not appear in DSH, check in
  order: state.json `lastError` → settings.yaml `llm-pi-ai` → whether the host
  process predates the last `lib/` build (restart DSH).
- The client surfaces report `live in DSH` vs `awaiting DSH` per provider by
  comparing `state.json.managed` with the host's live registry — if they
  disagree, DSH has not re-registered yet.

## Testing conventions

- `test/integration.ts` owns a full harness: fake home dirs (`mkdtempSync`),
  copied fixture DB (`PLUGIN_DB`), in-memory settings/credentials stores, an
  `emitted` event recorder, and `waitFor(cond, timeoutMs)` for async asserts.
  Sync-loop tests drive real `fs.watch` renames with generous timeouts.
- Name checks as behavior sentences ("changed sync announces model-input
  change"); the check id doubles as documentation.
- When you fix a bug, add the regression case FIRST in the same commit (see the
  four default-model ownership cases for the shape).
- `test/run.mjs` rebuilds test bundles from `.ts` sources each run; the
  committed repo must not contain `test/*.mjs` artifacts (gitignored).

## Versioning / release

- No npm package: the name `dsh-switch` on npm is an unrelated plugin. Users
  install from GitHub (`dsh plugin --profile web add github:a981008/dsh-switch`);
  market update checks compare the pinned commit vs HEAD, so every
  user-visible change is: change `src/` → rebuild → commit both → push `main`.
- `engines`: `node >=24` (build target and types align; `@types/node` 24), and
  `dsh >=0.1.5-rc.1` — raise the floor only when you actually use a newer host
  API, since the market filters cards on it.
- If the catalog entry's description drifts from reality, update
  `market/a981008__dsh-switch.yml` in the same commit (description rules: what
  it does, no marketing, `en` required, quote if it contains `: `).
