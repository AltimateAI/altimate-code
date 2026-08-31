# PR 1196 Consensus Review

- Repository: `AltimateAI/altimate-code`
- Pull request: [#1196](https://github.com/AltimateAI/altimate-code/pull/1196)
- Review dates: 2026-08-30 through 2026-08-31
- Final code candidate: `908be9cabb2b552c56cbd86537fbccb86ea5e0b2`
- Mode: full Council review plus final independent remediation pass
- Local verdict: **PASS**
- Remote status: final commits still need to be pushed and fresh CI/bot review must finish

## Decision

PR #1196 is locally merge-ready under the selected product scope.

The feature prevents avoidable provider failures by reserving output only after the real request shape is known. The final code budgets system text, messages, finalized tool schemas, provider instructions, semantic media, dedicated input ceilings, context-expansion headers, and fixed reasoning options at both production request boundaries.

PDF accounting is intentionally approximate. The user selected a parser-free policy:

```text
PDF allowance = max(32,768, decoded inline payload bytes)
```

Remote URLs and provider file IDs receive the fixed allowance. Exact page expansion and tokenization remain provider-authoritative. The Council did not require exact PDF parsing because adding a parser would create a new document-processing/resource boundary without making provider token accounting exact.

## Original Council gate

The first three-round Council unanimously rejected the pre-repair candidate and required five concrete fixes:

1. Enforce `model.limit.input` as a hard estimated-input ceiling.
2. Count every semantic media occurrence conservatively, including URL-backed and AI SDK v6 tool-result variants.
3. Reconcile fixed reasoning budgets with every defined final output reservation.
4. Distinguish repeated aliases from true cycles so repeated schemas/media are counted per transport occurrence.
5. Add behavioral proof that both AI SDK and native request paths send finalized tools, clamped output, and reconciled reasoning together.

All five are present in the final branch with focused regressions.

## Additional review findings

Post-Council review found and repaired:

- request-header precedence drift around the Anthropic 1M context flag;
- unsupported-media estimation before canonical projection;
- media-looking ordinary text being discounted as binary content;
- small-model output floors above the model's own reservation;
- safety-margin loss near the context boundary;
- non-JSON provider-option loss during reasoning reconciliation;
- raw PDF page-marker trust.

Each repair was centralized in the shared output-budget module or the existing pure media projection, then exercised through both request boundaries.

## Why the PDF parser experiment was rejected

An intermediate branch attempted structural page counting with `pdf-lib`. Independent reviewers found two blockers:

- the fixed 100-page/500 KB policy still undercounted valid many-page requests on supported 1M-context models;
- compressed object streams could expand substantially in-process before request admission, while the input gate bounded only compressed bytes.

The parser experiment was reverted. The dependency and transitive lock entries are absent from the final tree, estimator APIs are synchronous again, and tests describe the fixed allowance as parser-free.

Batching the same parser would not remove its decompression/traversal boundary. A subagent is useful for development review, but it is not a runtime memory, CPU, or trust boundary. The smallest safe scope is therefore the crude local estimate plus provider enforcement.

## Final independent remediation review

Two independent live Council seats re-reviewed exact head `908be9cabb` after the parser removal.

### Feynman seat — PASS

- Verified exact final head.
- Confirmed `pdf-lib`, async parsing, page regex/policy, and transitive lock entries are absent.
- Confirmed lazy estimation is not evaluated when `maxOutputTokens` is omitted.
- Confirmed both request boundaries clamp after headers, tools, instructions, and media projection are finalized.
- Re-ran provider, native, stream, typecheck, diff, and strict marker checks successfully.

### Musashi seat — PASS

- Confirmed the parser experiment is cleanly reverted.
- Confirmed the final code differs from the last pre-parser safe candidate only in the explicit parser-free comment and test naming.
- Confirmed synchronous lazy estimation and parity across both callers.
- Confirmed dependency cleanup, focused tests, typecheck, and diff checks pass.

### Degraded seat

The original chairman seat was rejected twice by the service safety filter because its retained conversation context included the earlier parser stress case. It produced no contrary code finding on the final head. The thread limit prevented replacing that retained seat with a new fourth thread.

Consensus therefore rests on two independent live PASS votes, the primary review, the complete changed-file inspection, and a sealed zero-finding Codex Security remediation scan. The degraded seat is disclosed rather than silently counted as agreement.

## Final verification

- Focused provider, AI-SDK stream, native request, and upstream bridge suites: **413 passed, 11 skipped, 1 existing todo, 0 failed**.
- Repository typecheck: **13/13 successful**.
- Strict changed-file marker validation: passed.
- Required-marker inventory: **35/35**.
- Frozen lockfile install: **1,295 installs across 1,390 packages, no changes**.
- Targeted oxlint: **212 warnings, 0 errors**.
- Prettier: all changed files pass except `provider/provider.ts` and `provider/transform.ts`; both fail identically on `origin/main`.
- `git diff --check origin/main...HEAD`: passed.
- Final Codex Security remediation scan: complete coverage, **0 findings**.

## Residual limitations

- Compact or dense PDFs can be underestimated locally and rejected by the provider.
- Exact tokenizer parity across providers is not claimed.
- No live request was made against every provider/context combination.
- Broader tokenizer calibration and document-ingestion architecture belong in follow-up work, not this PR.

## Merge gate

The local recommendation is **merge after remote completion**, provided:

1. the final commits are pushed without overwriting concurrent remote work;
2. every review thread is answered or resolved against the new head;
3. fresh required CI and bot reviews are green; and
4. no new critical finding appears on the pushed head.

Do not merge merely on the strength of the stale green checks attached to `9039a178c0`.

## Execution reliability

- Intended panel seats: 3
- Final live PASS seats: 2
- Degraded seats: 1 (service filter)
- Offline seats: 0
- Final retries of degraded seat: 1
- Fallback: primary reviewer completed the full diff and security reconciliation
- Code-discovery source: repository knowledge graph plus exact immutable Git diffs

---

- `schema_version: 1`
- `mode: full`
- `panel_size: 3`
- `final_live_votes: 2`
- `final_pass_votes: 2`
- `degraded_seats: 1`
