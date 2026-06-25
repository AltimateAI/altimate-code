# Plan to COVER the 46 remaining session todos (not regressions, but real work)

Breakdown: compaction 19, prompt 18, processor-effect 6, llm-native-recorded 1.

## Root cause of ~40 (TEST-ARCH harness-injection)
The fork kept IMPERATIVE session singletons behind thin Effect-Service FACADES; upstream v1.17.9 rewrote
processor/compaction/LLM as real INJECTABLE Effect Services. The tests drive the injectable shape, so their
fakes (LLM.Service, SessionStatus, SessionCompaction.process, SessionProcessor, Plugin) never reach the fork's
imperative code. The behaviors EXIST + work (compacted event, synthetic-continue, retry-via-SessionStatus,
plugin gate all present in src) — only the test can't inject. => completing the injectable-Service migration
for the session path makes these pass legitimately (restores coverage) AND eases future merges.

## Workstream 1 — make session facades injectable (covers ~40)
Make the fork's session execution accept injected Effect Services instead of resolving imperative singletons:
- LLM: route LLM.stream through the injected LLM.Service (so test LLM fakes reach the loop). [processor]
- SessionStatus: publish status via injected SessionStatus service (retry/abort/idle status tests).
- SessionCompaction: expose `process` on the Service (currently only `create`); route compaction.process through it
  so injected compact fakes apply. [compaction: 19]
- SessionProcessor / Plugin: thread injected instances for the synthetic-continue + plugin-gate tests.
- Interruption: align facade interruption semantics with the injectable path (abort/aborted-on-cleanup tests).
Approach: ONE service at a time, re-enable that cluster's tests, verify typecheck 0 + production WORKING + full
session suite after EACH, revert-if-broken. HIGH RISK (session2 lesson) -> strictly incremental.

## Workstream 2 — port unported v1.17.9 features (covers the remainder)
- preserve-token-budget tail retention; head/tail summary split; repeated-compaction anchoring;
  subtask Permission.merge inheritance; external_directory inherit. Port each from `git show v1.17.9:...`,
  re-enable its test, verify.
- llm-native-recorded (1): re-record/add the missing HTTP fixture, or leave documented if it needs live creds.

## Sequencing
Run AFTER the 2 independent codex audits finish (don't refactor session while they test). Then Workstream 1
(biggest, by service-cluster), then Workstream 2 (feature ports). Commit per green cluster. Target: 46 -> near 0.
HONEST: this is genuine engineering (a real refactor + feature ports), the largest remaining chunk; done
incrementally with production-verify so the working agent is never broken.
