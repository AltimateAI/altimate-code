# PR 1196 Security Review

- Repository: `AltimateAI/altimate-code`
- Pull request: [#1196](https://github.com/AltimateAI/altimate-code/pull/1196)
- Review dates: 2026-08-30 through 2026-08-31
- Final code candidate: `dc24ed05559d85a5a358d116e97b9b66d536cea4`
- Scan mode: chained immutable branch-diff reviews
- Final coverage: complete
- Findings remaining on the final candidate: **0**

## Outcome

The final candidate removes local PDF parsing entirely. PDF media now uses a deliberately crude, parser-free estimate:

```text
max(32,768 tokens, decoded inline payload bytes)
```

Remote references and provider file IDs receive the fixed 32,768-token allowance when the part is identifiable as a PDF. An untyped provider file ID cannot be classified locally and receives the generic 16,384-token file allowance instead. The estimate is monotonic in locally observable payload size, ignores untrusted page metadata, and does not decompress or traverse PDF structure. The configured provider remains authoritative for exact tokenization and for unusually compact or dense documents.

This is the selected product boundary, not an attempt at exact PDF accounting. A compact or dense PDF can still be underestimated locally and rejected by the provider. That residual is an acknowledged reliability limitation; it is not a local parser, authorization, confidentiality, integrity, or shared-service vulnerability.

## Scan chain

The review used immutable ranges so every material repair was independently reconciled.

| Stage                        | Immutable range/candidate                          | Result                                                       |
| ---------------------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| Initial PR review            | current `main` through remote PR head `9039a178c0` | Complete coverage; no remaining finding in that candidate    |
| Media hardening supplement   | `9039a178c0..e37b7a974d`                           | One validated Low finding: raw PDF page-marker amplification |
| Marker fix                   | `ac7346e767`                                       | Removed lexical page-marker trust                            |
| Structural parser experiment | `ac7346e767..858c7b1dab`                           | Two validated Low findings; experiment rejected              |
| Parser-free remediation      | `858c7b1dab..908be9cabb`                           | Complete coverage; **0 findings**                            |
| Final request-shape fixes    | `5e04c7885d..c78e1a61b6`                           | Complete coverage; **0 findings**                            |
| Instruction occurrence fix   | `c78e1a61b6..071f4dc782`                           | Complete coverage; **0 findings**                            |
| Final edge-case hardening    | `a279303720..aab3dac850`                           | Complete coverage; **0 findings**                            |
| Small-limit margin fix       | `e3ca59741a..56dbc7e9b1`                           | Complete coverage; **0 findings**                            |
| Final fixture compatibility  | `d663c49b74..b7cfd659fa`                           | Test-only; no production attack-surface change               |
| System-message framing fix   | `cedd33a866..d13f784786`                           | Complete coverage; **0 findings**                            |
| Post-main estimator repairs  | `b2c3a3480c..e475a2d1df`                           | Complete coverage; **0 findings**                            |
| Dense-boundary hardening     | `e475a2d1df..dc24ed0555`                           | Complete coverage; **0 findings**                            |

The parser-free remediation scan was sealed once as scan `80591880-0a17-454c-b312-92c32a38f5ff`. The final request-shape and edge-case scans were sealed once each as `1dcbce9e-587e-4495-94ff-6d3291e5e1d6`, `bfa1cc4a-7d87-463d-8fc9-822e1624f8b1`, `19f139b0-8c4c-48cc-adca-a60d41920664`, `5111b689-e4ad-4243-a7cb-86845b30ca6d`, and `33ec5c89-fce8-434d-b8a6-2baba941ff27`. The post-main bot-comment repair and chunk-boundary hardening were sealed once each as `86b98822-70df-446e-bd56-47d7169ef98a` and `37afdb50-204e-462a-85ab-7deeafdbb2ab`. Their authoritative results contain no deferred work, no open question, and zero findings.

## Findings discovered and resolved

### 1. Raw page markers could poison local admission

An intermediate estimator scanned PDF bytes for lexical `/Type /Pages /Count` text. A marker in a comment, literal string, stream, or unreachable object could therefore inflate the local estimate and reject a valid user turn before transport.

The fix removed page-marker scanning. Regression tests cover comment, string, stream, and unreachable-object variants across string, base64/data URL, `Uint8Array`, and `ArrayBuffer` payload shapes.

### 2. In-process parsing could amplify compressed object streams

The structural-parser experiment passed attacker-influenced PDF bytes to `pdf-lib` inside the synchronous request path. A bounded reproduction used a 51,430-byte PDF whose unreachable compressed object stream expanded to 50 MiB while loading and increased process RSS by roughly 88 MiB. The byte gate limited compressed input, not decompressed output, traversal work, or memory.

The final candidate removes `pdf-lib`, `PDFDocument.load`, all structural page traversal, and the parser's transitive lockfile entries. Graph-augmented source search found no remaining runtime parser reference.

### 3. The parser policy still disagreed with supported long-context requests

The experiment coupled a 100-page fallback to a 500 KB parser ceiling. A valid 600-page PDF on a 1M-context request could sit just above that byte ceiling, receive only a byte-sized estimate, and preserve a large output reservation. Structural parsing therefore did not make the local estimate authoritative; it merely added a new resource boundary.

The final policy removes the 100-page claim instead of replacing it with a larger parser. Exact page expansion is explicitly delegated to the provider.

### 4. Final boundary cases were made conservative

The final supplemental review found that an empty base64 image represented as a `URL` object could escape unsupported-media projection, and that positive context windows at or below 1,024 tokens were treated as placeholder metadata. The final candidate inspects `URL.href` using the same data-URL rule as strings and enforces every positive context limit. Absent and non-positive context metadata still bypasses lazily, so estimates are not evaluated when no credible limit exists.

### 5. Small authoritative limits retain usable capacity

A follow-up review correctly found that enforcing every positive limit with an unconditional 512-token minimum margin would consume an entire 512-token window. The final candidate retains the 512-token minimum for normal windows but caps that minimum at 2% of each smaller authoritative limit, never below one token. Context and dedicated input ceilings receive separate margins. This preserves local enforcement without rejecting every otherwise valid request on small models.

The subsequent branch-head delta changes only an artificial processor test context from 20 to 20,000 tokens. That value exactly equals the existing default compaction headroom and preserves the fixture's intended guard path; the separate production admission regressions continue to exercise 1-, 512-, and 1,024-token contexts.

### 6. System-message framing matches the request transport

A final bot review found that the estimator joined separately transmitted system strings with newlines. Both applicable request paths instead lower each entry to its own `{ role: "system", content }` record, so a plugin emitting many short entries could omit substantial role/content and JSON framing from the estimate.

The final candidate serializes the exact framed array before token estimation. Empty arrays still contribute zero, and OAuth/workflow paths still pass an empty system array while counting their provider instructions separately. A 2,000-entry regression fails under the old flattening and confirms linear, bounded execution under the corrected shape. The exact production delta was sealed as a complete zero-finding security scan.

### 7. Dense ASCII and semantic media accounting

Final bot review identified two estimator mismatches. High-entropy ASCII was receiving the same low character-ratio floor as repetitive prose, while audio and video were charged according to decoded bytes even though provider accounting is duration/semantic based.

Dense ASCII classification now makes one forward pass over the complete serialized text, preserving run state across the 400-character token-estimator chunks. It uses fixed counters and a unique-character `Set` capped at six entries. The final security review found no superlinear scan, unbounded allocation, backtracking, execution, logging, or chunk-boundary bypass. A regression exercises every possible chunk alignment.

Audio and video now receive fixed conservative semantic allowances of 32,768 and 131,072 tokens. Generic files retain decoded-byte scaling, and PDF remains the selected parser-free `max(32,768, decoded inline bytes)` policy. This avoids treating a long recording's encoded byte count as if every byte were a model token while preserving conservative request admission.

## Final trust and data flow

Both production request paths use the same sequence:

1. Finalize messages, tools, provider instructions, headers, and plugin-selected output reservation.
2. If no output reservation or credible limit exists, return without serializing the prompt.
3. Lazily estimate text, schemas, semantic media allowances, decoded inline payload size, each separately framed system entry, and every provider-instruction wire occurrence.
4. Enforce a dedicated input limit when declared.
5. Clamp the output reservation against the shared context window with a safety margin.
6. Reconcile fixed reasoning budgets with the final reservation.
7. Send through the AI SDK or native transport.

Codebase graph tracing found exactly two production callers of the centralized clamp: `session/llm.ts` and `session/llm/request.ts`.

## Verification

- Focused provider, AI-SDK stream, native request, processor, and upstream bridge suites: **435 passed, 11 skipped, 7 existing todos, 0 failed**.
- Repository typecheck: **13/13 tasks successful**.
- Strict changed-file marker validation: passed.
- Required-marker inventory: **35/35**.
- Frozen lockfile install: **1,295 installs across 1,390 packages, no changes**.
- Targeted oxlint: **0 errors**; warnings remain repository debt.
- Prettier: final supplemental files and the resolved merge-conflict test pass.
- `git diff --check`: passed.
- Final post-main scans through `dc24ed0555`: complete coverage, **0 findings**.

## Operational caveats

- TAC advisory was attempted once earlier in the PR workflow and was unavailable; it was not retried.
- No live provider request or full interactive UI replay was performed.
- Provider-side rejection remains possible for compact or unusually dense PDFs because the local estimate is intentionally crude.
- The remote PR must receive the final commits, reconcile every current review thread, and pass fresh CI/bot review before merge.
