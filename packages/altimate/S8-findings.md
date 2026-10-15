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
