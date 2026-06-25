# v1.17.9 Merge Regressions Found (Pillar 1: "was it merged right?")
Discovered by the upstream merge-correctness pass (test/upstream invariants). All FIXED in src unless noted.

## REAL regressions the v1.17.9 merge silently introduced (fixed):
1. **System prompts re-leaked upstream branding** — src/session/prompt/{default,codex,gpt,kimi}.txt reverted to
   "You are OpenCode" / github.com/anomalyco/opencode / opencode.ai. HIGHEST blast radius (sent to LLM every turn).
   Fixed -> "Altimate Code" / AltimateAI/altimate-code / altimate.ai.
2. **33 theme schema URLs** (packages/tui/src/theme/assets/*.json) reset to opencode.ai/theme.json. Fixed -> altimate.ai.
3. **21 httpapi OpenAPI descriptions** (src/server/routes/instance/httpapi/groups/*.ts) re-leaked "OpenCode" (root cause
   of many generated-SDK leaks). Fixed (strings only).
4. **20 TUI brand strings** (app.tsx title, dialog upsells/domains, tips, parsers-config, attention, permission). Fixed.
5. **`mcp add --name` non-interactive flag DROPPED** (src/cli/cmd/mcp.ts) — merge replaced fork's --name flag with a
   positional, breaking scripted MCP-add (2nd time per in-code history). Restored.
6. **anthropic login hint dropped** (src/cli/cmd/providers.ts) — restored `anthropic: "API key"`.
7. Plugin OAuth callback HTML titles + various CLI strings re-leaked OpenCode. Fixed.

## Real regression flagged for ARCHITECTURAL follow-up (.todo, not a 1-line fix):
8. **Duplicate `@opencode/Account` Effect Service identifier** — registered in BOTH src/account/account.ts AND
   src/account/index.ts -> shares one Layer slot (split-brain risk). Needs disambiguation or deleting stale index.ts
   variant + repointing its 2 importers. (Same class of bug as the auth/index vs auth/service dedup already handled.)

## Remaining branding leaks (out of shipped-src scope; .todo):
- ~107 in TEST fixtures (not shipped; mostly opencode.ai/config.json $schema fixtures).
- ~44 in GENERATED SDK artifacts (packages/sdk/.../gen/**, openapi.json) — need REGEN from rebranded descriptions, not hand-edit.
- ~11 deliberate User-Agent: opencode/${VERSION} provider headers (intentional compat).
- ~9 in packages/core/src/public/opencode.ts (intentional public Effect API class named OpenCode).

## Carry-forward features VERIFIED intact (merge preserved them; stale tests repointed):
build->builder alias, pluginSpecifier/pluginOptions/PluginSpec (moved config/plugin.ts), escapeHtml XSS guard (moved
@/util/html, still wraps every error interpolation — no XSS regression), Auth identifier dedup, logo brand colors,
variant_list keybind, SyncEvent->BusEvent bridge.

## Session behavioral regressions
- prompt.test: content-filter finish no longer persists ContentFilterError metadata or emits the expected session error.
- prompt.test: provider overflow with compaction.auto=false no longer records ContextOverflowError on the assistant.
- prompt.test: stop-finished assistant turns containing tool parts no longer schedule the required follow-up turn.
- prompt.test: subtask child sessions no longer inherit parent external_directory allow rules.
- prompt.test: running task tool parts no longer publish metadata before cancellation.
- prompt.test: SessionRunState no longer reports busy/idle consistently during prompt loops.
- prompt.test: prompt.cancel interrupts loop fibers instead of resolving with an aborted assistant message.
- prompt.test: cancelled prompt loops no longer persist MessageAbortedError on the interrupted assistant.
- prompt.test: cancellation before processor creation no longer finalizes assistant interruption state.
- prompt.test: slash-command subtask cancellation no longer cleans up child session busy/idle state.
- prompt.test: queued prompt.loop callers no longer share the cancelled assistant result.
- prompt.test: prompts submitted during an active run are no longer queued into the next LLM input.
- prompt.test: assertNotBusy no longer fails with SessionBusyError while a prompt loop is running.
- prompt.test: shell commands no longer observe prompt-loop busy state consistently.
- prompt.test: loop callers queued behind shell commands no longer wait/resume correctly.
- prompt.test: queued prompt.loop callers no longer resume cleanly after shell completion.
- prompt.test: command ! expansion no longer uses the configured shell over the environment shell.
- prompt.test: shell cancellation no longer finalizes an aborted shell result and idle run state cleanly.
- prompt.test: interrupted bash tool output no longer finalizes through normal truncation.
- prompt.test: cancelling a loop queued behind shell no longer resolves with the aborted shell result.
- prompt.test: concurrent shell calls no longer fail fast with SessionBusyError while another shell is running.
- prompt.test: prompt.prompt cancellation mid-stream no longer persists MessageAbortedError.
- processor-effect.test: token-overflow processing returns continue instead of compact.
- processor-effect.test: processor retry attempts no longer publish SessionStatus retry updates.
- processor-effect.test: interrupted pending tool calls remain pending instead of being persisted as aborted errors.
- processor-effect.test: interrupted processor runs no longer persist MessageAbortedError or idle state reliably.
- processor-effect.test: fiber interruption without manual abort no longer marks the assistant as MessageAbortedError.
- processor-effect.test: provider-executed tool error settlement hangs under the merged event bridge.
- processor-effect.test: partial text/reasoning fragments are not flushed before provider step failure.
- compaction.test: SessionCompaction.process bypasses injected fakes and hits the real localhost:1 provider path.
- compaction.test: compaction process no longer publishes the compacted continue event.
- compaction.test: compact result no longer marks the summary assistant with the compaction error.
- compaction.test: auto compaction no longer creates the synthetic continue prompt after summary.
- compaction.test: retained-tail compaction metadata no longer records tail_start_id.
- compaction.test: retained-tail sizing no longer shrinks to fit the preserve token budget.
- compaction.test: oversized recent turns no longer fall back to full summary input.
- compaction.test: media-heavy retained tails no longer fall back to full summary input when over budget.
- compaction.test: split-turn tail retention no longer keeps the later fitting suffix out of summary input.
- compaction.test: plugin autocontinue=false no longer suppresses the synthetic continue prompt.
- compaction.test: overflow compaction no longer replays the prior replayable user turn without media.
- compaction.test: overflow compaction no longer falls back to provider-size guidance when no replayable turn exists.
- compaction.test: aborting during retry backoff no longer stops the compaction process promptly.
- compaction.test: interrupting before processor setup can still leave summary assistant state behind.
- compaction.test: orphan reasoning deltas during summary generation no longer follow the expected drop behavior under the fake stream.
- compaction.test: summary generation no longer rejects tool calls through the injected compaction stream.
- compaction.test: summary input no longer reliably excludes the retained recent tail.
- compaction.test: repeated compaction no longer anchors new summaries with exactly one previous summary.
- compaction.test: repeated compaction no longer preserves configured recent pre-compaction turns.
- compaction.test: retained-tail sizing no longer ignores previous summary messages.
- message-v2.test: aborted bash tool errors drop partial stdout/stderr and only send the abort message.
- message-v2.test: signed Anthropic reasoning separated by empty text no longer preserves a non-empty separator.
- message-v2.test: OpenAI Responses API server_error chunks no longer become retryable APIError values.
