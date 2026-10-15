# H2 live verification (checkout altimate-code-v2-host-live @ 11b5ebe815, bun 1.4.2, no tracked edits)
Evidence: h2live/evidence/ (E). Helpers: h2live/env.sh, tui.sh, fake.ts. Isolated HOME/XDG_*/TMPDIR per run (b1 branded, s1 stock, a1/a2 part A).
Launch: `cd packages/cli && bun --preload packages/altimate/script/identity-preload.ts src/index.ts <args>`; managed service via `service start`; TUI via `... src/index.ts <project-dir> -s <session>`.
No plugin config anywhere. Model: no secrets; `altimate-code.json` provider `fake` (@ai-sdk/openai-compatible -> local fake.ts on 127.0.0.1:57390, scripted tool_calls). Tool calls went through the real branded service prompt path (session.prompt), not direct invocation.

| # | Check | Result | Evidence |
|---|---|---|---|
| A1 | Branded `--version` = `altimate-code vlocal`; `--help` says "Altimate Code command line interface", usage `altimate-code <subcommand>`; stock still `opencode` | PASS | E/a1-version-help.txt |
| A2 | Branded files named altimate-code-local.db(-wal/-shm), log/altimate-code-local.log, snapshot/.../altimate-code.gitconfig; no `opencode*` path in branded roots (excluding cloned reference repos, bun cache) | PASS | E/a3-branded-files.txt, a3-gitconfig.txt |
| A3 | Port-in-use hint names branded command: dummy listener on 57242, `service start` -> "Configure another port with `altimate-code service set port <port>`" | PASS (cause chain/stack still prints; hint text correct) | E/a2-port-in-use.txt |
| A4 | Default ports: local-channel service listens on 57242 with no override (lsof); 57241 is the latest/dev/beta/next default and was NOT exercised | PASS for 57242 / NOT RUN for 57241 | E/b0-service-start.txt, b0-info.txt |
| B1a | Branded TUI session (fresh HOME/XDG, no plugin config); warehouse_add (demo, :memory:) + sql_execute "select 42 as answer, 'duck' as animal, null as nothing" executed by the model's tool calls; both tools in the first model request; result 42 / duck / NULL | PASS | E/b1-messages.json, fake-requests.jsonl, b2-tui-session-140x40.txt |
| B1b | RPC listWarehouses / lastResult over real HTTP (`/api/rpc/altimate/...`) | PASS | E/b1-rpc.txt |
| B1c | `/warehouse` in TUI at 140x40: split panel beside session; shows demo (duckdb) + last result table (answer/animal/nothing, 42/duck/NULL, NULL rendered as NULL) | PASS | E/b3-warehouse-panel-140x40.txt |
| B1d | `f` full screen at 140x40 (panel takes whole screen, session hidden), `f` again returns to split, `esc` closes to session | PASS | E/b3-warehouse-fullscreen-140x40.txt, b3-fullscreen-toggle-back-140x40.txt, b3-after-esc-140x40.txt |
| B1e | `/warehouse` at 60x30 (fresh TUI started at 60x30): fullscreen-only panel with same content and hint footer; `f` is a no-op (panel.tsx:21 canSplit is width>80, by design); `esc` closes | PASS | E/b3-warehouse-panel-60x30.txt, b3-warehouse-f-60x30.txt, b3-after-esc-60x30.txt |
| B1f | `r` refresh | NOT RUN to a verifiable effect (key sent, no visible change; data unchanged) | |
| B2a | `plugin list --builtin` shows `altimate builtin` and `altimate builtin (tui)` | PASS once the location is warm; FAIL on the first call against a cold location (only `builtin (tui)`, no server rows) | E/b4-plugin.txt (cold), b4-plugin-api.txt (warm), b5-restart.txt |
| B2b | `plugin remove altimate` -> `Plugin "altimate" is a protected host builtin and cannot be removed` (exit 0); config + service files byte-identical (sha before/after) | PASS | E/b4-plugin.txt, b4-config-hash-*.txt |
| B3a | Stop/start managed service: new pid; RPC listWarehouses in project 1 still returns `demo` (storage restored) | PASS | E/b5-restart.txt, b5-second-location.txt |
| B3b | New session in project 1 after restart: sql_execute against restored `demo` runs (`42`) | PASS | E/b5-post-restart-sql.txt |
| B3c | Second project dir (proj2): RPC list is `[]` before use (independent), tools present (model request lists warehouse_add + sql_execute), scripted run registers `second2`; proj1 unaffected (`demo` only) | PASS | E/b5-second-location.txt |
| B3d | TUI opened in proj2 after restart: `/warehouse` shows `second2` panel and result | PASS | E/b5-proj2-panel-140x40.txt |
| B4 | Stock control (no preload): no altimate in `/api/plugin` (`"id":"altimate"` count 0), model's tool list has no warehouse_add/sql_execute/schema_inspect, RPC `altimate` -> `rpc.unavailable` (HTTP 400), TUI `/warehouse` -> "No matching commands" | PASS | E/c1-stock-api.txt, c1-stock-slash-warehouse-140x40.txt |
| not covered | server/TUI throw presentation, Zen provider, fs_usage trace, compiled build, terminal-title writes, `schema_inspect` execution, write-classification permission prompt | NOT RUN | |

## Defects / notes
1. Cold-location `plugin list --builtin` is wrong: the first call after a service (re)start prints only `altimate - builtin (tui)` (server inventory empty for that never-used location); the second call shows both. Stock behaves the same (cold: "No plugins found", warm lists opencode.*), so this is upstream lazy location bootstrap, but it makes the H2 acceptance command flaky. Code: packages/cli/src/commands/handlers/plugin/list.ts:23 (`client.plugin.list({location:{directory:process.cwd()}})` does not wait for location readiness). Repro: E/b5-restart.txt.
2. Source TUI cannot be launched from the project directory (`cd proj && bun --preload ... /abs/src/index.ts`): "Cannot find module 'react/jsx-dev-runtime'" from packages/tui/src/config/v1/index.tsx (bunfig Solid preload is lost). Launch from packages/cli with the directory as an argument (works with the identity preload). Same as H1 defect 6, now narrowed: dir-arg form works.
3. Unconfirmed render oddity: during a resize-in-place sequence (60 to 140 cols) a wrapped tool line lost its `'duck' as animal,` text; not reproduced on the clean 60x30 start (those captures were discarded). Treat as unconfirmed.
4. Harness artifact (not a product defect): piping the TUI through `tee` makes it render 80 cols; those captures were discarded.
5. Service reference-repo clone: a prompt in a git project caused ~data/altimate-code/repos/github.com/Effect-TS/effect-smol to be cloned (network) into the branded data root; unrelated to H2 but a side effect to know about.
6. Basic auth username and some upstream names stay `opencode` by design.

All started processes (services for branded/stock, fake.ts, dummy listener, tmux server h2live) were stopped; no listeners remain on 57241/57242/57390/49375.
