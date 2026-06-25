# Independent Codex Audit: OpenCode v1.4.0 -> v1.17.9 Merge

Date: 2026-06-25
Repo: `/Users/anandgupta/codebase/altimate-code/.claude/worktrees/get_latest_upstream`
Auditor stance: independent second opinion from git/tree evidence first, then compared to existing reports.

Important scope note: the user warned that another worker was editing `packages/opencode/src/session/{processor,prompt,message-v2,compaction}.ts`. At audit start, `git status` only showed `.github/meta/night-run/STATUS.md` modified. I still treated the session files as volatile and used committed/tree evidence plus direct reads at the time of audit.

## Refs Used

- HEAD: `95d168030c9d7758ca59ff7caaab8dad23e9e7fe`
- fork pre-merge tip `main`: `8fea4337d2a92e9e3b9a24ab464c517f79661d90`
- upstream prior base `v1.4.0`: `98325dcdc6a566de6b7ab42cc87af544bed3658d`
- upstream target `v1.17.9`: `5c23e88419c4743b9be42cea132f2fb1e6cb63ff`
- `git merge-base main HEAD`: `8fea4337d2a92e9e3b9a24ab464c517f79661d90`

## Claim 1: Fork Changes Not Lost

Verdict: AGREE, with a branding caveat noted under new issues.

I independently sanity-checked the claim that fork-authored files/regions from `main` were not lost in HEAD except where upstream removed or rehomed the owning file.

Evidence:

- `git diff --name-only --diff-filter=D main..HEAD -- packages/opencode/src` found 179 deleted source paths.
- For every deleted path, I checked presence in `v1.17.9`; none were present in `v1.17.9`, so the deleted source files are explained by upstream removal/rehome rather than unexplained fork deletion.
- Deleted files containing `altimate_change` markers were mainly old TUI/config migration paths. Those files were also absent from `v1.17.9`; the new TUI lives under `packages/tui`.
- `packages/opencode/src/altimate` grew from 160 files on `main` to 162 files on HEAD; `v1.17.9` has none.
- `altimate_change` marker count under `packages/opencode/src` increased from 1316 on `main` to 2095 on HEAD; `v1.17.9` has 0.
- Fork directory counts were preserved or increased:
  - `packages/opencode/src/altimate`: 160 -> 162
  - `packages/opencode/src/session/prompt`: 14 -> 16
  - `packages/opencode/src/altimate/prompts`: 3 -> 3
  - `packages/opencode/src/altimate/native/connections`: 7 -> 7
  - `packages/opencode/src/altimate/plugin`: 4 -> 4
- Spot checks in HEAD found fork features still wired:
  - `src/cli/cmd/mcp.ts` retains the fork `--name` behavior restoration markers.
  - `src/cli/cmd/providers.ts` retains the fork Anthropic provider wording.
  - `src/session/prompt/default.txt` is rebranded to Altimate.
  - Tool registration/test output included fork tools such as `sql_execute`, `schema_search`, `sql_analyze`, `finops_analyze_credits`, `altimate_core_rewrite`, and `altimate_core_validate`.
- `bun test test/altimate/carry-forward` passed: 40 pass, 0 fail.

I did not find evidence that a fork feature present on `main` was dropped by the merge. The caveat is that some prompt branding leaks existed before this merge and remain; they are not evidence of fork loss, but they are still user-visible/product-visible issues.

## Claim 2: Upstream Fully Merged

Verdict: DISAGREE as a semantic claim. AGREE only with the narrower file-presence claim.

I agree with "0 upstream files missing" at the file-presence level:

- Comparing `v1.17.9` to HEAD under `packages/opencode/src` and `packages/tui/src`, I found 0 files present in `v1.17.9` but missing in HEAD.
- Key upstream areas are largely present and include important v1.17.9 logic:
  - `src/session/processor.ts` has the pre-stream/pre-tool snapshot capture, content-filter error persistence, overflow guard with `compaction.auto=false`, and retry status updates.
  - `src/session/prompt.ts` has the stop-with-tool-parts continuation fix and configured shell expansion via `Shell.preferred((await Config.get()).shell)`.
  - `src/session/message-v2.ts` has signed-reasoning separator handling and aborted tool partial-output preservation.
  - `src/provider/error.ts` treats `server_is_overloaded` and `server_error` as retryable.
  - Server/provider/tool registry samples mostly passed, with one tool-registry timeout that passed when rerun in isolation.

However, I found two production semantic gaps against `v1.17.9`:

1. `TaskTool` does not use upstream child-session permission inheritance.

   `v1.17.9` wires `deriveSubagentSessionPermission` into `src/tool/task.ts` so subtask sessions inherit parent session permission constraints, including external directory policy. HEAD has `src/agent/subagent-permissions.ts`, and tests for the helper pass, but `src/tool/task.ts` still constructs the child session permission object manually with `todowrite`, `todoread`, `task`, and `primary_tools` denies. I did not find a call to `deriveSubagentSessionPermission` from `TaskTool`.

   This means the upstream permission semantics are only partly merged: the helper exists, but the production sink does not use it.

2. `src/session/compaction.ts` does not implement the v1.17.9 retained-tail compaction machinery.

   `v1.17.9` includes `DEFAULT_TAIL_TURNS`, `preserve_recent_tokens`, `tail_start_id`, and head/tail message selection for compaction. HEAD has schema/filtering support for `tail_start_id` elsewhere, but `src/session/compaction.ts` does not emit it and does not implement the retained-tail selection logic. A grep of HEAD `src/session/compaction.ts` for `tail_start_id`, `preserve_recent_tokens`, and `DEFAULT_TAIL_TURNS` found no matches.

   This is a half-merged upstream behavior, not just a missing test.

Because of these two gaps, I would not sign off on "upstream fully merged" without narrowing that claim to "all upstream files are present, and most key upstream fixes are present, with known semantic exceptions."

## Claim 3: Nothing Broke

Verdict: PARTIAL AGREE operationally, but not as an absolute statement.

Commands run:

- `cd packages/opencode && bun run typecheck`
  - Passed with exit 0.
- Focused sample:
  - `bun test test/session/message-v2.test.ts test/session/processor-effect.test.ts test/session/compaction.test.ts test/server/httpapi-v2-location.test.ts test/server/httpapi-sdk.test.ts test/provider/error.test.ts test/tool/task.test.ts test/tool/registry.test.ts test/upstream/bridge-merge.test.ts test/upstream/adversarial/upi-tool-api.test.ts`
  - Result: 176 pass, 15 skip, 27 todo, 1 fail.
  - The one failure was `tool.registry > loads tools from .opencode/tool (singular)`, a 5000ms timeout in the combined sample.
  - Rerun isolated with `bun test test/tool/registry.test.ts`: 12 pass, 0 fail. I classify the combined failure as likely timing/contention, not a confirmed regression.
- Extra upstream sample:
  - `bun test test/upstream/bridge-merge.test.ts test/upstream/adversarial/upi-provider.test.ts test/upstream/adversarial/upi-server.test.ts`
  - Result: 50 pass, 1 todo, 0 fail.
- Fork carry-forward:
  - `bun test test/altimate/carry-forward`
  - Result: 40 pass, 0 fail.
- Production smoke:
  - `SMOKE=$(mktemp -d); cd "$SMOKE" && timeout 80 bun run --conditions=browser /Users/anandgupta/codebase/altimate-code/.claude/worktrees/get_latest_upstream/packages/opencode/src/index.ts run "say WORKING" --model azure/gpt-4o-mini 2>/dev/null | tail -2`
  - Output included `WORKING`; exit 0.

Operationally, typecheck, production smoke, fork carry-forward, and representative tests are healthy enough to support the merge. But the test sample still has meaningful todos around compaction and processor behavior, and the upstream semantic gaps above are not covered by passing production tests. So "nothing broke" is acceptable only as "no typecheck/smoke/sample blocker found," not as proof of full behavioral equivalence.

## Review of DECISIONS.md

Verdict: mostly agree with the headline direction, but I disagree with some TEST-ARCH classifications.

I agree with:

- The 8 RESTORE items appear to have been real historical issues, and current HEAD contains the important restored logic I spot-checked in `processor`, `prompt`, `message-v2`, and `provider/error`.
- The 1 ACCEPT item for the overflow guard is defensible as fork-intentional behavior.
- Many TEST-ARCH entries are plausibly test-harness drift, especially where production code now contains the relevant behavior and the remaining tests are disconnected from current architecture.

I disagree with:

1. Subtask external-directory/parent permission inheritance should not be treated as merely TEST-ARCH.

   The helper and tests exist, but production `TaskTool` does not call the helper. If the upstream v1.17.9 behavior is desired, this is a real dropped upstream integration point.

2. Retained-tail compaction items should not be dismissed as TEST-ARCH.

   The production compaction implementation does not contain the v1.17.9 retained-tail machinery. Multiple compaction tests are todo'd around the same behavior, but the missing production implementation is the important part.

I would classify these as RESTORE/backlog items unless the fork explicitly decides to reject those upstream semantics. If rejected, the reports should say so plainly rather than grouping them under test architecture.

## New Issues Missed by Existing Reports

New issue count: 1.

1. LLM-visible lower-case `opencode` branding remains in active system prompt files.

   Existing reports and tests emphasize uppercase `OpenCode` branding and check only a subset of prompt files. Current `src/session/system.ts` imports and can route to prompt files that still say `opencode`:

   - `packages/opencode/src/session/prompt/beast.txt`
   - `packages/opencode/src/session/prompt/copilot-gpt-5.txt`
   - `packages/opencode/src/session/prompt/gemini.txt`
   - `packages/opencode/src/session/prompt/qwen.txt`
   - `packages/opencode/src/session/prompt/trinity.txt`

   These are not just dormant files; `src/session/system.ts` routes GPT/o-series models to `beast.txt`, Gemini models to `gemini.txt`, Trinity to `trinity.txt`, and a fallback path to `qwen.txt`.

   This appears pre-existing on `main` for several files and therefore is not a merge-loss finding. It is still a missed product/branding issue because the prompts are LLM-visible and the existing confidence statements say system prompts have correct branding.

I did not find additional unreported merge-loss, security, or upstream-file-missing issues in the sampled paths. I did see many TUI/help strings such as `opencode run`, `opencode serve`, and `.opencode` paths; I did not count those as a new issue because they may be intentional CLI/config compatibility names.

## Final Independent Verdict

- Claim 1, fork changes not lost: AGREE. I found no fork-owned feature from `main` dropped by HEAD outside upstream removals/rehomes.
- Claim 2, upstream fully merged: DISAGREE if meant semantically. File presence is complete, but `TaskTool` permission inheritance and retained-tail compaction are not fully merged to v1.17.9 behavior.
- Claim 3, nothing broke: PARTIAL AGREE operationally. Typecheck and smoke pass, and representative tests are mostly green with one isolated-passing timeout, but todos and the semantic gaps above remain.

