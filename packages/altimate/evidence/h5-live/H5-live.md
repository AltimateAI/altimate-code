# H5 live verification (copied branded artifact, managed server, real TUI)
Artifact under test: copy of /private/tmp/altimate-h5/branded/altimate-code-darwin-arm64 at h5live/art-branded (stock copy: h5live/art-stock). Env built with `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME XDG_* TMPDIR TERM` (envrun.sh); fresh HOME per run; cwd = fresh `git init` project. No bun / checkout on PATH (bun only ran fake.ts). Evidence: h5live/evidence/. Drivers: cold.py (timing), envrun.sh.

| # | Step | Result | Numbers / evidence |
|---|---|---|---|
| 1 | Copy, clean env, fresh project | PASS | env as above |
| 2a | Cold launch to first paint of home ("Ask anything" in tmux 140x40, 100 ms poll) | PASS | branded 1.88 / 1.87 / 1.99 s (t0 = tmux spawn). "Starting background server..." appears at 0.24-0.35 s. evidence/cold-branded{1,2,3}.json, *-home.txt |
| 2b | Plugin ready, cold, budget < 5 s | PASS | server-side `altimate  builtin` row active in `plugin list --builtin`: 0.91 / 0.87 / 0.98 s; RPC listWarehouses answers `{"output":[]}`: 1.15 / 1.21 / 1.13 s. Plugin is ready before first paint. evidence/cold-branded1-plugin-list.txt |
| 3 | fake provider; TUI prompt -> warehouse_add (duckdb :memory:, demo) then sql_execute "select 42 as answer, 'duck' as animal, null as nothing"; no restart | PASS | both tool calls shown as completed in the session (step3-session-140x40.txt), model said "Done."; fake-requests.jsonl |
| 3b | `/warehouse` panel, same session | PASS | split panel: `demo (duckdb)`, "Last query result / demo - 1 row / answer | animal | nothing / 42 | duck | NULL"; footer "r refresh - f full screen - esc close". evidence/step3-warehouse-panel-140x40.txt |
| 4 | lsof of service pid 6182 (`.../art-branded/bin/altimate-code serve --service`) | PASS | txt-mapped: art-branded/lib/altimate/drivers/node_modules/@duckdb/node-bindings-darwin-arm64/duckdb.node (392,792 B) and libduckdb.dylib (52,599,536 B, thinned arm64). evidence/step4-lsof-duckdb.txt, step4-lsof-full.txt |
| 5a | Size | PASS (info) | branded 230 MB (235,168 KiB: bin 183,240 + lib 51,924) vs stock 179 MB (183,036 KiB): +52 MB (+28%), all from lib/ DuckDB sidecars; executable itself +214,656 B |
| 5b | Stock cold first paint x3, same method | PASS | 5.56 / 1.90 / 1.76 s. Run 1 outlier (4.04 s before "Starting background server..." even printed) is most likely first-ever exec of that fresh copy (the branded copy had been run once via --help before timing); not reproduced. Steady cold: branded ~1.9 s vs stock ~1.8 s, i.e. no measurable branding/DuckDB penalty |
| - | `plugin list --builtin` after step 3 | PASS | both `altimate builtin` and `altimate builtin (tui)` rows (evidence/step3-plugin-list.txt) |

Cleanup: tmux servers (h5*, h5live3), managed services (`service stop` per run), fake.ts (pid killed) all stopped; no listeners remain.

## Defects / notes
1. Brand leak (minor, TUI sidebar): after the first session the branded TUI shows a "Getting started" card reading "OpenCode includes free models so you can start immediately" (evidence/step3-session-140x40.txt). Home screen also shows model "Nemotron 3.5 Super VL Free OpenCode" (cold-*-home.txt). Both are stock strings/provider names; decide whether they are in scope for branding.
2. Cold timing caveat: the plugin-ready poller runs `plugin list --builtin` in the same project once the service state file exists (~0.34 s), so it could in principle warm the location for the TUI; the first poll was never ready (1 poll miss per run), the second was. This matches the H2 defect 1 pattern (first call on a cold location lacks server rows) but resolves in ~0.5 s here. Plugin-ready is thus measured from tmux spawn, not from process exec (~tens of ms difference).
3. `rpc lastResult` via `api` needs `sessionID` input; listWarehouses with `{"input":{}}` works. Not a product defect, noted for the recipe.
4. Not run: narrow terminal, `f`/`r` keys, restart/shutdown cycle, `/warehouse` keyboard dispatch beyond Enter (H2 covered those on source).
