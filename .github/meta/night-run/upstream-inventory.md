# Upstream v1.17.9 Merge Risk Inventory

Scope: fork branch `upstream/merge-v1.17.9`, upstream bridge from v1.4.0 to v1.17.9. Sources inspected include `.github/meta/merge-v1179/PLAYBOOK.md`, merge log checkpoints, and the merged source tree. This inventory is intentionally not a 3254-commit changelog; it prioritizes systemic rewrites and integration seams where silent behavior drift is plausible.

Priority:

- P0: can corrupt sessions/state, drop tool or permission semantics, break core prompt flow, or create auth/security regressions.
- P1: likely user-visible breakage or interoperability drift.
- P2: lower blast radius but worth regression coverage while building adversarial suites.

## 1. Effect Runtime, Layers, and Promise Facades

### What upstream changed

Upstream moved broad API surfaces to Effect services and layers. Service consumers now expect `Context.Service`, `Layer`, `LayerNode`, `Effect.Schema`, managed runtime execution, and fiber-scoped environment instead of Promise namespaces.

### How the fork integrated it

The fork retained Promise/namespace APIs and added facades around them. `LayerNode` accepts lazy dependency thunks to avoid circular initialization (`packages/core/src/effect/layer-node.ts:17`, `packages/core/src/effect/layer-node.ts:75`). `AppRuntime` merges the new service graph behind `Layer.suspend` (`packages/opencode/src/effect/app-runtime.ts:55`, `packages/opencode/src/effect/app-runtime.ts:120`). Promise facades use `attach` / `makeRuntime` to restore instance and workspace context (`packages/opencode/src/effect/run-service.ts:14`, `packages/opencode/src/effect/run-service.ts:33`) and `EffectBridge` restores context for callbacks (`packages/opencode/src/effect/bridge.ts:14`, `packages/opencode/src/effect/bridge.ts:40`).

### Risky behaviors to test

**UPI-01 - P0 - Lazy layer construction and circular imports**

- Files: `packages/core/src/effect/layer-node.ts:17`, `packages/opencode/src/effect/app-runtime.ts:55`, `packages/opencode/src/effect/runtime-flags.ts:74`
- Input: import and run `AppRuntime.runPromise` for `Config`, `Provider`, `ToolRegistry`, `SessionPrompt`, `MCP`, `LSP`, and `Permission` from a fresh process.
- Expected: no `undefined.defaultLayer`, no eager circular-init failure, and no false cycle report. If a real dependency cycle is introduced, `LayerNode` should fail with the explicit cycle path from `buildLayer`.

**UPI-02 - P0 - Instance/workspace context survives Promise facade crossings**

- Files: `packages/opencode/src/effect/run-service.ts:14`, `packages/opencode/src/project/instance-store.ts:108`, `packages/opencode/src/project/instance-context.ts:18`, `packages/opencode/src/control-plane/workspace-context.ts:10`
- Input: within an `InstanceStore.provide({ directory, workspaceID })` Effect, call legacy Promise wrappers such as `Config.get()`, `Provider.list()`, `MCP.status()`, and a legacy tool execute path.
- Expected: emitted events include the same directory/project/workspace; file boundary checks use the scoped instance directory, not `process.cwd()` or a prior instance.

**UPI-03 - P0 - EffectBridge preserves callback context**

- Files: `packages/opencode/src/effect/bridge.ts:40`, `packages/opencode/src/session/prompt.ts:1533`, `packages/opencode/src/session/prompt.ts:1552`
- Input: a legacy tool calls `ctx.metadata()` and `ctx.ask()` after an async timer or plugin callback.
- Expected: session part metadata updates the correct message/part and permission request is scoped to the correct session and workspace.

## 2. Session State, Storage, and Projection Split

### What upstream changed

Upstream introduced a v2 session service, event-sourced durable session events, Drizzle-backed database tables, `SessionInput`, and Effect session services. It also expanded the `session` table with model/agent/path/metadata/token columns and added `session_message` and input/context tables.

### How the fork integrated it

The fork now has two live session APIs. Legacy prompt code imports `Session` from `@/session` (`packages/opencode/src/session/index.ts:42`) and writes through the old synchronous `Database.use` path. HttpApi and AppRuntime import `Session` from `@/session/session` (`packages/opencode/src/session/session.ts:532`) and publish `SessionV1.Event.*` through `EventV2Bridge`. Old `MessageV2.page()` remains sync and database-backed (`packages/opencode/src/session/message-v2.ts:880`), while Effect session methods re-type those rows (`packages/opencode/src/session/session.ts:865`). Core projectors write EventV2 session events to the same tables (`packages/core/src/session/projector.ts:212`), and old sync projectors still exist for Bus events (`packages/opencode/src/session/projectors.ts:64`).

### Risky behaviors to test

**UPI-05 - P0 - Legacy session API and Effect session API see identical rows**

- Files: `packages/opencode/src/session/index.ts:323`, `packages/opencode/src/session/session.ts:545`, `packages/core/src/session/sql.ts:21`
- Input: create one session via legacy `Session.create()` inside `Instance.provide`, then read/list through `Session.Service`; create another via `Session.Service.create`, then read/list through legacy `Session.get()` and `MessageV2.page()`.
- Expected: both APIs see both sessions with identical `id`, `projectID`, `workspaceID`, `directory`, `path`, `agent`, `model`, `permission`, timestamps, and title fields. No FK failures or missing `ProjectTable` row.

**UPI-06 - P0 - Session updates are persisted once and published once**

- Files: `packages/opencode/src/session/index.ts:407`, `packages/opencode/src/session/session.ts:784`, `packages/core/src/session/projector.ts:237`, `packages/opencode/src/event-v2-bridge.ts:38`
- Input: update title, permission, archived time, share URL, and revert metadata through both old namespace and Effect service while subscribers listen on legacy Bus and EventV2.
- Expected: final DB row has the last update, subscribers get one logical update per operation, and no duplicate Bus event is produced by EventV2Bridge plus old direct Bus publishing.

**UPI-07 - P0 - Message/part writes remain coherent across old sync DB and EventV2 projectors**

- Files: `packages/opencode/src/session/index.ts:722`, `packages/opencode/src/session/session.ts:679`, `packages/core/src/session/projector.ts:264`, `packages/opencode/src/session/message-v2.ts:616`
- Input: simulate a prompt with text deltas, tool call, tool result, step-finish token usage, then delete a part via HttpApi.
- Expected: `MessageV2.page`, `Session.Service.messages`, and raw `message`/`part` tables agree. Token/cost totals are not double-counted. PartDelta still emits over legacy Bus (`packages/opencode/src/session/session.ts:915`).

**UPI-08 - P0 - Busy/cancel/run-state split does not leave sessions stuck**

- Files: `packages/opencode/src/session/prompt.ts:321`, `packages/opencode/src/session/run-state.ts:71`, `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:367`, `packages/opencode/src/session/status.ts:81`
- Input: start a prompt, concurrently call shell, revert, delete message, abort, and prompt again.
- Expected: shell maps the legacy positional `BusyError` to API `SessionBusyError`; revert/delete reject while busy; abort publishes error before idle; final status is idle and no runner remains.

**UPI-09 - P0 - Compaction, replay, and revert boundaries**

- Files: `packages/opencode/src/session/compaction.ts:79`, `packages/opencode/src/session/compaction.ts:171`, `packages/opencode/src/session/revert.ts:41`, `packages/opencode/src/session/prompt.ts:713`
- Input: force context overflow with large media/tool outputs, auto-compact, then revert a message or part and continue prompting.
- Expected: compaction attempts stop after the circuit breaker; media is replaced by synthetic text when stripped; tool-output masks are preserved; revert restores snapshots and cleans later messages/parts without resurrecting stale compacted context.

**UPI-10 - P1 - Database migration journals and channel DB path**

- Files: `packages/opencode/src/storage/db.ts:83`, `packages/core/src/database/migration.ts:18`, `packages/core/src/database/database.ts:43`
- Input: open an existing DB with old `__drizzle_migrations` rows missing names; also open a new empty DB and a non-empty DB without `session`.
- Expected: old journal is seeded into new `migration` table, names are backfilled, new schema initializes once, and non-empty unknown DB fails loudly instead of partially migrating.

## 3. Tool API, Schema, Registry, and Execution

### What upstream changed

Tool definitions are Effect-first: `Tool.define` returns an Effect of tool info, params use Effect Schema, `execute` returns an Effect, and tool schemas need JSON Schema conversion for AI SDK execution.

### How the fork integrated it

The fork added a legacy zod/Promise adapter (`packages/opencode/src/altimate/tool-zod-compat.ts:1`) and overloaded `Tool.define` to accept old zod definitions (`packages/opencode/src/tool/tool.ts:294`). `Tool.wrap` now decodes Effect Schema, handles telemetry, and central truncation (`packages/opencode/src/tool/tool.ts:235`). `ToolRegistry` resolves builtins through `AppRuntime` and adapts plugin tools through `legacyToInit` (`packages/opencode/src/tool/registry.ts:177`, `packages/opencode/src/tool/registry.ts:224`). Prompt-side execution bridges Effect tools back into AI SDK tools (`packages/opencode/src/session/prompt.ts:1511`) and `session/tools.ts` contains the upstream-style resolver (`packages/opencode/src/session/tools.ts:23`).

### Risky behaviors to test

**UPI-11 - P0 - Legacy zod schemas are preserved through Effect Schema declarations**

- Files: `packages/opencode/src/altimate/tool-zod-compat.ts:132`, `packages/opencode/src/altimate/tool-zod-compat.ts:145`, `packages/opencode/src/tool/json-schema.ts:8`
- Input: run a representative legacy tool with missing required fields, wrong enum values, nested optional fields, and defaults.
- Expected: invalid args are rejected before execution with the same field semantics as zod; generated JSON Schema contains descriptions and required fields; no `Schema.declare` accepts bad input accidentally.

**UPI-12 - P0 - Tool context ask/metadata is correctly bridged**

- Files: `packages/opencode/src/tool/tool.ts:49`, `packages/opencode/src/session/prompt.ts:1523`, `packages/opencode/src/session/tools.ts:40`, `packages/opencode/src/permission/index.ts:78`
- Input: a tool calls `ctx.metadata({ title, metadata })`, then `ctx.ask({ permission, patterns, always })`, then returns output.
- Expected: running tool part is updated before permission UI appears; reject produces tool-error and stops according to session config; always approval resolves matching pending permissions for the same session only.

**UPI-13 - P0 - Central truncation does not double-truncate or lose attachments**

- Files: `packages/opencode/src/tool/tool.ts:274`, `packages/opencode/src/tool/truncation.ts:52`, `packages/opencode/src/session/prompt.ts:1688`
- Input: one native tool returns huge text with no `metadata.truncated`; another returns already-truncated metadata and file attachments; an MCP tool returns text plus image/resource content.
- Expected: huge raw output is saved once with `outputPath`; already-truncated output is not truncated again; attachment ids/session/message ids are added; MCP content ordering is preserved.

**UPI-14 - P1 - Plugin and custom tools still work in old shape**

- Files: `packages/opencode/src/tool/registry.ts:147`, `packages/opencode/src/tool/registry.ts:177`, `packages/opencode/src/altimate/tool-zod-compat.ts:183`
- Input: install a plugin tool using old `parameters: z.object(...)` and `execute(args, ctx) => Promise`, with `tool.execute.before/after` hooks enabled.
- Expected: tool appears in `ToolRegistry.tools` and `ToolRegistry.allInfos`, schema is visible to tool lookup, hooks fire once, and execution sees session/message/call metadata.

## 4. Provider, Model, and LLM Streaming

### What upstream changed

Provider/model handling now includes branded ids, Effect service facades, expanded provider metadata, stricter model defaults, AI SDK v6 stream shapes, and an Effect `LLM.Service` stream of LLM events.

### How the fork integrated it

The fork kept old provider namespaces and added an Effect facade (`packages/opencode/src/provider/provider.ts:1995`). It restored fork-specific providers and defaults: `altimate-backend`, Snowflake, Databricks, Copilot Enterprise, GitLab user-agent branding, machine-token GitHub skipping, and full provider database exposure (`packages/opencode/src/provider/provider.ts:196`, `packages/opencode/src/provider/provider.ts:989`, `packages/opencode/src/provider/provider.ts:1192`, `packages/opencode/src/provider/provider.ts:1288`, `packages/opencode/src/provider/provider.ts:1430`, `packages/opencode/src/provider/provider.ts:1603`). `LLM.stream` remains Promise/AI-SDK-first, with an Effect facade converting `fullStream` to `LLMEvent`s (`packages/opencode/src/session/llm.ts:55`, `packages/opencode/src/session/llm.ts:341`).

### Risky behaviors to test

**UPI-16 - P0 - Default model and altimate-backend auth selection**

- Files: `packages/opencode/src/provider/provider.ts:196`, `packages/opencode/src/provider/provider.ts:1288`, `packages/opencode/src/provider/provider.ts:1894`, `packages/opencode/src/session/system.ts:38`
- Input: no configured model, valid `~/.altimate/altimate.json` token; then stale/invalid altimate auth; then explicit user model.
- Expected: default selects `altimate-backend/altimate-default` only when configured; stale auth is removed; explicit model wins; system prompt routes gateway family to the right vendor prompt.

**UPI-17 - P1 - Custom provider visibility and machine GitHub token skipping**

- Files: `packages/opencode/src/provider/provider.ts:1429`, `packages/opencode/src/provider/provider.ts:1603`, `packages/opencode/src/provider/provider.ts:1615`
- Input: config has unauthenticated custom provider; environment has `CODESPACES=true` and only `GITHUB_TOKEN`.
- Expected: unauthenticated custom provider appears in `Provider.all()`/state but not connected `Provider.list()`; GitHub model/Copilot providers are not auto-enabled from machine-scoped tokens.

**UPI-19 - P0 - LLM Effect stream cancellation and error mapping**

- Files: `packages/opencode/src/session/llm.ts:39`, `packages/opencode/src/session/llm.ts:341`, `packages/opencode/src/session/message-v2.ts:1021`
- Input: fake provider stream emits start, text, tool events, then abort; another stream throws APICallError, decompression error, and context overflow.
- Expected: Effect stream emits equivalent LLM events, abort propagates to the underlying `AbortController`, errors map to the correct `MessageV2` error type, retryable flags are preserved.

**UPI-20 - P0 - Historical tool stubs and retrieval preserve provider invariants**

- Files: `packages/opencode/src/session/llm.ts:169`, `packages/opencode/src/session/llm.ts:191`, `packages/opencode/src/session/message-v2.ts:808`
- Input: transcript contains historical assistant tool calls for tools not in the current toolset, plus pending/running tool calls when resuming.
- Expected: missing historical tools are stubbed or retained as required; pending/running calls get interrupted tool results; Anthropic-style APIs never see dangling `tool_use` without `tool_result`.

**UPI-21 - P1 - Usage and cost accounting across AI SDK v6**

- Files: `packages/opencode/src/session/session.ts:387`, `packages/opencode/src/session/processor.ts:313`, `packages/opencode/src/session/index.ts:830`
- Input: usage objects with cached input tokens included/excluded, reasoning tokens, `totalNanoAiu`, non-finite counts, and over-200K model pricing.
- Expected: negative/non-finite counts clamp safely; cached tokens subtract correctly; reasoning billed as output when expected; `totalNanoAiu` overrides; legacy and Effect session APIs agree.

## 5. Config and MCP

### What upstream changed

Config moved to Effect Schema and Effect services. MCP moved to Effect services, new status states, OAuth flows, resource handling, tool-list change events, and external MCP discovery.

### How the fork integrated it

The fork restored `altimate-code.json`, old Promise config wrappers, `mcpServers` normalization, remote config auth detection, and automatic MCP discovery (`packages/opencode/src/config/config.ts:56`, `packages/opencode/src/config/config.ts:209`, `packages/opencode/src/config/config.ts:674`, `packages/opencode/src/config/config.ts:801`). MCP keeps Promise wrappers over an Effect service and adds Datamate/reload behavior, OAuth auth storage, tool name sanitization, and serialized enabled-state writes (`packages/opencode/src/mcp/index.ts:590`, `packages/opencode/src/mcp/index.ts:790`, `packages/opencode/src/mcp/index.ts:841`, `packages/opencode/src/mcp/auth.ts:60`).

### Risky behaviors to test

**UPI-22 - P0 - Config schema and MCP normalization are backward compatible**

- Files: `packages/opencode/src/config/config.ts:56`, `packages/opencode/src/config/config.ts:285`, `packages/opencode/src/config/config.ts:320`
- Input: `altimate-code.json` with top-level `mcpServers`, command string, command/args array, env, headers, url, and `updatedAt`; also global `opencode.jsonc`.
- Expected: config loads in documented precedence, `$schema` defaults to Altimate URL, `mcpServers` becomes `mcp`, `updatedAt` is preserved, and normalization does not rewrite disk unless update is called.

**UPI-23 - P1 - Remote config auth and account config failures are clear**

- Files: `packages/opencode/src/config/config.ts:247`, `packages/opencode/src/config/config.ts:275`, `packages/opencode/src/account/account.ts:351`
- Input: remote config URL returns HTTP 200 HTML login page; account config endpoint returns 404; malformed JSON is returned.
- Expected: HTML login is reported as remote auth, 404 account config yields none, malformed JSON is a decode failure with the source URL.

**UPI-24 - P0 - External MCP discovery precedence and safety**

- Files: `packages/opencode/src/mcp/discover.ts:138`, `packages/opencode/src/mcp/discover.ts:229`, `packages/opencode/src/mcp/discover.ts:258`, `packages/opencode/src/config/config.ts:674`
- Input: `.vscode/mcp.json`, `.cursor/mcp.json`, Copilot config, Claude project/global config, names like `__proto__`, env refs in env/headers and in command args.
- Expected: project-scoped discovered servers default disabled, first-source-wins precedence is stable, prototype-polluting names are ignored, env/header refs resolve exactly once and command args are not double-resolved.

**UPI-25 - P0 - MCP add/connect/disconnect persistence is serialized**

- Files: `packages/opencode/src/mcp/index.ts:752`, `packages/opencode/src/mcp/index.ts:767`, `packages/opencode/src/mcp/index.ts:790`, `packages/opencode/src/server/server.ts:577`
- Input: concurrently add, disconnect, reconnect, and reload a Datamate MCP entry whose disk config changed transport URL.
- Expected: enabled flag persists without racing, fresh disk config wins over stale Config singleton, `updatedAt` survives, no stale client remains connected.

**UPI-26 - P1 - MCP OAuth state and browser failures**

- Files: `packages/opencode/src/mcp/index.ts:961`, `packages/opencode/src/mcp/auth.ts:85`, `packages/opencode/src/mcp/index.ts:70`
- Input: start OAuth, finish with wrong state, finish with expired/missing token, simulate browser-open failure.
- Expected: state mismatch does not write credentials; status becomes `needs_auth` or `needs_client_registration` as appropriate; browser failure publishes `mcp.browser.open.failed`.

**UPI-27 - P0 - MCP tool execution, resources, and permissions**

- Files: `packages/opencode/src/mcp/index.ts:841`, `packages/opencode/src/session/prompt.ts:1617`, `packages/opencode/src/session/tools.ts:116`
- Input: MCP server exposes tools with colliding/unsafe names, text plus image/resource content, resource blobs, and a permission-denied tool.
- Expected: tool names are sanitized deterministically, permission prompt uses `mcp__...` key, output order is preserved, text is truncated with metadata, image/resource attachments get message/session ids, denied tool is not executed.

## 6. Server, HttpApi, Auth, SSE, and UI

### What upstream changed

Upstream added an Effect HttpApi server, route groups, auth middleware, workspace routing/proxying, typed SSE endpoints, and an embedded/proxied UI flow. Legacy Hono routes still exist in the fork for the local TUI and several old endpoints.

### How the fork integrated it

The new HttpApi surface is in `packages/opencode/src/server/routes/instance/httpapi/server.ts:121`, but legacy `Server.Default()` and `Server.listen()` still power the TUI worker and several paths (`packages/opencode/src/server/server.ts:63`, `packages/opencode/src/cli/tui/worker.ts:35`). HttpApi uses custom authorization to avoid auth alternatives remapping authorized not-found responses to unauthorized (`packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts:16`) and workspace routing to choose local vs remote targets (`packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:160`). UI proxy behavior differs between legacy and new shared UI (`packages/opencode/src/server/server.ts:631`, `packages/opencode/src/server/shared/ui.ts:9`).

### Risky behaviors to test

**UPI-28 - P0 - Legacy Hono and HttpApi route parity**

- Files: `packages/opencode/src/server/server.ts:260`, `packages/opencode/src/server/routes/instance/httpapi/server.ts:261`, `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:70`
- Input: issue equivalent requests for session create/get/list/messages/promptAsync/abort/permission/revert through legacy `Server.Default().fetch` and HttpApi `createRoutes()`.
- Expected: status codes, response bodies, validation failures, and event side effects are equivalent or explicitly documented where intentionally different.

**UPI-29 - P0 - Authorization does not hide NotFound or bypass protected APIs**

- Files: `packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts:73`, `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:86`, `packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts:118`
- Input: unauthenticated request, wrong Basic password, valid auth for nonexistent session, valid pty ticket for PTY route, invalid pty ticket.
- Expected: invalid auth is 401; valid auth plus nonexistent resource is ApiNotFound/404-like typed error, not 401; PTY ticket bypass only applies to its intended route.

**UPI-30 - P0 - SSE event bridge and stream lifecycle**

- Files: `packages/opencode/src/event-v2-bridge.ts:38`, `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:25`, `packages/opencode/src/server/server.ts:520`
- Input: subscribe to `/event`, publish one legacy Bus event and one EventV2 event in the same instance, publish an event for another workspace, then dispose instance.
- Expected: receives `server.connected`, heartbeat, matching events exactly once, no other workspace events, and stream closes after `server.instance.disposed`.

**UPI-31 - P1 - UI proxy host and CSP branding**

- Files: `packages/opencode/src/server/server.ts:631`, `packages/opencode/src/server/shared/ui.ts:9`, `packages/opencode/src/server/shared/ui.ts:96`
- Input: request `/`, `/assets/...`, and an HTML response with inline theme preload through legacy Hono and HttpApi with embedded UI disabled.
- Expected: fork should proxy Altimate UI host where intended; CSP allows the theme preload hash and expected connect-src. Current HttpApi shared UI points at `https://app.opencode.ai`, which is a branding/host regression candidate.

**UPI-32 - P1 - Global config update disposes instances and emits global lifecycle**

- Files: `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:86`, `packages/opencode/src/project/instance-store.ts:79`, `packages/opencode/src/project/instance.ts:132`
- Input: open two instances, subscribe `/global/event`, PATCH global config with a changed value.
- Expected: config update returns merged config, all instances dispose once, `server.instance.disposed` appears for each directory, and subsequent requests reload fresh config.

## 7. TUI Extraction and Client Sync

### What upstream changed

The TUI moved to `packages/tui`, with a new SDK/provider layer, plugin runtime, built-in feature plugins, sync context, and internal/external worker transport.

### How the fork integrated it

CLI still launches the extracted TUI but feeds it legacy server transport (`packages/opencode/src/cli/cmd/tui.ts:107`, `packages/opencode/src/cli/tui/worker.ts:23`). The new TUI sync context buffers line deltas and auto-approves in `ALTIMATE_CLI_YOLO` mode (`packages/tui/src/context/sync.tsx:155`, `packages/tui/src/context/sync.tsx:228`). Plugin adapters expose prompt state and slot/status APIs (`packages/tui/src/plugin/adapters.tsx:24`, `packages/tui/src/plugin/runtime.tsx:12`). Some UI branding remains upstream (`packages/tui/src/app.tsx:442`).

### Risky behaviors to test

**UPI-33 - P1 - TUI internal/external transport auth and reload**

- Files: `packages/opencode/src/cli/tui/worker.ts:23`, `packages/opencode/src/cli/tui/worker.ts:56`, `packages/opencode/src/cli/cmd/tui.ts:148`
- Input: run TUI internal transport, external server transport, invalid server auth, and SIGUSR2 reload.
- Expected: internal fetch injects `ServerAuth.header`; external transport uses configured server; reload invalidates config and disposes instances; no stale model/provider/MCP state remains.

**UPI-34 - P1 - Line streaming buffers do not duplicate or lose text**

- Files: `packages/tui/src/context/sync.tsx:155`, `packages/tui/src/context/sync.tsx:361`, `packages/tui/src/context/sync.tsx:430`, `packages/tui/src/context/sync.tsx:463`
- Input: send `message.part.delta` chunks split across newlines, then send part completed, removed, and authoritative part updated events.
- Expected: partial line buffer flushes on newline and completion; removal/update discards stale buffer; final rendered text has no duplicate tail and no dropped newline.

**UPI-35 - P1 - TUI plugin lifecycle and prompt.active state**

- Files: `packages/tui/src/plugin/runtime.tsx:12`, `packages/tui/src/plugin/adapters.tsx:176`, `packages/tui/src/feature-plugins/builtins.ts:21`
- Input: start TUI, activate prompt, run built-in prompt-enhance/status plugins, route between views, dispose/reload.
- Expected: plugin host starts and disposes once; `prompt.active` reflects the visible prompt; commands/status/slots clear on unload; deprecated command shim still works.

## 8. Permission System

### What upstream changed

Upstream introduced Effect `Permission.Service` with EventV2 `permission.asked` / `permission.replied`. The fork still has `PermissionNext`, a Promise/zod/Bus permission implementation used by prompt tools and legacy routes.

### How the fork integrated it

Effect `Permission` lives in `packages/opencode/src/permission/index.ts:23` and publishes through `EventV2Bridge`. Legacy `PermissionNext` lives in `packages/opencode/src/permission/next.ts:17` and is still called by `SessionPrompt.resolveTools` (`packages/opencode/src/session/prompt.ts:1552`) and old tools. The TUI auto-yolo path responds to permission events in the sync context (`packages/tui/src/context/sync.tsx:228`).

### Risky behaviors to test

**UPI-37 - P0 - PermissionNext and Permission.Service semantics stay aligned**

- Files: `packages/opencode/src/permission/index.ts:78`, `packages/opencode/src/permission/next.ts:131`, `packages/opencode/src/session/prompt.ts:1552`
- Input: rulesets with later overrides, wildcard deny, `~` and `$HOME` patterns, once/always/reject replies, and multiple pending requests in the same session.
- Expected: both implementations choose the same allow/deny/ask action, reject clears same-session pending requests, always resolves matching pending requests, and denied tools are excluded from available tool list.

**UPI-38 - P1 - Permission event shape is compatible with TUI and API**

- Files: `packages/opencode/src/permission/index.ts:11`, `packages/opencode/src/permission/next.ts:100`, `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:403`
- Input: create permission request through Effect service and through legacy prompt tool, then respond over HttpApi.
- Expected: TUI sees the same `permission.asked` shape, HttpApi reply maps missing request to typed PermissionNotFound for Effect service, and legacy missing request behavior is not silently ignored where API expects an error.

**UPI-39 - P1 - YOLO auto-approval is scoped and one-shot**

- Files: `packages/tui/src/context/sync.tsx:228`, `packages/opencode/src/permission/index.ts:120`
- Input: set `ALTIMATE_CLI_YOLO=1`, trigger two permission requests from different sessions/workspaces.
- Expected: only the visible/current workspace request is auto-replied `once`; no repeated auto-replies after request completion; rejected/denied config rules are not overridden.

## 9. LSP, Skills, and System Prompt

### What upstream changed

LSP and skills are Effect services. System prompt construction now composes skills, model-specific provider prompts, workspace metadata, and new session prompt caching assumptions.

### How the fork integrated it

The fork added Effect facades for LSP (`packages/opencode/src/lsp/lsp.ts:121`), skills (`packages/opencode/src/skill/index.ts:108`), and system prompt skills (`packages/opencode/src/session/system.ts:250`). It kept fork features: external `.claude` / `.agents` skill discovery, auto-load frontmatter, environment fingerprint skill selection, Altimate gateway prompt routing, and moving current date out of the cached system prefix (`packages/opencode/src/session/system.ts:38`, `packages/opencode/src/session/system.ts:106`, `packages/opencode/src/session/system.ts:112`).

### Risky behaviors to test

**UPI-40 - P1 - LSP server filtering, spawning, and path containment**

- Files: `packages/opencode/src/lsp/lsp.ts:100`, `packages/opencode/src/lsp/lsp.ts:210`, `packages/opencode/src/project/instance-context.ts:18`, `packages/opencode/src/project/instance.ts:101`
- Input: configure `pyright` and `ty` with experimental flag on/off, custom LSP command, symlinked file outside project, and concurrent `touchFile` calls.
- Expected: only one of `pyright`/`ty` is enabled as configured; broken servers are not retried endlessly; concurrent spawn reuses one client; files outside real project boundary do not get treated as internal.

**UPI-41 - P1 - Skill discovery, auto-load, and permission filtering**

- Files: `packages/opencode/src/skill/index.ts:189`, `packages/opencode/src/skill/index.ts:326`, `packages/opencode/src/session/system.ts:112`, `packages/opencode/src/session/system.ts:199`
- Input: global `.claude` skill, project `.agents` skill, config skill path, duplicate names, bad frontmatter, `alwaysApply`, `applyPaths`, and agent permission denying a skill.
- Expected: discovery order is stable, duplicate name override is deterministic, bad frontmatter emits session error without crash, denied skills are not listed/loaded, auto-loaded bodies appear before the available skills list.

**UPI-42 - P1 - System prompt provider routing and date caching**

- Files: `packages/opencode/src/session/system.ts:38`, `packages/opencode/src/session/system.ts:71`, `packages/opencode/src/session/prompt.ts:1010`
- Input: Altimate backend model families for Claude/Gemini/OpenAI, unknown family, and a session crossing midnight.
- Expected: provider prompt matches family; unknown gateway family falls back to Codex prompt; current date is appended to the last user turn and does not alter the cache-controlled system prefix.

## 10. Account, Auth, Share, and Workspace Boundaries

### What upstream changed

Account/auth moved into Effect services and Drizzle tables. Workspace routing and remote workspace proxying were added to the HttpApi stack.

### How the fork integrated it

CLI Auth uses a distinct `@opencode/Auth.cli` service id to avoid fork-local service collision (`packages/opencode/src/auth/index.ts:53`) and restores Promise wrappers (`packages/opencode/src/auth/index.ts:114`). Account data uses Effect repo over core DB (`packages/opencode/src/account/repo.ts:42`) and token refresh caches (`packages/opencode/src/account/account.ts:248`). Workspace routing reads query parameters and session workspace ids, then proxies or provides `InstanceRef`/`WorkspaceRef` (`packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:160`, `packages/opencode/src/server/routes/instance/httpapi/middleware/instance-context.ts:23`).

### Risky behaviors to test

**UPI-44 - P1 - Auth file and account table stores do not collide**

- Files: `packages/opencode/src/auth/index.ts:60`, `packages/opencode/src/auth/index.ts:84`, `packages/opencode/src/account/repo.ts:124`
- Input: set API auth for provider with trailing slash, remove auth, login account, refresh token, and list active org.
- Expected: file auth normalizes trailing slashes and writes 0600; account repo persists active org separately; token refresh cache does not serve stale token after repo update.

**UPI-45 - P1 - Workspace routing chooses local vs remote target correctly**

- Files: `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:65`, `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:160`, `packages/opencode/src/server/routes/instance/httpapi/middleware/instance-context.ts:23`
- Input: requests with `workspace=` query, invalid workspace id, session id whose row has a workspace, `OPENCODE_WORKSPACE_ID`, local control-plane routes, and remote workspace target.
- Expected: invalid workspace returns 400; missing workspace returns clear error; session workspace wins over query; env workspace pins local routing; remote proxy waits on fence headers when present.

## Highest Value P0 Set

If the first adversarial pass can only cover a subset, cover these first:

1. UPI-05 through UPI-09: session split-brain, DB projection, busy/cancel, compaction/revert.
2. UPI-11 through UPI-13: Tool API schema/context/truncation compatibility.
3. UPI-19 and UPI-20: LLM stream conversion, abort/error mapping, historical tool-call invariants.
4. UPI-24 through UPI-27: MCP discovery, persistence, OAuth, tool/resource execution.
5. UPI-28 through UPI-30: Hono/HttpApi parity, authorization, EventV2/Bus/SSE exactly-once behavior.
