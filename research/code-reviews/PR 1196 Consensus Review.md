# PR 1196 Consensus Review

- Repository: `AltimateAI/altimate-code`
- Pull request: [#1196](https://github.com/AltimateAI/altimate-code/pull/1196)
- Review dates: 2026-08-30 through 2026-08-31
- Final code candidate: `aab3dac85008fd9a21919741021d3be3848cefbe`
- Mode: full Council review plus final independent remediation pass
- Local verdict: **PASS**
- Remote gate: the final candidate must be pushed and fresh CI/bot review must finish

## Decision

PR #1196 is locally merge-ready under the selected product scope.

The feature prevents avoidable provider failures by reserving output only after the real request shape is known. The final code budgets system text, messages, finalized tool schemas, provider instructions, semantic media, dedicated input ceilings, context-expansion headers, and fixed reasoning options at both production request boundaries.

PDF accounting is intentionally approximate. The user selected a parser-free policy:

```text
PDF allowance = max(32,768, decoded inline payload bytes)
```

Remote references and provider file IDs receive the fixed allowance when the part is identifiable as a PDF. An untyped provider file ID cannot be classified locally and receives the generic 16,384-token file allowance instead. Exact page expansion and tokenization remain provider-authoritative. The Council did not require exact PDF parsing because adding a parser would create a new document-processing/resource boundary without making provider token accounting exact.

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
- raw PDF page-marker trust;
- provider-normalized Mistral/Devstral bridge messages missing from the estimate;
- generated system prompts counted even when workflows omit them or OAuth routes them through instructions;
- identical system and instruction values being deduplicated despite occupying two wire fields; and
- a static bridge assertion that could match the unclamped property-access form;
- empty base64 image data wrapped in a `URL` object escaping unsupported-media projection; and
- positive sub-floor context windows being treated as placeholder metadata.

Each repair was centralized in the shared output-budget module or the existing pure media projection, then exercised through both request boundaries.

## Why the PDF parser experiment was rejected

An intermediate branch attempted structural page counting with `pdf-lib`. Independent reviewers found two blockers:

- the fixed 100-page/500 KB policy still undercounted valid many-page requests on supported 1M-context models;
- compressed object streams could expand substantially in-process before request admission, while the input gate bounded only compressed bytes.

The parser experiment was reverted. The dependency and transitive lock entries are absent from the final tree, estimator APIs are synchronous again, and tests describe the fixed allowance as parser-free.

Batching the same parser would not remove its decompression/traversal boundary. A subagent is useful for development review, but it is not a runtime memory, CPU, or trust boundary. The smallest safe scope is therefore the crude local estimate plus provider enforcement.

## Final independent remediation review

Two independent live Council seats re-reviewed the request-shape correction at `c78e1a61b6`, then reviewed both follow-up deltas through exact final head `aab3dac850`. The final deltas make the estimator more conservative and do not change PDF behavior.

### Feynman seat — PASS

- Verified exact final code head `aab3dac850`.
- Confirmed `pdf-lib`, async parsing, page regex/policy, and transitive lock entries are absent.
- Confirmed lazy estimation is not evaluated when `maxOutputTokens` is omitted.
- Confirmed Mistral/Devstral projection matches the transport normalizer without mutating history.
- Confirmed workflow/OAuth prompt routing matches the fields actually sent.
- Confirmed identical system/instruction values are counted as two wire occurrences while omitted system fields remain excluded.
- Confirmed the tightened bridge regex rejects `params.maxOutputTokens` and accepts the clamped shorthand.
- Confirmed empty base64 images wrapped in `URL` objects become explanatory text while valid strings, byte buffers, and ordinary URLs remain unchanged.
- Confirmed undefined and zero context limits bypass lazily, while every positive limit—including 1, 512, and 1,024—is enforced.
- Confirmed the requested-capped floor accepts the exact 523-token boundary and rejects 522 tokens for the reproduced request.
- Re-ran provider, typecheck, diff, and bridge checks successfully.

### Musashi seat — PASS

- Verified exact final code head `aab3dac850`.
- Confirmed the parser experiment remains cleanly reverted and no PDF dependency returned.
- Confirmed synchronous lazy estimation, linear Mistral projection, and parity across both callers.
- Confirmed identical wire fields are counted separately while OAuth/workflow omissions are not double-counted.
- Confirmed the fixed-width bridge lookbehind runs correctly under Bun.
- Confirmed `URL.href` inspection matches the AI SDK URL contract without changing binary media handling.
- Confirmed every positive context window is enforced while absent/non-positive contexts retain lazy bypass behavior.
- Confirmed focused tests, typecheck, and diff checks pass.

### Degraded seat

The original chairman seat was rejected twice by the service safety filter because its retained conversation context included the earlier parser stress case. It produced no contrary code finding on the final head. The thread limit prevented replacing that retained seat with a new fourth thread.

Consensus therefore rests on two independent live PASS votes on exact final code head `aab3dac850`, the primary review, the complete changed-file inspection, and sealed zero-finding Codex Security scans. The degraded seat is disclosed rather than silently counted as agreement.

## Final verification

- Focused provider, AI-SDK stream, native request, and upstream bridge suites: **417 passed, 11 skipped, 1 existing todo, 0 failed**.
- Repository typecheck: **13/13 successful**.
- Strict changed-file marker validation: passed.
- Required-marker inventory: **35/35**.
- Frozen lockfile install: **1,295 installs across 1,390 packages, no changes**.
- Targeted oxlint on the final supplemental files: **173 warnings, 0 errors**; warnings are existing repository debt.
- Prettier: all changed files pass except `provider/provider.ts` and `provider/transform.ts`; both fail identically on `origin/main`.
- `git diff --check origin/main...HEAD`: passed.
- Final request-shape and edge-case Codex Security scans `1dcbce9e-587e-4495-94ff-6d3291e5e1d6`, `bfa1cc4a-7d87-463d-8fc9-822e1624f8b1`, and `19f139b0-8c4c-48cc-adca-a60d41920664`: complete coverage, **0 findings**.

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
