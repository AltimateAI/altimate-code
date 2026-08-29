# Completion-gate validators — deferred review findings

Findings from the review of the deterministic completion-gate validators that are
real but larger than the change they were raised against, plus the ones that were
declined on purpose. Each carries the rationale, so a later pass does not have to
re-derive it.

Source: review feedback and the end-to-end evidence run on
`feat/deterministic-validators` (2026-08-29).

---

## Deferred — real, but larger than a fix-in-place

### 1. Custom `model-paths` / `seed-paths` are not honoured

`modelsModifiedSince` requires a `models` path segment, and both
`collectProducedNodeNames` and the authored-file scan use a hard-coded directory
list. A project that configures `model-paths: ['analytics']` in `dbt_project.yml`
is invisible to every path-based check in the lane.

Direction is safe today — the validators under-fire rather than over-fire on such
a project — but the deliverable-names gate can report a name as absent when the
model exists under a custom path, which would block.

Why deferred: the fix is a shared `resolveDbtSourcePaths(dbtRoot)` that parses the
project file and threads its result through five call sites in four files, with
its own YAML-shape edge cases (list vs scalar, per-package overrides). That is a
change with its own test surface, not a line edit.

### 2. Python models (`.py`) are outside the touched-model set

`modelsModifiedSince` accepts `.sql` only, so a session that edits
`models/orders.py` produces an empty work list and `dbt-build-green` takes its
`nothing-to-gate` path.

Why deferred: widening the extension is one line, but the consumers are not
extension-agnostic. `dbt-dialect-guard` and `dbt-incremental-config` would then
run SQL/Jinja regexes over Python source, where `#` is a comment and
`config(materialized=...)` is a `dbt.config()` call — different lexical rules
entirely. The correct shape is a per-consumer file-kind filter, which is a
refactor of the discovery API rather than an added extension.

### 3. `run_results.json` is trusted as evidence an agent cannot forge

Nothing stops a session writing a `run_results.json` full of `success` rows
instead of running dbt. Every filesystem-evidence gate in this lane shares that
property.

Why deferred: closing it means recording dbt invocations from the tool layer and
signing them into the session record — a lane-wide trust model, not a validator
change. Partly mitigated already: build coverage now also reads the model DDL
under `<target>/run/`, so a forgery has to fabricate two artifacts rather than
one.

### 4. Post-build edit detection is mtime-based, not content-based

`BUILD_FRESHNESS_TOLERANCE_MS` was raised to 60 s because a formatter or a
trailing-newline fix landing seconds after a green build was blocking sessions.
That trades a false positive for a blind spot: a substantive rewrite inside the
window is not caught.

The right fix is a content comparison — hash each model at build time and compare
after — which needs a pre-build snapshot the gate does not currently take. Worth
doing when the lane gains a session-scoped artifact store.

### 5. ~~Compound `{% if is_incremental() and … %}` conditions are not matched~~ — RESOLVED

Closed in the review sweep. Guard-body extraction was rebuilt on the shared
nesting-aware helper (`extractJinjaIfBlocks` + `jinjaIfBranchHead`) rather than on
a looser regex, which is what this entry said the fix had to wait for. Compound
conditions and nested `{% if %}` / `{% else %}` inside a guard are now handled.
Covered by `review-sweep.test.ts`.

### 6. `analyses/` counts toward the produced-node inventory

An `analyses/foo.sql` satisfies a required model named `foo`, even though an
analysis is never materialised as a relation. The requested resource *type* is
also discarded during extraction, so a seed can satisfy a request for a model.

Why deferred: the honest fix is to carry the noun from the task through to the
comparison (required *model* vs required *seed*), which changes the
`RequiredDeliverables` shape and the gate's messages. Simply dropping `analyses`
from the inventory would make the gate block more often on a correct project,
which is the wrong direction to move without the type information.

### 7. Five copies of the recursive project walker

`modelsModifiedSince`, `collectProducedNodeNames`, `collectExecutedModelNames`,
`anyAuthoredFileSince` and `projectPrescribesGuards` each carry their own
recurse / skip-hidden / skip-`node_modules` / symlink / depth-cap loop. They have
already drifted (only two follow symlinks; only some skip `target`).

Why deferred: a shared `walkProject(root, opts)` is a clean refactor but touches
every validator in the lane at once, and doing it in the same change as the
behavioural fixes would make both harder to review. Worth its own change.

---

## Declined — the conservative behaviour is the intended one

### `IDENTIFIER_RE` requires at least three characters

Reviewers asked for identifiers of any length so a task requiring `id` is
honoured. Declined: two-character code spans in prose are overwhelmingly not
relation names, and every one that is wrongly accepted becomes a required model
that can never be satisfied. Under-extraction is a miss; over-extraction blocks a
correct session.

### `hasGuard` accepts any `is_incremental()` occurrence

Reviewers asked that it require an enclosing `{% if %}`. Declined: a model that
writes `{% set inc = is_incremental() %}{% if inc %}` is correct dbt, and
tightening this creates a new false positive to close a false negative. The
lenient direction is the safe one for a gate that blocks completion.

### A fresh test-only artifact should hard-fail rather than skip coverage

Reviewers asked that an artifact containing no model nodes block an edited model.
Declined as stated: `dbt build` followed by `dbt test` is a normal, correct
sequence and leaves exactly that artifact, so blocking on it fires on healthy
sessions. Addressed instead by reading the model DDL under `<target>/run/`, which
a test invocation does not overwrite, and by recording
`verdict: "coverage-inconclusive"` when neither source can speak — so the case is
visible in telemetry rather than silently green.

### Backslash string escapes in the SQL lexer

A reviewer asked that `scrubSql` stop treating `\'` as an escaped quote, on the
grounds that none of the target warehouses use backslash as a string-escape
character. Declined: the premise is wrong. Snowflake, BigQuery and Redshift all
support backslash escape sequences in string literals; only DuckDB is
strictly `''`-only. Dropping the branch would mis-lex `'it\'s'` on three of the
four warehouses this lane targets, which is the more common shape than the
literal-trailing-backslash case the reviewer raised.

### `unique_key` inherited from `dbt_project.yml`

Full dbt config inheritance is not resolved. Rather than guess, the keyless-upsert
finding is suppressed for the whole project when `dbt_project.yml` mentions
`unique_key` at all. Deliberately blunt: it gives up a true positive in exchange
for never inventing an inconsistency that the merged config does not have.

---

## Deferred — raised in the review sweep, still open

### 8. `<target>/run/` DDL proves execution, not success

Build coverage falls back to the model DDL under `<target>/run/` when
`run_results.json` has been overwritten by a later `dbt test`. dbt writes that
DDL *before* the warehouse executes the statement, so it is present for a model
that then failed. A session that runs `dbt build` (a model errors), then
`dbt test`, leaves a failed model with fresh DDL and no failing row in the
surviving artifact, and the gate reports green.

Why deferred: the obvious narrowing — trust the DDL only when the fresh artifact
carries no model rows at all — breaks the very common `dbt run --select a` then
`dbt run --select b` session, where `a` is covered by DDL alone and the artifact
does carry model rows. That would block healthy sessions, which is the wrong
direction. The real fix is retaining per-invocation run-result history for the
session rather than reading whichever single artifact survived, which is the same
session-scoped artifact store that item 4 needs.

Partially mitigated in the sweep: staleness is now measured against the DDL's own
mtime rather than the surviving artifact's, so an edit made between the build and
a later test is caught.

### 9. Build coverage is keyed on the bare node name, not the package

In a multi-package project where a dependency and the root project both define
`orders`, a successful `model.dependency.orders` row satisfies coverage for the
local `model.local.orders`.

Why deferred: matching on the full unique ID means mapping each touched file to
its manifest node via `original_file_path`, which is a new manifest-backed
resolution step rather than a line edit. Much narrower after the sweep: installed
packages are now excluded from the touched-model set, so this needs a genuine
name collision between the root project and a dependency, both selected in the
same session.

### 10. The dialect guard checks for a guard, not for the *right* guard

`dbt-dialect-guard` suppresses a warehouse-specific call when it sits anywhere
inside a `{% if … target.type … %}` chain. It does not check that the branch the
call sits in is actually limited to a warehouse that provides the function, so
both of these pass while still breaking on at least one target:

```jinja
{% if target.type != 'snowflake' %} {{ iff(a, b, c) }} {% endif %}
{% if target.type == 'snowflake' %} … {% else %} safe_cast(x as int) {% endif %}
```

Why deferred: closing it needs a mapping from each `DIALECT_FUNCTIONS` entry to
the `target.type` values that provide it, plus evaluation of each branch
condition against that set — `==`, `!=`, `in`, `not in`, and the implicit
complement an `{% else %}` arm carries. That is a feature with its own test
surface, and a half-implementation converts a false negative into a blocking
false positive on correct models. The validator's docstring states the weaker
property it actually checks, so the claim is not overstated in the meantime.
