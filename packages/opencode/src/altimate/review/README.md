# dbt PR Review (`altimate/review`)

<!-- HUMAN-AUTHORED: Start -->

## Purpose

Produce a single, signed verdict on a dbt/SQL pull request (`APPROVE` /
`COMMENT` / `REQUEST_CHANGES`) where every **blocking** finding is backed by a
deterministic engine proof, with an LLM reviewer layered on top for contextual
judgment. User-facing docs: [`docs/docs/usage/dbt-pr-review.md`](../../../../../docs/docs/usage/dbt-pr-review.md).

## The three layers (ordered by trust)

Each blocking decision comes from the most authoritative layer that can decide
it; lower layers fill gaps and add context but never override a proof.

1. **Deterministic engine — authoritative, the only layer that BLOCKS.**
   The Rust core (`@altimateai/altimate-core`) over parsed SQL ASTs: query
   equivalence, column-lineage/DAG blast radius, PII classification, A–F grade,
   and AST anti-pattern lint (`altimate_core.check` → `lint.findings`, e.g.
   `L032` division-by-column-without-guard, `L033` non-portable dialect
   functions). Robust by construction — a string literal or alias can't fool an
   AST.

2. **Deterministic catalog — diff/Jinja-aware fallback.**
   Regex detectors + a self-verifying rule catalog over the raw model + unified
   diff. Runs offline (no warehouse). Owns dbt-specific signals (incremental
   guards, materialization, `ref` conventions, `schema.yml` test removal) and a
   long tail of portability checks. **Defers to layer 1**: when the engine
   analyzed a file, the catalog's twins for engine-covered checks are dropped
   (`CORE_AST_COVERED` + per-function portability reconciliation in
   `orchestrate.ts`). It is the sole layer when the engine is unavailable, where
   it is hardened to be literal- and structure-safe.

3. **LLM reviewer — advisory, grounded in layers 1–2.**
   Reasons over the diff + compiled SQL + PR description, told **not** to repeat
   the engine findings it is handed. Adds intent mismatch, misleading names,
   business-logic risk, missing tests, cross-model inconsistency. Treats the
   diff as untrusted input (prompt-injection hardened) and is force-clamped out
   of `critical`, so it enriches the review but never blocks. Skipped (clean
   degrade) when no model is configured.

## Key invariants

- **Only layer 1 reaches `critical`** → only the engine can block. Catalog and
  LLM findings cap at `warning`.
- **Undecidable is never a block.** An undecidable equivalence result is a
  `warning` with `confidence: unknown`; the reviewer asks for a data-diff rather
  than claiming a refactor is unsafe.
- **Render-then-analyze.** Engine lanes consume dbt-**compiled** SQL
  (`target/compiled` HEAD, `target-base/compiled` BASE); the catalog uses the raw
  model + diff (it needs the Jinja). Jinja is never re-implemented.

<!-- HUMAN-AUTHORED: End -->

<!-- AI-GENERATED: Start -->
<!-- Last updated: 2026-05-30 -->

## Layer → file map

| Layer | Files |
|------|-------|
| 1 — engine | `runner.ts` (Dispatcher-backed `ReviewRunner`: impact/equivalence/check/grade/PII), `compiled.ts` (compiled-SQL resolver), `schema-context.ts` |
| 2 — catalog | `dbt-patterns.ts` (programmatic detectors + literal-safe helpers), `rule-catalog.ts` (declarative self-verifying rules + `evaluateCatalog`), `rule-generators.ts` (portability/reserved/type/operator families) |
| 3 — LLM | `ai-review.ts` (`runAiReview` — one-shot `LLM.stream` call, prompt + guardrails + JSON parse + clamp) |
| orchestration | `orchestrate.ts` (`runReview`: tiering → lanes → layer reconciliation → verdict; `CORE_AST_COVERED`, portability dedup, AI-lane merge) |
| verdict | `verdict.ts` (rubric → verdict, `stableStringify`, HMAC sign/verify), `rubric.ts`, `risk-tier.ts` (`TIER_LANES`) |
| entry | `run.ts` (`reviewPullRequest` — wires resolvers + `runAiReview`), `git.ts`, `finding.ts`, `diff-filter.ts`, `format.ts`, `post-github.ts`, `config.ts` |

## Entry points

- Tool: `dbt_pr_review` (`../tools/dbt-pr-review.ts`) — callable from any agent.
- CLI: `altimate review` (`../../cli/cmd/review.ts`).
- Agent: `reviewer` (read-only) — `../prompts/reviewer.txt`.
- Action: `github/review/action.yml`.

## Tests

`test/altimate/review*.test.ts` — `review.test.ts` (orchestration, verdict,
layer reconciliation, AI-lane merge), `review-ci.test.ts`, `review-dbt-patterns.test.ts`
(detectors + literal-safety regressions), `review-rule-catalog.test.ts`
(self-verifying corpus, ≥1000 rules).

<!-- AI-GENERATED: End -->
