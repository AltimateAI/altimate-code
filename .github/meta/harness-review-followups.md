# Harness reliability review — deferred follow-ups

Deferred MED findings from the pre-PR release review (pre-PR adversarial review).
All 5 HIGH findings plus selected MED/LOW items were fixed on this branch; the
items below were explicitly deferred and are listed verbatim from the review.

[MED] packages/opencode/src/tool/truncation.ts:66 — the plain-async truncation path hardcodes 2,000 lines/50KiB while the Effect wrapper honors `tool_output` configuration — MCP output through `prompt.ts` therefore ignores user caps despite the shared-core claim — consolidate the wrappers or pass the resolved configuration through both, with parity tests.

[MED] packages/opencode/src/session/compaction.ts:609 — carry-anchor trimming stops when one item remains — one oversized model-generated "Accomplished" item defeats `maxTokens` and can undo compaction — permit dropping or truncating the final item and assert the rendered result satisfies the cap.

[MED] packages/opencode/src/cli/cmd/idle-done.ts:157 — every command not recognized as read-only is treated as verification — an exit-zero install, cleanup, deployment, or arbitrary unknown command can satisfy the "green verify" precondition and trigger a false completion challenge — require configured or positively classified verification evidence; unknown commands should be ineligible.

[MED] packages/opencode/src/session/compaction.ts:70 — observation masks retain the first 80 characters of pruned output, while the ledger retains raw command/path/pattern text — credentials, authorization headers, query data, and signed URLs can survive pruning and be recopied into later synthetic prompts — retain only allowlisted metadata or hashes and apply shared secret redaction.

[MED] packages/opencode/src/session/compaction.ts:517 — ledger capping repeatedly joins and re-estimates the whole array while removing one line at a time, after collecting the full session history — this is quadratic in unique writes and adds latency at the critical compaction path — bound collection early and trim using accumulated token costs or a single cutoff search.

The following items from a later review pass were also considered and deliberately
deferred (no behavior change on this branch):

[LOW] packages/opencode/src/cli/cmd/run/run-mode.ts — the run entrypoint writes its process-scoped mode marker into the environment for the process lifetime, and child processes inherit it; a nested interactive server launched from such a session would arm run-mode mechanisms for genuinely interactive clients — clear or scope the marker in the interactive entrypoints (mirroring the existing child-env cleanup for the sibling non-interactive marker).

[LOW] packages/opencode/src/session/compaction.ts — module-level per-session pin state and per-session tracker read maps grow without bound in a long-lived server process (the pin map has no production eviction path; per-session read tracking keeps one entry per unique path for the session's lifetime) — bound both with the same LRU pattern now used by the session-state stores.

[LOW] packages/opencode/src/session/prompt.ts — the post-compaction pinned-task reminder re-derives its source by streaming the FULL session history from the database on every generation once a session has compacted — cache the resolved pin source per session or query only the needed boundary messages.

[LOW] packages/opencode/src/session/termination.ts — the post-compaction three-option completion nudge (including the completion-token instruction) is injected in ALL modes; interactive users can see an occasional bare completion token line with no interactive function — mode-gate the nudge text or document the cosmetic change.
