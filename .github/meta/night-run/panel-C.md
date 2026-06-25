# Panel C — User-Impact + Risk Lens (tie-breaker)

Lens: (a) does the NEW behavior cause user-visible harm (stuck session / lost output / silent failure / missing error)? (b) how risky is the src restore? Severe harm + cheap restore = RESTORE; cosmetic/internal or harm-low-but-restore-structural = ACCEPT; fake-can't-inject-through-imperative-facade = TEST-ARCH.

Key cross-cutting finding: v1.17.9 upstream `message-v2.ts` DOES contain the interrupted-output, signed-reasoning-separator, and nested-server_error behaviors; the merge dropped them into the imperative file. Those three are real, cheap (code sits verbatim in `git show v1.17.9`), low-risk restores. The processor/prompt/compaction `it.live`/`it.instance` deltas are dominated by one structural cause: the fork keeps the imperative `LLM.stream` / `SessionStatus.set` / `Bus.publish` singletons, so Effect-injected `LLM.Service`/`EventV2Bridge`/`SessionStatus` fakes never observe the real path. Those are TEST-ARCH unless the test drives the REAL HTTP mock (`*ServerLegacy`) and asserts a real behavior gap.

## message-v2.test.ts

message-v2.test.ts::forwards partial bash output for aborted tool calls | C:RESTORE | confidence:hi | high harm: user loses partial stdout on abort; v1.17.9 code present, trivial restore
message-v2.test.ts::substitutes space for empty text between signed reasoning blocks | C:RESTORE | confidence:hi | harm: Anthropic rejects signed-reasoning replay = broken turn; one-liner restore from v1.17.9
message-v2.test.ts::serializes OpenAI response server_error stream chunks as retryable APIError | C:RESTORE | confidence:hi | harm: retryable error shown as fatal Unknown, user stuck; small parser restore

## processor-effect.test.ts

processor-effect.test.ts::stop after token overflow requests compaction | C:RESTORE | confidence:med | runs real HTTP mock; compaction-skip risks silent context overflow; isOverflow threshold fix is contained
processor-effect.test.ts::publish retry status updates | C:TEST-ARCH | confidence:hi | retry works (sibling test passes); only the Effect EventV2 listener is blind; cosmetic-status, restore=rewire facade
processor-effect.test.ts::mark pending tools as aborted on cleanup | C:TEST-ARCH | confidence:med | abort cleanup is imperative; fake fiber-interrupt can't observe it; real abort path likely fine
processor-effect.test.ts::record aborted errors and idle state | C:TEST-ARCH | confidence:med | MessageAbortedError persisted via imperative path; Effect listener can't see it; high restore risk
processor-effect.test.ts::mark interruptions aborted without manual abort | C:TEST-ARCH | confidence:med | fiber-interrupt-only is an Effect-runtime concept the imperative process never receives
processor-effect.test.ts::fail provider-executed error results | C:TEST-ARCH | confidence:hi | note itself: bypasses injected LLM, hits real provider; pure injection gap, no user harm
processor-effect.test.ts::flush partial v2 fragments before step failure | C:TEST-ARCH | confidence:hi | note itself: injected LLM fake unreachable, times out; harness-only, structural restore

## prompt.test.ts (22)

prompt.test.ts::loop surfaces content-filter finishes as session errors | C:RESTORE | confidence:med | missing error = silent dead loop for user; error-mapping restore is contained
prompt.test.ts::loop stops provider overflow instead of auto-compacting when disabled | C:RESTORE | confidence:med | ignoring the disable flag = unwanted auto-compaction, user-visible; flag-check restore small
prompt.test.ts::loop continues when finish is stop but assistant has tool parts | C:RESTORE | confidence:med | harm: tool calls left dangling/loop stalls; continuation-guard restore is local
prompt.test.ts::subtask child inherits parent session external_directory allow | C:RESTORE | confidence:med | harm: child task blocked from allowed dir = broken subtask; permission-inherit restore moderate
prompt.test.ts::running task tool preserves metadata after tool-call transition | C:ACCEPT | confidence:lo | metadata-only on task tool, low user harm; restore through imperative loop is fiddly
prompt.test.ts::loop sets status to busy then idle | C:TEST-ARCH | confidence:hi | status set via imperative SessionStatus.set; Effect-instance fake can't observe; works in real app
prompt.test.ts::cancel interrupts loop and resolves with an assistant message | C:TEST-ARCH | confidence:med | cancel is real in app; Effect fiber-cancel semantics differ from imperative AbortController path
prompt.test.ts::cancel records MessageAbortedError on interrupted process | C:TEST-ARCH | confidence:med | same imperative-abort vs injected-runtime mismatch; real cancel persists error
prompt.test.ts::finalizes assistant when cancelled before processor creation completes | C:TEST-ARCH | confidence:med | race only observable through injected runtime timing; harness-only
prompt.test.ts::cancel propagates from slash command subtask to child session | C:TEST-ARCH | confidence:med | child-session cancel threads through singleton; fake injection can't trace it
prompt.test.ts::cancel with queued callers resolves all cleanly | C:TEST-ARCH | confidence:med | queue resolution is imperative promise-based; Effect harness can't drive queue
prompt.test.ts::prompt submitted during an active run is included in the next LLM input | C:RESTORE | confidence:lo | harm if dropped: lost user prompt; but queue lives in imperative path, restore risk high
prompt.test.ts::assertNotBusy fails with BusyError when loop running | C:TEST-ARCH | confidence:med | BusyError raised in imperative loop; Effect-instance harness state not shared
prompt.test.ts::shell rejects with BusyError when loop running | C:TEST-ARCH | confidence:med | same busy-state arbitration lives in singleton, not injected runtime
prompt.test.ts::loop waits while shell runs and starts after shell exits | C:TEST-ARCH | confidence:med | shell/loop serialization is imperative mutex; fake can't sequence it
prompt.test.ts::shell completion resumes queued loop callers | C:TEST-ARCH | confidence:med | queue resume imperative; harness injection cannot observe wakeups
prompt.test.ts::command ! expansion uses configured shell over env shell | C:RESTORE | confidence:lo | wrong shell = user command misbehaves; but config-shell plumbing restore is moderate
prompt.test.ts::cancel interrupts shell and resolves cleanly | C:TEST-ARCH | confidence:med | shell cancel via imperative child-process kill; Effect cancel path differs
prompt.test.ts::cancel finalizes interrupted bash tool output through normal truncation | C:RESTORE | confidence:lo | harm: lost interrupted bash output (ties to message-v2 abort restore); restore moderate
prompt.test.ts::cancel interrupts loop queued behind shell | C:TEST-ARCH | confidence:med | nested queue+cancel choreography only expressible through injected runtime
prompt.test.ts::shell rejects when another shell is already running | C:TEST-ARCH | confidence:med | single-shell guard is imperative state; harness can't share it
prompt.test.ts::records aborted errors when prompt is cancelled mid-stream | C:TEST-ARCH | confidence:med | mid-stream abort persisted imperatively; Effect listener blind; real path likely fine

## compaction.test.ts (19)

compaction.test.ts::publishes compacted event on continue | C:TEST-ARCH | confidence:hi | event via imperative Bus; Effect listener unreachable; compaction still runs for user
compaction.test.ts::marks summary message as errored on compact result | C:RESTORE | confidence:lo | harm: silent bad summary; but Service exposes only create(), restore = expose process()
compaction.test.ts::adds synthetic continue prompt when auto is enabled | C:RESTORE | confidence:med | missing continue = session stalls after auto-compact; behavior may be real, worth restoring
compaction.test.ts::persists tail_start_id for retained recent turns | C:RESTORE | confidence:lo | harm: lost recent context after compaction; budgeting is pure logic, restorable if exposed
compaction.test.ts::shrinks retained tail to fit preserve token budget | C:RESTORE | confidence:lo | harm: over-budget tail = re-overflow loop; pure budgeting logic, but needs Service.process surface
compaction.test.ts::falls back to full summary when even one recent turn exceeds preserve token budget | C:ACCEPT | confidence:lo | edge fallback, low harm; restore needs process() exposure, defer to A/B
compaction.test.ts::falls back to full summary when retained tail media exceeds preserve token budget | C:ACCEPT | confidence:lo | media edge case, rare; same exposure cost, low harm
compaction.test.ts::retains a split turn suffix when a later message fits the preserve token budget | C:ACCEPT | confidence:lo | subtle retention optimization, low harm if absent
compaction.test.ts::allows plugins to disable synthetic continue prompt | C:TEST-ARCH | confidence:med | plugin hook needs injected plugin runtime the imperative create() bypasses
compaction.test.ts::replays the prior user turn on overflow when earlier context exists | C:RESTORE | confidence:lo | harm: overflow recovery degraded; but lives behind process() exposure, moderate risk
compaction.test.ts::falls back to overflow guidance when no replayable turn exists | C:ACCEPT | confidence:lo | guidance-text fallback, low harm
compaction.test.ts::stops quickly when aborted during retry backoff | C:TEST-ARCH | confidence:med | abort-during-backoff timing only drivable via injected runtime/fakes
compaction.test.ts::does not leave a summary assistant when aborted before processor setup | C:TEST-ARCH | confidence:med | pre-setup abort race needs injected timing; imperative path self-cleans in app
compaction.test.ts::silently drops reasoning-delta arriving without prior reasoning-start | C:ACCEPT | confidence:med | defensive drop; absence is cosmetic, no user harm
compaction.test.ts::does not allow tool calls while generating the summary | C:TEST-ARCH | confidence:med | tool-gate enforced in imperative processor; fake LLM injection unreachable
compaction.test.ts::summarizes only the head while keeping recent tail out of summary input | C:RESTORE | confidence:lo | harm: recent turns wrongly summarized away; pure logic, needs process() exposure
compaction.test.ts::anchors repeated compactions with the previous summary | C:ACCEPT | confidence:lo | optimization for repeat-compaction quality, low single-event harm
compaction.test.ts::keeps recent pre-compaction turns across repeated compactions | C:RESTORE | confidence:lo | harm: cumulative context loss over compactions; logic restorable behind Service surface
compaction.test.ts::ignores previous summaries when sizing the retained tail | C:ACCEPT | confidence:lo | sizing nuance, low harm if mis-sized once

## Flaky / fixture (not merge regressions)

snapshot-tool-race.test.ts::tool execution produces non-empty session diff (snapshot race) | C:RESTORE | confidence:lo | harm: empty session diff = no revert/snapshot for user; pre-tool snapshot capture is real fix but timing-fragile
llm-native-recorded.test.ts::OpenAI OAuth: drives a tool loop to a final text answer | C:TEST-ARCH | confidence:hi | missing gpt-5.5 model fixture; fixture drift, no product behavior asserted
llm-native-recorded.test.ts::OpenCode proxy: drives a tool loop to a final text answer | C:TEST-ARCH | confidence:hi | recorded HTTP falls through to live proxy; fixture/recording gap, not a regression
llm-native-recorded.test.ts::Anthropic API key: drives a tool loop to a final text answer | C:TEST-ARCH | confidence:hi | recorded HTTP reaches live Anthropic; fixture gap, harness-only

## Counts

- RESTORE: 18
- ACCEPT: 8
- TEST-ARCH: 25
- Total: 51 (3 message-v2 + 7 processor-effect + 22 prompt + 19 compaction + 4 flaky/fixture = 55 lines incl. 4 flaky; 51 merge-set deltas per review)

## Tie-breaker notes (C)

1. The 3 message-v2 deltas are my strongest RESTORE calls: severe user-visible harm (lost output, broken Anthropic replay, fatal-looking retryable errors) AND the fix is verbatim in `git show v1.17.9` — near-zero restore risk. These should restore regardless of A/B.
2. The processor/prompt/compaction RESTOREs I flagged hi/med (overflow-compaction, content-filter error, overflow-disable flag, dangling-tool continuation, subtask dir inherit, synthetic-continue) are behaviors with real harm; most are gated behind the same `Service.process` exposure work, so I defer final risk weighting to the architecture panel, but the user-harm vote is RESTORE.
3. Everything I marked TEST-ARCH shares one root: the fork's imperative singletons (`LLM.stream`, `SessionStatus.set`, `Bus.publish`) are not the injected Effect services the harness fakes. These cause NO user harm in the shipped app — they are observability/injection gaps in the test. Lowest priority; convert to real-HTTP-mock assertions or accept.
