# S3 — Workspace MCP first-turn readiness

Date: 2026-10-15. Upstream: OpenCode v2.0.29. Bun: 1.4.2.

**Four offline SDK tests pass. First-turn readiness is P\*: public plugin APIs work,
with a bounded tool-registry readiness adapter. Mandatory MCP ownership is U.**
No upstream files changed. No network listener or external MCP service was used.

## Implementation

`src/workspace-mcp.ts` exports `workspaceMcp({ name, config, tools, timeoutMs })`.
The SDK host supplies this plugin alongside Altimate; a future workspace resolver
must supply the real MCP configuration and required effective tool IDs. The default
server plugin does not install the test stub or invent a production workspace URL.

The first `session.hook("prompt")` registers `ctx.mcp.transform` with
`editor.set(name, config)`. Each prompt reloads the MCP domain and polls
`ctx.tool.list()` for every required tool ID, at 10 ms intervals. The default
readiness deadline is 10 seconds. This uses only public APIs:

- MCP editor/transform/reload: `packages/plugin/src/promise/mcp.ts:6`, `:14`.
- Effective tool IDs/listing: `packages/plugin/src/promise/tool.ts:69`;
  IDs are assigned by `packages/core/src/tool.ts:183`.
- Prompt hooks are awaited before prompt preparation continues:
  `packages/core/src/session/prompt.ts:38` and `:40`.

Waiting only for MCP `connected` is insufficient. Core publishes tool changes on
connection at `packages/core/src/mcp/index.ts:459` and `:463`, then reconciles
the tool registry through a **100 ms debounce** at
`packages/core/src/tool/mcp.ts:140`. The plan's `:124` points to the reconciliation
function; `:140` is the actual delay. The tool must appear in `ctx.tool.list()`,
not merely in the server's catalog or status.

The TS fixture `test/lib/mcp-stub.ts` runs as a real Bun stdio subprocess. It
implements the MCP initialize/catalog/call JSON-RPC exchange, has exactly one
tool, and delays catalog discovery 150 ms. The config sets `codemode: false`,
so the first model request advertises `altimate_workspace_probe` directly.
The tool returns both text and `structuredContent`. The test observes structured
`result.output` through the public `tool.hook("execute.after")` and the successful
text through `opencode.sessions.log()`. Durable `session.tool.success` intentionally
contains model content, not a raw `output` field
(`packages/schema/src/session-event.ts:530`).

## Deadline finding and correction

An initial implementation timed only the polling loop. A real delayed-catalog
test exposed a gap: with an existing server already registered, a **200 ms**
deadline rejected only after **1764 ms** when the new catalog took 1500 ms.
The failing result is retained in `evidence/s3-deadline-gap.txt`.

Registration/reload await reconciliation: `packages/core/src/state.ts:123`,
`:200`, and `:250`; MCP reconciliation can await server replacement/startup at
`packages/core/src/mcp/index.ts:572` and `:518`. Therefore the final adapter
races the entire registration/reload/poll operation against a timer, clears that
timer in `finally`, and stops subsequent reload/poll work after the deadline.
The regression now verifies rejection within one second for a 200 ms deadline,
before any model request, despite the 1500 ms catalog.

The public Promise MCP API has no AbortSignal parameter
(`packages/plugin/src/promise/mcp.ts:15` and `:16`). The deadline bounds prompt
admission, **not cancellation of core MCP startup**. Startup already in progress
continues under core's own MCP timeout/lifecycle. Host cleanup can consequently
outlast the prompt deadline; the slow-catalog test's complete duration includes
that cleanup. No detached polling loop continues after the deadline.

## Correction (re-verification, 2026-10-15)

Re-running the suite three times, S3.4 exceeded its 1 s bound in 2 of 3 runs (1.76 s and 2.53 s with
a 200 ms plugin deadline and a 1.5 s catalog). The adapter's timer race does reject, but the
`sessions.prompt` call does not return until core MCP reconciliation for the slow server settles
(`packages/core/src/state.ts:123`, `packages/core/src/mcp/index.ts:518`, `:572`). **A plugin cannot
bound prompt admission against a slow MCP server.** Classification: **U** — needs a cancellable
`ctx.mcp.reload({ signal })` / non-blocking registration. The test now asserts the invariants that hold
(rejection, no model request) and documents the measured latency instead of claiming a 1 s bound.

## User removal: measured gap

**A user/client can remove the plugin-provided server.** The exact SDK call is:

```ts
await opencode.mcp.remove({
  server: "altimate_workspace",
  location: { directory },
})
```

The generated SDK sends `DELETE /api/experimental/mcp/:server`
(`packages/client/src/promise/generated/client.ts:1366`;
`packages/protocol/src/groups/mcp.ts:42`). The server handler calls the core
remove operation without checking plugin ownership
(`packages/server/src/handlers/mcp.ts:38`). Core writes a `false` runtime override
at `packages/core/src/mcp/index.ts:660`, builds the removed-name set at `:607`,
and ignores subsequent transform `editor.set` for that name at `:614`.

The SDK test verifies that both the server and its tool disappear, then explicitly
calls the plugin's public `ctx.mcp.reload()` and verifies they remain absent.
A subsequent prompt reaches the readiness deadline without making another model
request. Transform replay cannot undo the user's removal. The public MCP editor
and server schema have no built-in non-removable ownership flag
(`packages/plugin/src/promise/mcp.ts:6`;
`packages/schema/src/mcp.ts:26` and `:54`).

**Draft ledger ALT-P03 — managed workspace MCP ownership (U).** Add an explicit
managed/owned-server policy to the MCP registration contract, expose it to clients,
and enforce it on remove, disconnect, and replacement operations in
`packages/core/src/mcp/index.ts` and the public schema/protocol. No patch is
implemented here. Upstream candidate: a generic managed-server contract, independent
of Altimate. Removal condition: stock v2 exposes and enforces that contract. The
observed behavior is not F; it is a specific missing governance extension point.

## Verification and non-vacuity

Run from `packages/altimate` with the requested Bun 1.4.2 directory prefixed to PATH:

```sh
bun test test/s3-mcp.test.ts
bun run typecheck
```

| Test | Result | Evidence |
| --- | --- | --- |
| S3.1: new session's first request advertises and executes MCP tool | PASS | Exactly two model calls; required tool on call zero; structured echoed result and durable success text |
| S3.2: SDK removal survives plugin transform reload | PASS | Server/tool absent; next prompt rejected; model-call count unchanged; 2000 ms readiness budget allows startup margin |
| S3.3: missing required tool | PASS | 500 ms deadline; prompt rejected between 450 ms and 5 seconds; zero model calls |
| S3.4: slow catalog bounds whole readiness | PASS | 1500 ms catalog; 200 ms deadline; admission rejected within one second; zero model calls |

Focused results: **4 pass, 0 fail, 19 assertions** in
`evidence/s3-tests.txt`. Package typecheck passes in `evidence/s3-typecheck.txt`.
The 500 ms missing-tool deadline remains independent of the 2000 ms removal-test
startup margin.

Non-vacuity: temporarily removed the entire prompt hook, including MCP registration
and readiness waiting. S3.1 failed at the first-request tool-advertisement assertion
(`Expected: true; Received: false`), with **0 pass / 1 fail** and exit code 1.
The mutation was restored; evidence is `evidence/s3-registration-mutation.txt`.

Classification: provider-independent MCP registration/execution uses **P** public
interfaces; the readiness deadline/poll adapter is **P\***; enforced mandatory MCP
ownership is **U**. No **F** behavior or upstream edits are needed for the passing
readiness slice.


## Final round-3 verification

After formatting and all fixes, with the requested Bun 1.4.2 PATH prefix:

- `cd packages/altimate && ALTIMATE_LIVE=0 bun test`: **42 pass, 1 skip, 0 fail,
  190 assertions**, 43 tests across 9 files. The live test was explicitly kept
  disabled. [Full per-test output](evidence/round3-tests.txt).
- `cd packages/altimate && bun run typecheck`: **exit 0**.
  [Package typecheck](evidence/round3-typecheck.txt).
- Repository-root `bun run check`: **exit 0**, 1,353 existing lint warnings,
  zero errors; **37/37 package typechecks successful**.
  [Canonical check output](evidence/round3-root-check.txt).
- `git diff --check`: clean. Git index empty; every changed/new source, test,
  report, and receipt is under `packages/altimate/**`. No upstream edits,
  dependency installs, generated-client edits, or commits.

New slice totals: **S2 11 passing tests**, **S3 4 passing tests**, **S4 2 passing
tests**. All **25 pre-existing tests** also pass. Each slice has a restored,
expected-failing negative-control receipt. Work completed within the 40-minute
round budget (approximately 22 minutes).
