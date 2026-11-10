# Claude Agent provider

<!-- HUMAN-AUTHORED: Start -->
<!-- This section is manually maintained. AI should preserve this content. -->

<!-- HUMAN-AUTHORED: End -->

<!-- AI-GENERATED: Start -->
<!-- This section is automatically maintained by Claude Code. -->
<!-- Last updated: 2026-11-11 by Claude Code -->

## Purpose

Runs Claude models through the user's own Claude Code login (`claude auth login`), so a Claude Pro/Max
subscription covers usage. The CLI starts the user's installed `claude` through
`@anthropic-ai/claude-agent-sdk`, turns off Claude Code's own tools and settings, and gives Claude the
CLI's tools over an in-process MCP server. It never reads Claude Code's token.

Ported from upstream opencode PR 58782, "feat(core): add Claude Agent provider" (merge commit
`f29e281322b`). Upstream builds it in
`packages/core/src/plugin/provider/claude-agent/` on core's v2 plugin context. The shipped CLI does not
run that runtime, so the upstream modules that only depend on the SDK live here, and the plugin-context
wiring is replaced by the call sites below.

## Layout

Copied from upstream with import paths adjusted (compare against the upstream folder in a bridge merge):

- `claude/` — `claude` process lifecycle: probe, per-session processes, status, forks, SDK loading.
- `sync/` — matches the CLI's history with Claude's saved session (catch-up, checkpoints, branches).
- `tools/` — the MCP tool server, PreToolUse/PostToolUse hooks, held tool calls and results.
- `language-model/` — the `LanguageModelV3` the AI SDK calls, and Claude stream conversion.

Altimate-only integration (replaces upstream `index.ts`, `provider.ts`, `aisdk.ts`, `integration.ts`,
`session.ts`, `instructions.ts`):

- `id.ts` — provider ID `claude-agent` and package name `@opencode/claude-agent`.
- `index.ts` — `ClaudeAgent`: session registry per instance, AI SDK factory, login check, request routing.
- `catalog.ts` — saved model list from Claude Code, pricing by login type, `Provider.Model` entries.
- `storage.ts` — JSON files under `<data>/claude-agent/` (model list, per-session Claude records).
- `plugin.ts` — internal plugin: `/connect` login method, session-idle release, config connection.

## Call sites (all inside `altimate_change` markers)

- `provider/provider.ts` — bundled SDK factory, provider database entry, `haiku` as small model.
- `provider/transform.ts` — `variants()` returns the effort levels Claude Code reported.
- `session/llm.ts` — request kind and session headers, agent role and instructions as options, no default output cap
  (a plugin's explicit `maxOutputTokens` still applies).
- `session/message-v2.ts` — stopped Claude Agent tool calls carry `toolAborted` (see `tools/aborted.ts`).
- `plugin/index.ts` — registers `ClaudeAgentPlugin`.
- `packages/tui/src/component/dialog-provider.tsx` — listed under Popular with a subscription hint.

## Differences from upstream

- **Request kinds:** titles, summaries and compaction run as standalone side calls with the CLI's prompt.
  Upstream copies the chat's Claude session for summaries and compaction to reuse its prompt cache; the
  shipped runtime has no hook to snapshot a session for them. Forked sessions start a fresh Claude session.
- **Tool calls:** `convert-claude-stream.ts` emits `tool-input-start/delta/end` before each `tool-call`,
  because the shipped session processor only records a call whose part `tool-input-start` opened.
- **Instructions:** taken from `session/llm.ts` input (`input.system` and the user's system text) rather than
  keyed instruction metadata. The per-turn environment block stays out, as upstream leaves out
  `core/date` and `core/environment`.
- **Tool errors and stops:** upstream's `context` hook flags tool errors and stops in provider metadata. The
  shipped runtime already sends failed tools as `error-text` results, which `tools/result.ts` marks as errors.
  Stopped calls get `toolAborted` from history conversion, so the waiting Claude turn is interrupted.
- **Generate calls:** upstream only streams. `doGenerate` collects the streamed reply, because the shipped CLI
  calls `generateObject`/`generateText` (agent creation, learning reflection). A JSON request is asked for in
  the prompt, since Claude Code has no structured-output mode, and a markdown fence around it is removed.
- **Per-project state:** each directory gets its own session registry, connection settings and login status.
- **MCP server:** built on `@modelcontextprotocol/sdk` 1.x (already bundled) instead of `@modelcontextprotocol/server` 2.x.
- **Connection settings:** `headerTimeout` and `chunkTimeout` are consumed by the provider loader before
  the factory runs, so they do not reach Claude Code.
- **Model list refresh:** a new list from a chat's `claude` start is saved and shown after the next
  instance reload; `/connect` reloads immediately.
- **Branding:** model-visible text says "Altimate Code"; internal tool names keep `mcp__opencode__*`.

## Tests

`packages/opencode/test/altimate/provider/claude-agent/` — upstream's tests (except `plugin.test.ts`,
which needs core's plugin host) replaying recorded real Claude sessions through the real SDK with a fake
`claude`, plus `integration.test.ts` for the Altimate-only modules.

<!-- AI-GENERATED: End -->
