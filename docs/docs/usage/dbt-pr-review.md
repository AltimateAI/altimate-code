# dbt PR Review

[**See live review PRs**](https://github.com/AltimateAI/dbt-pr-review-demo/pulls)
·
[**Install the GitHub App**](https://github.com/apps/altimate-code-agent/installations/new)

The public demo is a zero-secret DuckDB project with open PRs for broken joins,
removed tests, PII exposure, `SELECT *`, unsafe incremental models, and a safe
refactor. The GitHub App handles interactive repository tasks; the automatic
review on every pull request is installed with the Action below.

AI code review specialized for dbt/SQL. `dbt-pr-review` produces a single,
**signed** verdict on a pull request — `APPROVE`, `COMMENT`, or `REQUEST_CHANGES`
— where every **blocking** finding is backed by a deterministic engine call, not
a model's opinion:

- **column-lineage / DAG blast radius** — which downstream models a change breaks
- **query equivalence** — whether a "refactor" provably returns the same rows
- **PII classification** — columns that newly expose sensitive data
- **A–F grade + anti-patterns** — readability, correctness, warehouse-cost issues

!!! warning "The bot posts a COMMENT review — never a formal GitHub *Approve*"
    `APPROVE` is the **semantic** verdict shown in the comment body ("✅ Approved
    — no findings"). On GitHub the bot always posts a **COMMENT** review event,
    **never** a formal *Approve*: a review bot must not be able to satisfy branch
    protection / required reviews and let a PR merge without human sign-off.
    `REQUEST_CHANGES` posts a blocking review in `gate` mode (softened to a
    comment in `comment` mode).

    **To block merges, gate on the verdict _check_ (`--mode gate`), not on
    requiring this bot as a reviewer.** If your branch protection previously
    *required the altimate bot's review approval*, remove that requirement — the
    bot no longer issues one, so those merges would otherwise stay blocked.

On top of that deterministic core, an **LLM reviewer** adds the contextual
judgment a static analyzer cannot — intent vs. the PR description, misleading
names, business-logic risk, and test coverage for the change — as **advisory**
comments that never block. The verdict is signed into a replayable envelope keyed
to your dbt manifest, so it is tamper-evident and reproducible.

## Architecture — three layers

The reviewer is three cooperating layers, ordered by trust. Each blocking
decision comes from the most authoritative layer that can decide it; the layers
below it fill gaps and add context without ever overriding a proof.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 3. LLM reviewer (advisory)                                             │
│    Reasons over the diff + compiled SQL + the PR description, GROUNDED  │
│    in layers 1–2. Catches intent mismatch, misleading names, business- │
│    logic risk, missing tests, cross-model inconsistency. Clamped to     │
│    ≤ warning — enriches the review, never blocks.                       │
├──────────────────────────────────────────────────────────────────────┤
│ 2. Deterministic catalog (fallback)                                    │
│    A thin self-verifying catalog for the few signals that need the raw  │
│    diff/Jinja and aren't yet AST (schema.yml test removal, single-line  │
│    added-only heuristics). Most dbt-specific rules — config/Jinja        │
│    (DBT0xx), base-vs-head structural (SC0xx), and SQL anti-patterns —    │
│    have MOVED into layer 1 as core AST/minijinja rules. Runs offline,    │
│    no warehouse; defers to layer 1 for anything the engine proves.      │
├──────────────────────────────────────────────────────────────────────┤
│ 1. Deterministic engine (authoritative — the only layer that BLOCKS)   │
│    The Rust core (`altimate-core`) over PARSED SQL ASTs: query          │
│    equivalence, column lineage / DAG blast radius, PII classification,  │
│    A–F grade, and AST anti-pattern lint (e.g. division-by-column        │
│    without a zero-guard, non-portable dialect functions). Robust by     │
│    construction — a string literal or alias can't fool an AST.          │
└──────────────────────────────────────────────────────────────────────┘
```

**How the layers compose**

- **Blocking is layer-1 only.** A `REQUEST_CHANGES` verdict is always backed by a
  proven engine fact (broken lineage, proven non-equivalence, new PII, an enforced
  contract break). Layers 2–3 can inform and comment, but cannot block on their
  own — so the verdict stays trustworthy and replayable.
- **The engine supersedes the catalog.** When the native engine analyzes a file,
  the catalog's regex twins for checks the engine covers (cartesian/comma join,
  `SELECT *`, `NOT IN` on nullables, window-without-partition, division-by-column,
  dialect-function portability, …) are dropped in favor of the AST verdict. The
  catalog only surfaces what the engine didn't — and is the sole layer when the
  engine is unavailable (no manifest / offline), where it is hardened to be
  literal- and structure-safe.
- **The LLM is grounded, not freewheeling.** The reviewer is handed layers 1–2 as
  context and told not to repeat them; it adds only contextual judgment, treats
  the diff as untrusted input (prompt-injection hardened), and is force-clamped
  out of `critical`. If no model is configured, the lane is skipped and the review
  degrades cleanly to deterministic-only.

---

## Quick start (local)

Run the reviewer on your working-tree changes against `origin/main`:

```bash
altimate review                 # human-readable summary
altimate review --json          # the full signed verdict envelope
altimate review --mode gate     # exit non-zero on REQUEST_CHANGES (for CI gating)
```

Options:

| Flag | Description |
|------|-------------|
| `--base <ref>` | Base git ref. Defaults to the merge-base with `origin/main`. |
| `--head <ref>` | Head git ref. Omit to review the working tree. |
| `--manifest <path>` | Path to the compiled `manifest.json` (default `target/manifest.json`). |
| `--mode comment\|gate` | `comment` never blocks; `gate` exits non-zero on `REQUEST_CHANGES`. |
| `--severity <level>` | Minimum severity to surface: `critical`, `warning`, `suggestion`. |
| `--post` | Post the verdict to the GitHub PR (uses `GITHUB_TOKEN` + the Actions event). |
| `--no-ai` | Disable the advisory LLM reviewer lane (no model calls / cost) — deterministic-only. |
| `--json` / `--output <file>` | Emit the verdict envelope as JSON. |

> **Full vs lint-only.** With a compiled `manifest.json` present, the reviewer
> proves lineage and equivalence exactly. Without it (or without a warehouse) it
> runs **lint-only** and conservatively *warns* on changes it cannot prove safe —
> clearly labeled, never mistaken for a full verdict. Run `dbt compile` first for
> the full verdict.

!!! question "Stuck in lint-only mode? It is **not** an API-key problem."
    The deterministic engine (lineage, equivalence, PII, grade) runs fully
    offline via the bundled native binary — **no altimate API key or account is
    required** for any part of the verdict. A key is only ever needed for the
    *optional* advisory LLM lane (see [below](#model--credentials-for-the-advisory-lane)),
    and that lane can never block a verdict.

    Lint-only means the **manifest didn't resolve**, not that auth failed. Check:

    - **Path.** The default is `target/manifest.json` *relative to the project
      root you run from*. If your manifest lives elsewhere, pass it explicitly:
      `dbt_pr_review({ manifest_path: "target/manifest.json" })` (or `--manifest`
      on the CLI), or set `manifestPath:` in `.altimate/review.yml`.
    - **Freshness.** A stale manifest that predates the changed models can't
      resolve them. Run `dbt compile` (or `dbt build`) to regenerate it before reviewing.
    - **Working directory.** Run the review from the dbt project root so the
      relative manifest path resolves.

!!! note "Current limitations"
    - **BigQuery equivalence** on some compiled SQL (3-part backtick relations)
      is currently *undecidable* — the reviewer reports a warning ("could not
      prove equivalent") rather than an `APPROVE`-on-proof. It never reports a
      false equivalence; it just can't prove some BigQuery refactors yet.
    - With no manifest, the SQL dialect defaults to `snowflake`. For a
      non-Snowflake project, pass a compiled `manifest.json` (its `adapter_type`
      is auto-detected) or set `dialect:` in `.altimate/review.yml`.

!!! tip "Reviewer vs validators"
    `dbt-pr-review` reviews a **PR diff** and emits a verdict. The
    [completion-gate validators](../data-engineering/validators.md) are a
    different surface — they gate the **agent's own build loop** so it can't
    declare "done" on failing dbt tests or schema drift.

## GitHub Action

Add the review to any repo with a workflow that compiles the project, then runs
the review action:

!!! danger "Run on `pull_request`, not `pull_request_target`"
    The bot derives the target PR from the Actions event payload. Trigger it on
    `pull_request` so fork PRs run with a **read-only** token. Do **not** use
    `pull_request_target` with a checkout of the PR head — that hands a write-
    scoped token to untrusted PR code (and to the PR's dbt Jinja/macros at
    compile time).

```yaml
name: dbt PR Review
on:
  pull_request:
    paths: ['models/**', 'macros/**', 'snapshots/**', '**/*.sql', '**/*.yml']
permissions:
  contents: read
  pull-requests: write     # post the summary + inline review
  checks: write            # the verdict check (gate mode)
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      # Produce target/manifest.json for the full verdict (adapter-specific).
      - run: pip install dbt-core dbt-bigquery && dbt deps && dbt compile
      - uses: AltimateAI/altimate-code/github/review@v0.8.5
        with:
          mode: comment                       # `gate` to block merges
          manifest_path: target/manifest.json
          severity_threshold: suggestion
          # Advisory LLM lane (OPTIONAL — see below). Hosted altimate model:
          altimate_api_key: ${{ secrets.ALTIMATE_API_KEY }}
          altimate_instance: ${{ secrets.ALTIMATE_INSTANCE }}
          # …or bring your own:  model: anthropic/claude-sonnet-4-6
          #                      model_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Model & credentials for the advisory lane

The deterministic engine (lineage, equivalence, PII, grade, lint — the only layer
that can **block**) runs entirely from the compiled artifacts and needs **no model
or credentials**. The optional layer-3 **LLM reviewer** does — supply it one of two
ways, or neither (it self-disables, leaving a deterministic-only review):

| Route | Action inputs | Result |
|-------|---------------|--------|
| **Hosted altimate model** | `altimate_api_key` + `altimate_instance` (+ optional `altimate_url`) | uses the altimate-hosted default model |
| **Bring-your-own** | `model` (e.g. `anthropic/claude-sonnet-4-6`) + `model_api_key` | uses your provider/model |

Always pass keys as repo **secrets**. Warehouse credentials are consumed by the
`dbt compile` step (via your `profiles.yml`), **not** by the review step. A
complete, copy-paste workflow lives at
[`github/review/examples/altimate-ingestion.yml`](https://github.com/AltimateAI/altimate-code/blob/main/github/review/examples/altimate-ingestion.yml).

Re-pushing commits updates the same summary comment in place; fixed findings are
dropped on the next run. `--post` targets **GitHub** PRs (it reads `GITHUB_TOKEN` /
`GITHUB_REPOSITORY` and posts via the GitHub API). On other platforms (e.g. GitLab),
run with `--json`/`--output` and post the verdict using that platform's own API —
native GitLab posting is not yet built in.

## Configuration — `.altimate/review.yml`

Per-repo configuration, the analogue of an `AGENTS.md`. Tune the rubric, choose
reviewer lanes, and pick comment-vs-gate without forking:

```yaml
mode: comment                 # comment | gate
severityThreshold: suggestion
manifestPath: target/manifest.json
dialect: snowflake
reviewers: []                 # empty = risk-tier defaults; or pin lanes
dataDiff:                     # OFF by default — see "Data-diff in CI" below
  enabled: false
  warehouse: ""               # connection name; empty = default connection
exclude:
  - models/legacy/**
rubric:
  blockOn: [lineage_breakage, contract_violation, pii_exposure, semantic_change]
  warningPatternThreshold: 3
  thresholds:
    warehouseCostMinRows: 1000000
  exclusions:
    allowSelectStarInStaging: true
    skipNonProdModels: true
```

## Data-diff in CI

Static equivalence proves a refactor *can't* change results. **Data-diff** goes
further: it runs the base and head SQL **against your warehouse** and reports the
actual row/value deltas on the model's key — catching value bugs that static
analysis can't decide (e.g. a wrong join key that silently over-/under-counts).
It's the right tool when "old ≠ new" but you need to know *how much* and *which
rows* changed.

Data-diff is **opt-in** because it costs warehouse compute and needs credentials.
Enable it and point it at a connection:

```yaml
# .altimate/review.yml
dataDiff:
  enabled: true
  warehouse: prod_ci      # a configured connection name; empty = default connection
```

### Configuring credentials

The data-diff lane reads warehouse credentials from a **connection**, resolved in
this order (later overrides earlier):

1. `~/.altimate-code/connections.json` (global)
2. `./.altimate-code/connections.json` (repo-local)
3. **Environment variables** — `ALTIMATE_CODE_CONN_<NAME>` holding a JSON config.
   This is the CI path: store the JSON in a secret and inject it.
4. A dbt `profiles.yml` (the same profile dbt already uses to compile).

The `warehouse:` value in `review.yml` selects which connection by name (the
`<NAME>` suffix, lowercased). Leave it empty to use the default/first connection.

In GitHub Actions, supply the connection from a secret — both sides of the diff
run against the **same** warehouse (base-compiled vs head-compiled SQL):

```yaml
      - uses: AltimateAI/altimate-code/github/review@v0.8.5
        with:
          mode: comment
          manifest_path: target/manifest.json
        env:
          # JSON for a single connection named "prod_ci" (referenced in review.yml).
          ALTIMATE_CODE_CONN_PROD_CI: ${{ secrets.ALTIMATE_DBT_CONNECTION }}
```

`secrets.ALTIMATE_DBT_CONNECTION` is a JSON blob, e.g. for Snowflake:

```json
{"type":"snowflake","account":"ab12345.us-east-1","user":"CI_SVC",
 "password":"…","role":"TRANSFORMER","warehouse":"CI_WH",
 "database":"ANALYTICS","schema":"DBT_CI"}
```

When no connection resolves, the data-diff lane **skips silently** — the review
still runs every other lane. Data-diff never blocks on its own; it surfaces a
`warning` so a human confirms the data impact is intended.

> **Least privilege:** use a read-only CI role scoped to the schemas under review.
> The lane only issues `SELECT`s against the compiled base/head SQL.

## Topology-aware equivalence (merge refactors)

Model-level equivalence compares a model's base vs head 1:1. A **merge refactor**
breaks that assumption: when a PR *deletes* several models and *adds* one that
supersedes them (e.g. `int_x_{base,direct,modified}` → `int_x_daily`), the new
model has no base to compare against, so plain equivalence skips it.

The reviewer detects this shape (≥2 deleted models sharing a name stem with one
added model), composes the **base** compiled SQL of the replaced set as
`UNION ALL`, and asks the engine whether the new model reproduces it. Because the
composition is *inferred* (the replaced models may have been combined differently
downstream), this lane is **advisory only** — it never blocks. It surfaces "this
merge isn't proven equivalent — verify with a data-diff" and stays silent when the
merge is proven equivalent.

## How models are rendered (Jinja → analyzable SQL)

dbt models are Jinja templates, so the SQL engine needs *rendered* SQL. The
reviewer does **not** re-implement Jinja — it consumes dbt's own compiled output
(the same render-then-analyze split dbt-Fusion uses, and what Datafold/Recce do):

1. **Deterministic `dbt-patterns` lane** reads the **raw** model + diff — it needs
   the Jinja (`{{ config(materialized) }}`, `is_incremental()`, `{{ ref }}`) and
   the unified diff to detect structural anti-patterns. This lane needs no
   warehouse and catches the majority of real-world failures.
2. **Engine lanes** (equivalence, grade, lint, PII) consume **dbt-compiled SQL**
   from `target/compiled/<project>/…` (HEAD) and `target-base/compiled/…` (BASE),
   produced by `dbt compile`. To enable full equivalence verdicts, compile both
   the base and head refs in CI (the base into `target-base/`, the Recce
   convention). Without compiled SQL the engine lanes fall back to raw and stay
   *undecidable* (never fabricated) — the `dbt-patterns` lane still runs.

## What it checks — deterministic rule catalog

Every blocking signal is an AST/engine fact in the Rust core, not a regex on text.
The deterministic rules group into four families:

- **SQL anti-pattern lint (AST).** Parsed-SQL rules that a string literal or alias
  can't fool — e.g. outer-join filter in `WHERE` (silently turns a `LEFT JOIN` into
  an inner), NULL-propagating concat, `GREATEST`/`LEAST` over nullables,
  `DISTINCT` + window non-determinism, cast-division integer truncation, clock
  functions in a filter (non-idempotent), cast in a join key, `FULL OUTER`/
  cartesian (`JOIN` without a condition), `NOT IN (… NULL)`, sum-of-a-ratio,
  non-portable dialect functions, integer-multiplication overflow, PK-aware
  join fan-out, timezone-in-hash-key.
- **dbt config / Jinja (`DBT0xx`).** A core **minijinja** parser reads
  `{{ config(...) }}` and the model body: incremental model without an
  `is_incremental()` guard, `merge`/`delete+insert` without a `unique_key`,
  microbatch lookahead without `lookback`, enforced contract without
  `on_table_exists`, `var()` without a default, **hardcoded relation** instead of
  `{{ ref() }}`/`{{ source() }}`, and materialization-change on diff.
- **Structural base-vs-head (`SC0xx`).** An AST comparison of the two model
  versions (no warehouse needed): `SELECT DISTINCT` added/removed, `UNION` ↔
  `UNION ALL`, `GROUP BY` grain shift, surrogate-key column-set change,
  `COALESCE`/`NVL` removed, a `WHERE` filter removed (output broadens), output
  type narrowed.
- **Engine proofs.** Query equivalence, column-lineage / DAG blast radius, PII
  classification, and the A–F grade — the only family that can `REQUEST_CHANGES`.

**Warehouse-dialect coverage.** Equivalence plans both sides through the engine, so a
dialect function the planner doesn't know would make the result *undecidable*. Rather
than enumerate every warehouse function, the engine **auto-stubs any unknown function**
found in the query — scanning the AST and registering a placeholder (classified
scalar vs aggregate by call context) so the plan succeeds across Snowflake / BigQuery /
Redshift / Databricks / Trino / DuckDB / Postgres / MySQL / Oracle / T-SQL / ClickHouse.
On top of that it normalizes dialect-only *syntax* DataFusion rejects: `QUALIFY`
(any dialect) → subquery form so window-filtered dedups decide; date-part keyword args
(`date_diff(d, d, DAY)`, `dateadd(DAY, …)`); raw `r'…'` strings; `SAFE.` prefix; dialect
cast type names; and array `UNNEST(split(…))`. A representative 39-construct battery
across 12 dialects all plan; anything still unrecognized stays *undecidable*, never wrong.

## How it works

1. **Risk-tiering (no LLM).** A deterministic pre-pass classifies the change on
   *data* signals — blast radius, PII/contract/source touch, materialization and
   incremental-logic changes — into `trivial` / `lite` / `full`. Expensive lanes
   only fire when the change warrants them. Any PII, source, contract, snapshot,
   or migration touch is always `full`.
2. **Engine-backed lanes (layer 1).** For each changed model the relevant lanes
   run against the Rust core over the parsed AST: lineage/impact, equivalence on
   before/after SQL, PII via the composite check, SQL grade, and AST
   anti-pattern lint (`altimate_core.check` → `lint.findings`). The catalog's
   regex twins (layer 2) for checks the engine covers are then dropped.
3. **AI reviewer lane (layer 3).** When a model is configured, the LLM reviewer
   runs **after** the deterministic lanes, grounded in their findings, and adds
   advisory contextual comments (intent, naming, business logic, test coverage).
   Findings are clamped to ≤ warning and never block. Skipped (clean degrade) if
   no model is available.
4. **Rubric → verdict.** Findings map to a verdict by a versioned rubric (data,
   not prompt): any blocking-category `critical` → `REQUEST_CHANGES`; ≥3 warnings
   → risk pattern → `REQUEST_CHANGES`; only suggestions → `COMMENT`; nothing →
   `APPROVE`. Only layer-1 findings reach `critical`, so only the engine can
   block. In `comment` mode, `REQUEST_CHANGES` is posted as comments rather than
   blocking.
5. **Signed envelope.** The verdict is HMAC-signed (`ALTIMATE_REVIEW_SIGNING_KEY`)
   and includes the manifest hash, so it is replayable and tamper-evident.

## The safety invariant

Query equivalence is undecidable in general. An **undecidable** equivalence
result is always a `warning` with `confidence: unknown` — **never** a block. The
reviewer never claims a refactor is unsafe when it could not prove it; it asks you
to verify with a data-diff instead. A false "this is safe" is worse than a noisy
warning, so the rubric clamps unknown/low-confidence findings out of `critical`.

## Agent & skill

- Agent: `reviewer` (read-only) — `altimate --agent reviewer`.
- Skill: `/dbt-pr-review` — runs the verdict engine and presents the findings.
- Tool: `dbt_pr_review` — callable from any agent.
