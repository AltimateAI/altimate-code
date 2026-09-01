# PR 1196 Consensus Review

- Repository: `AltimateAI/altimate-code`
- Pull request: [#1196](https://github.com/AltimateAI/altimate-code/pull/1196)
- Review dates: 2026-08-30 through 2026-08-31
- Final code candidate: `856f428981ddc970880cb525e82aee4f974e5e5f`
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
- identical system and instruction values being deduplicated despite occupying two wire fields;
- a static bridge assertion that could match the unclamped property-access form;
- empty base64 image data wrapped in a `URL` object escaping unsupported-media projection;
- positive sub-floor context windows being treated as placeholder metadata;
- the fixed 512-token safety margin consuming an entire small but valid context or input limit;
- separately transmitted system messages being flattened before estimation, omitting each entry's wire framing.
- high-entropy ASCII being estimated like repetitive prose, which could leave too much output reserved for opaque identifiers or encoded text;
- audio and video payloads being charged by decoded bytes rather than a semantic media allowance; and
- a first-pass dense-text detector resetting at 400-character estimator boundaries, allowing short opaque runs to evade the conservative floor at particular alignments.

Each repair was centralized in the shared output-budget module or the existing pure media projection, then exercised through both request boundaries.

## Main reconciliation and final bot-comment repairs

Current `main` (`7f07b7d3b6`) was merged into the PR branch in `b2c3a3480c`. The only textual conflict was the import in `packages/opencode/test/session/llm.test.ts`; the resolution preserves the PR's `jsonSchema` and `tool` runtime imports and `main`'s `Tool` type import. The focused file passes with 14 tests and 2 intentional skips.

The two remaining bot comments were addressed in `e475a2d1df` and `dc24ed0555`:

- Dense ASCII runs of at least 32 characters and six distinct opaque characters receive an added conservative floor. Detection is one forward pass with scalar counters and a `Set` capped at six entries, so it is linear time, constant auxiliary memory, and independent of the estimator's 400-character chunk boundaries.
- Audio and video use the crude hybrid `max(8,192, ceil(decoded inline bytes / 64))`. Tiny and remote media remain usable on 16K contexts, while very large inline payloads grow monotonically instead of receiving an unbounded fixed estimate. Generic files still scale one-for-one with decoded payload size, images retain the existing fixed allowance, and PDF remains parser-free at `max(32,768, decoded inline bytes)`.
- A regression sweeps all 400 possible chunk alignments for a 32-character dense token. Both independent reviewers reproduced the same conservative delta at every offset.

After the first push, fresh Cubic and Codex reviews exposed opposing problems with the initial fixed media constants: 131,072 tokens rejected even tiny video on supported 16K/32K models, while any fixed constant could undercount arbitrarily large inline media. Commit `856f428981` replaces those constants with the hybrid above without parsing codecs, duration, frames, or PDF structure.

## Why the PDF parser experiment was rejected

An intermediate branch attempted structural page counting with `pdf-lib`. Independent reviewers found two blockers:

- the fixed 100-page/500 KB policy still undercounted valid many-page requests on supported 1M-context models;
- compressed object streams could expand substantially in-process before request admission, while the input gate bounded only compressed bytes.

The parser experiment was reverted. The dependency and transitive lock entries are absent from the final tree, estimator APIs are synchronous again, and tests describe the fixed allowance as parser-free.

Batching the same parser would not remove its decompression/traversal boundary. A subagent is useful for development review, but it is not a runtime memory, CPU, or trust boundary. The smallest safe scope is therefore the crude local estimate plus provider enforcement.

## Final independent remediation review

Two independent live Council seats re-reviewed the request-shape correction at `c78e1a61b6`, the small-limit production delta through `56dbc7e9b1`, the test-fixture correction through `b7cfd659fa`, and the final system-framing correction at exact production head `d13f784786`. The last correction serializes non-empty system entries as the same array of `{ role: "system", content }` records sent by both applicable request paths. Empty arrays remain free, while OAuth and workflow paths continue to omit generated-system framing. None of these changes alter PDF behavior.

After reconciling `main`, the same two seats reviewed the intermediate range `a0d7a4aed2..dc24ed0555`. Both returned **PASS**. Feynman independently measured a 1 MiB dense-text pass at roughly 38 ms and confirmed all 400 alignments. Musashi independently observed the same +24-token delta at every alignment and verified that equal-size generic/PDF payloads still scaled by bytes while audio/video used the intermediate fixed allowances.

Both seats then reviewed `800e3b102f..856f428981` and returned **PASS** on the final hybrid media curve. They independently reproduced 8,221 tokens for tiny/remote media, 16,413 for 1 MiB, and 65,565 for 4 MiB; verified usable output remains on a 16K context; and confirmed bounded header inspection with no decoding, parsing, copying, dependency, or PDF/generic-file change. Both explicitly classified codec-dependent over/underestimation as the documented heuristic limitation rather than a blocker.

### Feynman seat — PASS

- Re-reviewed post-main head `dc24ed0555` and final media-calibration head `856f428981`.
- Verified exact final production code head `d13f784786`.
- Confirmed `pdf-lib`, async parsing, page regex/policy, and transitive lock entries are absent.
- Confirmed lazy estimation is not evaluated when `maxOutputTokens` is omitted.
- Confirmed Mistral/Devstral projection matches the transport normalizer without mutating history.
- Confirmed workflow/OAuth prompt routing matches the fields actually sent.
- Confirmed identical system/instruction values are counted as two wire occurrences while omitted system fields remain excluded.
- Confirmed the tightened bridge regex rejects `params.maxOutputTokens` and accepts the clamped shorthand.
- Confirmed empty base64 images wrapped in `URL` objects become explanatory text while valid strings, byte buffers, and ordinary URLs remain unchanged.
- Confirmed undefined and zero context limits bypass lazily, while every positive limit—including 1, 512, and 1,024—is enforced.
- Confirmed the final margin is the larger of 2% of estimated input and the limit-scaled minimum: 2% of the authoritative limit capped at 512 tokens, with a one-token floor.
- Confirmed the exact 8,192-token context boundary: input 7,516 fits with output 512 and margin 164, while input 7,517 is rejected.
- Confirmed a one-token input/output request fits a 512-token context, while reserving the full 512-token output does not.
- Confirmed a 512-token dedicated input ceiling accepts input 501 with margin 11 and rejects input 502.
- Confirmed the processor fixture now uses context 20,000, exactly its default compaction headroom, while the former context 20 still raises `OutputTokenBudgetError`.
- Confirmed each system entry receives its own role/content framing in both the AI SDK and native request shapes, while OAuth/workflow callers still pass an empty system array.
- Reproduced the framing regression with 2,000 entries: the old flattened shape estimated 1,629 tokens and the corrected framed shape estimated 17,298 tokens, with linear bounded runtime.
- Re-ran provider, typecheck, diff, and bridge checks successfully.

### Musashi seat — PASS

- Re-reviewed post-main head `dc24ed0555` and final media-calibration head `856f428981`.
- Verified exact final production code head `d13f784786`.
- Confirmed the parser experiment remains cleanly reverted and no PDF dependency returned.
- Confirmed synchronous lazy estimation, linear Mistral projection, and parity across both callers.
- Confirmed identical wire fields are counted separately while OAuth/workflow omissions are not double-counted.
- Confirmed the fixed-width bridge lookbehind runs correctly under Bun.
- Confirmed `URL.href` inspection matches the AI SDK URL contract without changing binary media handling.
- Confirmed every positive context window is enforced while absent/non-positive contexts retain lazy bypass behavior.
- Confirmed the exact 8,192-token context boundary: input 7,516 plus output 512 plus margin 164 fits, while one additional input token is rejected.
- Confirmed the exact 512-token input-limit boundary: input 501 plus margin 11 fits, while input 502 is rejected.
- Confirmed context and dedicated input limits receive independent margins while normal-window behavior remains unchanged.
- Confirmed the processor-fixture delta changes only that fixture and comment, preserves the intended `base <= headroom` compaction guard, and does not mask the separate small-context admission regressions.
- Confirmed discrete system-entry framing matches both request lowerings, empty arrays remain free, and OAuth/workflow caller projections are unchanged.
- Reproduced a 15,669-token increase over flattened text for 2,000 tiny entries in roughly 2.4 ms.
- Confirmed focused tests, typecheck, and diff checks pass.

### Degraded seat

The original chairman seat was rejected twice by the service safety filter because its retained conversation context included the earlier parser stress case. It produced no contrary code finding on the final head. The thread limit prevented replacing that retained seat with a new fourth thread.

Consensus therefore rests on two independent live PASS votes on exact final production head `856f428981`, the primary review, the complete changed-file inspection, and sealed zero-finding Codex Security scans through the final production change. The degraded seat is disclosed rather than silently counted as agreement.

## Final verification

- Focused provider, AI-SDK stream, native request, processor, and upstream bridge suites: **435 passed, 11 skipped, 7 existing todos, 0 failed**.
- Repository typecheck: **13/13 successful**.
- Strict changed-file marker validation: passed.
- Required-marker inventory: **35/35**.
- Frozen lockfile install: **1,295 installs across 1,390 packages, no changes**.
- Targeted oxlint on the final supplemental production and provider-test files: **161 warnings, 0 errors**; warnings are existing test-file debt.
- Prettier: the final supplemental files and resolved `llm.test.ts` pass.
- `git diff --check`: passed.
- Post-main, dense-boundary, and final media-calibration Codex Security scans `86b98822-70df-446e-bd56-47d7169ef98a`, `37afdb50-204e-462a-85ab-7deeafdbb2ab`, and `5b969965-638d-42a6-bc38-d2f5d23b7dc2`: complete coverage, **0 findings**. Earlier request-shape and edge-case scans remain sealed with zero findings.

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

Do not merge merely on the strength of checks attached to an earlier head; fresh checks must complete after the final documentation commit is pushed.

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
