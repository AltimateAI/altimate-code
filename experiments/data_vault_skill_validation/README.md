# Data Vault Skill Validation

Comprehensive eval suite for the `data-vault` skill living at
`.opencode/skills/data-vault/`. Runs deterministic checks against the
skill's structure, content, and the SQL patterns it prescribes.
Designed to be CI-runnable — exits non-zero on any regression.

## What Gets Evaluated

The suite has five independent evals; each can run standalone.

| Suite | What it checks | Runtime |
|-------|----------------|---------|
| `skill_structure` | SKILL.md frontmatter, referenced files exist, links resolve, per-file section coverage, dialect-coverage matrix | < 5 s |
| `sql_correctness` | DV 2.0 rule engine over a curated dataset of hub/link/sat SQL snippets — insert-only enforcement, shared-macro usage, hashdiff discipline, load-metadata correctness | < 10 s |
| `knowledge_qa` | 60+ concept questions with expected key facts and citation targets — verifies the skill actually contains the guidance it should | < 5 s |
| `platform_routing` | Given a customer setup ("Snowflake + dbt", "Databricks + DLT", ...), does the skill route to the correct references? | < 5 s |
| `agent_tasks` | End-to-end tasks with graders — either LLM-graded (requires API key) or deterministic-graded | 30 s – 30 min depending on mode |
| `e2e_dbt` | Real dbt+DuckDB project exercising hub/link/sat patterns from the skill — runs `dbt build`, executes SQL, asserts row-count invariants, verifies idempotency on second run | ~20 s |

Everything except `agent_tasks --mode llm` runs offline. The `e2e_dbt`
suite requires `dbt-core` and `dbt-duckdb`, installed as sibling
Python packages.

## Quickstart

```bash
# From the repo root
cd experiments/data_vault_skill_validation

# Run every eval and produce a unified report
python run_all.py

# Run one eval
python skill_structure/run.py
python sql_correctness/run.py --input sql_correctness/dataset.json --output sql_correctness/results/
python knowledge_qa/run.py --input knowledge_qa/dataset.json --output knowledge_qa/results/
python platform_routing/run.py --input platform_routing/dataset.json --output platform_routing/results/

# Agent-task eval (deterministic mode — no LLM required)
python agent_tasks/run.py --mode deterministic --input agent_tasks/dataset.json --output agent_tasks/results/

# Agent-task eval (LLM mode — needs an API key)
export OPENROUTER_API_KEY=...
python agent_tasks/run.py --mode llm --model moonshotai/kimi-k2.6 \
    --input agent_tasks/dataset.json --output agent_tasks/results/

# Report on a previous run
python skill_structure/report.py --input skill_structure/results/
```

Exit codes:
- `0` — all checks passed.
- `1` — one or more failures.
- `2` — the eval harness itself is broken (missing file, invalid dataset).

## Directory Layout

```text
data_vault_skill_validation/
├── README.md                              ← you are here
├── __init__.py
├── run_all.py                             ← runs every eval and produces unified report
├── report_all.py                          ← report on last run of every eval
│
├── skill_structure/                       ← eval #1
│   ├── __init__.py
│   ├── run.py                             ← executes structure checks
│   ├── report.py                          ← formats results
│   └── results/                           ← JSON outputs
│
├── sql_correctness/                       ← eval #2
│   ├── __init__.py
│   ├── dataset.json                       ← DV SQL snippets + expected rule violations
│   ├── rule_engine.py                     ← DV 2.0-specific pattern checkers
│   ├── run.py                             ← runs rule_engine over dataset
│   ├── report.py                          ← per-rule accuracy report
│   └── results/
│
├── knowledge_qa/                          ← eval #3
│   ├── __init__.py
│   ├── dataset.json                       ← concept Qs + expected facts + citation targets
│   ├── run.py                             ← verifies citations resolve to real content
│   ├── report.py
│   └── results/
│
├── platform_routing/                      ← eval #4
│   ├── __init__.py
│   ├── dataset.json                       ← customer setups + expected reference routing
│   ├── run.py
│   ├── report.py
│   └── results/
│
└── agent_tasks/                           ← eval #5
    ├── __init__.py
    ├── dataset.json                       ← end-to-end tasks + graders
    ├── graders.py                         ← per-task deterministic graders
    ├── run.py                             ← LLM or deterministic mode
    ├── report.py
    └── results/
```

## Adding a New Test Case

**To add a SQL-correctness case** — append an entry to
`sql_correctness/dataset.json`:

```json
{
  "id": "hub_using_merge_bad",
  "category": "hub",
  "sql": "{{ config(materialized='incremental', incremental_strategy='merge') }}\n\nSELECT ...",
  "expected_violations": ["hub_uses_merge_strategy"],
  "notes": "Regression from 2026-Q1 incident"
}
```

Then run `python sql_correctness/run.py` — no code change needed.

**To add a knowledge question** — append to `knowledge_qa/dataset.json`
with `question`, `key_facts` (list of substrings the answer must
contain), and `citations` (list of `{file: "references/x.md",
must_contain: "phrase"}` entries the runner will verify).

**To add a platform-routing scenario** — append to
`platform_routing/dataset.json` with `setup` (free-text description)
and `expected_references` (list of files the skill should route to).

**To add a rule to the rule engine** — add a `check_*` function in
`sql_correctness/rule_engine.py`; register it in the `RULES` list.
Add positive and negative test cases to `dataset.json`.

## CI Integration

`.github/workflows/eval-data-vault-skill.yml` runs the full suite on
every push touching `.opencode/skills/data-vault/**` or
`experiments/data_vault_skill_validation/**`. See
`../.github/workflows/` for the template used by other experiments.

## Interpreting Failures

**skill_structure failure**: something structural changed in the
skill — a reference was renamed, a link broke, frontmatter is
malformed. Fix the skill or update the eval to match a legitimate
change.

**sql_correctness failure**: the rule engine caught a bug in a SQL
snippet the skill teaches. Either the snippet is a genuine bug (fix
the skill) or the rule engine has a false positive (fix the eval).

**knowledge_qa failure**: an expected fact or citation is missing
from the skill. Either the guidance was removed (add it back) or
the QA dataset is stale (update it).

**platform_routing failure**: the skill's "Step 0 — Detect" section
no longer covers a platform / tool combination. Add coverage.

**agent_tasks failure (deterministic mode)**: a task-specific grader
found a defect in a sample answer stored in the dataset.

**agent_tasks failure (LLM mode)**: the model, given the skill,
produced output that failed the grader. Investigate — the skill may
be missing guidance, ambiguous, or the model may have ignored it.

## Design Philosophy

- **Deterministic > flaky.** Every eval except `agent_tasks --mode llm`
  is byte-for-byte reproducible. No LLM calls, no network, no random
  seeds.
- **Regressions must fail loudly.** Every past bug or design decision
  gets a test case; changes that violate them break CI.
- **Fast enough for pre-commit.** The four offline evals finish in
  under 30 seconds combined. `agent_tasks --mode llm` is opt-in for
  full releases.
- **Same shape as `experiments/sql_analyze_validation/` and
  `experiments/lineage_validation/`.** Dataset JSON + generator +
  runner + reporter + `results/` — consistent with the rest of the
  repo.
