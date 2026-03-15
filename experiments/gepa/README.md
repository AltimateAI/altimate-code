# GEPA: Genetic-Pareto Evolutionary Prompt Adaptation

GEPA is a prompt optimization framework that evolves the altimate-code builder agent prompt (`builder.txt`) to maximize Spider 2.0-DBT benchmark scores using Pareto-frontier-based multi-objective optimization.

## How It Works

GEPA treats each benchmark instance as a separate objective. Rather than optimizing a single aggregate score, it maintains a **Pareto frontier** of non-dominated prompt variants -- variants where no other variant solves a strict superset of instances.

### Algorithm

1. **Seed**: Load the current `builder.txt` and evaluate it against the benchmark
2. **Select**: Pick 2 parent prompts from the Pareto frontier (tournament selection)
3. **Reflect**: Use an LLM to analyze why each parent failed on specific instances, producing actionable "lessons"
4. **Merge**: Use an LLM to intelligently merge both parents + lessons into a new prompt variant, preserving the structural sections of builder.txt
5. **Evaluate**: Run the new variant against the benchmark
6. **Filter**: Anti-regression check (must solve all instances the seed solves) + Pareto dominance check
7. **Repeat** for N generations

### Anti-Regression Guarantee

Every new variant must solve all instances that the original seed prompt solves. This prevents "creative destruction" where improving on some tasks causes regressions on others.

## Architecture

```
experiments/gepa/
  __init__.py          # Package marker
  pareto.py            # Pareto frontier management (PromptVariant, ParetoFrontier)
  evaluator.py         # Pluggable evaluation (BenchmarkEvaluator, MockEvaluator, ResultsEvaluator)
  reflector.py         # LLM-driven failure analysis (Lesson, reflect_on_failure, batch_reflect)
  merger.py            # Structure-aware prompt merging (merge_prompts)
  gepa_runner.py       # Main orchestrator with CLI
  README.md            # This file
```

## Usage

### Dry Run (Mock Evaluator)

Create a mock scores file first:

```json
{
    "instance_scores": {
        "playbook001": 1.0,
        "provider001": 0.0,
        "asana001": 1.0,
        "shopify001": 0.0
    }
}
```

Then run:

```bash
python -m experiments.gepa.gepa_runner \
    --seed-prompt packages/opencode/src/altimate/prompts/builder.txt \
    --generations 5 \
    --evaluator mock \
    --mock-scores experiments/gepa/mock_scores.json \
    --output-dir experiments/gepa/output
```

### Full Benchmark Run

```bash
python -m experiments.gepa.gepa_runner \
    --seed-prompt packages/opencode/src/altimate/prompts/builder.txt \
    --generations 10 \
    --evaluator benchmark \
    --benchmark-script experiments/spider2_dbt/run_benchmark.py \
    --parallel 4 \
    --output-dir experiments/gepa/output
```

### Evaluate Existing Results

```bash
python -m experiments.gepa.gepa_runner \
    --seed-prompt packages/opencode/src/altimate/prompts/builder.txt \
    --generations 10 \
    --evaluator results \
    --result-dir experiments/spider2_dbt/workspace/run_001 \
    --output-dir experiments/gepa/output
```

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--seed-prompt` | (required) | Path to initial builder.txt |
| `--generations` | 10 | Number of evolutionary generations |
| `--population-size` | 20 | Population size hint |
| `--parallel` | 4 | Benchmark parallelism |
| `--output-dir` | `experiments/gepa/output` | Output directory |
| `--evaluator` | mock | `benchmark`, `mock`, or `results` |
| `--mock-scores` | - | Mock scores JSON path |
| `--mock-perturbation` | 0.05 | Score flip rate for mock evaluator |
| `--benchmark-script` | - | Path to benchmark runner |
| `--result-dir` | - | Existing results directory |
| `--gold-dir` | - | Gold data directory |
| `--model` | `claude-sonnet-4-20250514` | Anthropic model for reflection/merging |
| `--max-reflect-failures` | 10 | Max failures to analyze per parent |
| `--log-level` | INFO | Logging level |

## Output

After a run, `--output-dir` contains:

- `frontier_final.json` -- Full Pareto frontier with all non-dominated variants
- `frontier_checkpoint.json` -- Checkpoint for resuming interrupted runs
- `best_prompt.txt` -- The highest-scoring prompt variant
- `summary.json` -- Run statistics
- `run_config.json` -- Configuration used for the run
- `prompts/` -- All prompt variants generated during the run

## Cost Estimates

Each generation involves:
- **2 batch reflections** (up to `max_reflect_failures` API calls each): ~$0.10-0.50 per batch at 10 failures
- **1 merge** call: ~$0.05-0.10
- **1 benchmark evaluation** (if using benchmark evaluator): compute-dependent

For a 10-generation run with mock evaluator: ~$2-6 in Anthropic API costs.
For a 10-generation run with full benchmark: ~$2-6 API + benchmark compute costs.

## Resuming Interrupted Runs

GEPA saves a checkpoint after each generation. To resume, simply run the same command with the same `--output-dir`. It will detect the checkpoint and continue from where it left off.

## Dependencies

- Python 3.11+
- `anthropic` (pip install anthropic)
- `ANTHROPIC_API_KEY` environment variable must be set
