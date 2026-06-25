# Panel A — Evaluator A verdicts (lens: UPSTREAM-FIDELITY)

Per-delta verdict on whether the v1.17.9 merge's NEW behavior should be ACCEPTED (update
test) or the fork's old behavior RESTORED (fix src). Lens A defaults to ACCEPT/TEST-ARCH:
upstream's design is assumed intentional unless a clear safety/data-integrity/branded-UX
fork behavior was verifiably dropped.

Classes:
- TEST-ARCH = test can't inject its fake through the new Effect facade; behavior is fine,
  only the harness needs porting (not an accept/restore question).
- ACCEPT = the new upstream v1.17.9 behavior is reasonable/correct; test expectation is stale.
- RESTORE = the merge dropped a deliberate fork (or upstream) behavior that should be in src.

Key structural finding: the fork carries the OLD imperative `src/session/{processor,prompt,
compaction}.ts` with thin Effect Service facades. Upstream v1.17.9 rewrote these as real
Effect Services. Most `.todo` tests here are written against upstream's new Service shape and
fail because they can't inject Effect fakes through the delegating facade => TEST-ARCH.

## Verdicts

| Delta | Verdict | Confidence | Reason |
|---|---|---|---|
| message-v2.test.ts::forwards partial bash output for aborted tool calls | A:RESTORE | hi | Merge dropped upstream v1.17.9's interrupted-output forwarding (msg-v2:337); test=upstream behavior. |
| message-v2.test.ts::substitutes space for empty text between signed reasoning blocks | A:RESTORE | med | Fork safety guard (invalid empty segment between signed Anthropic reasoning) dropped; sibling tests confirm intent. |
| message-v2.test.ts::serializes OpenAI response server_error stream chunks as retryable APIError | A:RESTORE | hi | Merge dropped upstream's nested-message decode + server_error retryable case (error.ts:172). |
| snapshot-tool-race.test.ts::tool execution produces non-empty session diff (snapshot race) | A:RESTORE | hi | Upstream v1.17.9 pre-captures snapshot before stream (proc-effect:111); fork imperative path lost it. |
| instruction.test.ts::fetches remote instructions from config URLs via HttpClient | A:TEST-ARCH | hi | Already re-enabled as it.live with an Effect HttpClient fixture; harness-only port, behavior fine. |
| llm-native-recorded.test.ts::OpenAI OAuth: drives a tool loop to a final text answer | A:TEST-ARCH | hi | Empty stub; fails on missing gpt-5.5 recorded fixture, not behavior. |
| llm-native-recorded.test.ts::OpenCode proxy: drives a tool loop to a final text answer | A:TEST-ARCH | hi | Empty stub; falls through to live proxy (Invalid proxy path) — missing recording fixture. |
| llm-native-recorded.test.ts::Anthropic API key: drives a tool loop to a final text answer | A:TEST-ARCH | hi | Empty stub; falls through to live Anthropic URL — missing recording fixture. |
| processor-effect.test.ts::stop after token overflow requests compaction | A:TEST-ARCH | med | Imperative src trips needsCompaction on overflow (proc:448/615); Effect-facade usage-token path unreachable by harness. |
| processor-effect.test.ts::publish retry status updates | A:TEST-ARCH | hi | src publishes retry via SessionStatus.set singleton; injected EventV2Bridge listener never wired. |
| processor-effect.test.ts::mark pending tools as aborted on cleanup | A:TEST-ARCH | med | src settles pending tools to error (proc:598); interrupted-flag/fiber-interrupt plumbing is the only gap. |
| processor-effect.test.ts::record aborted errors and idle state | A:TEST-ARCH | hi | Fiber.interrupt of Effect.sync-wrapped imperative Promise doesn't reach abort mapping; behavior otherwise present. |
| processor-effect.test.ts::mark interruptions aborted without manual abort | A:TEST-ARCH | hi | Same facade-interruption bridging gap; imperative create() not interrupt-aware via injected Effect runtime. |
| processor-effect.test.ts::fail provider-executed error results | A:TEST-ARCH | hi | Injected LLM.Service fake bypassed; imperative create() uses LLM.stream singleton, hits real provider. |
| processor-effect.test.ts::flush partial v2 fragments before step failure | A:TEST-ARCH | hi | Same injected-LLM.Service bypass; imperative path ignores Effect LLM fake stream. |
| compaction.test.ts::publishes compacted event on continue | A:TEST-ARCH | hi | Compacted event exists in imperative src; injected fakes can't reach singleton process. |
| compaction.test.ts::marks summary message as errored on compact result | A:TEST-ARCH | hi | Injected compact-result SessionProcessor fake never reaches imperative create() singleton. |
| compaction.test.ts::adds synthetic continue prompt when auto is enabled | A:TEST-ARCH | hi | Synthetic continue exists in src (L385); facade can't inject auto-path fakes. |
| compaction.test.ts::persists tail_start_id for retained recent turns | A:TEST-ARCH | hi | tail_start_id is upstream-only feature absent from imperative src; needs Effect compaction ported. |
| compaction.test.ts::shrinks retained tail to fit preserve token budget | A:TEST-ARCH | hi | preserve_recent_tokens tail-budget is upstream-only; imperative fork src lacks it. |
| compaction.test.ts::falls back to full summary when even one recent turn exceeds preserve token budget | A:TEST-ARCH | hi | Tail-budget fallback is upstream-only feature missing from imperative src. |
| compaction.test.ts::falls back to full summary when retained tail media exceeds preserve token budget | A:TEST-ARCH | hi | Media tail-budget fallback is upstream-only; imperative path has no preserve logic. |
| compaction.test.ts::retains a split turn suffix when a later message fits the preserve token budget | A:TEST-ARCH | hi | Split-turn tail retention is upstream-only; absent from imperative compaction src. |
| compaction.test.ts::allows plugins to disable synthetic continue prompt | A:TEST-ARCH | hi | Plugin gate exists in src but injected Plugin fake bypassed by imperative Plugin.trigger. |
| compaction.test.ts::replays the prior user turn on overflow when earlier context exists | A:TEST-ARCH | hi | Overflow replay exists in src (L210-219); fakes unreachable through imperative process. |
| compaction.test.ts::falls back to overflow guidance when no replayable turn exists | A:TEST-ARCH | hi | Overflow guidance exists in src; fails only on facade injection of fakes. |
| compaction.test.ts::stops quickly when aborted during retry backoff | A:TEST-ARCH | hi | Injected LLM/status fakes can't drive imperative retry path; abort timing untestable via facade. |
| compaction.test.ts::does not leave a summary assistant when aborted before processor setup | A:TEST-ARCH | hi | Plugin-gated abort fake never reaches imperative singleton processor setup. |
| compaction.test.ts::silently drops reasoning-delta arriving without prior reasoning-start | A:TEST-ARCH | hi | Injected LLM stub stream never reaches imperative processor reasoning handling. |
| compaction.test.ts::does not allow tool calls while generating the summary | A:TEST-ARCH | hi | Injected LLM tool-call stub bypassed by imperative SessionProcessor.create singleton. |
| compaction.test.ts::summarizes only the head while keeping recent tail out of summary input | A:TEST-ARCH | hi | Head/tail split is upstream-only feature absent from imperative compaction src. |
| compaction.test.ts::anchors repeated compactions with the previous summary | A:TEST-ARCH | hi | previousSummary anchoring is upstream-only; imperative src has no anchor logic. |
| compaction.test.ts::keeps recent pre-compaction turns across repeated compactions | A:TEST-ARCH | hi | tail_turns retention across compactions is upstream-only; imperative path lacks it. |
| compaction.test.ts::ignores previous summaries when sizing the retained tail | A:TEST-ARCH | hi | Retained-tail sizing is upstream-only feature missing from imperative compaction src. |
| prompt.test.ts::loop surfaces content-filter finishes as session errors | A:RESTORE | med | Fork loop never maps content-filter finish to a session Error; upstream surfaces it. |
| prompt.test.ts::loop stops provider overflow instead of auto-compacting when disabled | A:RESTORE | med | Fork loop auto-compacts on overflow even when compaction.auto:false; upstream stops with error. |
| prompt.test.ts::loop continues when finish is stop but assistant has tool parts | A:TEST-ARCH | hi | Two-call tool loop works in src; test can't drive recorded LLM through facade. |
| prompt.test.ts::subtask child inherits parent session external_directory allow | A:TEST-ARCH | med | Permission.merge inheritance exists/upstream (prompt.ts:330); test can't observe child rules via facade. |
| prompt.test.ts::running task tool preserves metadata after tool-call transition | A:TEST-ARCH | hi | Sibling non-todo metadata test passes; this one only differs by hang/poll injection timing. |
| prompt.test.ts::loop sets status to busy then idle | A:TEST-ARCH | hi | busy/idle status set via SessionStatus.set singleton; injected status listener never wired. |
| prompt.test.ts::cancel interrupts loop and resolves with an assistant message | A:TEST-ARCH | hi | Imperative cancel()+processor catch resolve assistant; facade can't drive cancel timing. |
| prompt.test.ts::cancel records MessageAbortedError on interrupted process | A:TEST-ARCH | hi | src maps abort→MessageAbortedError via processor catch; only fiber-interrupt plumbing missing. |
| prompt.test.ts::finalizes assistant when cancelled before processor creation completes | A:TEST-ARCH | med | Early-cancel finalize exists; race only observable through injected Effect runtime timing. |
| prompt.test.ts::cancel propagates from slash command subtask to child session | A:TEST-ARCH | hi | Child cancel propagation present; test can't observe child status via facade. |
| prompt.test.ts::cancel with queued callers resolves all cleanly | A:TEST-ARCH | hi | run-state queue resolves callers; test can't inject hang/queue through facade. |
| prompt.test.ts::prompt submitted during an active run is included in the next LLM input | A:TEST-ARCH | hi | Queued-prompt merge exists in run-state; injected LLM-input assertion unreachable via facade. |
| prompt.test.ts::assertNotBusy fails with BusyError when loop running | A:TEST-ARCH | hi | BusyError busy-lock exists in run-state; test can't hold loop busy through facade. |
| prompt.test.ts::shell rejects with BusyError when loop running | A:TEST-ARCH | hi | Shell BusyError guard present; injected loop-running state unreachable through facade. |
| prompt.test.ts::loop waits while shell runs and starts after shell exits | A:TEST-ARCH | hi | Shell/loop serialization exists in run-state; injected shell fake can't drive wait path. |
| prompt.test.ts::shell completion resumes queued loop callers | A:TEST-ARCH | hi | Queued-caller resume exists in run-state; injected shell completion unreachable via facade. |
| prompt.test.ts::command ! expansion uses configured shell over env shell | A:RESTORE | med | Fork calls Shell.preferred() w/o cfg.shell (prompt.ts:2491); upstream passes Shell.preferred(cfg.shell). |
| prompt.test.ts::cancel interrupts shell and resolves cleanly | A:TEST-ARCH | hi | Shell cancel exists in src; test can't drive cancel/waitForBusy through facade. |
| prompt.test.ts::cancel finalizes interrupted bash tool output through normal truncation | A:TEST-ARCH | med | Interrupted bash truncation exists; depends on cancel-timing injection through facade. |
| prompt.test.ts::cancel interrupts loop queued behind shell | A:TEST-ARCH | hi | Queued-loop cancel exists in run-state; test can't drive shell+queue+cancel through facade. |
| prompt.test.ts::shell rejects when another shell is already running | A:TEST-ARCH | hi | Single-shell lock exists in run-state; concurrent-shell injection only reachable through facade. |
| prompt.test.ts::records aborted errors when prompt is cancelled mid-stream | A:TEST-ARCH | hi | src persists MessageAbortedError on mid-stream abort; facade can't inject hang+cancel timing. |
