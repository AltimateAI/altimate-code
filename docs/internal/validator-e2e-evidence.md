# Completion-gate validators: end-to-end evidence

**Status:** measurement report, input to an enable/shadow/revert decision
**Date:** 2026-08-29
**Scope:** the five validators added in PR #1175 —
`dbt-nothing-built`, `dbt-build-green`, `dbt-deliverable-names`,
`dbt-incremental-config`, `dbt-dialect-guard` — measured on real dbt projects
rather than on unit-test fixtures.

> **Sample-size disclosure, up front — read this before the A/B section.**
> The planned A/B was 10 tasks × 2 arms × 2 rollouts = 40 live sessions.
> **Three complete sessions were achieved: N = 1 paired task (arm A + arm B)
> plus one unpaired arm-A run.** The batch was terminated for machine capacity:
> these sessions ran on a single laptop that was concurrently hosting another
> workstream's agent fleet, the machine had already crashed twice under load,
> and local session execution was stopped outright at a load average above 20.
> **No conversion claim can be made from N = 1.** The A/B numbers below are
> reported for completeness and transparency, not as evidence of effect in
> either direction.
>
> The false-positive, true-positive, negative-control and cost sections do
> **not** carry this limitation. Those are deterministic probes — the validator
> code paths run directly against real project states with no model in the loop
> — and their N (38 known-good states, 11 known-bad states) is what the safety
> conclusions rest on. The negative control is a completed live session.
>
> What a properly powered A/B would need is specified in
> [What a real A/B would require](#what-a-real-ab-would-require).

---

## Bottom line

| Question | Answer |
|---|---|
| Do the five fire on healthy, complete dbt projects? | **Not in ordinary end-states** — 0 firings across 27 naturalistic known-good states. |
| Are there false positives at all? | **Yes, five reproducible ones**, all in `dbt-build-green` (3) and `dbt-dialect-guard` (2), each triggered by an ordinary dbt practice rather than by a defect. |
| Do they fire on genuinely-unfinished work? | **Yes** — every constructed defect state was caught, with two recall gaps in the task-document parser. |
| Do they execute in a non-dbt repo? | **No.** Zero validators executed; confirmed in a live session with the lane and the artifact opt-in both forced on. |
| Runtime cost? | ~2–10 ms per dispatch on a small project; ~1–3.5 s on a 2 000-model project, because each validator re-walks the tree independently. |
| Does enforcement convert failures into passes? | **Unknown — not measured.** N = 1 paired task; the run needed no retry, so there was nothing to convert. |
| Verdict | **Shadow only.** Two reasons, independently sufficient: five reproducible false positives, and no conversion evidence at all. Details in [Verdict](#verdict). |

---

## Methodology

### Code under test

`feat/deterministic-validators` at `14747ac6c9`, worktree `/tmp/validators-build`.
Validators at `packages/opencode/src/altimate/validators/`; dispatch hook at
`packages/opencode/src/session/prompt.ts:1360`.

The lane registers **seven** validators, not five: the two pre-existing members
(`dbt-schema-verify`, `dbt-tests-pass`) are registered alongside this PR's five.
To attribute results to this PR rather than to the lane as a whole, an
**experiment instrument** was added to `validators/index.ts` for the duration of
the measurement: an `ALTIMATE_VALIDATORS_ONLY` env allowlist filtering which
validators get registered (unset ⇒ register everything, i.e. shipped behaviour
unchanged). **That instrument is reverted in the commit that carries this
document** — it exists only so the numbers below describe the five.

### Model

altimate-code exposes a ChatGPT-subscription (Codex) provider
(`packages/opencode/src/plugin/codex.ts`, provider id `openai`, OAuth), but
**this environment has no credential for it** — `auth list` shows Anthropic
(oauth), Azure, Google, Vertex, Vertex (Anthropic), and the plugin's OAuth flow
needs an interactive browser login. Per the standing rule, no Vertex/GCP
Anthropic path was used.

The three completed sessions therefore ran against a **self-hosted internal
staging endpoint**, registered as a custom OpenAI-compatible provider:

```
provider  custom (npm: @ai-sdk/openai-compatible), internal staging endpoint
context   65536, output limit 8192
sampling  temperature 0.2, seed 1001 (pinned per rollout)
agent     builder, --max-turns 40, --yolo, --format json
```

The model is a mid-capability coding model, not a frontier one. That matters
for reading the A/B: a stronger model would need the gates less often, a weaker
one more, so the fire rates here do not transfer directly to production traffic.
It does **not** affect the false-positive, true-positive, cost or
negative-control results, none of which involve a model.

### Projects

1. **An internal dbt task corpus** (10 tasks, all 10 used for the offline
   probes, 2 reached in the live A/B) — real dbt projects (dbt-core
   1.8.7 + dbt-duckdb 1.8.3), each with a task prompt and a `verify.sh` grader
   that rebuilds from scratch and diffs against a golden expectation file.
   Every workspace was **copied** to a scratch directory before use; the
   pristine corpus was never written to, and `verify.sh` was always invoked
   with an explicit workspace argument.
2. **`dbt-labs/jaffle-shop-classic`** (public, Apache-2.0), cloned fresh and
   pointed at a local DuckDB profile. Used for the false-positive work because
   it is a complete, correct, third-party project with no injected defects.

### Instruments

* `validator-probe.ts` (repo root, **not committed**) — imports the registry
  and runs `appliesTo()` + `check()` against an arbitrary directory with an
  explicit `sessionStartMs`, emitting JSON. This is how the false-positive
  sweep is executed: it exercises the exact validator code paths the session
  hook calls, without a model in the loop, so results are deterministic and
  repeatable.
* Live sessions via `bun run packages/opencode/src/index.ts run …` with
  `ALTIMATE_VALIDATORS_DEBUG=1`, which mirrors every `validator_hook_reached`
  and `dispatch_result` event to stderr.
* `altimate-dbt` was rebuilt from `packages/dbt-tools` and put first on `PATH`;
  the globally-installed copy is stale and does not implement `schema-verify`.

---

## Measurement 1 — false-positive rate (safety)

A false positive here means: **a validator returns `ok:false` on a state a
competent engineer would call finished.** In enforce mode that state costs the
session a synthetic retry turn for nothing.

### Set A — naturalistic known-good states (n = 27)

For each of the seven `real-*` tasks whose pristine workspace builds green
(01, 02, 04, 05, 08, 09, 10), three end-states were probed:

* **kg1a** — every project file written during the session, then `dbt build`
  green ("the agent authored this and built it").
* **kg1b** — project pre-existing, session ran only the build.
* **kg4** — read-only session: nothing written, nothing built.

Plus six jaffle_shop states: whole project authored + built green; build-only;
read-only; a new correct model added and built green; the same with an explicit
`TASK.md` naming the deliverable (so the contract-driven validators activate);
and a correctly-configured incremental model built green.

**Result: 0 firings from any of the five, across all 27 states.**

The three `real-*` tasks whose pristine workspace does *not* build green
(03, 06, 07) were excluded from the known-good set — they are genuinely
unfinished, and firings there are true positives (recorded below).

### Set B — constructed known-good states, each an ordinary dbt practice (n = 11)

| # | State | Fired? |
|---|---|---|
| B1 | dialect-specific function inside a `{% if target.type … %}` guard | — |
| B2 | same, but the guard block contains a **nested `{% if %}`** | **FP — `dbt-dialect-guard`** |
| B3 | dialect function name appears only in a `--` SQL comment | — |
| B4 | dialect function name appears only inside a **string literal** | **FP — `dbt-dialect-guard`** |
| B5 | incremental config declared in `dbt_project.yml`, not in `config()` | — |
| B6 | last dbt command of the session was `dbt test` | — |
| B7 | green build, then the model file is **touched 3 s later** (reformat/comment) | **FP — `dbt-build-green`** |
| B8 | session edits an **ephemeral** model, builds green | **FP — `dbt-build-green`** |
| B9 | session **disables** a model on purpose (`enabled=false`), builds green | **FP — `dbt-build-green`** |
| B10 | session builds only the changed model with `--select` | — |
| B11 | session's build was `dbt run` (no tests) | — |

### False-positive table

| Validator | FPs | Known-good states where it could fire | Mechanism |
|---|---|---|---|
| `dbt-nothing-built` | **0** | 4 | — |
| `dbt-build-green` | **3** | 38 | see FP-1..3 |
| `dbt-deliverable-names` | **0** | 4 | — |
| `dbt-incremental-config` | **0** | 38 | — |
| `dbt-dialect-guard` | **2** | 7 | see FP-4..5 |

Total: **5 false positives across 38 known-good states.** All five are
deterministic and reproduce on every run.

#### FP-1 — `dbt-build-green`: any post-build write to a model file blocks

State B7. The session writes a model, runs `dbt build` green, then appends a
trailing newline (a formatter, a comment, a tidy-up) three seconds later.

```
The build is not green: 1 model(s) were edited after the last build: extra_green2.
  "stale_build": ["extra_green2"], "failed_in_scope": [], "not_built": []
```

`BUILD_FRESHNESS_TOLERANCE_MS` is 1 000 ms. Any edit after that window — even a
whitespace-only one that cannot change compiled SQL — flips the model into
`stale_build` and blocks the session. "Build, then tidy, then summarise" is a
common agent trajectory, so this is not a corner case.

#### FP-2 — `dbt-build-green`: editing an **ephemeral** model always blocks

State B8. dbt does not emit a `run_results` node for an ephemeral model, so the
coverage assertion ("is every model I edited present in the artifact?") can
never be satisfied for one.

```
The build is not green: 1 model(s) you edited were never built: eph_helper.
  "not_built": ["eph_helper"], "model_nodes_in_artifact": 6
```

The build was green; the ephemeral model was compiled into its consumer, which
built and passed. There is no defect to fix, and no action the agent can take
that clears the gate short of changing the materialization.

#### FP-3 — `dbt-build-green`: deliberately disabling a model always blocks

State B9. `{{ config(enabled=false) }}` removes the node from the manifest, so
the same coverage assertion fires. Retiring a model is a legitimate, common
change.

```
The build is not green: 1 model(s) you edited were never built: retired_model.
```

FP-2 and FP-3 share one root cause: `not_built` treats "absent from
`run_results`" as evidence of an unbuilt model, but dbt legitimately omits
ephemeral and disabled nodes.

#### FP-4 — `dbt-dialect-guard`: a nested `{% if %}` breaks guard detection

State B2. `listagg()` sits inside a `{% if target.type == 'snowflake' %}` block
that also contains an inner `{% if var(...) %}…{% endif %}`:

```
1 unguarded warehouse-specific construct(s) in 1 model(s) you edited: nested_guard.
  findings: [{"model":"nested_guard","function":"listagg()","dialects":"Snowflake / Redshift / Oracle"}]
```

`TARGET_TYPE_GUARD_RE` is non-greedy from `{% if … target.type … %}` to the
**first** `{% endif %}`. The inner `{% endif %}` closes the blanked region
early, so the still-guarded remainder is scanned and reported. Nested Jinja
inside a dialect guard is normal dbt.

#### FP-5 — `dbt-dialect-guard`: string literals are not masked

State B4. `'listagg('` as a string literal is flagged.

Isolating the two halves of the composite probe shows the boundary precisely:
a `--` comment containing `listagg( … )` is **not** flagged (so
`stripSqlComments` works), while `select 'listagg(' as never_executed` **is**.
Lower frequency than FP-1..4, but the same class of bug: text matching without
lexical masking.

### True-positive discrimination (known-bad states, n = 11)

**8 of 11 known-bad states fired; 3 were silent.** This is the other half of the
safety question — a gate that never fires is also useless.

| Known-bad state | Fired |
|---|---|
| `real-03` pristine: build genuinely red (`team_game_counts` errors) | `dbt-build-green` ✓ |
| `real-06`, `real-07` pristine: models edited, project does not parse, no artifact | `dbt-build-green` ✓ |
| `real-07`: required `stg_nba_games` does not exist | `dbt-nothing-built` ✓, `dbt-deliverable-names` ✓ |
| jaffle + `listagg()` unguarded in a project that establishes the guard convention | `dbt-dialect-guard` ✓ |
| jaffle + `incremental_strategy='delete+insert'` with no `unique_key` | `dbt-incremental-config` ✓ |

The three silent known-bad states were `real-03` read-only, `real-06` build-only
and `real-06` read-only. All three are explained by the recall gaps below rather
than by a logic error.

**Two recall gaps worth noting** (misses, not false positives):

* `real-06`'s prompt reads *"Add the missing `models/staging/stg_nba_teams.sql`"*.
  `REQUIREMENT_VERB_RE` covers `creat|build|produc|implement|deliver|materiali[sz]|generat|writ|deploy`
  — **not `add`**. `real-07` says *"Implement the missing …"* and is picked up.
  One word decides whether the contract-driven validators activate at all: of
  ten real task documents, exactly one (`real-07`) yielded a literal contract.
* `dbt-dialect-guard` never activated on any of the ten `real-*` tasks or on
  stock jaffle_shop: none of those projects establishes a `target.type`
  convention, which is the validator's activation precondition. Its real-world
  coverage is therefore narrow by design.

### Adjacent finding: the two pre-existing lane members (out of PR scope)

Not part of PR #1175, but it matters to anyone deciding whether to switch
`ALTIMATE_VALIDATORS_ENABLED=1` on, because that flag turns on all **seven**
registered validators, not five.

Probing the full lane against a green, complete `real-01` workspace produced:

```
dbt-schema-verify  ok:false  errored=3/5 models  elapsed_ms=10864
dbt-tests-pass     ok:false  errored=4/5 models  elapsed_ms=13919
```

Zero actual mismatches and zero actual test failures — every one of those is a
subprocess that did not return a parseable result, and both validators treat
"could not verify" as "blocks". Two contributing causes were observed: the
globally-installed `altimate-dbt` predates `schema-verify` entirely (so the
subprocess errors out), and even with a freshly built binary on `PATH` the
validators fan out at `concurrency_limit: 4` against a single DuckDB file, which
is single-writer. They also cost **11–14 s each**, three orders of magnitude
more than the five under test.

Separately, `schema-verify` treats columns present in the model but absent from
`schema.yml` as `columns_extra` — and partially-documented models are the norm
in real dbt projects, so that is a large latent false-positive surface on its
own. None of this is PR #1175's doing, but it means "enable the lane" and
"enable these five" are very different decisions.

---

## Measurement 2 — A/B conversion (does it help?)

**Read the sample-size disclosure at the top of this document first. This
section does not support a conclusion about conversion.**

### Design (as intended)

Same model, same prompts, same pinned seed (1001) and temperature (0.2), same
`--max-turns 40`, same task workspaces. Arm A: no validator env set. Arm B:
`ALTIMATE_VALIDATORS_ENABLED=1` with the five under test registered. Grading by
each task's own `verify.sh`, which wipes `target/`, rebuilds from scratch and
diffs against a golden expectation file — so the grader is independent of
anything the validators looked at.

### Achieved N

| | planned | achieved |
|---|---|---|
| tasks | 10 | 2 |
| arms per task | 2 | 2 for `real-01`, 1 for `real-07` |
| rollouts per cell | 2 | 1 |
| total sessions | 40 | **3** |
| complete A/B pairs | 20 | **1** |

Terminated for machine capacity, not because the result was in. Two further
arm-B sessions (`real-07`, `real-10`) were in flight and were killed; their
partial data is discarded, not reported.

### Runs completed

| Task | Arm | verify.sh | wall clock | assistant steps | tool calls | validator dispatches | validator retries | validators that fired |
|---|---|---|---|---|---|---|---|---|
| `real-01-home-team-join` | A (off) | **pass** | 478 s | 14 | 24 | 0 | 0 | — |
| `real-01-home-team-join` | B (on) | **pass** | 392 s | 13 | 16 | 1 | 0 | — |
| `real-07-add-game-staging` | A (off) | **pass** | 867 s | 29 | 37 | 0 | 0 | — |

### What can and cannot be read from this

**Cannot be read:** any pass-rate difference, any conversion effect, any wall-clock
or turn-count overhead. One pair is one pair; the 478 s → 392 s difference between
the two `real-01` arms is ordinary run-to-run variance in a nondeterministic
agent loop, not a measured effect of the gate, and it would be dishonest to
present it as one.

**Can be read**, because they are structural observations rather than statistics:

1. **The hook fires where it is supposed to and nowhere else.** In arm A the
   session logged `validator_hook_reached` on every step with
   `validatorsEnabled: false` and **zero** `dispatch_enter` events — the flag-off
   path costs nothing, as the code comment claims. In arm B the dispatch ran
   exactly once, on the single step where the model declared a clean stop.

2. **Only two of the five ever became applicable on this task.**
   `dbt-nothing-built`, `dbt-deliverable-names` and `dbt-dialect-guard` all
   returned `appliesTo: false`, consistent with the offline sweep: the first two
   need a task document with a literal deliverable contract (1 of 10 real task
   prompts produced one), the third needs a project that already uses
   `target.type` guards (0 of 11 projects tested).

3. **`dbt-build-green`, the lane's central gate, degraded to a no-op on this
   real session.** Its own telemetry from the live dispatch:

   ```json
   {"name":"dbt-build-green","ok":true,"details":{
     "models_touched":1,"run_results_fresh":true,"verdict":"fresh-build",
     "coverage_assertable":false,"model_nodes_in_artifact":0,
     "failed_in_scope":[],"not_built":[],"stale_build":[]}}
   ```

   `model_nodes_in_artifact: 0` means the agent's final dbt command left a
   `run_results.json` containing test nodes only, so the coverage assertion was
   skipped by design (`coverage_assertable: false`). The gate returned `ok:true`
   **without checking anything** — it would have passed identically had the
   model never been built. The same blind spot reproduces deterministically in
   the offline probe (state B6). This is the documented conservative fallback,
   but it means the gate's real-world discriminating power depends on which dbt
   command the agent happens to run last, which the gate does not control.

### What a real A/B would require

On a GCP VM, isolated from developer machines:

* **Scale:** 10 tasks × 2 arms × 3 rollouts = 60 sessions. At the observed
  392–867 s per session, that is ~9 h serial, or ~2 h at concurrency 5 on a
  machine that can take it (each session is one `bun` process plus a DuckDB
  build; ~4–6 GB RSS observed per session, so size for ≥8 vCPU / 32 GB).
* **A third arm.** Arm A (off) and arm B (enforce) are not enough, because a
  fired validator changes the trajectory and destroys its own counterfactual.
  Add **arm S (`ALTIMATE_VALIDATORS_SHADOW=1`)**: validators run and log but do
  not enforce, so shadow tells you the true fire rate on unperturbed sessions,
  and the arm-A/arm-S verdict difference should be zero (a sanity check on the
  harness).
* **Tasks that can actually fire the gates.** Of the 10 `real-*` prompts, only
  one yields a deliverable contract and none establishes a `target.type`
  convention, so three of the five validators are structurally unreachable on
  this task set. A conversion study needs a task set where each validator has a
  reachable failure mode — otherwise arm B is arm A with extra logging.
* **A pre-grade workspace snapshot.** `verify.sh` deletes `target/` and
  rebuilds, which destroys the very artifact state the validators inspect.
  Snapshot the workspace before grading so post-hoc probes are valid.
* **Report per-dispatch telemetry, not just pass rates** — `dispatch_result`
  already carries everything needed (`coverage_assertable`, `not_built`,
  `stale_build`, per-validator `elapsed_ms`).

---

## Negative control — non-dbt project

A live session in a small TypeScript repo (`/tmp/valexp/negctl/repo`: two source
files, a `bun test` suite, a README, no dbt anywhere), with the **full lane**
enabled and the artifact gate additionally forced on:

```
ALTIMATE_VALIDATORS_ENABLED=1
ALTIMATE_VALIDATORS_REQUIRE_ARTIFACTS=1
(ALTIMATE_VALIDATORS_ONLY unset — all seven validators registered)
```

Task: *"Add a `stddev` function to src/stats.ts and a unit test for it. Run
`bun test`."* The session completed the work (`stddev` present in both files)
and stopped cleanly.

Validator events, verbatim from the session's stderr:

```
validator_hook_reached step=1..5  finish=tool-calls  validatorCount=7
validator_hook_reached step=6     finish=stop        validatorCount=7
dispatch_enter        step=6
dispatch_result       step=6      checks_count=0     results=[]
```

**Zero validators executed.** All seven were registered and the dispatch ran,
but every `appliesTo()` returned false because `findDbtProjectRoot()` finds no
`dbt_project.yml`. No synthetic message was injected (`grep -c
"altimate-validator:" trace.jsonl` → 0). The gate is inert outside dbt, as
designed, even with the most aggressive opt-in set.

---

## Cost overhead

Per-validator `check()` wall time, measured across 50 probe invocations on the
small projects (5–6 models):

| Validator | mean | max |
|---|---|---|
| `dbt-build-green` | 1.4 ms | 4 ms |
| `dbt-incremental-config` | 1.7 ms | 5 ms |
| `dbt-dialect-guard` | 1.2 ms | 2 ms |
| `dbt-nothing-built` | 1.3 ms | 2 ms |
| `dbt-deliverable-names` | 0.8 ms | 2 ms |

Whole-dispatch wall time on those projects: **mean 10 ms, max 39 ms.**
Negligible.

**Scaling is the caveat.** On a synthetic 2 005-model project:

| Scenario | `dbt-build-green` | `dbt-incremental-config` | dispatch total |
|---|---|---|---|
| all 2 005 models modified this session | 300 ms | 738 ms | 2 853 ms |
| zero models modified this session | 649 ms | (skipped) | 3 454 ms |

Cost is dominated by the directory walk, not by the analysis, and **it is paid
even when nothing was touched**. Each validator runs its own independent
`modelsModifiedSince()` / project scan with no shared work or caching, so the
tree is walked up to five times per dispatch, and the dispatch fires on every
clean stop. On a large monorepo that is seconds of wall time per turn boundary.

The dominant cost of enforce mode is not CPU — it is the injected retry turn,
which is a full model turn plus whatever tool calls the model makes in response.

---

## Verdict

**Shadow only. Do not enable by default yet.** Two independent reasons.

**1. Five reproducible false positives, and they are not exotic.** Editing an
ephemeral model, disabling a model, touching a file after the build, nesting a
Jinja `if` inside a dialect guard — these are ordinary dbt work, not defects. In
enforce mode each one costs a session a synthetic retry turn, and the fix hint
tells the agent to do something that is either impossible (`eph_helper` can never
appear in `run_results`) or wrong (rebuild after a whitespace change). A gate
that burns its retry budget on non-problems is exactly the failure mode the
lane's own design doc warns about. All four of the highest-frequency ones are
small, contained fixes:

* `dbt-build-green`: exclude nodes that dbt legitimately omits from
  `run_results` — resolve `manifest.json` for `enabled: false` and for
  `materialized: ephemeral` before asserting coverage.
* `dbt-build-green`: compare **content**, not mtime, for the stale check, or
  raise the tolerance far above 1 s and skip files whose comment-stripped SQL is
  unchanged since the build.
* `dbt-dialect-guard`: match `{% if %}`/`{% endif %}` by nesting depth instead
  of a non-greedy regex; mask string literals as well as comments.

**2. There is no conversion evidence at all.** N = 1 paired task, and that pair
needed no retry. Nothing here shows the gate turns a failure into a pass, and
nothing here shows it does not. The claim in PR #1175 that these gates improve
outcomes is, on this evidence, **untested** — which is a different and more
honest statement than "disproven".

**What the evidence does support.** The safety envelope is genuinely
conservative where it was designed to be: 0 firings across 27 naturalistic
known-good end-states, 0 false positives from three of the five validators, a
clean negative control in a non-dbt repo with the most aggressive opt-in forced
on, and negligible CPU cost on normal projects. The true-positive side works
too: every constructed defect was caught. The problem is not that the lane is
reckless; it is that its blast radius includes a handful of legitimate dbt
practices, and its benefit is unmeasured.

**Recommended sequence.**

1. Ship the five behind `ALTIMATE_VALIDATORS_SHADOW=1` only. The lane already
   emits per-validator `validator_check` telemetry with `enforced: false`, which
   is enough to measure the real fire rate on real traffic.
2. Fix FP-1 through FP-5 (above) and add the five constructed known-good states
   as regression tests — they are a few lines each and all five reproduce
   deterministically.
3. Widen `REQUIREMENT_VERB_RE` to include `add` (and probably `convert`,
   `rename`, `fix`, `repair`); today one verb decides whether two of the five
   validators activate at all.
4. Look hard at whether `dbt-build-green`'s coverage assertion should survive
   `dbt test` overwriting `run_results.json`. Reading `manifest.json` (which is
   not overwritten by `dbt test`) alongside the run artifact would close the
   blind spot that made the gate a no-op on the one real session measured here.
5. Only then run the VM-based three-arm A/B described above, and decide on
   enable-by-default from those numbers.

**Not recommended:** reverting. The checks are cheap, the design is sound, the
true-positive behaviour is real, and the defects found are localized bugs rather
than a flaw in the approach.

**Also not recommended:** flipping `ALTIMATE_VALIDATORS_ENABLED=1` as a lane-wide
default, on the strength of these five. That flag also enables
`dbt-schema-verify` and `dbt-tests-pass`, which in this environment blocked a
green, complete project on subprocess errors alone and cost 11–14 s each. Those
two need their own evidence before the lane ships enabled.

---

## Reproducing this

Probe harness (not committed; recreate at the repo root):

```ts
// validator-probe.ts — bun run validator-probe.ts <cwd> <sessionStartMs> <label>
import { ValidatorRegistry } from "./packages/opencode/src/session/validators/registry"
import { registerAltimateValidators } from "./packages/opencode/src/altimate/validators"
registerAltimateValidators()
const ctx = { sessionID: "probe", workingDirectory: process.argv[2]!,
              sessionStartMs: Number(process.argv[3]), step: 1, retryCount: 0 }
console.log(JSON.stringify(await ValidatorRegistry.runAll(ctx as any), null, 2))
```

Each known-good state in Set B is built by: copy `dbt-labs/jaffle-shop-classic`,
point it at a local DuckDB profile, `dbt build` once, record `t0`, apply the one
change described in the table, `dbt build` again, then probe with `t0`. Full
scripts used for this report live under `/tmp/valexp/` on the machine that ran
it; they are shell wrappers around the snippet above and are not worth
committing.
