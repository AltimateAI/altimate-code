# S8 — warehouse session panel through public TUI and RPC APIs

Date: 2026-10-15. Upstream: OpenCode v2.0.29. Bun: 1.4.2.

**Implementation, in-process RPC acceptance, and component rendering pass. Live terminal capture remains pending.**
Classification: **P** for the implemented surface; the original S8 terminal-capture acceptance is still open.
All S8 changes are confined to `packages/altimate`. The panel does not depend on either S6 patch.

## Implementation

`src/tui.tsx` exports the public `@opencode/plugin/tui` plugin. Its setup registers
`/warehouse` and a command-palette entry through `keymap.layer`. The command opens
`altimate.warehouse` through `ui.panel.open`; outside a session it explains that a
session is required. The `session.panel` slot contribution renders the actual
`WarehousePanel` only when its name is selected. The host owns panel sizing,
focus, and full-screen behavior.

The panel uses the session's Location and the generated client RPC API to fetch
registered warehouses and the selected session's last successful query. It shows
warehouse names and types, column headings, rows, row count, truncation, and
loading/empty/error states. JSON values and `NULL` remain readable. The `r`, `f`,
and Escape bindings refresh, toggle full screen, and close the panel. Successful
tool events for the displayed session trigger a refresh; disposing the panel
removes the event subscription. Theme colors use `text.base`, `text.muted`, and
`text.feedback.error.base` for their documented semantic roles.

`src/rpc.ts` defines the `altimate` RPC contract with `Rpc.define`:

| Method           | Input           | Output                                  |
| ---------------- | --------------- | --------------------------------------- |
| `listWarehouses` | `{}`            | Location's registered warehouse records |
| `lastResult`     | `{ sessionID }` | Last successful query result, or `null` |

The Promise API accepts portable schemas, so each method uses
`Schema.toStandardSchemaV1`. The existing tool and RPC outputs share the same
warehouse and query-result schemas. `src/server.ts` registers both methods with
`ctx.rpc.register`. A successful `sql_execute` saves its normalized output in
plugin storage using both Location and session identity. Failed or cancelled
queries do not overwrite the prior successful result. Results and warehouse
registrations survive host restart; the native in-memory database itself does
not become durable.

## Evidence

Focused command, from `packages/altimate` with the requested Bun 1.4.2 PATH:

```sh
bun test test/s8-rpc.test.ts test/s8-tui.test.tsx
bun run typecheck
```

Results: **4 tests pass, 27 assertions, 0 failures; typecheck exits 0**.
Receipts: [tests](evidence/s8-tests.txt), [typecheck](evidence/s8-typecheck.txt).
Full package `bun test` also passes: **49 pass, 1 skip, 0 failures, 241 assertions**
(the skip is the pre-existing live gateway test). Receipt: [full suite](evidence/s8-suite.txt).

Focused `oxlint` of the five implementation/test TypeScript files also exits 0
with no warnings or errors.

`test/s8-rpc.test.ts` calls `host.opencode.rpc(AltimateRpc)` on the existing real
SDK fixture. This is the generated Promise client's `POST /api/rpc/altimate/{method}`
transport through `EmbeddedHost.fetch` and the real in-process HTTP router. No
listener or network connection is opened, and no RPC handler is invoked directly.
Assertions cover empty state, actual DuckDB query rows, per-session result
isolation, Location isolation, preservation after a failed query, and persistence
across host restart.

`test/s8-tui.test.tsx` executes the production TUI plugin's setup, finds the
registered `/warehouse` command, invokes it, and checks that it opens the matching
panel name. The test invokes the registered slot renderer with the real SDK RPC
client, using OpenTUI's existing `testRender` facility at **42 and 110 columns**.
Both frames contain the warehouse, headers, and `42 | duck | NULL` from a real
DuckDB query. It also verifies subscription cleanup and the outside-session
message. The host UI registration objects are narrow test doubles; the production
panel, RPC, SDK HTTP transport, server plugin, and DuckDB execution are real.
This component test does not establish terminal keyboard dispatch or CLI loading.

Negative control: temporarily removed the server's `ctx.rpc.register` block and
ran the first RPC test. It failed with `rpc.unavailable` / `RPC is unavailable:
altimate`, exit 1. The file was restored in `finally`, and the focused suite then
passed again. Receipt: [registration mutation](evidence/s8-rpc-mutation.txt).

## Remaining verification

- **Real terminal capture pending**, as requested. Run the TUI with the Altimate
  server and TUI entrypoints loaded, create a warehouse and execute a query, enter
  `/warehouse` in a session, then capture narrow and wide terminal views. Exercise
  refresh, full screen, close, and keyboard focus there. Component rendering is
  supplementary evidence; it does not replace this original plan acceptance.
- `package.json` now declares optional OpenTUI/Solid peer dependencies and matching local
  test dependencies, preserving server-only installations; `tsconfig.json` and `bunfig.toml` enable the JSX runtime and
  test preload. The environment already contains these dependencies, so ignored
  local `node_modules` links were used. `bun.lock` remains untouched to honor the
  S8 restriction on upstream files. A fresh/frozen install needs the Altimate
  workspace's lockfile metadata refreshed in a separately authorized packaging
  change; no network installation was attempted here.
- The worktree's network/listener restriction prevents a real CLI/server launch
  in this task. No screenshot or live-terminal acceptance is claimed.

## Exact S8 file set

- `packages/altimate/src/server.ts`
- `packages/altimate/src/rpc.ts`
- `packages/altimate/src/tui.tsx`
- `packages/altimate/package.json`
- `packages/altimate/tsconfig.json`
- `packages/altimate/bunfig.toml`
- `packages/altimate/test/s8-rpc.test.ts`
- `packages/altimate/test/s8-tui.test.tsx`
- `packages/altimate/S8-findings.md`
- `packages/altimate/evidence/s8-tests.txt`
- `packages/altimate/evidence/s8-suite.txt`
- `packages/altimate/evidence/s8-typecheck.txt`
- `packages/altimate/evidence/s8-rpc-mutation.txt`

All files are left unstaged. No S6a or S6b file is included in this set.

## Live terminal capture (2026-10-15)

Result: **PASS** in the real OpenCode v2.0.29 TUI (packages/cli, `--standalone`), once the plugin is loadable by path.

### Root cause of the earlier "No matching commands"
The plugin was never loaded. A local plugin declared by absolute directory path is resolved by
`Host.resolve({ directory })` (packages/plugin/src/host.ts:17-27) as `<dir>/server`, `<dir>/index`, `<dir>/tui`,
`<dir>/rpc`; it does NOT consult package.json `exports`. For `packages/altimate` (sources under `src/`) it returns
`{server: undefined, tui: undefined, rpc: undefined}` (verified by calling it), and
packages/core/src/config/plugin/source.ts:~165 (`if (!entrypoints.server) return []`) silently drops the plugin: no
log line, empty TUI plugin manager. Only npm-style package names (`name` set) honor `exports`.
Fix for the spike: declare a directory that has root-level `server.ts`, `tui.tsx`, `rpc.ts` (shims re-exporting
`src/*`: [evidence/s8-live-plugin-shim](evidence/s8-live-plugin-shim)). A real publish should either install by package name or ship root entry files.
Secondary: the spawned server needs the OpenTUI preload (cwd bunfig), see below.

### Exact setup
- Bun 1.4.2; isolated HOME/XDG under scratchpad; project dir outside the repo with git init and a bunfig.toml
  ([evidence/s8-live-bunfig.toml](evidence/s8-live-bunfig.toml), absolute `@opentui/solid/scripts/preload.js`), because the standalone server child
  inherits cwd and needs the preload.
- `~/.config/opencode/opencode.json` and `cli.json` (both): `{"plugins":[{"package":"<shim dir>"}]}`.
- Launch: [evidence/s8-live-run.sh](evidence/s8-live-run.sh) (`bun run packages/cli/src/index.ts --standalone <proj>`) inside `tmux -L s8`, 140x40 then resized to 60x30.
- A real model replied (Build agent), so a genuine session existed; the model called the plugin's `warehouse_add` and `sql_execute` (DuckDB `:memory:`).

### Observed per step (captures in evidence/s8-live-*.txt)
| Step | Result |
| --- | --- |
| Home screen renders; typing `/warehouse` shows autocomplete "/warehouse  Open warehouses" (140x40-1) | PASS |
| Enter on home (no session): toast "Open a session to view warehouses." (140x40-2) | PASS |
| In session, `/warehouse` opens side panel: "No warehouses registered." / "No query result in this session." via RPC (140x40-3) | PASS |
| After real `warehouse_add` + `sql_execute`: panel lists `demo (duckdb)`, `demo · 1 row`, `answer | animal | nothing`, `42 | duck | NULL` (140x40-7) | PASS |
| `f` full screen: panel fills the terminal (140x40-9, 60x30-3) | PASS (60x30 panel already full-width, so no visible difference there) |
| `esc` closes, session view restored (140x40-10, 60x30-4) | PASS |
| 60x30: panel renders same content, fits width (60x30-1) | PASS |
| `r` refresh | NOT VERIFIED: key sent, output unchanged (140x40-4/8, 60x30-2); no visible effect is expected when data is unchanged, so this capture cannot show it ran |
| Auto-refresh on tool events | not exercised live (only covered by component test) |

Warnings: the model made real API calls (about $0.03). Servers and tmux were killed afterwards.
