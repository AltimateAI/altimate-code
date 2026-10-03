# RSI research harness

Research tooling only. Model-driven suites incur provider charges; the self-tests below do not.
The learning loops, v1 delivery, bootstrap, and drift suites require the **`learn` features from
PR #1405**. This harness-only branch does not supply them. Use a checkout containing those
features through `ALTIMATE_CMD`; changing product code is outside this experiment.
The verifier, fake backend, and local `none`/`gold`/`playbook` evaluation arms do not need `learn`.

Prerequisites: Bun, Git, repository dependencies installed for the selected CLI, and Python
3.10+ for the dbt environment (harness syntax supports 3.9+). The local checks used Python 3.11.
For example, from the repository root:

```bash
python3.11 -m venv /tmp/rsi-dbt
/tmp/rsi-dbt/bin/pip install dbt-core==1.12.5 dbt-duckdb==1.11.0
export DBT_BIN=/tmp/rsi-dbt/bin/dbt
export DBT_PYTHON=/tmp/rsi-dbt/bin/python
```

Pin package versions and record the CLI commit and model IDs alongside any reported results.
The shared default CLI is this repository's `packages/opencode/src/index.ts`; baseline and fix
comparison wrappers retain their historical `rsi-base` and `rsi` worktrees. An override is a
shell-quoted command string, e.g. `ALTIMATE_CMD="bun run --conditions=browser '/path with spaces/src/index.ts'"`.
Model-driven runs need provider authentication usable from the isolated homes. Account/org policies
may block Claude, including Claude on Vertex; choose models your account can use. The harness checks
requested model IDs before evaluation and treats timeouts, errors and incomplete turns as failed runs.

## Running suites

Free local checks (from the repository root):

```bash
experiments/rsi-workspace/demo/run_task.sh selftest
python3 experiments/rsi-workspace/fake-backend/selftest.py
python3 experiments/rsi-workspace/harness/selftest.py
python3 experiments/rsi-workspace/harness/v1bench/selftest.py
```

Model-driven suites, from `experiments/rsi-workspace/harness/`:

```bash
bash run_all.sh my-ci-loop                 # train / validation gate / publish / heldout arms
bash run_corrections.sh my-corrections     # simulated teammate corrections / publish / eval
python3 eval.py --arm gold --runs 1 --run-id my-eval --out runs/my-eval/eval/gold.jsonl
bash run_arms.sh my-ci-loop                # rerun final arms of an existing completed loop
python3 publish_replace.py runs/my-ci-loop # recover publishing using supported publish/update
bash budget/run_budget.sh                 # rule-budget arms
bash budget/run_budget2.sh                # scope/conflict arms
bash budget/run_drift.sh my-drift "${REFLECTOR_MODEL:-google-vertex/gemini-3.5-flash}"
FIX_SRC_ROOT=/path/to/fix-checkout bash budget/run_drift_matrix.sh
FIX_SRC_ROOT=/path/to/fix-checkout bash budget/run_drift_matrix2.sh
bash v1bench/run_baselines.sh              # n50-short / all-50 / all-300 / all-1000
bash v1bench/run_all_v1.sh                 # retrieval, vague task, topic, bootstrap, drift suites
bash v1bench/run_fix_v1.sh                 # focused fix comparison (ALTIMATE_CMD selects checkout)
```

See [v1 suite plan](harness/v1bench/PLAN.md), [topic switch](harness/v1bench/topic_switch/README.md),
[vague tasks](harness/v1bench/vague_tasks/README.md), [demo](demo/README.md), and
[fake backend](fake-backend/README.md) for task definitions and additional switches.
`fake-backend/demo.sh` runs the model-driven two-user workspace demo.
IDs must be simple names (letters/digits plus `.`, `_`, `-`); empty, absolute and traversing IDs
are rejected. Main loops require a fresh run ID. Recovery/evaluation replaces complete arm output;
v1 resumes only outputs containing the exact unique expected task/run keys.

## Environment

| Variable | Default / meaning |
|---|---|
| `ALTIMATE_CMD` | Bun CLI in this repository; honors quoted paths |
| `DBT_BIN`, `DBT_PYTHON` | `dbt` on PATH; Python beside dbt, or explicitly selected interpreter |
| `AGENT_MODEL` | Shared Python drivers: `google-vertex-anthropic/claude-haiku-4-5@20251001`; v1 and budget drift shell drivers: `google-vertex/gemini-3.5-flash` |
| `REFLECTOR_MODEL`, `REVIEWER_MODEL` | Shared default: `google-vertex-anthropic/claude-sonnet-4-6@default`; drift shell reviewer: `google-vertex/gemini-3.1-pro-preview`; independently overridable |
| `BACKEND` | Historical default `saas`, requiring explicit opt-in; `fake` uses loopback and isolated test users |
| `ALLOW_REAL_SAAS` | Unset; must equal `1` to permit real workspace access |
| `WORKSPACE_ID` / `--workspace-id` | Required positive ID for SaaS; binding must resolve to it |
| `SAAS_CREDS_DIR` | No default; explicit directory containing `home-a/.altimate/altimate.json` and `home-b/...` for SaaS |
| `RUNS`, `PARALLEL`, `K`, `RUNS_VAL` | Wrapper sample count, concurrency, iterations and validation repetitions |
| `AGENT_TIMEOUT`, `STAGGER_SECONDS` | Agent deadline (600s), startup spacing (3s) |
| `BASELINE_FROM` | Corrections driver defaults to `runs/saas-v2/eval/none.jsonl`; set empty to evaluate anew; retain original logs when reusing |
| `FIX_SRC_ROOT`, `STRONG_MODEL`, `WEAK_MODEL` | Drift matrix checkout (historical `rsi-fix` worktree by default), reflector choices |
| `BUDGET_REAL_FILE` | Optional real-lesson source; defaults to `runs/corr-main/playbooks/final.md` |
| `FAKE_DEBUG_TOKEN` | Standalone fake-server admin token; unset disables debug routes; harness generates its own |

SaaS publishing can update an existing **owned** `team-playbook`. Only run it against an intended test
workspace, with `BACKEND=saas ALLOW_REAL_SAAS=1 WORKSPACE_ID=... SAAS_CREDS_DIR=...` (Python entrypoints use
`--backend saas --workspace-id ...`). No real SaaS or paid benchmark is needed for self-tests.

Lesson pools/playbooks are deterministic: regenerate with `python3 harness/v1bench/pool.py` then
`python3 harness/v1bench/make_playbooks.py` from this directory. Committed pools, playbooks, lesson IDs/order, and benchmark treatment defaults match `780168ab18`.
Historical result Markdown predates these verifier and delivery fixes; it is retained as historical evidence,
not rescored or claimed as current benchmark results.
