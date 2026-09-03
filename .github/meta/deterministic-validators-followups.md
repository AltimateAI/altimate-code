# Completion-gate validators — deferred review findings

Findings from the review of the deterministic completion-gate validators that are
real but larger than the change they were raised against, plus the ones that were
declined on purpose. Each carries the rationale, so a later pass does not have to
re-derive it.

Source: review feedback and the end-to-end evidence run on
`feat/deterministic-validators` (2026-08-29).

---

## Deferred — real, but larger than a fix-in-place

### 1. ~~Custom `model-paths` / `seed-paths` are not honoured~~ — RESOLVED

`modelsModifiedSince` requires a `models` path segment, and both
`collectProducedNodeNames` and the authored-file scan use a hard-coded directory
list. A project that configures `model-paths: ['analytics']` in `dbt_project.yml`
is invisible to every path-based check in the lane.

Direction is safe today — the validators under-fire rather than over-fire on such
a project — but the deliverable-names gate can report a name as absent when the
model exists under a custom path, which would block.

Closed in the consensus pass. `resolveDbtSourcePaths(dbtRoot)` parses
`model-paths`, `seed-paths`, `snapshot-paths`, `analysis-paths`, `macro-paths`,
`test-paths` and `packages-install-path` (plus the pre-1.0 `source-paths` /
`data-paths` spellings), handling inline flow lists, block sequences and bare
scalars. `modelsModifiedSince`, `collectProducedNodeNames` and the authored-file
scan are all driven off it.

One deliberate carve-out: when the scanned directory has no `dbt_project.yml`
there is nothing to honour, so `modelsModifiedSince` keeps its legacy "any
`models` ancestor" predicate. That keeps the helper usable on a directory that
is not itself a project root.

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

### 6. ~~`analyses/` counts toward the produced-node inventory~~ — PARTLY RESOLVED

An `analyses/foo.sql` satisfies a required model named `foo`, even though an
analysis is never materialised as a relation. The requested resource *type* is
also discarded during extraction, so a seed can satisfy a request for a model.

Half closed in the consensus pass. `analyses/` and `tests/` no longer contribute
to the inventory from either source: the filesystem scan visits only the
configured model/seed/snapshot paths, and manifest nodes are filtered on
`resource_type`. An analysis is compiled but never materialised, so it was never
a relation that could satisfy a deliverable.

Still open: the requested resource *type* is discarded during extraction, so a
seed can still satisfy a request for a model and vice versa. That needs the noun
carried from the task through to the comparison, changing the
`RequiredDeliverables` shape and the gate's messages.

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

Further mitigated in the consensus pass, and the reasoning above is confirmed
against real dbt 1.8.7: a `dbt build` that errors on a model still leaves that
model's DDL in `<target>/run/`, and a following `dbt test` writes
`run_results.json` with `args.which: "test"` and zero rows. The two evidence
sources are then indistinguishable from a healthy `dbt run` + `dbt test`, so
this still cannot be made to block without firing on correct sessions.

What did change is the label. Coverage resting on DDL alone now reports
`verdict: "build-unproven"` instead of `fresh-build`. That matters more than it
sounds: the confident verdict was contaminating the shadow telemetry the enable
decision is supposed to rest on, so red builds were being counted as green in
the measurement itself. The gate's pass/fail behaviour is unchanged.

Closing it properly still needs per-invocation run-result history for the
session — the same session-scoped artifact store item 4 needs. Note the harness
makes this worse on its own: `dbt-tests-pass` spawns `altimate-dbt test` in the
project on every validation pass, so from the second pass onward the surviving
artifact is always a test artifact.

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

---

## Consensus review (six reviewers, 2026-08-29) — closed in this pass

Recorded here so a later pass does not re-derive them. Each has a regression
test in `test/altimate/validators/consensus-review.test.ts`.

- **`dbt compile` artifacts certified builds.** `run_results.json` carries no
  statement of which subcommand wrote it, and `dbt compile` emits a full set of
  `status: "success"` model rows — verified against real dbt 1.8.7, including
  for a model selecting from a non-existent relation. `readRunResults` now reads
  `args.which`, and an artifact from a command that executes no model SQL is not
  build evidence. An artifact with no `args.which` is still trusted, so the
  change is backwards compatible; real dbt always stamps it.
- **`CONFIG_CALL_RE` truncated at the first `)`.** `pre_hook="{{ log_start(run_id) }}"`
  ended the non-greedy capture early and silently dropped every argument after
  it — reading a correctly-keyed merge model as an unkeyed upsert, and losing
  `enabled=false` / `materialized='ephemeral'` exemptions. Replaced with a
  paren-depth and quote aware scanner.
- **`dbt-nothing-built` passed on any unrelated edit.** It asked only whether
  *anything* had been written under the project, never comparing against
  `expectation.required`. A session told to create `fct_orders` cleared it by
  touching `macros/helper.sql`. Evidence must now intersect the named
  deliverables; the coarse bar is kept only for the opt-in with no named
  deliverables.
- **`packages-install-path` was ignored.** The `dbt_packages` / `dbt_modules`
  skip was matched on the bare directory name, so a project configuring the
  install path sent dependency models through the two *pre-existing* subprocess
  validators, and a locally authored directory of that name anywhere in the tree
  was wrongly skipped. Now resolved from project config and matched on path.
- **Inactive Jinja exempted live models.** `{% if false %}{{ config(enabled=false) }}`
  and the same inside `{% raw %}` read as real exemptions. Both regions are
  blanked before config extraction. Limited to these two on purpose — a looser
  condition would strip live config and push the gate towards blocking.
- **`insert_overwrite` / `microbatch` were told to add a guard.** Both converge
  on re-run by construction, and the prescribed remediation would have changed
  what the model does. Now exempt from the guard requirement.
- **`is_incremental()` inside a string literal counted as a guard.** The scan
  tested the unmasked source while the file's own comment said otherwise.
- **`[^%]*` in `ownBranchMatches` / `jinjaIfBranchHead`.** A Jinja modulo in a
  tag (`{% if loop.index % 2 == 0 %}`) stopped the match dead and lost an arm
  from the depth counter. Aligned with `JINJA_IF_OPENER_SOURCE`.
- **Repository text was spliced into the retry prompt.** dbt error messages and
  node names were interpolated verbatim into `reason`/`fixHint`, which dispatch
  concatenates into a synthetic `role: "user"` turn — so a hostile repo could
  place text at instruction position. All untrusted values now go through
  `sanitizeForPrompt`.
- **Verdicts that hid a zero-verification pass.** An empty scope and an
  exempt-only scope both reported `fresh-build`. Now `nothing-verified` and
  `exempt-only`; DDL-only coverage is `build-unproven`; an edit inside the 60 s
  grace window is reported in `edited_within_grace` and downgrades the verdict.
- **Unreadable models read as clean.** `dbt-dialect-guard` and
  `dbt-incremental-config` now report `models_scanned`, `unreadable_models` and
  `coverage_complete` rather than counting an unreadable file as verified.
- **`prompt.ts` claimed shadow mode spawns no subprocesses.** It does. Shadow
  suppresses only the retry; every validator runs in full. Comment corrected —
  the false claim was load-bearing for "enable in shadow first" advice.

## Consensus review — open, NOT addressed in this pass

Ordered by how much they should weigh on an enable decision.

### 11. Node identity is a bare lowercase name, not a `unique_id`

Supersedes and widens item 9. Run-result IDs and `<target>/run/` paths are both
reduced to a bare name, discarding package *and* resource type, so
`model.dependency.orders` can satisfy coverage for a local `orders`, and a
snapshot's DDL can stand in for a model's. The honest fix is to resolve each
touched file to its manifest `unique_id` via `original_file_path` and match on
that — a manifest-backed resolution step the lane does not have yet. This is the
single largest remaining source of fabricated coverage.

### 12. Effective dbt config is never resolved

`dbt-incremental-config` only sees inline `config()`. A model made incremental
through `dbt_project.yml` or properties YAML is invisible, while any textual
`unique_key:` anywhere in `dbt_project.yml` suppresses the keyless-upsert
finding for every model in the project. dbt supports `unique_key` in SQL,
properties YAML and project config. Needs the effective config for the exact
node from a fresh manifest.

### 13. `dbt-deliverable-names` mines natural language for a blocking contract

Assessed by two reviewers as the validator most likely to block correct work.
Code-formatted column names in a Required/Deliverables section become required
models; rename wording can demand both names; negated bullets can demand the
prohibited artifact; `create a model with name fct_orders` is not recognised.
Both contract gates also stop at the first task document that parses any
contract, silently masking a later `REQUIREMENTS.md`. The direction of travel is
an explicit structured contract rather than prose mining, with ambiguous prose
yielding inconclusive instead of a blocking invented requirement.

### 14. Dialect guard does not check which target owns the function

Restates item 10, still open, now with a second failure mode: the scrubber does
not handle dollar-quoted strings, so valid text such as `$tag$… iff( …$tag$`
produces a blocking finding.

### 15. Python models are still outside the touched set

Item 2, unchanged. Now paired with the `model-paths` fix: discovery honours
custom paths but still accepts `.sql` only, so a `models/orders.py` session takes
the `nothing-to-gate` path. Needs a per-consumer file-kind filter, because the
SQL/Jinja regexes are wrong for Python source.

### 16. Validator telemetry has no field allowlist

`details` is attached to telemetry wholesale and includes absolute `dbt_root`,
`task_file` and `run_results_path` plus business model names, against a
telemetry contract that says file paths are not collected. Pre-existing for
`dbt_root`; this lane widens it. Wants an allowlist of bounded counters,
booleans, enum verdicts and durations, with paths dropped or hashed.

### 17. No whole-check resource budget

Recursive scanners follow directory symlinks without realpath containment or
cycle detection, several Jinja helpers are near-quadratic on pathological input,
and no deadline is passed through the registry. The 60 s timeout covers
`altimate-dbt` children only, not the in-process checks.

### 18. Retry budget is shared, and the ceiling is wall-clock, not just waste

`validatorRetryCount` is one session-scoped counter capped at 3, and the five
new validators register *before* `dbt-schema-verify` / `dbt-tests-pass`. See the
PR discussion for the analysis; not changed here because the counter lives in
`session/prompt.ts`, which this PR otherwise does not touch. The associated
number worth carrying: the two subprocess validators run one `altimate-dbt`
child per touched model at concurrency 4 with a 60 s per-child timeout, across
an initial dispatch plus up to three retries — roughly `480 × ceil(M/4)` seconds
worst case, about 3 h 20 m at 100 touched models.

---

## Second review sweep (2026-08-31) — closed in this pass

Each has a regression test in `test/altimate/validators/review-sweep-2.test.ts`
that fails against the pre-fix source.

- **Seed and snapshot builds read as "nothing built".** Narrowing
  `MODEL_EXECUTING_DBT_COMMANDS` to `{run, build}` was right for
  `dbt-build-green` — a `dbt seed` says nothing about whether an edited model
  compiles — but `dbt-nothing-built` reused the same predicate to answer a
  different question. A successful `dbt seed` of exactly the required name then
  read as no build at all, and the gate blocked a session that had delivered
  what it was asked for. Split into `runResultsProducedNodes`. The two must not
  be collapsed again: model *coverage* and *deliverable* evidence are different
  claims.
- **`data/` was a default seed path.** dbt's default is `seeds/` alone;
  `data-paths` is only the pre-1.0 spelling. Listing `data/` unconditionally
  made `data/orders.csv` read as a produced, authored node in a project where
  dbt will never load it, so both contract gates could accept a required
  `orders` deliverable with nothing built. The legacy key is still honoured when
  the project actually sets it.
- **A contradictory source config granted an exemption.** A model whose live
  config states both `enabled=false` and `enabled=true` satisfied
  `sourceExemptsFromRunResults`, which drops it out of scope entirely — so even
  a fresh `error` row for it was filed as out-of-scope and the build gate
  reported green having checked nothing. Each axis now requires that the source
  does not also declare its opposite.
- **The dead-`if` strip blanked live `else` arms.** `stripInactiveJinja` blanked
  a `{% if false %}` chain through its `{% endif %}`, taking real `config()` in
  the `{% elif %}` / `{% else %}` arms with it — an ephemeral or disabled model
  lost its exemption and the build gate demanded a `run_results` row dbt never
  writes. Only the constant-false arm is blanked now, depth-counted so a nested
  `if` inside it cannot steal the outer `else`.
- **The dialect-guard convention probe still carried `[^%]*`.** The modulo fix
  applied to `ownBranchMatches` and `JINJA_IF_OPENER_SOURCE` never reached
  `TARGET_TYPE_GUARD_PROBE_RE`, so `{% if n % 2 == 0 and target.type == … %}`
  left the project's only guard unrecognised, `appliesTo` returned false, and
  the validator silently switched itself off for the whole session.
- **The convention probe scanned hard-coded `models/` and `macros/`.** A project
  on `model-paths: ['transform']` or `macro-paths: ['jinja']` found no
  convention and disabled the lint, even though the touched-model scan already
  honours custom paths. Driven off `resolveDbtSourcePaths` now, matching it.
- **The incremental predicate started at a subquery's `where`.** A clause
  keyword anywhere in the arm outranked a leading `and`/`or`, so
  `and ts > … (select max(ts) from {{ this }} where ok)` sliced from the *inner*
  `where` and never examined the outer high-water-mark comparison. A guard body
  that opens with a conjunction is now taken whole; the clause tier still
  applies to arms that merely project a boolean, which is what motivated it.
- **`{% if not is_incremental() %}` was read as the incremental arm.** A clock in
  that full-refresh branch was reported as blocking non-determinism on a correct
  model. Negated arms are now skipped — see the still-open item below for why
  they are not swapped for their complement.
- **Project-level YAML keys were matched at any indentation.** `target-path` and
  every key `readDbtProjectPathList` reads also matched a same-named key nested
  under `vars:`, sending the artifact search and every path-based scan at a
  directory the project never configured — which blocks a genuinely green build.
  Both are anchored at column 0 now.
- **A workspace-level required file failed the inverse gate.** With the dbt
  project nested below the workspace, `dbt-deliverable-names` resolved
  `reports/output.yml` from either root and `dbt-nothing-built` checked only
  below `dbtRoot`, so a correct session passed one contract gate and was blocked
  forever by the other. Both check both roots now.
- **Build staleness was dated from the model's DDL, not build completion.**
  `Math.min(fresh.mtimeMs, ddlMtime)` always resolved to the DDL, because a
  model with a status row was covered by that artifact's own invocation and dbt
  writes per-model DDL as it walks the DAG. The 60 s tolerance therefore started
  ticking at compile time, and a tidy-up edit seconds after a long green build
  read as stale. `fresh.mtimeMs` is correct when a status row exists; DDL mtime
  remains correct for the DDL-only case.
- **`update` / `modify` / `change` did not state a contract.** The most ordinary
  phrasing for work on an existing relation ("Update the model `orders`") named
  its deliverable literally and yielded nothing, so both contract gates went
  inapplicable and a zero-write session finished clean. Added with the same
  bounded inflections the other modification verbs use.
- **An unreadable `ALTIMATE_VALIDATORS_TASK_FILE` erased the contract.** A stale
  or misspelled pin returned no task document at all rather than falling back to
  discovery, and all three contract gates skipped in silence. A readable pin is
  still exclusive.
- **Repository text reached the retry prompt unsanitised.** The consensus pass
  routed `dbt-build-green`'s untrusted values through `sanitizeForPrompt` but
  left the same exposure in three places: `dbt-nothing-built` interpolated
  `expectation.taskFile` and the parsed deliverable list into `reason` and
  `fixHint`, and `dbt-incremental-config` and `dbt-dialect-guard` interpolated
  repository-derived model names. All build the same synthetic `role: "user"`
  turn, so a name or filename carrying a newline breaks out of the sentence it
  is quoted in and lands at instruction position. All now sanitized.
- **The inverse gate misdescribed an unrelated build.** A session that built
  something other than the named deliverables was told it "produced no fresh
  successful build artifact", which is simply false. It now branches on
  `freshRun`.

## Second review sweep — open, NOT addressed in this pass

### 19. Both contract gates read the task document from the mutable worktree

`dbt-deliverable-names` and `dbt-nothing-built` each call `readContract` /
`artifactExpectation` at completion time, against the live filesystem. A session
that deletes, renames or rewrites `TASK.md` so it no longer parses a contract
makes both gates return `appliesTo === false`, and can then terminate having
produced nothing — every remaining gate sees zero touched models.

Why deferred: the honest fix is to capture the contract at session start, or to
read it from harness state the agent cannot write. Neither exists in this lane;
`ValidatorContext` carries `sessionStartMs` and nothing else. The available
half-measure — block when a task-document candidate path was written during the
session — cannot tell a deletion from a file that never existed, and fires on
the entirely normal case of a task that asks for the document itself to be
updated. That converts a false negative into a blocking false positive, which is
worse than the gap. Same missing infrastructure as items 4 and 8: a
session-scoped artifact store.

### 20. The dialect guard's applicability is decided from the mutated filesystem

`projectPrescribesGuards` runs at completion time. A session that removes the
project's only `target.type` guard and leaves an unguarded `iff()` observes no
remaining convention, so the validator makes itself inapplicable — silently
accepting exactly the portability regression it exists to catch.

Why deferred: same as item 19. Applicability has to be determined from
pre-session project state, and there is nowhere to record it.

### 21. Prose mining still over-extracts in two shapes

Both are instances of item 13, restated with the specific shapes reviewers
found, so a later pass does not have to re-derive them:

- `requirementHead` returns text from the start of the line, so code spans
  *before* the requirement verb are collected. "Using the source `raw_orders`,
  create the model `fct_orders`" demands `raw_orders` as a model, and no action
  the agent can take satisfies it. Slicing from the verb instead trades this for
  a passive-voice miss ("The `fct_orders` model must be created"), which is the
  safer direction but is a behaviour change to the extractor, not a repair.
- A `## Required deliverables` section collects every code span under it, so
  `- Model \`fct_orders\` with unique key \`order_id\`` makes `order_id` a
  required model. The qualifier narrowing that fixed this for prose requirement
  lines has no equivalent for section entries, which are structurally a list
  rather than a sentence.

The recorded direction of travel for item 13 is an explicit structured contract
with ambiguous prose yielding inconclusive, rather than a further round of
heuristics on top of these. Patching either shape in isolation keeps the
extractor on the treadmill this entry exists to get it off.

### 22. `{% if not is_incremental() %}` arms are skipped, not complemented

The negated form no longer produces a false positive on the full-refresh arm,
but the *real* incremental arm — the `{% else %}` — is still not inspected, so a
non-deterministic predicate there is missed. Identifying it means evaluating the
complement of an arbitrary Jinja condition across `elif` chains, which is the
same branch-semantics feature items 10 and 14 need, with the same property: a
half-implementation turns this miss into a blocking false positive on correct
models.

### 23. `dbt-build-green` cannot see a model that was deleted

`modelsModifiedSince` walks the CURRENT filesystem for `.sql` files with
`mtime >= sessionStartMs`. A file that existed at session start and was
deleted during the session cannot appear in that scan by construction — there
is no path to stat. With no fresh artifact either, `touchedPaths.length === 0
&& !artifactIsFresh` takes the `nothing-to-gate` path, so a session that
deletes a model — leaving every downstream `ref()` to it broken — clears this
gate, `dbt-deliverable-names`, and `dbt-nothing-built` (which only checks
POSITIVE evidence of authored/built work) without a single one of them
inspecting the deletion.

Why deferred: closing this needs to know the workspace's file listing AT
SESSION START, to diff against the current one. Two ways to get that, both
infrastructure this lane does not have:

- A session-scoped snapshot written by the harness before the agent's first
  turn — the same missing artifact store items 19 and 20 need, generalized
  from "the task contract" to "the file tree".
- A VCS diff (`git diff --name-status --diff-filter=D` against a commit
  bracketing the session start). This validator is deliberately built with
  "No subprocess, no warehouse connection" as an architectural constraint (see
  its own module doc), specifically so a completion check cannot itself become
  a source of flakiness or a new external dependency in a path that gates
  session termination. Adding a git subprocess call here is exactly the kind
  of dependency that constraint rules out, and it degrades silently to
  "no signal" the moment the workspace is not a git repository, or the
  session's edits were never committed — the common case for an in-progress
  session — leaving the same blind spot with an added dependency and no
  reliable win.

No half-measure was found that narrows this without either reintroducing a
subprocess dependency the validator's own design forbids, or trading this
false negative for a blocking false positive on a correct session (the same
pattern items 19–20 already ruled out for the same reason). Left open with the
reasoning recorded rather than patched.
