# De-fork spike — S2 execution-route trace + bypass matrix

Status: draft for S3 handoff. Analysis-only; no product code was modified to
produce this document. Governed by S2 of `docs/internal/2026-07-18-defork-spike-spec.md`
(rev 4, Codex-consensus-approved).

## Purpose

S3 will build **HardPolicy**, a pure/synchronous/total deny-gate placed at
every point where a resolved `Tool.Info` actually gets `.execute(args, ctx)`'d.
This document separates **ingress surfaces** (how a request enters the system)
from **execution dispatchers** (where a tool call is actually dispatched), and
records, for every dispatcher, whether it is currently reachable in production
(`active`), wired but with no current caller (`latent`), or intentionally
outside HardPolicy's model-invoked boundary (`out-of-scope`).

Every `active` route below has an executable sentinel test in
`packages/opencode/test/altimate/defork/route-sentinels.test.ts` proving
execution actually reaches the cited dispatch line. `latent` routes have a
guard test that is designed to fail the moment the route gains a real caller
(signalling that its classification must be revisited).

## Ingress surfaces (not dispatchers)

These are how a tool-invoking request enters the system. None of them
directly calls `tool.execute(...)`; each ultimately funnels into one of the
dispatchers in the next section.

| Surface | Entry point | Feeds dispatcher |
|---|---|---|
| CLI `run` | `src/cli/cmd/run.ts` → SDK/server call | `resolveTools` (via server route → `SessionPrompt.prompt`/`loop`) |
| TUI | `src/cli/tui/worker.ts` — starts an in-process `Server` and calls its fetch handler directly (in-process `rpc.fetch`, no real socket) | same server routes as any HTTP client → `resolveTools` |
| Server v1 (Hono) | `src/server/routes/session.ts` | `SessionPrompt.Service` → `resolveTools` |
| Server v2 (`HttpApi`) | `src/server/routes/instance/httpapi/handlers/session.ts` | `SessionPrompt.Service` → `resolveTools` (except `shell`, see below) |
| ACP | `src/acp/service.ts:511-526` (`ACP.prompt`) calls `input.sdk.session.prompt(...)` — an SDK/HTTP client call, structurally identical to CLI `run`. Exhaustive grep across all 12 files in `src/acp/` found **zero** `.execute(`, `ToolRegistry`, or `resolveTools` references. | server routes → `resolveTools` |
| GitHub / GitLab handlers | call `SessionPrompt.prompt` in-process | `resolveTools` |

`src/server/routes/instance/httpapi/server.ts:236` (`SessionPrompt.node`), and
`src/server/routes/instance/httpapi/groups/session.ts` (payload type
definitions only) were both inspected and confirmed to add no dispatch
points of their own — pure Effect-layer/type wiring.
`src/server/routes/experimental.ts` contains only a stale comment; no live
route.

## Execution dispatchers

| # | Dispatcher | File:line | `ctx.ask` wiring | Ruleset | `Plugin.trigger` before/after | Reachable under allow-all | State |
|---|---|---|---|---|---|---|---|
| D1 | `SessionPrompt.resolveTools` — registry-tools loop | `src/session/prompt.ts:1521` (fn), context/`ask` at `1562-1572`, dispatch `await AppRuntime.runPromise(item.execute(args, ctx))` at `1601`, source-stamp `1614` | Real: `PermissionNext.ask({..., ruleset})` wrapped in `Effect.promise` | `PermissionNext.merge(input.agent.permission, input.session.permission ?? [])` | Yes / Yes (`1589-1599`, `1615-1624`) | Yes — this is the primary, always-reachable per-turn tool dispatch path (called from `loop()` at `918`) | **active** |
| D2 | `SessionPrompt.resolveTools` — MCP-tools loop | `src/session/prompt.ts:1630-1739`, dispatch `const result = await execute(args, opts)` at `1669` | Real and **deny-capable**: `AppRuntime.runPromise(ctx.ask({permission: key, patterns: ["*"], always: ["*"]}))` at `1656-1667`. Correction: `PermissionNext.ask` DOES evaluate the tool key + `"*"` pattern against the merged ruleset — it throws on an explicit `deny` and blocks for a reply when the result is `ask` (`src/permission/next.ts:138-168`). The `always: ["*"]` field only persists approval patterns after an `always` reply; the wildcard `patterns` merely prevents *argument-level* distinctions — it does NOT make the gate non-deny-capable. Comment documents a **previously fixed bug**: `await ctx.ask(...)` alone only awaited the Effect *object*, never ran `PermissionNext.ask` — MCP tools executed with no permission check until this was corrected (`upstream_fix` marker). | Same merge as D1 (wildcard pattern) | Yes / Yes (`1644-1654`, `1671-1680`) | Yes, if any MCP server is configured | **active** |
| D3 | `SessionTools.resolve` — registry-tools loop | `src/session/tools.ts:27` (fn), context/`ask` at `44-75`, dispatch `yield* item.execute(args, ctx)` at `97` | Real: `permission.ask({..., ruleset}).pipe(Effect.orDie)` at `66-74` | `Permission.merge(input.agent.permission, input.session.permission ?? [])` | Yes / Yes (`92-96`, `109-113`) | N/A — **zero production callers**. Exhaustive grep for `SessionTools` outside its own definition file returns only two doc-comments in `src/session/prompt.ts` (noting the shared `stampRegistryToolSource`/`describeMcpTool` helpers) and two doc-comment references in `src/altimate/tool-source.ts`. No call site exists at HEAD. | **latent** |
| D4 | `SessionTools.resolve` — MCP-tools loop | `src/session/tools.ts:124-216`, dispatch `Effect.promise(() => execute(args, opts))` at `145` | Real (with same wildcard-pattern caveat as D2) at `144` | Same merge as D3 | Yes / Yes (`138-142`, `156-160`) | N/A, same as D3 | **latent** (bundled with D3 — same unused resolver) |
| D5 | `BatchTool` inner dispatch | `src/tool/batch.ts:104` — `await AppRuntime.runPromise(tool.execute(validatedParams, toEffectContext(ctx, partID)))` | **Forwarded, not independently gated.** `toEffectContext` (`batch.ts:16-28`) passes the *same* `ctx.ask` the outer dispatcher (D1/D2/D3/D4/D6, whichever invoked "batch") supplied — BatchTool adds no wrapper-level, tool-specific `ask` of its own. Per-inner-tool permission enforcement therefore depends entirely on whether that inner tool's own implementation calls `ctx.ask` internally (many built-ins, e.g. `bash`, do). | Same ruleset as whichever outer dispatcher invoked "batch" (forwarded, not re-derived) | **No** — confirmed by full read of `tool/batch.ts`: no `Plugin.trigger` call anywhere in the file. `stampRegistryToolSource` is also never applied to inner results. **This is also a genuine PERMISSION bypass, not merely a hooks/stamping gap:** `BatchTool` resolves every registry tool WITHOUT the current agent (`batch.ts:62`) and invokes it directly, so an inner tool that does not call `ctx.ask` internally (e.g. `warehouse_remove`, `src/altimate/tools/warehouse-remove.ts`) is executed with NO permission evaluation — a configured `warehouse_remove: deny` rule is never applied when the tool is reached via `batch`. This is exactly why S3 gates each inner dispatch independently at `batch.ts:104` rather than relying on inner tools' own `ctx.ask`. | Yes — the model can invoke `batch` from any agent that has it enabled, and can batch any tool present in `ToolRegistry.tools(...)` except `batch` itself (`DISALLOWED`, `batch.ts:11`) | **active** |
| D6 | Direct Task-tool dispatch (subtask replay/continuation) | `src/session/prompt.ts:517-625` inside `loop()`; `Plugin.trigger("tool.execute.before", ...)` at `580-588`, dispatch `await AppRuntime.runPromise(taskTool.execute(taskArgs, taskCtx))` at `625`, `Plugin.trigger("tool.execute.after", ...)` at `636-644` | `PermissionNext.ask({..., ruleset})` closure present at `612-621`, **but currently NOT exercised**: `taskCtx.extra.bypassAgentCheck` is always `true` at `src/session/prompt.ts:597`, and `TaskTool.execute` only calls `ctx.ask` when that flag is `false` (`src/tool/task.ts:96-107`). So these direct pending-subtask executions are effectively **ungated** today — which is precisely why S3 inserts a dispatcher-level `HardPolicy.check()` here (`prompt.ts:625`) rather than relying on the task tool's own ask. | `PermissionNext.merge(taskAgent.permission, session.permission ?? [])` | Yes / Yes | Yes — fires whenever a pending `task`-type item is popped off the session's task queue (subtask continuation), independent of the current turn's LLM tool_calls | **active** |
| D7 | `TaskTool`'s own recursive prompt call | `src/tool/task.ts` → recursively invokes `SessionPrompt.prompt` for the spawned subagent session | N/A — delegates to D1/D2 for the child session's own tool loop | Child session's own agent/session ruleset | N/A at this layer (delegates) | Yes, whenever `task`/subagent tool is invoked | **active** (not a distinct dispatch primitive — routes back into D1/D2 for the child session) |
| D8 | CLI `debug agent --tool <id>` handler | `src/cli/cmd/debug/agent.handler.ts:60` — `const result = yield* tool.execute(params, toolCtx)` | Real: `ctx.ask` at `196-205` evaluates `Permission.evaluate(req.permission, pattern, ruleset)` and throws `PermissionV1.DeniedError` on `deny` | `Permission.merge(agent.permission, session.permission ?? [])` (`186`) | **No** — full-file read confirms zero `Plugin` import/usage in `agent.handler.ts`. Inconsistent with every other dispatcher above. | Only reachable via the `opencode debug agent` developer CLI command, not via any model-facing surface | **active, but out-of-scope** per the spec's "arbitrary code outside HardPolicy's model-invoked boundary" carve-out — it is a human-operated debug utility, not something the model can trigger. Flagged here because the missing `Plugin.trigger` is a real inconsistency worth fixing regardless of HardPolicy scope. |
| — | `SessionPrompt.shell` | `src/session/prompt.ts:2418-2664`, raw process spawn at `2580` (`spawn(shell, args, {...})`) | N/A — never touches `ToolRegistry`/`resolveTools`/any `Tool.Info.execute` | N/A | Only extensibility hook is `Plugin.trigger("shell.env", {cwd, sessionID, callID}, {env: {}})` at `2575-2579` — this is the spec's own named `out-of-scope` example, matched verbatim. | N/A | **out-of-scope** (matches spec's own example). **Flag:** the server v2 `shell` HTTP route (`src/server/routes/instance/httpapi/handlers/session.ts:367-388`) gates this with **only** `requireSession(ctx.params.sessionID)` (`371`) — a session-existence check, **no permission/Ruleset check of any kind**. Formally out of HardPolicy's model-invoked-tool boundary, but worth a security follow-up outside this spike since it is a raw-exec HTTP route with no ask-gate. **The identical gap exists on the v1 Hono endpoint** `POST /session/:sessionID/shell` (`src/server/routes/session.ts:1004-1034`), whose handler also calls `SessionPrompt.shell` directly with no permission/Ruleset check — both routes reach the same process spawn and belong in the same follow-up (tracked: **issue #1019**). |
| — | Direct `ReadTool` dispatch (user attachments) | `src/session/prompt.ts` — `createUserMessage` initializes + executes `ReadTool` for text/directory file parts (~`:2001`, `:2070`) with `ask: () => Effect.void` | N/A — ungated by design (fixed `read` tool, non-model-controlled args: the attachment paths the user supplied) | N/A | These do NOT funnel through any dispatcher above | N/A | **out-of-scope** — the `read` tool is ungoverned (no v1 HardPolicy rule targets it) and the args are user-attachment paths, not model-controlled tool_call args. Listed for completeness so the S3 audit covers every `Tool.Info.execute` site. |

## Notes on legacy/compat plumbing (not distinct dispatchers)

- `src/altimate/tool-zod-compat.ts` (`legacyDefToDef`/`legacyToInit`) converts
  old Promise-based zod tool defs into the new Effect-based `Tool.Def` shape
  and preserves `ctx.ask` pass-through unchanged. It does not introduce a new
  dispatch point; every dispatcher above still owns the actual `.execute(...)`
  call.
- `src/tool/registry.ts`'s `fromPlugin(id, def)` (plugin-registered tools)
  feeds `Tool.Info` objects into `ToolRegistry.tools(...)`, so plugin-defined
  tools are dispatched through whichever of D1–D6 resolved them — not a
  separate dispatcher.

## Known constraint affecting sentinel-test design

The fork resolves builtin tool definitions **freshly per `ToolRegistry.tools()`/`.allInfos()` call**
rather than returning a mutable live singleton map (unlike upstream
OpenCode's `ToolRegistry.named()`). This breaks the classic "monkey-patch a
registered tool's `.execute`" test pattern — evidenced by two pre-existing
`.skip`'d tests in `packages/opencode/test/session/prompt.test.ts` (~line
1914) with an explanatory `altimate_change` comment. Sentinel tests below
therefore invoke each dispatcher's real code path directly (via `initTool()`
for self-contained tools like `batch`, or via the project's existing
Effect-layer test harness for registry/session-backed dispatchers) rather
than patching a previously-fetched tool instance.

## Route → sentinel test mapping

All test names below are verified verbatim against `route-sentinels.test.ts`
as committed (9 tests, all passing). Run it package-locally (the repo-root
`bunfig.toml` points the test root at a deliberately-nonexistent dir, so it
must be invoked from `packages/opencode`):

```bash
cd packages/opencode && bun test test/altimate/defork/route-sentinels.test.ts
```

| Dispatcher | Sentinel test(s) |
|---|---|
| D1 `resolveTools` registry loop | "D1: resolveTools reaches item.execute for a real registry tool" (real execution, via direct `SessionPrompt.resolveTools()` call) + "D1: resolveTools dispatch chokepoint is pinned at the documented line" (structural) |
| D3/D4 `SessionTools.resolve` (latent) | "D3/D4: SessionTools.resolve has no production caller (latent guard)" + "D3/D4: SessionTools.resolve dispatches a tool when invoked directly" (real execution, via direct `SessionTools.resolve()` call with a hand-built Effect layer) + "D3/D4: SessionTools.resolve dispatch chokepoints are pinned at the documented lines" (structural) |
| D5 `BatchTool` inner dispatch | "D5: BatchTool dispatches inner tool.execute without Plugin.trigger" (real execution, via `initTool(BatchTool)`) + "D5: BatchTool never calls Plugin.trigger for inner tool calls (structural bypass)" (structural) |
| D6 direct Task dispatch | "D6: direct Task dispatch chokepoints are pinned at the documented lines" (structural) + "D6: existing real-execution proof exists in test/session/prompt.test.ts" (citation of `it.instance("failed subtask preserves metadata on error tool state"`) — **partial compliance, flagged**: this route does not have a fresh, self-contained real-execution sentinel in `route-sentinels.test.ts` itself; see the compliance note in that file's D6 section for rationale (reconstructing the cited test's harness would duplicate ~250 lines of module-private test infrastructure from `prompt.test.ts` that isn't exported anywhere). Team-lead should decide whether to accept this as a documented S2 exception or require a follow-up to export a shared harness. |

**D2 (`resolveTools` MCP-tools loop) is intentionally absent from this table.**
D2 shares its outer function (`resolveTools`), `context()` closure, and
`Plugin.trigger`/`ask` wiring pattern with D1 — the two loops differ only in
tool source (registry vs. MCP-discovered) and in D2's wildcard-pattern `ask`
call (`ctx.ask({permission: key, patterns: ["*"], always: ["*"]})`, see D2's
row above). D1's real-execution test already exercises `resolveTools`'s
shared machinery — permission merge, `ctx` construction, `Plugin.trigger`
before/after, result stamping — end to end; the only D2-specific code that
proof does *not* touch is the MCP-loop's own dispatch line (`1669`) and its
wildcard `ask` call (`1656-1667`). Exercising that branch for real would
require standing up a real or fake MCP server as a tool source (the same
`MCP.Service` faking technique used for D3/D4 would work, feeding one
synthetic MCP tool through `resolveTools`), which was judged disproportionate
for what is structurally the same dispatch pattern as D1 with a different
tool origin. This gap is flagged explicitly, not silently omitted, as a
candidate follow-up if S3 wants dedicated D2 coverage.
