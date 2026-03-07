# Spider 2.0-DBT Benchmark Evaluation

Evaluate **altimate-code** against the [Spider 2.0-DBT](https://spider2-dbt.github.io/) benchmark — 68 real-world dbt + DuckDB data engineering tasks.

## Quick Start

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Setup (clone Spider2 repo, download databases)
python setup_spider2.py

# 3. Run benchmark (all 68 tasks)
python run_benchmark.py

# 4. Evaluate against gold standard
python evaluate_results.py

# 5. Generate interactive HTML report
python report.py
```

## Smoke Test (5 tasks)

```bash
python run_benchmark.py --tasks 5
python evaluate_results.py
python report.py
```

## CLI Options

### `run_benchmark.py`

| Flag | Default | Description |
|------|---------|-------------|
| `--tasks N` | all | First N tasks |
| `--tasks id1 id2` | all | Specific task IDs |
| `--timeout` | 600 | Seconds per task |
| `--model` | `anthropic/claude-opus-4-6` | Model to use |
| `--agent` | default | Agent to use |
| `--no-resume` | off | Force re-run all tasks |
| `--dry-run` | off | Print tasks without running |

### `evaluate_results.py`

| Flag | Default | Description |
|------|---------|-------------|
| `--results` | latest | Path to benchmark results JSON |

### `report.py`

| Flag | Default | Description |
|------|---------|-------------|
| `--evaluation` | latest | Path to evaluation JSON |
| `--output` | auto | Output HTML file path |

## Directory Structure

```
experiments/spider2_dbt/
├── config.py              # Paths, leaderboard data, defaults
├── setup_spider2.py       # One-time: clone Spider2, download data
├── prompt_template.py     # Prompt engineering for each task
├── run_benchmark.py       # Runner: invoke altimate-code per task
├── evaluate_results.py    # Bridge to Spider2's official eval_utils
├── report.py              # Generate interactive single-file HTML report
├── requirements.txt       # Python deps
├── results/               # Timestamped JSON results
│   └── incremental/       # Per-task results for resumability
├── reports/               # Generated HTML reports
├── workspace/             # Per-task dbt project copies (gitignored)
└── spider2_repo/          # Cloned Spider2 repository (gitignored)
```

## Resumability

The benchmark runner saves per-task results to `results/incremental/`. If interrupted, re-running `python run_benchmark.py` will skip completed tasks. Use `--no-resume` to force a full re-run.

## Report Features

The HTML report is a single self-contained file (no external dependencies):

- **Summary cards**: Pass rate, total time, model, rank
- **Leaderboard chart**: SVG bar chart with all Spider2 entries + altimate-code highlighted
- **Category breakdown**: Tasks grouped by domain with pass/fail counts
- **Per-task table**: Sortable, filterable, with expandable agent logs
- **Timing histogram**: Distribution of execution times

## Leaderboard Context

Current Spider 2.0-DBT leaderboard (as of 2025):

| Agent | Pass Rate |
|-------|-----------|
| Databao Agent | 44.11% |
| MLE-Bench Agent | 38.24% |
| Claude 3.5 Sonnet (CoT) | 36.76% |
| GPT-4o (CoT) | 33.82% |
| CodeS Agent | 32.35% |
| OpenHands Agent | 30.88% |
| SWE-Agent | 27.94% |
