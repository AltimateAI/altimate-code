# Harness reliability review — deferred follow-ups

Deferred MED findings from the pre-PR release review (codex-release-review4).
All 5 HIGH findings plus selected MED/LOW items were fixed on this branch; the
items below were explicitly deferred and are listed verbatim from the review.

[MED] packages/opencode/src/tool/truncation.ts:66 — the plain-async truncation path hardcodes 2,000 lines/50KiB while the Effect wrapper honors `tool_output` configuration — MCP output through `prompt.ts` therefore ignores user caps despite the shared-core claim — consolidate the wrappers or pass the resolved configuration through both, with parity tests.

[MED] packages/opencode/src/session/compaction.ts:609 — carry-anchor trimming stops when one item remains — one oversized model-generated "Accomplished" item defeats `maxTokens` and can undo compaction — permit dropping or truncating the final item and assert the rendered result satisfies the cap.

[MED] packages/opencode/src/session/starvation.ts:330 — a mutating tool is credited at call time before its result is known — failed edits reset the zero-mutation counter, allowing varied failing writes to evade starvation detection — count attempts separately and mark mutation only after successful completion or snapshot evidence.

[MED] packages/opencode/src/cli/cmd/idle-done.ts:157 — every command not recognized as read-only is treated as verification — an exit-zero install, cleanup, deployment, or arbitrary unknown command can satisfy the "green verify" precondition and trigger a false completion challenge — require configured or positively classified verification evidence; unknown commands should be ineligible.

[MED] packages/opencode/src/session/compaction.ts:70 — observation masks retain the first 80 characters of pruned output, while the ledger retains raw command/path/pattern text — credentials, authorization headers, query data, and signed URLs can survive pruning and be recopied into later synthetic prompts — retain only allowlisted metadata or hashes and apply shared secret redaction.

[MED] packages/opencode/src/session/compaction.ts:517 — ledger capping repeatedly joins and re-estimates the whole array while removing one line at a time, after collecting the full session history — this is quadratic in unique writes and adds latency at the critical compaction path — bound collection early and trim using accumulated token costs or a single cutoff search.

[MED] packages/opencode/src/session/processor.ts:63 — provider-controlled call IDs index ordinary `{}` objects — IDs such as `__proto__`, `constructor`, or `toString` return inherited non-string values or mutate prototypes, breaking tool-call pairing — use `Map` or null-prototype dictionaries and test these keys.
