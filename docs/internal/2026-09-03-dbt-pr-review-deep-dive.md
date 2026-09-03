# dbt PR Review — state, experience, and a plan for the AI + feedback layer (2026-09-03)

Inputs: main @ `1caa234ff9`; Azure telemetry (45 d); GitHub mining of the three repos that run the review; a clean end-to-end run on `jaffle_shop_duckdb` with five injected changes; competitor research (Kilo Code, CodeRabbit, Greptile, Graphite, Recce). Supporting notes: `code-map-review.md`, `telemetry-review-notes.md`, `dogfood-notes.md`, `e2e-notes.md`, `research-feedback-loops.md` (session scratchpad; key content is folded in below).

## 0. Correction to the 2026-09-02 telemetry report

The "growing customer CI review usage" line was **our own repos**. The 177 headless machines on 0.9.3 are `AltimateAI/altimate-ingestion` (private) — its `dbt-pr-review.yml` pins `--version 0.9.3`, 176 runs since Aug 19 on PRs by our engineers and dependabot. The 0.8.3 runs are `dbt-pr-review-demo`. Public GitHub code search finds **zero third-party workflows** using `altimate-code/github/review` (one of ours, `altimate-bigquery-demo`, uses the separate `altimate-code-actions@v0`). External usage of the review is 11 interactive machine IDs in 45 days. `project_id` is empty on every review event, so telemetry could not have told us this.

What that means: the review has a real dogfood corpus (30 reviewed PRs, 853 findings, engineers who did not react once) and no external users yet. That corpus is the asset.

## 1. What the product is today

Three layers, already built, all funnelling through `reviewPullRequest()` (`packages/opencode/src/altimate/review/run.ts:209`):

1. **Deterministic engine** (Rust core via `Dispatcher`): equivalence, column lineage / blast radius, PII, grade, AST lint. Documented as the only layer that can produce `critical` and block.
2. **Deterministic catalog**: regex + 1,000-rule self-verifying catalog over raw model + diff; dbt-specific signals. Documented as capped at `warning`; in fact it emits `critical` in places and three of its warnings can block (see §4, Codex finding 1).
3. **LLM reviewer — already exists.** `ai-review.ts` is a transport: system prompt and response parser live in the compiled core (`altimate_core.review_ai_prompt` / `review_ai_parse`); one-shot `LLM.stream`, ≤20 files × 6,000 chars, 60 s timeout, findings clamped to `warning`, and `computeIdealVerdict` excludes `evidence.tool==="ai-review"` from the block count (`verdict.ts:63-65`). Runs only on lite/full tiers and only if a model is configured (`action.yml:129-163`).

So "it's just deterministic" is what users *see*, because the AI layer is invisible when it runs and silent when it fails. There is **no feedback mechanism of any kind**: no reaction or reply handling, no suppression store, no false-positive marking. `applyOverride()` (`verdict.ts:258`) exists with zero callers.

## 2. What we found

### 2.1 Quality of the proofs (e2e, 0.10.0, jaffle_shop_duckdb, five injected changes)
| Injected change | Result |
|---|---|
| Semantic filter change | Caught precisely by engine equivalence **only with `catalog.json`**; otherwise "could not be decided" |
| `not_null` test removed | Caught every run, best-worded finding |
| New model with `SELECT *` + `DATEDIFF` | Partial (suggestion-level), plus a false `unbalanced_quote (possible injection breakout)` |
| Inconsistent column rename breaking two consumers | **Best catch**: critical, names the column and both consumers — only with `catalog.json` |
| Pure column reorder (safe refactor) | **False positive**: "NOT row-equivalent"; the comparator is positional |
| (not injected) pre-existing PII columns | critical `pii_exposure` on every touch, by design (`orchestrate.ts ~1021`); docs say "newly expose" |

The engine is genuinely good when it has artifacts. Whether it has them is decided by undocumented steps.

### 2.2 Experience and operations
| # | Issue | Evidence | Root cause |
|---|---|---|---|
| 1 | Reviews run lint-only most of the time | 57% of dogfood PRs, 72% of interactive `review_run` `degraded=true`; the demo PR meant to show "safe refactor approved" shows the hedge instead | Docs and examples never say to run `dbt docs generate` (catalog) or compile the **base** into `target-base/compiled`; dogfood runs `dbt parse` only. `grep target-base` hits only prose. |
| 2 | "Lint-only run — no manifest/warehouse" banner lies | e2e: manifest present, most lanes high-confidence, banner still shown | `degraded = runDegraded \|\| findings.some(f => f.degraded)` (`orchestrate.ts:1424`, `format.ts:45`) — one undecidable finding flips the whole-run banner |
| 3 | AI lane fails silently | 18% of CI runs call `review_ai_prompt` and never `review_ai_parse`; e2e default run attempted a dead local endpoint every time, docs say "skipped" | Every failure path returns `[]` with a log (`ai-review.ts:88,130,174`); orchestrator discards even that; 60 s timeout vs ~240 KB prompt |
| 4 | Wrong base ref, and one review posted to the wrong PR | PR #1320 (base `deployment`) → posted to #1319 (base `main`, same head) | `defaultBaseRef` (`git.ts:143-154`) walks `origin/main→master`, never reads the event's `pull_request.base.ref`; PR number does come from the event, so the posting side needs a repro from the dogfood workflow |
| 5 | One rule is half of all findings | `test_coverage` "new model has no uniqueness/grain test" = 427 of 853; repeated 9–14× across sibling PRs; never acted on | `missingGrainTestLane` fires per added mart/intermediate model (`orchestrate.ts:735-762`), one finding per model, no collapse |
| 6 | Inline comments duplicate on every re-run | code | Only the summary is upserted by marker; `pulls.createReview` always creates (`post-github.ts:65-107`) |
| 7 | No org attribution in telemetry | `project_id` "" on 100% of review events | `Telemetry.setContext` is only called from the interactive session loop (`session/prompt.ts:662`); headless review never sets it |
| 8 | Coverage trap | 8 of 10 unreviewed dogfood PRs touched non-Snowflake packages | workflow path filter; product cannot see it, but the summary could report "N changed dbt files outside the review scope" |
| 9 | Review takes 6–14 minutes in CI | p50 362 s telemetry / 591 s workflow, p90 ~10–14 min | dbt install + parse dominate; the review itself is ~5 s locally |
| 10 | Interactive path fails on small models | `altimate-code run "Review…"`: 79 K-token builder prompt vs 65 K window | no fallback agent; the `reviewer` agent exists but is not chosen |
| 11 | Two products disagree on confidence | `altimate-code-actions@v0` calls an unverified CTE inline "✅ Safe"; the CLI hedges the same class | separate codebases, separate posture |

### 2.3 Engagement
Zero reactions on 30 bot comments. One explicit reply in 30 PRs (#1286: "Thanks — addressing all four…", fixed 2 of 4). 100% of interactive `review_post_outcome` are `not_requested`. We cannot tell whether anyone reads it, because there is nothing to click and nothing that records what happened to a finding afterwards.

## 3. How others close the loop

| Tool | Signal | Store | Applied | Suppression |
|---|---|---|---|---|
| Kilo Code | replies/feedback on past reviews, batch-analysed (opt-in "Code Review Memory", Jun 2026) | `REVIEW.md` in the repo, read from the **base** branch so a PR cannot rewrite its own policy; >10 K chars truncated | prompt guidance on every review; memory run proposes a PR you merge | manual via REVIEW.md ("files to skip", severity calibration) |
| CodeRabbit | `@coderabbitai` replies + inferred | hosted "Learnings" DB with dashboard, scopes, 0–30 d approval delay, PR quarantine until merge | retrieved per review | learning that says "don't flag X" |
| Greptile | 👍/👎, replies, addressed-vs-ignored commits | hosted Memory | **automatic**: comment types suppressed after repeated ignores; rule suggestions after ~10 PRs; security/logic never suppressed | `ignorePatterns`, scoped rules with "Last Applied" |
| Graphite Diamond | up/downvote, accepted suggestions | offline eval datasets | model/prompt iteration, not per-team | manual natural-language Exclusions |
| Recce (dbt) | check approve/reject | preset checks per project | run every PR | deterministic: skip non-data PRs, drop no-data-impact findings |

The pattern that fits us: Kilo's **version-controlled, human-approved repo file** as the store (auditable, matches the signed-envelope posture, no server-side PII), Greptile's **cheap signals** (reactions, replies, addressed-vs-ignored) as input, and Recce's **deterministic de-noising** where a rule is structurally wrong. Our differentiator is that most findings come from named deterministic rules with stable `ruleKey`s, so feedback can attach to a rule, not to prose — and aggregate across customers.

## 4. What the Codex plan review changed (2026-09-03)

Codex reviewed the first draft of this plan against the code and found two things the draft, the README and the public docs all get wrong today:

1. **"Only the deterministic engine blocks" is false.** `dbt-patterns.ts:165` emits `critical` (e.g. CROSS JOIN) and the rule catalog has critical rules (`rule-catalog.ts:289`, `select-into`). Any three non-AI warnings also trip `REQUEST_CHANGES` (`verdict.ts:52`); the only exclusion is `evidence.tool === "ai-review"`. The regex/catalog layer blocks directly and cumulatively. Either the docs change or the verdict gets an explicit provenance allow-list (`verdictEligible`) instead of an AI-only deny-list, with a test of one catalog critical plus three catalog warnings.
2. **Review policy is controlled by the PR under review.** `reviewPullRequest()` loads `.altimate/review.yml` from the checkout, i.e. the PR head (`run.ts:238`). A PR can rewrite `reviewers`, `exclude`, `rubric.blockOn`, thresholds and `ai`; a bogus non-empty `reviewers` list disables most lanes (`orchestrate.ts:1173`). Governance must load from an immutable base commit, policy changes must be reported in the PR, and the effective-policy hash signed into the envelope. This precedes any suppression store.

Sizing corrections accepted: base-ref handling has to pick one baseline semantics (merge-base SHA everywhere, or base-tip with two-dot diff) and compile that exact SHA, since `git diff base...head` and `git show base:file` disagree once the target branch moves (`git.ts:35,100`); gate mode has no lifecycle (a clean rerun does not clear the earlier `REQUEST_CHANGES` review, and `applyOverride()` cannot update a failed check) so a single owned check-run should be the gate's source of truth; the grain-test rule should be grouped in presentation, not merged into one finding (`Finding.file` is required and per-model outcomes matter later); a workflow skipped by `paths:` cannot post a scope warning, so coverage needs an always-on job; compiling the base ref inside the composite action runs PR-controlled macros and `docs generate` touches the warehouse, so that stays in an opt-in reference workflow; `altimate-ingestion` should pin an exact current release with automated bumps, not `latest`.

Design corrections accepted for later phases: appending `REVIEW.md` to the AI user message is verdict-safe but not prompt-safe (the core prompt declares all PR content untrusted; repo guidance is an instruction and needs a defined lower-authority slot in the core prompt, loaded from a base blob SHA, with adversarial tests); GitHub suggestion blocks need a typed replacement/range field the core parser does not have (probe of `altimate-core` 0.7.0 discards unknown fields) so they are a core release, not a TS patch; feedback needs a **low-cardinality shipped `ruleId` + `origin` + `ruleVersion`** because today's `ruleKey` is stripped by the `Finding` schema (`finding.ts:65`) and some keys embed lint text, relation names or AI titles; addressed-vs-ignored needs a durable per-run snapshot (run id, SHAs, every surfaced finding id) because the upserted summary destroys history and only line-anchored findings become individual comments (`format.ts:146`); suppression must be three operations (presentation mute, false-positive suppression for non-verdict-eligible rules only, authorized risk acceptance that preserves the ideal verdict) and the blocking list is the full default rubric (`rubric.ts:39`: lineage, contract, PII, semantic change, join risk, fanout, SQL correctness); ignored findings rank, they never propose suppression; the store is hybrid (repo files for approved policy, minimal pseudonymous observations server-side via the GitHub App, or signed run manifests if server storage is rejected); the CLI and action never pass `prTitle`/`prBody` (`cli/cmd/review.ts:84`) so intent checking is absent in CI, and the AI lane uses generic `Provider.defaultModel()` rather than an explicit selector, which is how the e2e run hit a dead local endpoint; and the metrics need stable repo/PR/run ids plus eligibility flags before "per PR" or "per rule" rates mean anything (`review_run` measures an invocation and its timer excludes CI wall time).

## 5. Plan (revised)

### Phase 0A — correctness and trust (before anything user-visible)
1. **Verdict provenance allow-list.** Findings carry `origin: engine | catalog | ai`; only `engine` findings are `verdictEligible` unless the rubric opts a catalog rule in. Test: one catalog critical + three catalog warnings → COMMENT. Update README and public docs to match whatever is decided.
2. **Policy from the base.** Load `.altimate/review.yml` from the resolved base commit (`git show <baseSha>:.altimate/review.yml`), diff it against the head copy, list policy changes in the summary, sign `policySha` and the effective rubric hash into the envelope.
3. **One baseline semantics.** Resolve `baseSha = merge-base(base, head)` once in `git.ts`; use it for `diff`, `show`, and as the SHA the base-compile step must build; take `base.ref`/`head.sha` from `GITHUB_EVENT_PATH`, never guess `origin/main`.
4. **Gate lifecycle.** Publish one owned check-run per PR as the gate; update it on reruns; wire `applyOverride()` behind maintainer authorization with a real HMAC key, prior-envelope verification, and an audit record (actor, reason, time, SHAs, prior verdict).

### Phase 0B — capabilities, status, telemetry (the branch in flight, `fix/dbt-pr-review-ci-experience`)
5. Capability fields on the envelope (manifest, catalog, head/base compiled coverage per changed model, data-diff, AI status) rendered honestly; the "Lint-only" banner only when no manifest resolved; undecidable count separate.
6. Artifact hints with the exact command (`dbt docs generate`; compile the base SHA into `target-base/`).
7. AI lane status `ok | skipped | timeout | error` with reason, in the comment and in `review_run` (`ai_status`, `ai_findings`, eligible/attempted, duration, prompt size, model id, prompt version). Explicit AI-lane model selector with a disabled state; no fallback to whatever `defaultModel()` finds. Instrument prompt size before raising the timeout.
8. Pass `prTitle`/`prBody` from the event into `reviewPullRequest()` so the AI lane can do intent checks in CI.
9. `project_id` (and a privacy-safe stable repo/PR/run id) on headless review telemetry.
10. Docs and both example workflows: `dbt compile` head, compile the base SHA into `target-base/compiled` in a separate worktree, `dbt docs generate`; state plainly what is undecidable without them; fix the PII "newly expose" sentence.

### Phase 0C — presentation and rollout
11. **Make the comment readable.** Evidence from `altimate-ingestion` PR #1375: 406 lines, 130 findings, seven models each with two near-identical paragraphs (fan-out, "could not be proven equivalent"), five grain columns each with a 60-word paragraph, and the one contextual finding worth reading (an unused CTE that means a documented gate may not apply, an AI-lane finding) buried at position 15. Deterministic fixes, presentation only, findings stay atomic: (a) `groupKey` on the repetitive lanes so fan-out, undecidable equivalence and grain `not_null` render as one item each with the members' specifics; (b) fold any severity section past 12 items into `<details>`, never critical; (c) a "Read first" block of up to three items (critical, then AI contextual, then high-confidence ungrouped warnings) when a review has eight or more findings; (d) an incremental line on re-run, "Since last review: N fixed · M new · K unchanged", from a hidden finding-id block in the previous sticky comment. Section headers show "54 findings · 9 items" so volume stays honest.
12. Inline comments deduped by `<!-- altimate-finding:<id> -->`; previous bot reviews dismissed or reconciled on rerun.
13. Always-on coverage job (or no `paths:` filter) so unreviewed dbt files are reported.
14. `altimate-ingestion`: pin the current release with automated bumps; widen to the Databricks package; measure on real volume.

### Phase 1 — the AI layer earns its place (2–3 weeks)
- Hosted altimate model on by default in our own CI; measure `ai_status=ok` share, AI findings per completed invocation, and engineer touches.
- Core prompt release: a defined, lower-authority "repository review guidance" slot; guidance loaded from the base blob SHA, ≤10 K chars; cannot change output/verdict/grounding rules; adversarial test corpus (delimiter closure, fake finding markers, prompt-leak, poisoned feedback text). Only then read `.altimate/REVIEW.md`.
- Feed the AI lane changed schema/test files, not only model contexts.
- **What the AI layer does for readability, and what it must not do.** It writes the three-to-five-line executive summary at the top of the comment: what this PR changes in plain language, which of the deterministic findings are one change repeated N times, and the one or two things a human should look at. Every sentence cites finding ids; it adds no findings of its own in that block and never touches the verdict. It also proposes the "Read first" ordering when the deterministic heuristic ties. It does not rewrite the deterministic finding text (that stays reproducible and signed). The grouping and folding in Phase 0C do most of the work without a model; the AI summary is the layer that makes a 54-warning comment readable in ten seconds.
- Judge on the dogfood corpus: replay the 30 reviewed PRs with AI on/off; grader model calibrated against a blinded human sample and an injection corpus; ship if true-positive share ≥70% and duplicates ≤10%.
- Suggestion blocks deferred until the core parser has a typed replacement/range field validated against the right side of the diff.

### Phase 2 — the feedback loop (after Phase 1 data)
- **Identity first**: shipped `ruleId` + `origin` + `ruleVersion` on every finding (low cardinality, no model/column/path/relation names); `finding.id` stays the repo-local occurrence fingerprint. Per-run snapshot (run id, base/head SHA, capability state, every surfaced finding id/rule id) posted as a hidden block or stored server-side.
- **Signals**: 👍/👎 on inline comments; `@altimate-code-agent feedback <finding-id> false-positive|helpful|accept-risk <reason>` for line-less findings; addressed-vs-ignored derived from snapshots (ranking only).
- **Operations**: presentation mute; false-positive suppression only for non-verdict-eligible rules, scoped by path glob + rule + reason + actor + expiry + policy SHA; authorized risk acceptance that keeps the finding and ideal verdict but overrides enforcement.
- **Store**: approved policy in `.altimate/review.yml` + `.altimate/REVIEW.md` on the base branch; observations server-side via the GitHub App (pseudonymous repo/PR/finding ids, rule id, signal, actor role, SHA, time) with retention controls, or signed run manifests if server storage is rejected.
- **Incorporation**: `altimate review learn` (also `@altimate-code-agent learn`) drafts policy edits and opens a PR; proposals require explicit structured false-positive signals from maintainers, minimum distinct PRs and users, a negative-rate denominator, recency, and unchanged rule version; shadow mode until calibrated; every proposed glob shows its corpus-wide blast radius.
- **Telemetry**: `review_feedback` and `review_finding_outcome` keyed by public rule id; aggregated across repos this is the dbt rule-quality dataset nobody else has.

### Phase 3 — the agent on top
Replies on a finding open an altimate-code session with the finding, compiled SQL and lineage as context ("explain", "fix", "diff the data" via the opt-in warehouse lane); the `reviewer` agent, not `builder`, is the default for review conversations so it starts on a 65 K-window model. The GitHub App already exists; the missing piece is finding-scoped context.

### Metrics (once Phase 0B/2 identities exist)
- Lint-only share of CI invocations < 20% (from 57%). Definition: over a trailing 4-week window, among `review_run` events with `invocation=cli` and `empty_scope=false` (at least one reviewable model file), the share with `lint_only=true` (no changed model resolved against a manifest). Both fields are recorded on the event by this PR; `degraded` merges empty scope and is not used. Per-finding `degraded` / `undecidableFindings` are excluded so undecidable equivalence cannot move this number. The 57% baseline was measured on the 30 dogfood PRs from the posted comment banner (which used the old combined flag), so the first post-fix reading resets the baseline.
- AI `status=ok` ≥ 90% of eligible invocations (from ≤ 82%).
- Findings per completed invocation p50 ≤ 8 (from 11); top rule ≤ 10% of findings (from 50%).
- Reaction or structured feedback on ≥ 20% of reviewed PRs (from 0–3%).
- Addressed rate per public rule id, from snapshots.
- CI wall time p50 < 4 min, from job data, not `review_run.duration_ms`.

## 6. Decisions for Anand
1. Resolve the blocking invariant: enforce "only engine blocks" in code, or rewrite the docs/README to say catalog rules block too. Recommendation: enforce, with a rubric opt-in for named catalog rules.
2. Hosted altimate model as the default AI lane in the action (we pay per review) vs BYO key only. Recommendation: hosted by default with a per-repo cap; the AI layer is otherwise invisible.
3. Feedback store: hybrid (repo policy + server observations via the GitHub App) vs repo-only. Recommendation: hybrid; repo-only cannot see reactions or cross-PR thresholds.
4. Reconcile `altimate-code-actions@v0` (says "Safe" without proof) with this product: fold in or retire.
5. Widen `altimate-ingestion` to the Databricks package now and move it from the 0.9.3 pin to an exact pin of the current release with automated bumps (Dependabot/Renovate on the `--version` line), so Phase 1 measures real volume without floating `latest`. Same policy as Phase 0C item 14.
6. Budget a core release (prompt guidance slot, typed suggestion payload, `ruleId` in engine output) — Phases 1–2 depend on it.

## 7. Not verified
- The wrong-PR posting in #1320: the base-ref bug is confirmed; PR-number resolution reads the event correctly, so the misdirection needs a repro against the dogfood workflow's exact trigger.
- The AI layer's output quality: no run in this investigation had credentials for it.
- The positional equivalence comparator lives in the core; reproduced, not fixed.
