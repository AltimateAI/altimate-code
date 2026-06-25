# Panel B — FORK-GUARDIAN verdicts (session test deltas vs v1.17.9 merge)

Lens: B = fork-guardian. RESTORE = the merge dropped a deliberate fork **or proven-correct upstream**
data-integrity / abort / error-surfacing / compaction-policy behavior that the test encodes → fix `src`.
ACCEPT = neither fork nor upstream implemented the asserted behavior (aspirational triage test), or fork
legitimately diverges and current==fork-pre-merge → test is stale. TEST-ARCH = the asserted behavior IS
present and unchanged in current `src` (== `main`), but the new Effect facade / legacy-instance harness
cannot inject/drive the imperative singleton path (harness-only failure, no src regression).

## Method / key evidence
- Compared each delta against `git show main:<src>` (fork pre-merge) AND `git show v1.17.9:<src>` (upstream).
- Decisive axis: **does current `src` DIFFER from `main`?** `git diff main -- session/prompt.ts` shows the
  ONLY change is an added Effect `Service` facade (cancel/shell wrappers) at EOF; the imperative core
  (`assertNotBusy`, `cancel`, `shell`, abort registry, loop, `modelFinished`) is UNCHANGED from `main`.
  Same for `processor.ts` (imperative `create()`/`process()` carried over verbatim, `LLM.stream` singleton
  at line 83) and `compaction.ts` (`process()` is still the fork's imperative namespace fn).
- Therefore most cancel/abort/shell/busy/compaction failures are HARNESS injection problems (TEST-ARCH),
  NOT dropped fork behavior. Fork-guardian discipline: do NOT over-RESTORE when the fork code is intact.
- Genuine RESTOREs = where upstream v1.17.9 `src` has a proven data-integrity/error behavior that the
  merge failed to port (the fork kept its OLD imperative path). The `.todo` test comments label these
  "BUG: REGRESSION" — i.e. regression vs v1.17.9, which is real.

---

## message-v2.test.ts (3) — RESTORE (proven upstream data-integrity behavior lost in merge)
v1.17.9 message-v2.ts implements ALL three (lines 337, 274-290) and provider/error.ts:139 (`server_error`→retryable:true).
Current src kept the fork's old `toModelMessages`/`parseStreamError` which lack them (main==current==missing).

message-v2.test.ts::forwards partial bash output for aborted tool calls | B:RESTORE | confidence:hi | v1.17.9:337 forwards interrupted bash output; merge kept fork path dropping stdout/stderr
message-v2.test.ts::substitutes space for empty text between signed reasoning blocks | B:RESTORE | confidence:hi | v1.17.9:274-290 emits " " separator for signed Anthropic reasoning; merge dropped it
message-v2.test.ts::serializes OpenAI response server_error stream chunks as retryable APIError | B:RESTORE | confidence:hi | v1.17.9 provider/error:139 marks server_error retryable; fork parseStreamError lacks the case

## processor-effect.test.ts (7)
processor-effect.test.ts::stop after token overflow requests compaction | B:ACCEPT | confidence:hi | fork's PR#35 isOverflow safety guard (base<=20k buffer) deliberately returns continue for context:20 fixture
processor-effect.test.ts::publish retry status updates | B:TEST-ARCH | confidence:hi | retry SessionStatus.set intact (src 540, ==main); status not routed through injected EventV2Bridge in harness
processor-effect.test.ts::mark pending tools as aborted on cleanup | B:TEST-ARCH | confidence:hi | cleanup loop settling tools intact (src 596-612, ==main); imperative cleanup runs async after Fiber.interrupt
processor-effect.test.ts::record aborted errors and idle state | B:TEST-ARCH | confidence:med | abort→MessageAbortedError+idle path intact (catch 520-578, ==main); Effect-bridge race, not src regression
processor-effect.test.ts::mark interruptions aborted without manual abort | B:TEST-ARCH | confidence:med | same fromError abort mapping intact; Fiber.interrupt tears fiber before imperative catch flushes
processor-effect.test.ts::fail provider-executed error results | B:TEST-ARCH | confidence:hi | process() uses LLM.stream singleton (src 83), injected Effect LLM fake never reaches code under test
processor-effect.test.ts::flush partial v2 fragments before step failure | B:TEST-ARCH | confidence:hi | same: imperative process bypasses injected LLM.Service; fake stream not driveable through facade

## prompt.test.ts (22)
RESTORE = upstream-only behavior dropped in merge. TEST-ARCH = fork code intact (diff = facade only), harness can't drive imperative abort-registry/shell-mutex/forked-fiber timing.

prompt.test.ts::loop surfaces content-filter finishes as session errors | B:RESTORE | confidence:hi | v1.17.9 processor:1343-1348 surfaces ContentFilterError on content-filter finish; current src=0, merge dropped it
prompt.test.ts::loop stops provider overflow instead of auto-compacting when disabled | B:RESTORE | confidence:med | v1.17.9 processor:927 honors compaction.auto:false on reactive overflow; merge kept fork's always-compact path
prompt.test.ts::loop continues when finish is stop but assistant has tool parts | B:RESTORE | confidence:med | v1.17.9:1159-1167 hasToolCalls continuation; fork modelFinished (==main) terminates, tools unexecuted
prompt.test.ts::subtask child inherits parent session external_directory allow | B:ACCEPT | confidence:lo | no version (fork/upstream) implements external_directory inheritance; aspirational triage test, nothing dropped
prompt.test.ts::running task tool preserves metadata after tool-call transition | B:TEST-ARCH | confidence:med | sibling "failed subtask preserves metadata" passes (harness works); running→tool transition timing only
prompt.test.ts::loop sets status to busy then idle | B:TEST-ARCH | confidence:med | busy/idle SessionStatus.set intact in src (==main); forked-fiber status observation timing under legacy runner
prompt.test.ts::cancel interrupts loop and resolves with an assistant message | B:TEST-ARCH | confidence:med | cancel()=abort.abort() intact (src 321-330, ==main); Effect cancel/Fiber bridge resolution timing
prompt.test.ts::cancel records MessageAbortedError on interrupted process | B:TEST-ARCH | confidence:med | MessageAbortedError persisted via processor catch (intact, ==main); async catch not flushed before assert
prompt.test.ts::finalizes assistant when cancelled before processor creation completes | B:TEST-ARCH | confidence:med | pre-creation cancel handled by cancel() idle-direct branch (src 325-328, ==main); harness race
prompt.test.ts::cancel propagates from slash command subtask to child session | B:TEST-ARCH | confidence:med | child-session abort propagation via abort registry intact (==main); facade-driven propagation timing
prompt.test.ts::cancel with queued callers resolves all cleanly | B:TEST-ARCH | confidence:med | queued-caller resolution is imperative defer/registry logic intact (==main); harness can't drive cleanly
prompt.test.ts::prompt submitted during an active run is included in the next LLM input | B:TEST-ARCH | confidence:med | mid-run queue logic intact in src (==main); injection of second prompt through facade is the blocker
prompt.test.ts::assertNotBusy fails with BusyError when loop running | B:TEST-ARCH | confidence:med | assertNotBusy/BusyError intact (src 148-150, ==main); busy-window timing under forked-fiber harness
prompt.test.ts::shell rejects with BusyError when loop running | B:TEST-ARCH | confidence:med | shell BusyError guard intact (==main); concurrent loop+shell state not reproducible through facade
prompt.test.ts::loop waits while shell runs and starts after shell exits | B:TEST-ARCH | confidence:med | shell/loop mutex intact in imperative src (==main); coordination timing not driveable via Effect facade
prompt.test.ts::shell completion resumes queued loop callers | B:TEST-ARCH | confidence:med | queued-loop resume is intact imperative logic (==main); harness can't sequence shell-then-loop
prompt.test.ts::command ! expansion uses configured shell over env shell | B:TEST-ARCH | confidence:lo | Shell.preferred expansion intact; withSh env-mutation fixture / shell-injection harness issue
prompt.test.ts::cancel interrupts shell and resolves cleanly | B:TEST-ARCH | confidence:med | shell-cancel cleanup intact (==main); Effect cancel-of-shell bridge timing, no src change
prompt.test.ts::cancel finalizes interrupted bash tool output through normal truncation | B:TEST-ARCH | confidence:med | bash truncation+abort path intact (==main); same Effect interrupt-vs-async-cleanup race
prompt.test.ts::cancel interrupts loop queued behind shell | B:TEST-ARCH | confidence:med | cancel of shell-queued loop is intact registry logic (==main); harness sequencing only
prompt.test.ts::shell rejects when another shell is already running | B:TEST-ARCH | confidence:med | single-shell mutex guard intact in src (==main); concurrent-shell state not reproducible via facade
prompt.test.ts::records aborted errors when prompt is cancelled mid-stream | B:TEST-ARCH | confidence:med | mid-stream cancel→MessageAbortedError persisted via processor catch (intact, ==main); async-flush race

## compaction.test.ts (19) — all TEST-ARCH
Root: `SessionCompaction.process` is the fork's imperative namespace fn using singletons (SessionProcessor.create,
Plugin.trigger, Provider, Session), so injected LLM/processor/plugin/status fakes never reach it. Every fork
policy the tests touch that IS in src (synthetic-continue, replay-on-overflow, overflow-guidance, parent
validation, circuit breaker) is intact == main. Tail/preserve/previous-summary/compaction_continue assertions
are UPSTREAM-only features (fork process() src=0, v1.17.9=11) — stale-against-upstream, but blocked by facade first.

compaction.test.ts::publishes compacted event on continue | B:TEST-ARCH | confidence:hi | process is imperative singleton fn; injected fakes/Bus never reach code under test
compaction.test.ts::marks summary message as errored on compact result | B:TEST-ARCH | confidence:hi | fake processor result not injectable through facade; src uses SessionProcessor singleton
compaction.test.ts::adds synthetic continue prompt when auto is enabled | B:TEST-ARCH | confidence:hi | synthetic-continue policy present in src (==main); failure is facade injection not dropped behavior
compaction.test.ts::persists tail_start_id for retained recent turns | B:TEST-ARCH | confidence:hi | tail retention upstream-only (fork src=0); blocked by facade injection regardless
compaction.test.ts::shrinks retained tail to fit preserve token budget | B:TEST-ARCH | confidence:hi | preserve_recent_tokens upstream-only; fork process never sized tail; not injectable
compaction.test.ts::falls back to full summary when even one recent turn exceeds preserve token budget | B:TEST-ARCH | confidence:hi | upstream tail-budget behavior absent in fork; facade injection blocks
compaction.test.ts::falls back to full summary when retained tail media exceeds preserve token budget | B:TEST-ARCH | confidence:hi | upstream tail-media budgeting; fork never had it; LLM fake not injected
compaction.test.ts::retains a split turn suffix when a later message fits the preserve token budget | B:TEST-ARCH | confidence:hi | upstream split-tail behavior absent in fork; process not Effect-injectable
compaction.test.ts::allows plugins to disable synthetic continue prompt | B:TEST-ARCH | confidence:hi | Plugin.trigger singleton; plugin layer fake never reaches imperative process
compaction.test.ts::replays the prior user turn on overflow when earlier context exists | B:TEST-ARCH | confidence:hi | replay-on-overflow IS fork src behavior (==main); failure is facade injection not regression
compaction.test.ts::falls back to overflow guidance when no replayable turn exists | B:TEST-ARCH | confidence:hi | overflow-guidance present in src (==main); blocked by non-injectable singleton facades
compaction.test.ts::stops quickly when aborted during retry backoff | B:TEST-ARCH | confidence:hi | LLM/status fakes not injected into imperative process; abort path unreachable by harness
compaction.test.ts::does not leave a summary assistant when aborted before processor setup | B:TEST-ARCH | confidence:hi | plugin-gated abort fake not injectable; process uses singleton Plugin/Processor
compaction.test.ts::silently drops reasoning-delta arriving without prior reasoning-start | B:TEST-ARCH | confidence:med | reasoning-delta handling in processor; LLM fake not injected through facade
compaction.test.ts::does not allow tool calls while generating the summary | B:TEST-ARCH | confidence:hi | LLM fake emitting toolCall not injected; process singleton path unreachable
compaction.test.ts::summarizes only the head while keeping recent tail out of summary input | B:TEST-ARCH | confidence:hi | head/tail split upstream-only; fork src absent; LLM capture not injected
compaction.test.ts::anchors repeated compactions with the previous summary | B:TEST-ARCH | confidence:hi | previous-summary anchoring upstream-only (fork src=0); LLM fake not injectable
compaction.test.ts::keeps recent pre-compaction turns across repeated compactions | B:TEST-ARCH | confidence:hi | tail_turns retention upstream-only; fork process never retained turns; facade blocks injection
compaction.test.ts::ignores previous summaries when sizing the retained tail | B:TEST-ARCH | confidence:hi | tail-sizing upstream-only; absent in fork; not Effect-injectable

## Flaky / fixture (4) — not in the 52-merge-regression set
snapshot-tool-race.test.ts::tool execution produces non-empty session diff (snapshot race) | B:RESTORE | confidence:med | v1.17.9 pre-captures snapshot BEFORE LLM stream (processor:111-121); fork only tracks at start-step → empty diff race
llm-native-recorded.test.ts::OpenAI OAuth: drives a tool loop to a final text answer | B:TEST-ARCH | confidence:hi | missing gpt-5.5 model fixture; recorded-HTTP/fixture harness gap, no src behavior
llm-native-recorded.test.ts::OpenCode proxy: drives a tool loop to a final text answer | B:TEST-ARCH | confidence:hi | recorded HTTP falls through to live proxy URL (Invalid proxy path); cassette/fixture gap
llm-native-recorded.test.ts::Anthropic API key: drives a tool loop to a final text answer | B:TEST-ARCH | confidence:hi | recorded HTTP falls through to live Anthropic URL with fixture creds; cassette/fixture gap

---

## Counts
Non-flaky deltas (51): message-v2 3 + processor-effect 7 + prompt 22 + compaction 19 = 51
- RESTORE: 6  (message-v2 ×3, prompt content-filter, prompt overflow-disabled, prompt stop-with-tool-parts)
- ACCEPT: 2   (processor-effect overflow-guard fixture, prompt external_directory inheritance)
- TEST-ARCH: 43 (processor-effect ×6, prompt ×18, compaction ×19)

Flaky/fixture (4): RESTORE 1 (snapshot-race), TEST-ARCH 3 (llm-native-recorded).

Grand total (55): RESTORE 7 · ACCEPT 2 · TEST-ARCH 46.

## Fork-guardian note
The merge did NOT silently regress fork-authored abort/cancel/shell/compaction code — `git diff main` proves
that imperative core is intact (only Effect facades were added). The genuine src gaps are where v1.17.9 shipped
proven data-integrity / error-surfacing fixes (partial-bash-output, signed-reasoning separator, server_error
retryable, content-filter surfacing, compaction.auto:false overflow-stop, stop-with-tool-parts continuation,
pre-stream snapshot) that the merge failed to port because it carried the fork's OLD imperative modules forward.
Those 7 are RESTORE (fix src toward upstream). The remaining 46 are harness/facade injection problems: the new
Effect Service facades + legacy-instance runner cannot drive the imperative singleton paths — fix the harness,
not src. Lens-bias caveat: I deliberately did NOT RESTORE the cancel/abort/shell cluster despite my fork-guardian
default, because the fork behavior is demonstrably present and unchanged in `src`; restoring it would be a no-op.
