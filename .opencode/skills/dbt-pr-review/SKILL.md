---
name: dbt-pr-review
description: Cloudflare-style AI code review for dbt/SQL pull requests. Produces a signed APPROVE/COMMENT/REQUEST_CHANGES verdict where every blocking finding is backed by a deterministic engine call — column-lineage blast radius, query equivalence, PII classification, and A–F grade. Use to review a dbt PR or the working-tree changes before merge.
---

# dbt PR Review

## Requirements
**Agent:** `reviewer` (read-only) — also works from `analyst`/`builder`.
**Tools used:** `dbt_pr_review` (primary), `impact_analysis`, `altimate_core_equivalence`, `altimate_core_check`, `lineage_check`, read-only `git`.

## When to Use This Skill

Use when the user wants to:
- Review a dbt pull request (changed models) before merge
- Get a single verdict (APPROVE / COMMENT / REQUEST_CHANGES) with evidence
- Understand the downstream blast radius of a model/column change
- Check whether a "refactor" actually preserves results (query equivalence)
- Catch PII exposure, contract breaks, or warehouse-cost anti-patterns pre-merge

## What makes this different from a generic AI reviewer

Generic reviewers read the diff as text and guess. This review is backed by the
Rust core: every blocking finding carries a deterministic proof (an equivalence
counterexample, a downstream-model list, a PII classification). The verdict is
**signed** into a replayable envelope keyed to the dbt manifest.

## Workflow

1. **Run the verdict engine.** Call `dbt_pr_review` once:
   - `dbt_pr_review({})` reviews the working tree against `origin/main`.
   - `dbt_pr_review({ base: "origin/main", head: "HEAD", manifest_path: "target/manifest.json" })`
     for an explicit PR range.
   - The tool reads `.altimate/review.yml` for the per-repo rubric and `mode`.

2. **Read the signed envelope.** It contains the verdict, a risk tier
   (trivial / lite / full), and findings grouped by severity
   (critical / warning / suggestion), each with engine evidence.

3. **Present the verdict** exactly as returned. Group findings by severity.
   If the run is **degraded** (no manifest/warehouse), state that lineage,
   equivalence, and data-impact were NOT verified — it is a lint-only review.

4. **Respect the safety invariant.** An UNDECIDABLE equivalence result is a
   WARNING, never a block. Never claim a refactor is unsafe when equivalence
   could not be decided — recommend a data-diff instead.

## Configuration (`.altimate/review.yml`)

```yaml
mode: comment            # comment (never blocks) | gate (blocks on REQUEST_CHANGES)
severityThreshold: suggestion
manifestPath: target/manifest.json
dialect: snowflake
reviewers: []            # empty = tier defaults; or pin lanes e.g. [lineage_breakage, semantic_change]
exclude:
  - models/legacy/**
rubric:
  blockOn: [lineage_breakage, contract_violation, pii_exposure, semantic_change]
  warningPatternThreshold: 3
  thresholds:
    warehouseCostMinRows: 1000000
```

## Verdict rubric (defaults)

- **REQUEST_CHANGES** — any blocking-category `critical` (broken lineage with
  downstream consumers, contract violation, PII exposure, proven non-equivalent
  rewrite), or ≥3 warnings (risk pattern).
- **COMMENT** — only suggestions, or a single non-blocking warning.
- **APPROVE** — no findings.

In `comment` mode (default), REQUEST_CHANGES is posted as comments rather than
blocking the merge. Switch to `gate` per-repo once you trust the false-positive rate.
