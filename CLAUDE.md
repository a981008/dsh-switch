# CLAUDE.md

All agent guidance lives in [AGENTS.md](AGENTS.md) — read it before changing
code. The three rules that have historically shipped bugs if broken:

1. Build sync deps only through `syncDepsFrom()` — `runSync` takes `SyncDeps`,
   not the plugin's `RouteDeps` (this exact mismatch once silently killed the
   automatic sync).
2. Run `node test/run.mjs` after every change — its `tsc --noEmit` step is the
   only type gate (esbuild strips types without checking).
3. Rebuild AND commit `lib/` together with `src/` — the running host loads
   `lib/`, and installs from GitHub need no build step.
