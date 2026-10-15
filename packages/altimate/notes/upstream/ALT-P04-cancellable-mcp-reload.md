# [FEATURE]: Support cancellable MCP reload and bounded prompt readiness

> Local draft only; nothing posted. Network was unavailable, so an upstream duplicate search remains required. Proposal only; open the issue and obtain design approval before opening an implementation PR.

### Feature hasn't been suggested before.

- [ ] I have verified this feature I'm about to request hasn't been suggested before.

### Describe the enhancement you want to request

Please support `ctx.mcp.reload({ signal })` and bounded registration/reconciliation so a plugin that provides database tools can enforce a prompt-admission deadline while waiting for required tools before the first model request.

A local SDK fixture on v2.0.29 reproduced this with a real stdio MCP process:

1. Register an existing disabled MCP server so later registration takes the reconciliation path.
2. In a prompt hook, register another server whose `tools/list` response takes 1,500 ms, reload MCP, and poll `ctx.tool.list()` for its required tool.
3. Race the entire registration/reload/poll operation against a 200 ms timer and time `sessions.prompt(...)`.

The prompt rejected without making a model request, but returned after **1.76 s and 2.53 s** in two of three re-verification runs. An earlier passing run did not establish a reliable bound. The plugin's timer does not cancel the core reconciliation awaited before the caller returns.

The contract should cover transform registration as well as reload; a signal only after blocking registration leaves this case unresolved. Aborting should settle the caller promptly with a defined cancellation result and documented cleanup/shared-work behavior. Timeout must reject admission before any model request.

Existing per-server startup/catalog timeouts are useful, but do not provide this caller-scoped deadline across registration, reconciliation, and effective tool discovery. A regression should use a delayed stdio catalog, assert bounded admission latency and zero model requests on timeout, and verify that healthy startup exposes tools on the first request.

Code references, verified against **v2.0.29**:

- `packages/plugin/src/promise/mcp.ts:14`: transform/reload have no signal option; `packages/schema/src/mcp.ts:7` defines existing server timeouts.
- `packages/core/src/state.ts:105`, `:123`, `:245`, `:250`: notification draining, awaited reconciliation, registration, and reload.
- `packages/core/src/mcp/index.ts:572`, `:518`: subsequent reconciliation awaits replacement/startup; initial connections are asynchronous at `:550`.
- `packages/core/src/session/prompt.ts:40` awaits prompt hooks; `packages/core/src/tool/mcp.ts:140` debounces effective tool reconciliation by 100 ms, so connected status alone is insufficient.

### Open questions for maintainers

- Should registration accept a signal, or return before reconciliation with a separate cancellable readiness operation?
- When reload work is shared, should abort cancel startup or only release that caller's wait?
