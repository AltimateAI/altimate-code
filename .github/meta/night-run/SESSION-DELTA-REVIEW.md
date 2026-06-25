# Session Delta Review

Scope: `packages/opencode/test/session/` todo tests reviewed against the v1.17.9 merge.

## Summary

| Bucket | Count | Outcome |
|---|---:|---|
| Cat 1: TEST-HARNESS ARTIFACT fixed test-side | 1 | Re-enabled with a real fixture |
| Cat 2: ACCEPTABLE UPSTREAM BEHAVIOR CHANGE fixed test-side | 0 | None found |
| Cat 3: TRUE FORK REGRESSION documented | 52 | Left `.todo` with source-fix notes |
| Flaky / fixture drift | 4 | Left `.todo`; not counted in the 52 merge-regression set |

Headline: of the prior "52 regressions", active execution showed 0 were safely fixable as test-infra-only in this pass and 52 still reproduce as true source regressions or facade/injection regressions requiring `src/` work. One extra non-regression placeholder (`instruction.test.ts`) was fixed test-side.

## Classification Table

| Test | Category | Action taken |
|---|---|---|
| `instruction.test.ts` - `fetches remote instructions from config URLs via HttpClient` | Cat 1 | Replaced empty `test.todo` with an active `it.live` test that injects an Effect `HttpClient` fixture and asserts the fetched remote instruction text. |
| `message-v2.test.ts` - `forwards partial bash output for aborted tool calls` | Cat 3 | Left `.todo`; current output is only `Tool execution aborted`, losing partial stdout/stderr. Minimal fix: update `packages/opencode/src/session/message-v2.ts` tool-result conversion to prefer aborted bash output when present. |
| `message-v2.test.ts` - `substitutes space for empty text between signed reasoning blocks` | Cat 3 | Left `.todo`; current conversion preserves empty text, which can separate signed Anthropic reasoning blocks with an invalid empty segment. Minimal fix: update `packages/opencode/src/session/message-v2.ts` assistant-content conversion to emit `" "` for empty text between signed Anthropic reasoning parts. |
| `message-v2.test.ts` - `serializes OpenAI response server_error stream chunks as retryable APIError` | Cat 3 | Left `.todo`; current `fromError` returns `UnknownError` for JSON-in-message server_error chunks. Minimal fix: update `packages/opencode/src/session/message-v2.ts` error parsing to decode nested OpenAI Responses error chunks and mark `server_error` retryable. |
| `processor-effect.test.ts` - `stop after token overflow requests compaction` | Cat 3 | Left `.todo`; active run returns `continue` instead of `compact`. Minimal fix: `packages/opencode/src/session/processor.ts:448` must trip `needsCompaction` for over-context usage and preserve the return at `processor.ts:615`. |
| `processor-effect.test.ts` - `publish retry status updates` | Cat 3 | Left `.todo`; active run retries but the Effect status listener sees no retry event. Minimal fix: `packages/opencode/src/session/processor.ts:540` should publish retry through the injected `SessionStatus`/`EventV2Bridge` runtime. |
| `processor-effect.test.ts` - `mark pending tools as aborted on cleanup` | Cat 3 | Left `.todo`; active run leaves pending tool state as `pending`. Minimal fix: `packages/opencode/src/session/processor.ts:596` cleanup must settle pending/running tools before interruption is observable. |
| `processor-effect.test.ts` - `record aborted errors and idle state` | Cat 3 | Left `.todo`; active run can publish idle without persisted `MessageAbortedError`. Minimal fix: `packages/opencode/src/session/processor.ts:520` abort handling should map aborts to `MessageAbortedError` before idle cleanup. |
| `processor-effect.test.ts` - `mark interruptions aborted without manual abort` | Cat 3 | Left `.todo`; fiber interruption alone leaves assistant error undefined. Minimal fix: `packages/opencode/src/session/processor.ts:520-580` should persist `MessageAbortedError` for interrupted streams. |
| `processor-effect.test.ts` - `fail provider-executed error results` | Cat 3 | Left `.todo`; active run bypasses injected Effect LLM and hits the real provider path. Minimal fix: `packages/opencode/src/session/processor.ts:75/83` should consume injected `LLM.Service`, not the imperative singleton. |
| `processor-effect.test.ts` - `flush partial v2 fragments before step failure` | Cat 3 | Left `.todo`; active run bypasses injected Effect LLM and times out. Minimal fix: `packages/opencode/src/session/processor.ts:75/83` should route through injected `LLM.Service`. |
| `prompt.test.ts` - 22 prompt loop/run-state/shell/cancel todos | Cat 3 | Left `.todo`; active file run produced 22 failures/timeouts. Minimal fix: `packages/opencode/src/session/prompt.ts` must route loop, cancel, shell, and child-task execution through one coherent Effect `SessionProcessor`/`SessionStatus` runtime rather than mixed singleton facades. |
| `compaction.test.ts` - 20 `session.compaction.process` todos | Cat 3 | Left `.todo`; active runs bypass Effect fakes or expose raw invalid-parent TypeError. Minimal fix: expose `SessionCompaction.process` on `SessionCompaction.Service` and route processor/LLM/plugin/status dependencies through the provided Effect runtime at `packages/opencode/src/session/compaction.ts:171` and `:223-306`. |
| `snapshot-tool-race.test.ts` - `tool execution produces non-empty session diff (snapshot race)` | Flaky / fixture | Left `.todo`; with a longer timeout the file is created but `SessionSummary.diff` remains empty. Minimal fix: `packages/opencode/src/session/processor.ts:299-300` must capture pre-tool snapshots before tool execution can mutate the worktree. |
| `llm-native-recorded.test.ts` - `OpenAI OAuth: drives a tool loop to a final text answer` | Flaky / fixture | Left `.todo`; enabling fails before behavior assertion due missing `gpt-5.5` model fixture. |
| `llm-native-recorded.test.ts` - `OpenCode proxy: drives a tool loop to a final text answer` | Flaky / fixture | Left `.todo`; enabling falls through recorded HTTP and reaches live proxy URL with `Invalid proxy path`. |
| `llm-native-recorded.test.ts` - `Anthropic API key: drives a tool loop to a final text answer` | Flaky / fixture | Left `.todo`; enabling falls through recorded HTTP and reaches live Anthropic URL with fixture credentials. |

