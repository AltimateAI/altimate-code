# Session Delta — Autonomous Panel Consensus (A=upstream-fidelity, B=fork-guardian, C=user-impact)
Reconciliation: majority of A/B/C; A+B both git-verified fork src vs main/v1.17.9 (authoritative). Panel counts:
A: TEST-ARCH 49 / ACCEPT 0 / RESTORE 7 · B: TEST-ARCH 46 / ACCEPT 2 / RESTORE 7 · C: TEST-ARCH ~32 / ACCEPT ~10 / RESTORE ~24.

## KEY FINDING (A+B independently verified via git)
The fork's imperative session core (cancel/abort/shell/busy/loop, processor create()/process(), compaction process())
is BYTE-FOR-BYTE UNCHANGED from `main`; the merge added only Effect Service facades. => the ~46 cancel/abort/
compaction test failures are NOT dropped fork behavior (src intact) — the v1.17.9 tests expect injectable Services and
their fakes can't reach the imperative singletons (TEST-ARCH). NOT runtime regressions.

## CONSENSUS RESTORE set (≥2 panels, git-confirmed dropped v1.17.9 behavior — IMPLEMENT, minimal src):
1. message-v2: forward partial bash output for aborted tool calls            [A hi, B hi, C hi]  (message-v2.ts ~337)
2. message-v2: server_error/overloaded -> retryable APIError                 [A hi, B hi, C hi]  (provider/error.ts ~139)
3. message-v2: space separator between empty signed-reasoning blocks         [A med, B hi, C]    (toModelMessages ~274-290)
4. prompt/processor: surface content-filter finish as session Error         [A med, B hi, C]    (processor ~1343-1348)
5. prompt/processor: honor compaction.auto:false on reactive overflow        [A med, B med, C]   (processor ~927)
6. snapshot-tool-race: pre-capture snapshot before LLM stream                [A hi, B med, C hi]  (processor ~111-121)
7. prompt: command ! expansion use Shell.preferred(cfg.shell)                [A med, C]          (prompt.ts ~2491)
8. prompt: stop-with-tool-parts -> continue (don't leave tools unexecuted)   [B med, C]          (processor ~1159-1167)

## CONSENSUS ACCEPT (update test to current behavior):
- processor-effect "overflow requests compaction": fork's deliberate PR#35 isOverflow guard returns continue for
  the test's context:20 fixture; the TEST predates the guard -> update test expectation. [B ACCEPT, A TEST-ARCH]

## CONSENSUS TEST-ARCH (~46) — NOT regressions; two sub-kinds:
(a) Harness/injection mismatch: fork keeps imperative session singletons behind Effect facades; tests' fakes
    (LLM.Service, SessionStatus, SessionProcessor, Plugin, SessionCompaction.process) don't reach them. Fixable by
    porting tests to inject via the Effect layer / exposing Service.process — OR leave .todo (coverage gap, code works).
(b) Unported upstream features (preserve-token-budget tail retention, head/tail summary split, repeated-compaction
    anchoring, subtask Permission.merge inheritance, external_directory inherit): fork never adopted these v1.17.9
    features -> NOT regressions; document as enhancement backlog, leave .todo.

## IMPLEMENT PLAN: do the 8 RESTOREs (minimal src, file:line above, production-verify+typecheck after each, revert-if-broken)
+ the 1 ACCEPT (test update). Re-enable each test as it passes. TEST-ARCH (a) = best-effort test-injection fixes;
(b) = documented .todo. This converts "52 regressions" -> 8 real dropped-behavior restores + 1 accept + ~46 non-regressions.
