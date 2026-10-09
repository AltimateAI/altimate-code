---
title: "Validators (Completion Gates) — Altimate Code"
description: "Harness-side validators run after the agent declares done, catching SQL errors, schema drift, and test failures automatically."
---

# Validators (completion gates)

Validators are harness-side checks that run **after** the agent declares done.
Unlike tools, they are not visible to the agent — the framework dispatches
them automatically once the LLM emits `finishReason === "stop"`. If a
validator fails, the framework injects a synthetic user turn with the
failure body, giving the agent one more turn to fix the issue (bounded by
a per-session retry budget).

This catches a class of error that prompt engineering alone cannot: the
agent claiming "done" while the work is actually broken (failing dbt
tests, schema drift, etc.).

!!! info "Opt-in by default"
    The validator dispatch is gated behind a feature flag. By default
    (`ALTIMATE_VALIDATORS_ENABLED=0`) the entire dispatch path is skipped
    — no filesystem scan, no subprocess spawn, no performance overhead
    for non-opted-in users. See [Enabling validators](#enabling-validators).

## When validators fire

The framework triggers the validator dispatch when **all** of the
following are true on a turn:

1. `ALTIMATE_VALIDATORS_ENABLED=1` (enforcement) **or**
   `ALTIMATE_VALIDATORS_SHADOW=1` (telemetry-only) is set
2. The processor returned `continue` (i.e. the loop is about to consume
   the next message — not a hard stop / compaction event)
3. The LLM's last message has `finish === "stop"`
4. There is no `error` on the last message
5. At least one validator is registered

If any of these is false, the dispatch is skipped and the session ends
normally.

## Built-in validators

altimate-code ships seven validators out of the box. All apply only to
sessions inside a dbt project (their `appliesTo` check looks for a
`dbt_project.yml`).

Two are enabled whenever validators run (`dbt-tests-pass`,
`dbt-schema-verify`); the other five are **completion gates** added in the
deterministic-validators work and are currently soak-tested in shadow mode
— see [Enabling validators](#enabling-validators) before relying on them.

### `dbt-tests-pass`

After the agent declares done, runs `altimate-dbt test --model <name>`
against every dbt model the agent modified during this session. Refuses
to terminate if a model's tests fail, or if tests could not be run
because dbt itself errored.

**Catches**: row-data correctness errors (`relationships`, `unique`,
`not_null`, `accepted_values`, `AUTO_*_equality` tests) — the kind of
bug that column-shape verification cannot detect because the schema can
be green while the SELECT logic produces wrong values or wrong row
counts.

**What counts as what**

| dbt result for the model | Validator |
|---|---|
| Tests ran and all passed | passes |
| Tests ran and some failed or errored | **fails**, naming captured failing tests when available |
| dbt selected no tests (it prints `Nothing to do` and no summary) | passes, and sends nothing. A model with no tests has nothing to check. Recorded as `no_tests` in telemetry. |
| The selector matched no enabled node | passes (`unmatched_selector_models` in telemetry) |
| dbt aborted (connection, lock, compile or runtime error) before or while running tests | **fails**, with dbt's error text |

An error from a run that happened in parallel with other `altimate-dbt`
processes is retried once, alone, before it is reported, because several
processes sharing a single-writer warehouse such as DuckDB can fail each
other without anything being wrong with the model (`retried_serially` in
telemetry). Timeouts and spawn failures are not retried.

### `dbt-schema-verify`

After the agent declares done, runs `altimate-dbt schema-verify --model
<name>` on every modified model and compares the built table with the
columns its YAML declares. It reports only what dbt's own semantics
establish as a problem, and says which file declares what:

- **Enforced contract.** The model has `contract: {enforced: true}` and
  the built table has columns the contract does not list, or lacks columns
  it lists. dbt itself rejects such a model. Only column names are compared
  here; `dbt build` is what checks a contract's data types.
- **Declared column with tests, not produced.** The YAML declares a column
  that has at least one test attached, but the built table does not have it.
  The test reads a column that does not exist.

It does **not** report, and never tells the agent to remove, add or
reorder anything because of:

- columns the model produces that the YAML does not list. YAML commonly
  documents only some columns (those with tests or descriptions); that is
  not an exhaustive list unless a contract is enforced;
- a declared column with no tests and no contract that the model lacks.
  This may be a stale or aspirational entry, so it is only a note in the
  `altimate-dbt schema-verify` output;
- column order, or a declared `data_type` that differs from the warehouse
  type outside a contract (dbt does not enforce either, and adapters spell
  types differently);
- a model with no YAML entry or no declared columns (`no-spec`).

The message states the evidence and leaves the decision with the agent
(change the model if the YAML is right, or the YAML if its entry is
stale). The full classification appears in `altimate-dbt schema-verify`
and `altimate-dbt build --model` as `findings` (established problems),
`notes` (true observations) and `spec` (declaring file, package, contract
flag). The project-wide `altimate-dbt build` returns these detailed fields
only for models with a mismatch; matching models are summarised as a count.
`columns_extra`, `columns_missing`, `columns_reordered` and
`type_mismatches` remain as the raw diff against the YAML and are not
instructions. A tool error is still a
failure (drift cannot be ruled out) and now includes the first error text.

## Completion gates (shadow mode)

The following five validators are the deterministic **completion gates**.
They are soak-tested in shadow mode (`ALTIMATE_VALIDATORS_SHADOW=1`, which
records outcomes without blocking) and are **not** recommended for
enforcement (`ALTIMATE_VALIDATORS_ENABLED=1`) yet. Each applies only inside
a dbt project.

### `dbt-build-green`

After the agent declares done, refuses to terminate unless a fresh
successful `dbt build` artifact (`run_results.json` newer than the session
start, no failing status) covers every model the session edited.

**Catches**: the agent declaring "done" while the build is red or stale.

### `dbt-nothing-built`

Inverse completion gate. When the workspace carries a task document that
literally names required models or files (or the require-artifacts opt-in
is set), refuses to terminate a session that authored no project files and
produced no fresh successful build artifact.

**Catches**: a vacuous "done" where the task named deliverables but nothing
was actually built.

### `dbt-deliverable-names`

After the agent declares done, compares the deliverable names the task
document states literally against the model, seed and snapshot names the
project actually defines, and refuses to terminate when a required name is
absent.

**Catches**: renames and self-chosen substitutes — the agent building
something *like* the requested deliverable under a different name.

### `dbt-incremental-config`

After the agent declares done, lints the incremental models the session
edited for self-contradictory configuration: upsert semantics declared
without a `unique_key`, a missing `is_incremental()` guard where the task
demands idempotent re-runs, and non-deterministic functions inside the
incremental predicate.

**Catches**: incremental models that will silently duplicate or drop rows
on re-run.

### `dbt-dialect-guard`

After the agent declares done, flags warehouse-specific SQL functions used
in the models the session edited without the project's prescribed
`target.type` Jinja guard. Only active in projects that already establish
the guard convention.

**Catches**: dialect-specific SQL that runs on one warehouse but breaks on
another. *Known limitation*: a call already wrapped in a
`{% if target.type != '...' %}` branch is treated as guarded even when it
is live on every other target — see the internal follow-up notes.

## Enabling validators

Two opt-in modes:

| Env var | Effect |
|---|---|
| `ALTIMATE_VALIDATORS_ENABLED=1` | Full enforcement. Failing validators inject a synthetic user turn for the agent to fix (bounded by retries). |
| `ALTIMATE_VALIDATORS_SHADOW=1` | Telemetry-only. Validators run and emit `validator_check` events (with `enforced: false`), but do **not** block the session. Use this to measure "would have caught a real bug" rates against production traffic. |

Set in your shell, your `~/.altimate-code/altimate-code.json`'s `env`
block, or in your CI runner config. Either flag is enough to activate
the dispatch path; if neither is set the framework is completely inert.

```bash
# Enforcement (blocks session on failure, with retries)
export ALTIMATE_VALIDATORS_ENABLED=1

# Telemetry-only (no enforcement, no perf-blocking retry)
export ALTIMATE_VALIDATORS_SHADOW=1
```

## Configuration knobs

| Env var | Default | Meaning |
|---|---|---|
| `ALTIMATE_VALIDATORS_ENABLED` | unset (off) | Master enforcement switch |
| `ALTIMATE_VALIDATORS_SHADOW` | unset (off) | Telemetry-only mode |
| `ALTIMATE_VALIDATORS_MAX_RETRIES` | `3` | How many synthetic-message retries per session before giving up |
| `ALTIMATE_VALIDATORS_TIMEOUT_MS` | `60000` | Per-subprocess kill timeout (NaN/0/negative falls back to default) |
| `ALTIMATE_VALIDATORS_CONCURRENCY` | `4` | Max concurrent `altimate-dbt` subprocesses (clamped to `items.length`) |
| `ALTIMATE_VALIDATORS_DEBUG` | unset | When `1`, mirror dispatch diagnostics to stderr (file logs always include them) |

## Performance characteristics

When **off** (default): zero cost — the dispatch returns immediately
after the diagnostic log.

When **on** in a dbt project:

- Filesystem scan: 50–500 ms (walks up to 8 levels deep under the
  project root, stats every `.sql` file)
- Per-model subprocess: 5–30 s each
  (`altimate-dbt test` or `altimate-dbt schema-verify`)
- Concurrency cap of 4 → worst case `ceil(N/4) × 30 s` for N modified
  models
- 5 touched models ≈ 1–2 minutes of "agent said done, you're still
  waiting"

For interactive sessions, this is real latency. For batch / CI use
the trade-off is usually worth it because correctness wins over a
minute of wall time.

## Telemetry

When validators run (either mode), they emit one
`validator_check` event per applied validator:

```json
{
  "type": "validator_check",
  "session_id": "...",
  "validator_name": "dbt-tests-pass",
  "ok": true,
  "step": 12,
  "retry_count": 0,
  "enforced": true,
  "details": {
    "models_touched": 3,
    "checked": 3,
    "dbt_root": "/work/my-dbt-project",
    "elapsed_ms": 14523,
    "concurrency_limit": 4
  }
}
```

When `ALTIMATE_VALIDATORS_ENABLED=1` retries are exhausted with
outstanding failures, a `validator_retries_exhausted` event marks the
session as completed-with-unresolved-validator-failures.

See [Telemetry reference](../reference/telemetry.md) for the event
catalogue and what's collected.

## Result shape

When a validator runs, it returns:

```ts
{
  ok: boolean
  reason?: string      // human-readable failure summary
  fixHint?: string     // the body injected into the synthetic user turn
  details: {
    models_touched: number
    dbt_root: string | null
    session_id: string
    elapsed_ms: number
    // present only when at least one model was touched:
    checked?: number
    concurrency_limit?: number
    // validator-specific extras:
    // dbt-tests-pass:
    passed?: number
    no_tests?: number
    no_tests_models?: string[]
    unmatched_selector_models?: string[]
    retried_serially?: number
    failed?: number
    errored?: number
    spawn_failures?: number
    failing_models?: string[]
    errored_models?: string[]
    // dbt-schema-verify:
    verified?: number
    match?: number
    mismatch?: number
    no_spec?: number
    diff_not_established?: number
    mismatch_models?: string[]
  }
}
```

`reason` names the failing models inline (e.g. `"2 of 3 models you
edited contradict the YAML that declares their columns: foo, bar"`).

## Phased rollout plan

The framework is intentionally opt-in until we have:

1. **Sufficient shadow telemetry** — "would have caught a real bug" rate
   well above "false positive" rate, against representative traffic.
2. **Build / schema-verify sync resolved** — currently a freshly-built
   model can briefly report `mismatch` while `altimate-dbt`'s manifest
   catches up; enabling by default would block sessions where the
   agent did the right thing.
3. **Coverage gaps closed** — custom `model-paths` (anything other
   than `models/`), Python models (`.py`), and workspace projects
   nested below the first subdirectory are not currently detected.
4. **Performance**: today the dispatch is synchronous on session end.
   For interactive UX we want to either move it to a background job
   that the agent can `await` only when needed, or surface progress to
   the user.

Once those are met, validators will be opt-out for dbt projects and
default-on. Track progress in
[#849](https://github.com/AltimateAI/altimate-code/pull/849).

## Known limitations

- Only `.sql` model files inside a `models/` ancestor are scanned
  (case-insensitive). Python models (`.py`, dbt 1.3+) and custom
  `model-paths` are not.
- `findDbtProjectRoot` checks the cwd and one level of subdirectories,
  skipping `.hidden`, `node_modules`, `target`. Projects nested
  deeper (workspace layouts) are not detected.
- Multiple `dbt_project.yml` candidates pick the alphabetically-first
  match deterministically.
- A model that was never materialized is reported as a tool error
  ("has no warehouse table. Build it first"), not as a column finding.
- Retries consume the shared validator budget (three by default) whether
  or not the failure text changed. A failure that is re-sent verbatim on
  every retry spends the budget without giving the agent new information.

## Writing custom validators

The framework is generic — only the built-in two are dbt-specific.
A validator is any object satisfying:

```ts
interface Validator {
  name: string
  description: string
  appliesTo(ctx: ValidatorContext): Promise<boolean>
  check(ctx: ValidatorContext): Promise<ValidatorResult>
}
```

Register it with `ValidatorRegistry.register(yourValidator)` at module
load. The framework will then dispatch it on every gated turn. Keep
`appliesTo` fast (it runs on every session end) and `check` idempotent
(it may run multiple times across retries).

See `packages/opencode/src/altimate/validators/dbt-tests-pass.ts` for a
worked example.
