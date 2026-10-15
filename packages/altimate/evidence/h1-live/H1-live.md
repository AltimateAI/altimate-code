# H1 live verification (checkout altimate-code-v2-host-live @ 8e5bbf817a, bun 1.4.2, no tracked edits)
Evidence: /private/tmp/claude-501/-Users-anandgupta-codebase-altimate-code/a3ba8813-c4f4-4234-9efe-d5c7103ee560/scratchpad/h1live/evidence/ (E). Helper env: h1live/env.sh, tui.sh, echo.ts.
Runs: b1 (branded, isolated HOME/XDG/TMPDIR), s1 (stock negative control), c1 (both concurrently, shared roots).
Env note: branded "local" channel port 0xa17f=41343 is held on this machine by LM Studio (pid 930), so branded ran with `service set port 41350`; stock local default 49375 ran unmodified.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1a | Branded writes only under altimate-code roots / ${TMPDIR}/altimate-code; no `opencode` dir created; stock-root sentinel not applied | PASS (listing-based; fs_usage needs sudo, NOT available, so reads are unverified) | E/c1-b1-files.txt, c1-b1-files-full.txt |
| 1b | Negative control (no preload) creates opencode roots and applies sentinel | PASS | E/c1-stock-files.txt, c1-stock-api-config.txt (config sources list xdg/config/opencode/opencode.json, username SENTINEL_STOCK_USER), c1-stock-model-default.txt (opencode cat-jam-free = sentinel model), c1-stock-home-140x40.txt |
| 2 | Coexistence: separate ports, own server per client, independent stop/restart | PASS | E/c2-coexist-start.txt, c2-coexist-lifecycle.txt, c2-coexist-tuis.txt (branded 41350 pid / stock 49375 pid; each TUI holds connections only to its own server; stop/restart of one never changes other's pid) |
| 3a | Logo wide/narrow | PASS | E/c3-branded-home-140x40.txt, c3-logo-widths.txt (100, 40 stacked, 30 "A" mark; stock 40 for comparison) |
| 3b | Terminal title | PASS | home "Altimate Code" (E/c3-branded-title-home.txt); unnamed session "Altimate Code"; named session "Altimate Code | My named task" vs stock "OC | My named task" (E/c3-titles-in-session.txt). Plugin/mini titles NOT RUN |
| 3c | `--version` | FAIL | prints `opencode vlocal` for branded and `--help` says "OpenCode command line interface", usage `opencode` (E/c3-version.txt) |
| 3d | User agent to local echo | PASS | models.dev fetch redirected with ALTIMATE_CLI_MODELS_URL: `user-agent: altimate-code/local/local/cli`; stock: `opencode/local/local/cli` (E/c3-echo-brand.jsonl, c3-echo-stock.jsonl). Via provider prompt path NOT RUN |
| 3e | ACP initialize agentInfo.name | PASS | "Altimate Code" (stock "OpenCode") (E/c3-acp.txt). authMethods still "Run `opencode auth login`" (known) |
| 4 | Env alias auth | PASS | on `serve --port` (managed `service` mode ignores env passwords, uses generated one): ALTIMATE_CLI_SERVER_PASSWORD=x -> x 200, none/wrong 401; OPENCODE_ only y -> y 200, x 401; both -> x wins, y 401; empty primary falls back to y; stock ignores ALTIMATE_ var (E/c4-auth.txt) |

Note on 1a sentinel evidence: branded config API showed only config sources [xdg/config/altimate-code]; default model stayed opencode/nemotron-3.5-super-vl-free (sentinel was opencode/cat-jam-free) and TUI footer showed Nemotron (E/c3-branded-home-140x40.txt, c3-branded-session-140x40.txt). Sentinel files byte-identical/unmodified, no new files in xdg/config/opencode or home/.config. tui.json theme sentinel not observably verified.
Not covered: fs_usage trace; default-port (non-overridden) branded service; real `latest`-channel port 41342; plugin/mini titles; prompt via a provider baseURL.

## Defects / findings
1. `--version`/`--help` unbranded: packages/cli/src/commands/commands.ts:38-39 uses `OPENCODE_CLI_NAME` build define else "opencode" and description "OpenCode command line interface"; not routed through Identity (and `Runtime.run` version string at cli/src/index.ts:~111). Source run via preload therefore shows opencode.
2. Cosmetic stock names inside altimate roots: cli/src/database-path.ts (`opencode.db`/`opencode-local.db`), log file `opencode-local.log`, snapshot `opencode.gitconfig` under altimate-code data dir. Not stock roots, but a user listing shows opencode-named files.
3. server-process.ts:175 port-in-use message tells user to run `opencode service set port`. (Observed on 41343 conflict.)
4. Branded host is rejected by OpenCode Zen free tier ("OpenCode's free tier can only be used from within OpenCode"; E/c3-branded-session-140x40.txt) - outbound UA/client id (core/src/plugin/provider/opencode.ts:189-191) now altimate-code. Product decision: default model/provider for the branded build.
5. Branded default local-channel port 41343 collides with LM Studio on this machine (dev-only channel; latest 41342 not tested).
6. Source launch with a directory arg (`... src/index.ts <dir>`) made the stock managed server spawn fail: "Cannot find module 'react/jsx-dev-runtime'" (cwd change loses bunfig preload); I did not re-test with preload + dir arg, so unknown for branded. 
7. Known/accepted: ACP authMethods still say `opencode auth login`; basic-auth username remains `opencode`.

All started processes (services, serve instances, echo servers, tmux server "h1live") were stopped; verified no remaining index.ts/echo.ts processes.
