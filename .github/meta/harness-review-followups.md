# Harness reliability review — deferred follow-ups

Deferred MED findings from the pre-PR release review (pre-PR adversarial review).
All 5 HIGH findings plus selected MED/LOW items were fixed on this branch; the
items below were explicitly deferred and are listed verbatim from the review.

[MED] packages/opencode/src/tool/truncation.ts:66 — the plain-async truncation path hardcodes 2,000 lines/50KiB while the Effect wrapper honors `tool_output` configuration — MCP output through `prompt.ts` therefore ignores user caps despite the shared-core claim — consolidate the wrappers or pass the resolved configuration through both, with parity tests.

[MED] packages/opencode/src/session/compaction.ts:663 (renderCarryAnchors) — carry-anchor trimming stops when one item remains — one oversized model-generated "Accomplished" item defeats `maxTokens` and can undo compaction — permit dropping or truncating the final item and assert the rendered result satisfies the cap.

[MED] packages/opencode/src/cli/cmd/idle-done.ts:157 — every command not recognized as read-only is treated as verification — an exit-zero install, cleanup, deployment, or arbitrary unknown command can satisfy the "green verify" precondition and trigger a false completion challenge — require configured or positively classified verification evidence; unknown commands should be ineligible.

[MED] packages/opencode/src/session/compaction.ts:70 — observation masks retain the first 80 characters of pruned output, while the ledger retains raw command/path/pattern text — credentials, authorization headers, query data, and signed URLs can survive pruning and be recopied into later synthetic prompts — retain only allowlisted metadata or hashes and apply shared secret redaction.

[MED] packages/opencode/src/session/compaction.ts:572 (renderLedger) — ledger capping repeatedly joins and re-estimates the whole array while removing one line at a time, after collecting the full session history — this is quadratic in unique writes and adds latency at the critical compaction path — bound collection early and trim using accumulated token costs or a single cutoff search.

The following items from a later review pass were also considered and deliberately
deferred (no behavior change on this branch):

[LOW] packages/opencode/src/cli/cmd/run/run-mode.ts — the run entrypoint writes its process-scoped mode marker into the environment for the process lifetime, and child processes inherit it; a nested interactive server launched from such a session would arm run-mode mechanisms for genuinely interactive clients — clear or scope the marker in the interactive entrypoints (mirroring the existing child-env cleanup for the sibling non-interactive marker).

[LOW] packages/opencode/src/session/compaction.ts — module-level per-session pin state and per-session tracker read maps grow without bound in a long-lived server process (the pin map has no production eviction path; per-session read tracking keeps one entry per unique path for the session's lifetime) — bound both with the same LRU pattern now used by the session-state stores.

[LOW] packages/opencode/src/session/prompt.ts — the post-compaction pinned-task reminder re-derives its source by streaming the FULL session history from the database on every generation once a session has compacted — cache the resolved pin source per session or query only the needed boundary messages.

[LOW] packages/opencode/src/session/termination.ts — the post-compaction three-option completion nudge (including the completion-token instruction) is injected in ALL modes; interactive users can see an occasional bare completion token line with no interactive function — mode-gate the nudge text or document the cosmetic change.

The following items came from an external multi-reviewer pass over this branch and
were deliberately deferred (no behavior change on this branch):

[MED] packages/opencode/src/cli/cmd/run.ts — a prompt retry after a client timeout or connection reset can hit the server AFTER it accepted the original POST, sending the same task again and creating a second user message / duplicate execution — the retry loop has no way to tell "not yet accepted" from "accepted, response lost." Needs a stable idempotency/message key the server honors, or a way to confirm the first attempt was never accepted before retrying.

[MED] packages/opencode/src/session/compaction.ts (fitHead) — the summarization-request budget reserves a fixed 2,000 tokens for the summary prompt, but the actual assembled prompt (default template + carry anchors + pin-summary addition + first-person reframe, or a plugin-supplied override) can exceed that on an active session — size the reservation from the actual assembled prompt instead of a constant.

[MED] packages/opencode/src/session/compaction.ts (buildLedger) — on a session's second or later auto-compaction, the ledger is built from the already-filtered/compacted message view, not the full session stream, so verified-write facts from before the first compaction silently drop out of later ledgers — build from the full stream and let selection filter afterward.

[LOW] packages/opencode/src/session/prompt.ts (uncountedTail) — the proactive overflow estimate sums tool-result tokens on messages AFTER the last-finished assistant message, but a tool call and its result can live on that SAME message when the turn is still mid-flight — those results are excluded from the estimate, so compaction can fire a step later than it should on a heavy tool-output turn.

[LOW] packages/opencode/src/tool/truncate-core.ts (preview, middle direction) — a degenerate `maxBytes: 1` config (no realistic caller sets this) can still allocate one byte to each of the head/tail halves and exceed the byte budget by a small margin; the equivalent `maxLines: 1` case was already fixed by degrading to tail-only — extend the same degrade to the byte-only case.

[LOW] packages/opencode/src/session/{termination,nudge,tool-result-cap}.ts, packages/opencode/src/cli/cmd/{run-accounting,idle-done}.ts — these 5 new modules use `export namespace` for organization, which the repo's module-shape convention (`packages/opencode/AGENTS.md`) asks new code to avoid in favor of flat exports + a bottom-of-file self-reexport. ~69 pre-existing files in the package already use the same pattern, so this is consistent with existing debt rather than a regression; fold into a holistic namespace-to-flat-exports cleanup across the package rather than converting these 5 files in isolation.

[LOW] packages/opencode/test/session/starvation.test.ts — the run-mode "armed" gate test re-implements the gate expression as a local helper instead of importing the real predicate from processor.ts, so a future change to the actual gate (added condition, reordered precedence, renamed exemption) would not be caught by this test — extract the gate into a shared, directly-testable predicate.

The following items came from a further multi-reviewer pass over this branch and
were deliberately deferred (no behavior change on this branch):

[MED] packages/opencode/src/session/llm.ts (addHistoricalToolStubs) — the stub-injection skip was narrowed to `toolChoice === "none" && no tools`, which closes the normal-turn regression, but the compaction summarizer still takes that path with a head that references historical tool calls. The skip rests on the claim that omitting both `tools` and `tool_choice` is universally accepted; the issue the stubs exist to fix concerned validation of referenced historical tool calls, which is orthogonal. Verify against the provider that originally needed the stubs before changing anything — reintroducing stubs here would advertise callable tools on a text-only call, so this is a provider-compatibility question, not a code cleanup.

[MED] packages/opencode/src/session/starvation.ts (repeatSignature / consecutive-signature counter) — the repeat signature folds the failure message in but the counter accumulates for successful calls too, so three identical SUCCESSFUL calls (re-running the same verification command, polling a status probe) reach the threshold and produce a directive asserting that repeating the call cannot change the result, which is untrue for a polling or verification call. Restricting accumulation to calls that carry a failure message narrows the detector's semantics and its overlap with the identical-args doom-loop ladder; make that change with validation data rather than in review, and note the directive text is prompt-visible.

[LOW] packages/opencode/src/cli/cmd/run-accounting.ts (termination) — `why_model_stopped` falls back to "stop" when no step-finish reason was ever recorded (an aborted run that never completed a step), so the run record attributes an ordinary stop to a session that never reported one. Distinguishing it needs a new value in the published record's enum, which is an output-contract change for downstream consumers — batch it with the next deliberate revision of the run record schema.

[LOW] packages/opencode/src/session/prompt.ts (post-compaction pin reminder) and packages/opencode/test/cli/idle-done.test.ts — the idle-done unit tests now pin production event ordering (step-finish part before the step's snapshot patch part) in two dedicated cases, but the shared fixtures still emit the patch first; converge the remaining fixtures on production ordering when the file is next touched.

The following items came from the fourth review pass over this branch and were
deliberately deferred (no behavior change on this branch):

[MED] packages/opencode/src/session/processor.ts (dispatch tool-result cap) — the per-result hard cap is applied on the successful `tool-result` branch only. A `tool-error` still persists an unbounded error string, and an interrupted running tool keeps partial output in metadata that `message-v2.ts` later replays as a tool result, so a failed call with very large stderr can still overflow the next request. Applying the cap to error text and interrupted partial output changes what gets PERSISTED on the failure path, which is where diagnostics come from — size it against real failure payloads before truncating them.

[MED] packages/opencode/src/cli/cmd/idle-done.ts (verify classification) — with no configured verify command, ANY non-read-only bash command is treated as a verification, so a mutating command that is not on the mutating-heads list (a build script that also writes generated sources, say) can register as the green verify it is not. The mutation watermark now advances for the in-place, redirection, and known-mutating-head forms, but the underlying "not read-only implies verification" inference still needs replacing with an explicit verify classifier.

[LOW] packages/opencode/src/cli/cmd/run.ts (--max-turns) — `--max-turns 0` disables the limit entirely because the guard is a truthiness check, and negative or fractional values are accepted without validation. For a governance control an explicit zero should not mean unlimited; fix it together with the CLI validation pass that gives the other numeric options explicit range errors, so the behavior change is documented in one place.

[LOW] packages/opencode/src/tool/bash.ts (child env) — `ALTIMATE_RUN_RESUMED` joins `ALTIMATE_RUN_MODE` as a marker that nested processes inherit from the bash tool's merged env. Its leak direction is benign (a nested run would use interactive pin selection), but it belongs in the same holistic decision about which run-scoped markers get stripped for child processes.
