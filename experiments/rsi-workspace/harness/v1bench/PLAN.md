# learn v1 benchmark: arms, inputs, metrics

The learning suites require the product `learn` features from **PR #1405**. They are absent
from this research-only checkout: set `ALTIMATE_CMD` to a checkout containing those features.
The whole-playbook baselines, generator, fake backend, and verifier can run independently.
The earlier planning/results source under `research/rsi-workspace-learning-2026-09-30/` is
not included here. The committed `results-*.md` files are the tables as first published. The
analysis now excludes runs whose agent turn did not complete cleanly, which changes some cells;
the corrected tables are in PR #1405 (`learn-v1-results.md`). The verifier and the task project
are unchanged, so the saved runs were rescored, not rerun.

Default agent: `google-vertex/gemini-3.5-flash`, overridable with `AGENT_MODEL`.
Reflectors/reviewers are also configurable; see the workspace README. Claude models on
Vertex may be blocked by organization policy. Check access before paid runs.

## Inputs in this directory

| File | What |
|---|---|
| `lessons-1000.jsonl` | 1,000 lessons: 4 real (short form), 949 regular distractors, 47 near distractors. Fields: `id`, `text` (<=140), `tags`, optional `trigger.paths`, `kind` = real / distractor / near |
| `pool-300.jsonl`, `pool-50.jsonl` | deterministic nested subsets (50 < 300 < 1000), always contain the 4 real lessons; 14 / 4 near |
| `real-long.jsonl` | the 4 real lessons in their original long form (same ids, from `runs/corr-main/playbooks/final.md`) |
| `needs.json` | lessons each verifier task needs (retrieval-recall denominator). Heldout: disputes/invoices = L-2fe6, L-8536, L-8201; ledger = L-2fe6, L-8201; support-tickets = L-8536, L-8201; controls = none. L-8aba is never needed |
| `pool-review.md` | the near distractors with one line each on why they cannot change a staging answer |
| `vague_tasks/*.json`, `vague_tasks/README.md` | 4 vague prompts, same verifier; lesson -> file mapping for the file hook |
| `topic_switch/tasks.json`, `README.md`, `run_topic_switch.py` | 18 two-request sessions; follow-up via `run --session`; driver (untested against a model) |
| `playbooks/*.md` (from `make_playbooks.py`) | SKILL.md files for arms that work today: `real4-short`, `real4-long`, `all-50`, `all-300`, `all-1000`, `n50-long`, `n50-short` |
| `tasks_lib.py` | `load_dir`, `install` (make vague tasks visible to `common.select_tasks`), `shown_lessons(trace, lessons)`, `recall(task, shown)` |
| `pool.py`, `pool_data.py`, `pool_near.py` | regenerate everything deterministically: `python3 pool.py && python3 make_playbooks.py` |

Pool design: the 96 budget distractors are reused with their ids (rationale clause stripped to fit 140 chars); 904 new ones
across marts, snapshots, seeds, macros, analyses, Airflow, Python, notebooks, CI, git, Snowflake, BigQuery, Postgres, BI,
contracts, incidents, cost, security, testing, docs, naming of other layers, Terraform, dbt ops, ingestion, semantic layer,
data quality, ML, catalog, vendors, comms, SQL style. A regular distractor may not contain staging vocabulary (regex in
`pool.py` `BANNED`: cents, utc, staging, stg_, timestamp, rename, source(s), soft delete, money/currency, stage); no lesson
sets units/names/filters for staging models, analyses or seeds, and every dbt lesson names its layer. 804 of 1,000 carry
`trigger.paths`. For a typical staging task's touched files, 77 pool lessons match by path (4 real, 12 near, 61 other);
50-pool: 8; 300-pool: 28. Control analysis task: 35 / 15 / 4 (it also surfaces L-2fe6 and L-8536 through `seeds/raw_*.csv`).

Real-lesson trigger paths are the file-hook surface (see `vague_tasks/README.md`). For arms that must not use paths (item 2
text-only retrieval) strip `trigger` when loading.

## Common run mechanics and where each metric comes from

Run records (`harness/eval.py` -> `common.run_task` -> one JSON line per run in `<run-dir>/eval/<label>.jsonl`):

| Metric | Source |
|---|---|
| pass, per-check | `rec["pass"]`, `rec["checks"]` (C1..C6 heldout, K1..K4 controls), messages in `rec["verify"]["checks"]` |
| tokens per call | `rec["tokens"]` {input, output, cache_read, cache_write} / `rec["steps"]` (= generations); first-call input and mean cacheRead per generation from the trace via `budget/analyze.py trace_stats` (`rec["trace_path"]`) |
| cache reads | `rec["tokens"]["cache_read"]` (events `step_finish`), cross-checked with trace `cacheRead` |
| wall time, cost | `rec["duration"]`, `rec["cost"]` (sum of `step_finish.part.cost`) |
| retrieval recall | per run: `tasks_lib.shown_lessons(rec["trace_path"], pool)` -> `recall(task, shown)` against `needs.json`. Playbook arms: ids appear because the whole playbook is in the system prompt. Retrieval arms: prefer the product's frozen-selection record in the learn state (see "needs product") and use the trace search as a cross-check |
| distractors shown | same search, count of shown ids with `kind` near/distractor; precision = needed shown / all shown |
| over-application | control pass rate and K-checks (K4 numbers keep cents; K3 existing columns intact) |
| leak | `rec["leak"]` must be false for every run; discard and rerun otherwise |

Stats: 18 runs per arm = (4 heldout + 2 controls) x 3 runs (`--runs 3`, `--split heldout,control`) unless noted. Report
heldout fully-passing runs and checks passed separately from controls, like `budget/analyze.py` (which excludes
`heldout-support-tickets` from the headline, as in `report_corrections.py`; keep that convention and show it separately).
The supplied shell drivers run arms sequentially. Within an arm, tasks are interleaved by
`run_idx` with `--parallel 4`; this does not control for changes between arm blocks. For
cross-arm temporal balancing, run each driver with `RUNS=1` in fresh output roots and
alternate arm order across repetitions. Do not claim the supplied full-arm runs are interleaved.

Today's command pattern (old behaviour, whole playbook in context):

    cd experiments/rsi-workspace/harness
    python3 eval.py --run-dir runs/v1-<item> --split heldout,control --runs 3 --parallel 4 \
      --arm playbook:v1bench/playbooks/<file>.md --label <label> --out runs/v1-<item>/eval/<label>.jsonl

`none` is `--arm none`; the vague tasks need a 6-line driver that calls `tasks_lib.install(tasks_lib.VAGUE_DIR)` before
`eval.evaluate(..., splits=["vague"])`, plus 3 controls runs with the originals.

## Items

### 1. Baselines
- Arms (18 each): `none`; `real4` = `playbooks/real4-long.md` (old behaviour; equals corr-main final.md content).
  Optional third arm `real4-short` (also feeds item 3).
- Metrics: pass, per-check, tokens/call, cache reads, wall time, cost; recall = 1.0 by construction for `real4`.
- Runs today: yes. Existing corr-main numbers can be used as a sanity check, but rerun in the same session/model.

### 2. Scale and retrieval
- Arms (18 each): `tiered-50`, `tiered-300`, `tiered-1000` (4 relevant hidden among N, retrieval on); `all-300`
  (`playbooks/all-300.md`, load everything; comparison only at 300). Optional `all-50`, `all-1000` for cost curves.
  Optional text-only retrieval variant (trigger paths stripped) to separate path from text signal.
- Inputs: `pool-50.jsonl`, `pool-300.jsonl`, `lessons-1000.jsonl`, `needs.json`.
- Metrics: retrieval recall per task (needed shown / needed), precision, number shown, held-out pass + per-check,
  tokens per call, cache reads (does a stable prefix keep cache reads high when additions vary?), wall time, cost.
- Runs today: `all-300` (and all-50/all-1000) via playbook arms. The harness's old "tiered" arm (`budget/make_arms.py`,
  oracle glob match on the initial workdir files, cap 8) is only a proxy. Needs product: tiered retrieval (always-on
  tier, retrieved tier with limits, frozen selection) and a way to see which lessons were selected (learn state or
  trace event).

### 3. Compression
- Arms (18 each): `real4-long` vs `real4-short`; `n50-long` vs `n50-short` (same 50 lessons, original vs <=140 chars).
- Inputs: `playbooks/real4-*.md`, `playbooks/n50-*.md` (46 reused budget distractors with long originals, real spread evenly).
- Metrics: pass, per-check (does shortening drop the exact identifier? the shorts keep `cents_to_dollars`, `to_utc`, `_at`,
  `where not _is_deleted`), prompt tokens (first-generation input), cost.
- Runs today: all four arms. No product features needed. (If compression also applies to the 300/1000 pools, add
  retrieval arms later; long forms exist only for the 96 reused distractors.)

### 4. Topic switch
- Arms (18 sessions each, `topic_switch/tasks.json`): `none`; `real4-long` loaded at start; `tiered-frozen` (selection from
  request 1 only); `tiered+per-request` (selection refreshed for request 2).
- Inputs: `topic_switch/tasks.json` (3 request-1 prompts x 6 request-2 tasks), pool files, `needs.json`.
- Follow-up: `run ... --session <sid> "<request 2>"` in the same workdir (`topic_switch/README.md`; `run.ts:305,562`,
  precedent `loop_corrections.py:136`). Score: request-2 verifier only.
- Metrics: pass and per-check on request 2; recall at request 2 (was each needed lesson shown during turn 2); turn-2
  tokens, cache reads, cost, wall time (separately from turn 1); whether the lessons were already in context from turn 1.
- Runs today: `none` and `real4-long` through `run_topic_switch.py`. Needs product: frozen selection across turns and
  resumed sessions, per-request additions.

### 5. File hook
- Arms: vague heldout x3 + the 2 original controls x3 = 18 per arm: `none`; `real4-long` (ceiling); `no hook`
  (core and request retrieval disabled); `file hook` (same limits, hook enabled). Optional: same four on the original (non-vague) prompts.
- Inputs: `vague_tasks/*.json`, `vague_tasks/README.md` (lesson -> file map), pool(s), `needs.json`.
- Metrics: pass, per-check, recall (the point: with core/request retrieval disabled, only file hooks can expose L-2fe6/L-8536/L-8201), hook
  firing evidence (which file triggered which lesson), control pass (over-application), tokens/cost.
- Runs today: `none` and `real4-long` on vague tasks (ceiling and floor; also shows whether vague prompts alone hurt).
  Needs product: file hook (read/edit path -> lesson attach) and the retrieval tier.

### 6. Drift (outdated lessons + teammate corrections, 2 iterations, new store, strong and weak reflector)
- Arms: `drift-base` vs `drift-fix` x {strong, weak reflector}, as in `budget/run_drift*.sh` / `run_corrections.sh`
  (`loop_corrections.py`, simulated teammate in `teammate.py`, correction sent as a follow-up with `--session`).
- Inputs: existing drift seeds in `budget/arms/{stale-seed,conflict,overgeneral}.md`; optionally `pool-50` as background
  lessons. No new inputs required.
- Metrics: corrections per session across the 2 iterations, first-attempt LGTM, final heldout pass, stale-lesson
  retirement (lesson store diff), reflector tokens/cost.
- Runs today on the old store only. Needs product: the new store (migration, atomic promote, reviewed hash).

### 7. Bootstrap
- Arms (18 each): `none`; `bootstrap-lessons` (lessons mined from earlier benchmark sessions' history, then held-out run
  with them); optionally `real4-long` as reference.
- Inputs: histories already on disk: `harness/runs/corr-main` (`home-a`, `learn-history`, `logs`, `work`), `saas-main`,
  `saas-v2`, `g*` runs. Record which runs were fed in (must exclude the heldout tasks' own sessions so held-out stays held out).
- Metrics: lessons produced (count, dedupe, overlap with the 4 real: how many of L-2fe6/L-8536/L-8201 are recovered),
  held-out pass + per-check, bootstrap tokens/cost (also item 9).
- Needs product: bootstrap (preview, bounds, dedupe). Cannot run today.

### 8. Review import
- Arms: none (no pass rate claimed). Output: lessons imported from a real repo's merged-PR review comments (read-only).
- Inputs needed: the repo choice (not decided here; blocking, see below) and a rubric for the hand review. Proposed
  rubric per lesson: actionable rule (y/n), identifiers exact (y/n), general beyond one PR (y/n), would a reviewer
  repeat it (y/n), duplicates another (y/n), contains secret/PII/person name (must be n).
- Metrics: PRs scanned, comments read, bots/resolved threads skipped, lessons proposed, % accepted by hand, import
  tokens/cost/time, rate-limit backoffs. Needs product: import-reviews (real `gh`, pagination, dedupe).

### 9. Cost
- No arms. Reflection tokens and dollars per reflection (from item 4/6 sessions), per bootstrap (item 7), per import (item 8).
- Sources: today `learn reflect --json` result in the loop log (`loop_corrections.py:212` stores `result`) and reflector
  events; for new features the learn state's per-operation usage record (to be defined with the product: input/output/cache
  tokens, model, dollars, wall time). Report per operation: median, p90, and total for the whole benchmark.
- Runs today only for reflections on the old store.

## What runs today vs needs product features

| Item | Today | Blocked on |
|---|---|---|
| 1 | all | none |
| 2 | `all-N` arms, oracle-glob proxy | tiered retrieval, selection record |
| 3 | all | none |
| 4 | `none`, `real4` | frozen selection, per-request additions |
| 5 | `none`, `real4` on vague tasks | file hook, retrieval |
| 6 | old store | new store |
| 7 | none | bootstrap, history ingestion |
| 8 | none | import-reviews, repo choice |
| 9 | reflections on old store | usage records for the new operations |

## Suggested order

1 and 3 (no product needed, validates harness and compression) -> baselines for 2/4/5 (`none`, `real4`, `all-300`) -> product
arms as features land -> 6 -> 7 -> 8 -> 9 (aggregated from the others).

## Regeneration and restart semantics

Run `python3 v1bench/pool.py && python3 v1bench/make_playbooks.py` from `harness/`.
Generation is deterministic. Long/short compression pairs preserve lesson IDs and positions;
short staging rules retain their staging scope. The former stale distractor ID `L-033178`
is regenerated as `L-c7cefe` from its committed PROJ-123 text. Historical result files retain
their original observations and must not be compared by that old ID without this mapping.

Evaluation and topic drivers replace their output JSONL on a full retry. Shell drivers skip
an arm only when its file has exactly the expected unique task/session and run-index keys,
with completed agent turns; failed verifier checks still count as valid observations.
Drift learning requires a fresh directory after an interrupted loop. Bootstrap re-prepares
its project and isolated home before mining, and never promotes a failed bootstrap.
