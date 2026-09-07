# Deterministic completion checks: what belongs in the engine

**Status:** assessment, input to a build decision
**Date:** 2026-08-28
**Scope:** the two deterministic checks the plan assigns to the engine rather than to the
validator lane — unguarded division (parse-level) and filter consistency (semantic /
lineage-level). The cheap fs+regex tier lives in
`packages/opencode/src/altimate/validators/` and is out of scope here.

Engine repo inspected read-only at `/Users/anandgupta/codebase/altimate-core-internal`
(Rust workspace, version `0.7.0`).

---

## Bottom line

| Check | Engine capability today | Work required |
|---|---|---|
| Unguarded division | **Already implemented and already wired.** Lint rule `L032` (`division_by_column_no_guard`) is a real sqlparser expression-tree walk, reachable from altimate-code right now via `Dispatcher.call("altimate_core.lint", …)`. | **None engine-side.** Consumer-side only: a validator that feeds it compiled model SQL. |
| Filter consistency | **Partial — the wrong granularity.** The engine ships `extract_source_filters`, a *cross-model* sibling-filter primitive already consumed by the review orchestrator. It reads WHERE clauses only, and cannot see predicates attached to sibling aggregates inside one SELECT. | **One new engine analysis** (~a rule-sized addition, not an architecture change) plus a napi export, a dispatcher entry and a consumer tool. |

Neither check can move into the cheap validator tier: both need a parsed expression tree.
Regex cannot tell `a / b` from `a / nullif(b, 0)` once either side is a function call, a
CASE, or a nested expression, and it certainly cannot group aggregates by the column they
read.

---

## How engine capability reaches altimate-code

Relevant because it sets the cost of "add something engine-side".

- Engine crates: `altimate-core` (analysis), `altimate-core-bindings-common` (shared binding
  layer), `altimate-core-node` (napi-rs), plus `polyglot-sql` for multi-dialect parse and
  transpile.
- Published as the npm package `@altimateai/altimate-core` (per-platform native addon).
  altimate-code pins it exactly: `packages/opencode/package.json` → `"@altimateai/altimate-core": "0.7.0"`.
- Consumer binding: `packages/opencode/src/altimate/native/altimate-core.ts` registers 42
  `altimate_core.*` handlers on the dispatcher. Registration is lazy — the napi binary loads
  on the first `Dispatcher.call()` (`packages/opencode/src/altimate/native/index.ts`), so a
  validator importing `Dispatcher` costs nothing until it actually calls.
- Adding a capability therefore means: engine PR → workspace version bump → publish →
  bump the consumer pin → one `register(...)` block in `altimate-core.ts` → optionally a
  `Tool.define` file under `src/altimate/tools/`. Four repos-worth of steps, one release
  boundary.

---

## Check A — unguarded division

**What the check is.** Flag a division whose denominator is not wrapped in a `NULLIF` or a
`CASE` guard. The failure it catches is a division-by-zero or silent-NULL result in a ratio
column; it recurs in evaluation traces as a wrong-value defect that builds green and passes
schema checks.

**Verdict: the engine already does this. Nothing to build engine-side.**

- Rule: `crates/altimate-core/src/linter/rules/division_by_column_no_guard.rs`, lint code
  `L032`, name `division_by_column_no_guard`.
- Implementation is a genuine AST walk, not a text heuristic: it parses with sqlparser and
  walks `Expr::BinaryOp { op: Divide }` nodes through CTE bodies, set-op branches, function
  arguments and nested expressions (`find_division_by_column_in_set_expr`, and the shared
  walkers in `crates/altimate-core/src/linter/rules/mod.rs`).
- The guard semantics fall out of the tree shape: it fires only when the denominator is a
  bare `Expr::Identifier` / `Expr::CompoundIdentifier`. A denominator wrapped in
  `NULLIF(...)` parses as `Expr::Function` and one wrapped in `CASE` as `Expr::Case`, so
  guarded divisions are excluded structurally rather than by pattern-matching the guard.
- `fn check(&self, sql: &str, _schema: &SchemaDefinition)` ignores the schema, so the rule
  needs no table/column resolution to be accurate.

**How altimate-code would call it.**

```ts
import { Dispatcher } from "../native"

const result = await Dispatcher.call("altimate_core.lint", { sql, schema_path: "" })
const findings = (result.data?.findings ?? []).filter((f: any) => f.rule === "L032")
```

`altimate_core.lint` is registered at `packages/opencode/src/altimate/native/altimate-core.ts`
(handler 2), calling `core.lint(sql, schema)` in `crates/altimate-core-node/src/safety.rs`.
`schemaOrEmpty()` in the same file means an empty schema is a supported argument. The
composite `altimate_core.check` handler folds the same lint output into `data.lint.findings`
and is already exposed to the agent through
`packages/opencode/src/altimate/tools/altimate-core-check.ts`, which shows the finding shape
(`f.rule`) end to end.

**The one real consumer-side problem: Jinja.** The engine parses SQL, and a dbt model source
is not SQL — `{{ ref() }}`, `{% if %}` and `{{ config() }}` will not parse. A validator must
feed it the **compiled** SQL from `<target>/compiled/<project>/models/**.sql`, which exists
only after a successful compile or build. That makes the division lint naturally sequenced
*after* the build-green gate: no fresh compiled artifact, nothing to lint, skip. The
existing `resolveDbtTargetPath()` in
`packages/opencode/src/altimate/validators/validator-utils.ts` already resolves the artifact
directory including a custom `target-path`.

**Recommendation.** Build it as a validator in the existing lane, consuming
`altimate_core.lint` and filtering to `L032`, scoped to session-touched models and their
compiled counterparts. No engine work, no version bump. The cost is the compiled-SQL
plumbing, not the analysis.

---

## Check B — filter consistency

**What the check is.** Detect an exclusion predicate applied on one aggregate path but
omitted on a sibling aggregate over the same source — e.g. two `SUM(CASE WHEN … END)`
measures in one SELECT where one carries an extra exclusion the other lacks. This is the
most-evidenced wrong-logic family: the model builds, the shape is right, the numbers are
quietly inconsistent between columns.

**Verdict: the engine has the building blocks and a close cousin, but not this check.**

What exists:

- `crates/altimate-core/src/review/grain.rs` → `extract_source_filters(sql) -> BTreeMap<String, Vec<String>>`.
  Returns, per upstream table, the filter columns applied to it. Exported over napi in
  `crates/altimate-core-node/src/review.rs` and registered as the dispatcher key
  `altimate_core.source_filters` (`altimate-core.ts`, "Per-upstream WHERE-filter columns,
  for cross-model sibling filter-consistency").
- It is already consumed: `siblingConsistencyLane` in
  `packages/opencode/src/altimate/review/orchestrate.ts` compares those filter sets **across
  different models reading the same upstream** in a diff, and flags a model missing a filter
  its siblings apply. The doc comment on the Rust function cites the real incident that
  motivated it (one of three sibling loaders missing a NULL filter).
- `crates/altimate-core/src/filter_analysis/` analyses WHERE-clause quality within a single
  query (contradictory, redundant, missing-partition predicates) via logical plans.
- `crates/altimate-core/src/lineage/complete.rs` carries, per output column, a
  `lens_code: Vec<LensStep>` — the SQL text of each transformation step — alongside
  `transform_type` / `lineage_type` labels. Exposed via `column_lineage` in
  `crates/altimate-core-node/src/lineage.rs` (dispatcher key `altimate_core.column_lineage`).

Why none of it is the check:

- `extract_source_filters` walks `sel.selection` — the WHERE clause — and attributes filter
  *columns* to upstream tables. It never looks inside projection expressions, so a
  `CASE WHEN status = 'x' AND NOT is_test THEN amount END` inside a `SUM()` is invisible to
  it. Its comparison unit is a model, not a column.
- `filter_analysis` reasons about one predicate set at a time; there is no cross-aggregate
  comparison anywhere in it.
- The lineage `lens_code` does carry the aggregate's expression *text* per target column,
  which is tantalising but not sufficient: it is unparsed text with a coarse transform
  label, so any comparison built on it would be string diffing — exactly the fuzzy matching
  a deterministic gate must not do. Two logically identical predicates written differently
  would read as inconsistent, and a genuinely asymmetric one written similarly could slip
  through.

**What would need to be added engine-side.** One new analysis pass, following the shape of
the existing rules:

1. Walk the SELECT projection, collecting aggregate calls (`SUM`, `COUNT`, `AVG`, …) whose
   argument is a `CASE` expression. The helpers already exist next door in
   `crates/altimate-core/src/linter/rules/mod.rs` and `review/grain.rs` (aggregate
   detection, bare/qualified column extraction).
2. For each, extract the CASE `WHEN` condition set as parsed predicates, plus the base
   column being aggregated.
3. Group the aggregates by base column (and by upstream relation, reusing the attribution
   `walk_query_filters` already performs).
4. Diff the predicate sets within a group and emit a finding for an asymmetric exclusion,
   normalising predicates structurally rather than textually so that reordered or
   differently-spelled equivalents do not produce noise.

Then, one of two wiring paths — they are not the same amount of work:

- **As a lint rule (cheaper, preferred).** Add the code in `safety.rs::lint` and consume
  the existing `altimate_core.lint` handler. No napi export and no dispatcher key are
  needed: `altimate-core.ts` already exposes lint results end to end, to the agent and to
  `altimate_core.check`.
- **As a bespoke analysis API.** Only this path needs a new napi export in
  `crates/altimate-core-node/src/review.rs` plus a dispatcher entry in `altimate-core.ts`.
  Choose it only if the finding needs a richer result shape than a lint code carries.

Either way, a validator consumes the result.

**Why this cannot live in the validator lane.** Step 1 needs the projection's expression
tree; step 2 needs parsed boolean predicates; step 3 needs column attribution through CTEs
and aliases; step 4 needs structural predicate comparison. Every one of those is SQL
analysis. A regex approximation would fire on formatting differences and miss the real
asymmetries, which is the worst outcome for a gate that blocks completion — a lane that
cries wolf gets its retry budget burned and then disabled.

**Sizing.** Rule-sized, not architecture-sized: it reuses existing sqlparser walkers, has a
direct precedent in `extract_source_filters`, and needs no change to lineage or to the
binding architecture. The dominant cost is predicate normalisation (step 4), which is where
the false-positive risk concentrates and where the test corpus has to be built.

---

## Decision inputs

1. **Unguarded division is free.** It is a consumer-side validator over
   `altimate_core.lint` + compiled SQL. Do it in the lane; no engine ticket, no version bump.
2. **Filter consistency is the only item here that needs an engine ticket**, and it is worth
   scoping as a lint rule (code alongside `L032`) rather than a bespoke review API, because
   the lint path is already wired end to end — engine rule → `lint` → dispatcher →
   `altimate_core.check` → agent and validators. That collapses the wiring work to the rule
   itself.
3. **Sequencing.** Both checks depend on compiled SQL, so both sit behind the build-green
   gate in the completion lane. Neither is worth building before that gate demonstrably
   fires on real sessions.

---

## Placement of the shipped completion-gate validators

**Status:** assessment, addendum to the above
**Date:** 2026-08-28
**Scope:** the five completion-gate validators actually shipped in
`packages/opencode/src/altimate/validators/`: `dbt-nothing-built`, `dbt-build-green`,
`dbt-deliverable-names`, `dbt-incremental-config`, `dbt-dialect-guard`. Question: does any
of this — or its logic — belong in `altimate-core-internal` instead of `altimate-code`, so
other engine consumers (the dbt PR reviewer, CI tooling, other products) can reuse it?

### Per-validator table

| Validator | What it analyzes | Reuse value for other engine consumers | Engine-feasible (does the engine see the inputs)? | Recommendation |
|---|---|---|---|---|
| `dbt-nothing-built` | Filesystem: any authored file under `models/seeds/snapshots/data/analyses/macros/tests` since session start, `run_results.json` freshness. Plus a markdown/regex scan of a task-instruction file for literal required deliverables. | None. The check *is* "did this session's filesystem change since a wall-clock timestamp" — meaningless outside a live agent session. | No. The engine's API is SQL-in/findings-out; it has no concept of session start time, a live project directory to `stat`, or a task-instruction document. | **Stays in altimate-code.** Not a SQL question at any point. |
| `dbt-build-green` | Filesystem: `<target>/run_results.json` parsed, cross-referenced against edited-model mtimes for coverage/staleness/failure status. | None. Same category as above — needs a live build artifact plus session-scoped mtime comparisons. | No. Same as above; also no dbt subprocess invocation happens in-engine. | **Stays in altimate-code.** |
| `dbt-deliverable-names` | Filesystem inventory (`models/seeds/snapshots/data/analyses`) + `manifest.json` node names/aliases, diffed against literal deliverable names extracted from a task document via markdown/regex parsing. | None directly — this is a naming-contract check against a task doc, not a SQL property. | No. Requires a live project directory and a task-instruction file; the engine never sees either. | **Stays in altimate-code.** |
| `dbt-incremental-config` | Two of its three findings are dbt **config** semantics — `incremental_strategy`/`unique_key` presence, `is_incremental()` guard presence — read via regex over `{{ config(...) }}` args and grep over the model body. The third is a regex scan for non-deterministic functions (`current_timestamp`, `random()`, …) inside the `is_incremental()` predicate block. | **High, and already realized elsewhere.** `crates/altimate-core/src/review/dbt_config.rs::dbt_config_lint` implements the *same two* checks — `DBT001` (`incremental_no_guard`) and `DBT002` (`incremental_no_unique_key`) — as a real minijinja-based structural config parser, not regex. It is already wired dispatcher-side as `altimate_core.dbt_config_lint` and is **already consumed** by the dbt-PR-reviewer (`packages/opencode/src/altimate/review/runner.ts:338`). | Yes for findings 1 & 2 — the engine already does this, on raw (uncompiled) model SQL, no compiled-artifact dependency. Finding 3 (non-determinism *specifically inside* the `is_incremental()` predicate) has no engine equivalent yet; the closest existing rule, `L049 clock_in_filter`, catches clock functions in any WHERE/JOIN/HAVING predicate but doesn't scope to the incremental guard block specifically. | **Rewire, don't reimplement.** Findings 1 & 2 should call `altimate_core.dbt_config_lint` and filter to `DBT001`/`DBT002` instead of carrying a parallel regex implementation — the validator's own comment tier ("grep-level … config declared in `dbt_project.yml` is intentionally not resolved") describes exactly the ceiling the engine's minijinja parser already clears. The idempotency-gating policy (only escalate the missing-guard finding to a blocker when the task doc says "idempotent") is genuinely consumer-side — it depends on a task-instruction file the engine doesn't see — and stays in the validator as a thin policy layer over the engine's finding. **Worth an engine follow-up ticket:** add a `DBT007`-style rule to the same `dbt_config.rs` file for "non-deterministic function inside an `is_incremental()` predicate" — the parsing/masking infrastructure (`mask_comments_and_strings`, predicate-block extraction) already exists in that file, so it's a small addition, not new architecture. |
| `dbt-dialect-guard` | Raw (uncompiled) model text: (a) does the project already establish a `target.type`-guard convention (fs scan for the string across `models/`+`macros/`); (b) a curated 19-entry list of warehouse-specific function names, regex-matched; (c) whether each match sits inside a `{% if …target.type… %}…{% endif %}` block, detected by blanking out guarded regions before matching. | Partial, and one-directional. The engine's `L033 non_portable_function` rule is a genuine sqlparser AST walk with a much larger curated function set (the excerpt alone showed 50+ names vs. the validator's 19) — the validator is duplicating a *subset* of engine data with a worse matcher. But L033 cannot do what this validator does: it requires parseable SQL, and compiling a dbt model resolves away whichever `{% if target.type %}` branch wasn't taken — the information "was this guarded" is gone by the time SQL reaches the engine's parser. | No, for the guard-detection half — that is a category error: the engine's SQL-in/findings-out contract has nothing to say about un-rendered Jinja branches, because by the time it sees valid SQL the branch has already been chosen. Yes, in principle, for the *function-name curation* half, which is pure data the engine already owns more completely. | **Hybrid, but the "hybrid" is data-sharing, not logic-splitting.** The guard-detection orchestration must stay in altimate-code (it needs live, un-rendered Jinja source — a live-project concern by definition). The curated dialect-function list should stop being hand-maintained twice: either export `non_portable_function_set()` (or a subset annotated with source dialect) via a small napi accessor so the validator sources its match list from the engine, or accept the current duplication and add a periodic reconciliation check. This is a maintenance/consistency follow-up, not an engine ticket for new analysis logic. |

### Overall recommendation — does this need to go into the engine?

**No, not as a wholesale move.** Three of the five validators (`dbt-nothing-built`,
`dbt-build-green`, `dbt-deliverable-names`) never touch SQL semantics at all — they reason
about filesystem state, build artifacts (`run_results.json`, `manifest.json`), and a task
document's prose. None of that is representable in the engine's SQL-in/findings-out
dispatcher contract, and none of it has any value to another engine consumer (the dbt PR
reviewer doesn't care whether *this* session's clock wrote a file). Pushing them
engine-side would be the same category error the prior assessment already named for
division-guard and filter-consistency, just in the other direction: these validators need a
live project directory and session-scoped timestamps, and the engine's API surface is
SQL text in, findings out. There's nothing to move.

The one real finding here is `dbt-incremental-config`, and it isn't "should this move to
the engine" — **it already lives there.** `dbt_config_lint` (`DBT001`/`DBT002`) is shipped,
wired through the dispatcher, and already consumed by the dbt-PR-reviewer's `runner.ts`.
The validator built a second, weaker (regex-only) implementation of the same two checks
instead of calling the existing one. The fix is a rewire of the validator's detection
layer onto `altimate_core.dbt_config_lint`, keeping only the task-doc-driven idempotency
policy consumer-side (exactly the hybrid pattern the division-guard case established:
engine finds it, consumer decides when it's blocking). One small engine follow-up is worth
filing — a `DBT007` rule for non-determinism scoped to the `is_incremental()` predicate,
reusing infrastructure already in `dbt_config.rs` — but it's rule-sized, not a new
capability.

`dbt-dialect-guard` is the only genuinely mixed case, and even there the "engine work" is
data reconciliation (share `L033`'s function-name set) rather than new analysis: the guard
-detection logic itself has no engine home because it depends on un-rendered Jinja
branches, which the engine's compiled-SQL contract structurally cannot see.
