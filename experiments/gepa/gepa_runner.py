"""GEPA: Genetic-Pareto Evolutionary Prompt Adaptation.

Main orchestrator that evolves builder.txt prompts to maximize
Spider 2.0-DBT benchmark scores using Pareto-frontier-based
multi-objective optimization.

Usage:
    python -m experiments.gepa.gepa_runner \
        --seed-prompt packages/opencode/src/altimate/prompts/builder.txt \
        --generations 10 \
        --evaluator mock \
        --mock-scores experiments/gepa/mock_scores.json \
        --output-dir experiments/gepa/output
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .evaluator import (
    BenchmarkEvaluator,
    EvaluationResult,
    Evaluator,
    MockEvaluator,
    ResultsEvaluator,
    create_evaluator,
)
from .merger import merge_prompts
from .pareto import ParetoFrontier, PromptVariant
from .reflector import Lesson, batch_reflect

logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def generate_variant_id(generation: int) -> str:
    """Generate a unique variant ID with generation prefix."""
    short_uuid = uuid.uuid4().hex[:8]
    return f"gen{generation:03d}_{short_uuid}"


def load_failure_metadata(
    failures: list[str],
    result_dir: Path | None = None,
    task_jsonl: Path | None = None,
) -> list[dict[str, str]]:
    """Load task descriptions and agent outputs for failed instances.

    Intentionally does NOT load gold/expected answers. Lessons must be
    derived from the agent's process failures, not from knowing the
    correct answer. This ensures prompt improvements are general-purpose
    and not benchmark-specific.

    Tries to load from result directories. Falls back to placeholder
    descriptions if files are not available.
    """
    # Load task descriptions from the task JSONL (instructions, not answers)
    task_jsonl = task_jsonl or (REPO_ROOT / "experiments" / "spider2_dbt" / "spider2_repo" / "spider2-dbt" / "examples" / "spider2-dbt.jsonl")
    task_descriptions: dict[str, str] = {}
    if task_jsonl.exists():
        with open(task_jsonl) as f:
            for line in f:
                data = json.loads(line.strip())
                iid = data.get("instance_id", "")
                desc = data.get("instruction", data.get("question", ""))
                if iid:
                    task_descriptions[iid] = desc

    failure_data = []
    for instance_id in failures:
        entry: dict[str, str] = {"instance_id": instance_id}

        # Task description from the task JSONL (what the agent was asked to do)
        if instance_id in task_descriptions:
            entry["task_description"] = task_descriptions[instance_id][:2000]
        else:
            entry["task_description"] = f"Benchmark task: {instance_id}"

        # NOTE: gold_answer is intentionally NOT loaded here.
        # The reflector must diagnose failures from process/output analysis only.

        # Try to load agent output
        if result_dir:
            agent_log = result_dir / instance_id / "agent_output.txt"
            if agent_log.exists():
                entry["agent_output"] = agent_log.read_text()[:3000]
            else:
                # Try results_metadata.jsonl
                results_meta = result_dir / "results_metadata.jsonl"
                if results_meta.exists():
                    with open(results_meta) as f:
                        for line in f:
                            data = json.loads(line.strip())
                            if data.get("instance_id") == instance_id:
                                entry["agent_output"] = json.dumps(data)
                                break
                if "agent_output" not in entry:
                    entry["agent_output"] = "Agent output not available"
        else:
            entry["agent_output"] = "Agent output not available (no result_dir)"

        failure_data.append(entry)

    return failure_data


def run_gepa(
    seed_prompt_path: Path,
    generations: int,
    population_size: int,
    evaluator: Evaluator,
    output_dir: Path,
    model: str = "claude-sonnet-4-20250514",
    max_reflect_failures: int = 10,
    result_dir: Path | None = None,
) -> ParetoFrontier:
    """Run the GEPA evolutionary loop.

    Algorithm:
    1. Load seed prompt, evaluate it
    2. Initialize Pareto frontier with seed
    3. For each generation:
       a. Select 2 parents from frontier
       b. Reflect on failures of each parent
       c. Merge parents + lessons -> new variant
       d. Evaluate new variant
       e. Anti-regression: must solve all seed instances
       f. Add to frontier if not dominated
    4. Save final frontier + best prompt

    Args:
        seed_prompt_path: Path to the initial builder.txt prompt.
        generations: Number of evolutionary generations to run.
        population_size: Max population size (unused for now, frontier is unbounded).
        evaluator: Evaluator instance to score prompts.
        output_dir: Directory to save results and checkpoints.
        model: Anthropic model for reflection and merging.
        max_reflect_failures: Max failures to reflect on per parent per generation.
        result_dir: Optional path to benchmark results for loading failure metadata.

    Returns:
        The final ParetoFrontier.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    prompts_dir = output_dir / "prompts"
    prompts_dir.mkdir(exist_ok=True)

    # Load seed prompt
    seed_text = seed_prompt_path.read_text()
    logger.info("Loaded seed prompt from %s (%d chars)", seed_prompt_path, len(seed_text))

    # Check for existing checkpoint
    checkpoint_path = output_dir / "frontier_checkpoint.json"
    if checkpoint_path.exists():
        logger.info("Found checkpoint at %s, resuming", checkpoint_path)
        frontier = ParetoFrontier.load(checkpoint_path)
        # Find the last generation
        last_gen = max((v.generation for v in frontier.variants), default=0)
        start_gen = last_gen + 1
        # Get seed scores from the seed variant
        seed_variant = next((v for v in frontier.variants if v.generation == 0), None)
        if seed_variant:
            seed_solved = seed_variant.solved_set
        else:
            seed_solved = set()
    else:
        # Evaluate seed prompt
        logger.info("Evaluating seed prompt...")
        seed_result = evaluator.evaluate(seed_text, "seed_000")
        logger.info(
            "Seed prompt: %d/%d solved (%.1f%%)",
            seed_result.total_solved,
            seed_result.total_instances,
            seed_result.accuracy * 100,
        )

        seed_variant = PromptVariant(
            id="seed_000",
            text=seed_text,
            scores=seed_result.scores,
            parent_ids=[],
            generation=0,
            lessons=[],
        )
        seed_solved = seed_variant.solved_set

        # Save seed prompt
        (prompts_dir / "seed_000.txt").write_text(seed_text)

        # Initialize frontier
        frontier = ParetoFrontier()
        frontier.add(seed_variant)
        start_gen = 1

    # Save run config
    run_config = {
        "seed_prompt": str(seed_prompt_path),
        "generations": generations,
        "population_size": population_size,
        "model": model,
        "max_reflect_failures": max_reflect_failures,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "seed_solved": len(seed_solved),
    }
    (output_dir / "run_config.json").write_text(json.dumps(run_config, indent=2))

    # Evolution loop
    for gen in range(start_gen, generations + 1):
        gen_start = time.time()
        logger.info("=" * 60)
        logger.info("GENERATION %d/%d", gen, generations)
        logger.info("=" * 60)

        # Step 1: Select parents
        parents = frontier.select_parents(n=2)
        parent1, parent2 = parents[0], parents[1] if len(parents) > 1 else parents[0]
        logger.info(
            "Selected parents: %s (%d solved) and %s (%d solved)",
            parent1.id, parent1.total_solved, parent2.id, parent2.total_solved,
        )

        # Step 2: Reflect on failures
        p1_failures = parent1.scores
        p1_failed_ids = [k for k, v in p1_failures.items() if v < 1.0][:max_reflect_failures]
        p2_failed_ids = [k for k, v in parent2.scores.items() if v < 1.0][:max_reflect_failures]

        p1_failure_data = load_failure_metadata(p1_failed_ids, result_dir=result_dir)
        p2_failure_data = load_failure_metadata(p2_failed_ids, result_dir=result_dir)

        logger.info("Reflecting on %d + %d failures...", len(p1_failure_data), len(p2_failure_data))
        lessons1 = batch_reflect(parent1.text, p1_failure_data, model=model)
        lessons2 = batch_reflect(parent2.text, p2_failure_data, model=model)
        logger.info("Got %d + %d lessons", len(lessons1), len(lessons2))

        # Step 3: Merge parents + lessons
        logger.info("Merging prompts...")
        try:
            merged_text = merge_prompts(
                parent1_text=parent1.text,
                parent2_text=parent2.text,
                lessons1=lessons1,
                lessons2=lessons2,
                parent1_id=parent1.id,
                parent2_id=parent2.id,
                parent1_solved=parent1.total_solved,
                parent2_solved=parent2.total_solved,
                model=model,
            )
        except ValueError as e:
            logger.error("Merge failed: %s. Skipping generation.", e)
            continue

        variant_id = generate_variant_id(gen)

        # Save the merged prompt
        (prompts_dir / f"{variant_id}.txt").write_text(merged_text)

        # Step 4: Evaluate
        logger.info("Evaluating merged variant %s...", variant_id)
        eval_result = evaluator.evaluate(merged_text, variant_id)
        logger.info(
            "Variant %s: %d/%d solved (%.1f%%)",
            variant_id,
            eval_result.total_solved,
            eval_result.total_instances,
            eval_result.accuracy * 100,
        )

        # Step 5: Anti-regression check
        new_solved = {k for k, v in eval_result.scores.items() if v >= 1.0}
        regressions = seed_solved - new_solved
        if regressions:
            logger.warning(
                "ANTI-REGRESSION VIOLATION: Variant %s lost %d seed instances: %s",
                variant_id,
                len(regressions),
                sorted(regressions),
            )
            logger.warning("Skipping this variant due to regressions.")
            _log_generation_summary(gen, gen_start, frontier, variant_id, eval_result, rejected=True, reason="regression")
            continue

        # Step 6: Add to frontier
        all_lessons = [l.to_dict() for l in lessons1 + lessons2]
        variant = PromptVariant(
            id=variant_id,
            text=merged_text,
            scores=eval_result.scores,
            parent_ids=[parent1.id, parent2.id],
            generation=gen,
            lessons=all_lessons,
        )

        added = frontier.add(variant)
        if added:
            logger.info("Variant %s added to frontier!", variant_id)
            # Check for new instances solved
            new_instances = new_solved - seed_solved
            if new_instances:
                logger.info(
                    "NEW INSTANCES SOLVED (vs seed): %s",
                    sorted(new_instances),
                )
        else:
            logger.info("Variant %s dominated, not added to frontier.", variant_id)

        # Save checkpoint
        frontier.save(checkpoint_path)
        _log_generation_summary(gen, gen_start, frontier, variant_id, eval_result, rejected=not added)

    # Final summary
    summary = frontier.summary()
    logger.info("=" * 60)
    logger.info("GEPA COMPLETE")
    logger.info("=" * 60)
    logger.info("Frontier size: %d", summary["frontier_size"])
    logger.info("Total unique solved: %d", summary["total_unique_solved"])
    logger.info("Best variant: %s (solved %d)", summary["best_variant_id"], summary["best_variant_solved"])
    logger.info("Seed solved: %d", len(seed_solved))
    logger.info(
        "Improvement: +%d instances",
        summary["best_variant_solved"] - len(seed_solved),
    )

    # Save final outputs
    frontier.save(output_dir / "frontier_final.json")
    (output_dir / "summary.json").write_text(json.dumps(summary, indent=2))

    # Save best prompt
    best_id = summary["best_variant_id"]
    if best_id:
        best_variant = next(v for v in frontier.variants if v.id == best_id)
        (output_dir / "best_prompt.txt").write_text(best_variant.text)
        logger.info("Best prompt saved to %s", output_dir / "best_prompt.txt")

    return frontier


def _log_generation_summary(
    gen: int,
    gen_start: float,
    frontier: ParetoFrontier,
    variant_id: str,
    eval_result: EvaluationResult,
    rejected: bool = False,
    reason: str = "",
) -> None:
    """Log a structured generation summary."""
    elapsed = time.time() - gen_start
    summary = frontier.summary()
    status = "REJECTED" if rejected else "ACCEPTED"
    if reason:
        status += f" ({reason})"

    logger.info(
        "Gen %d summary: variant=%s status=%s solved=%d/%d "
        "frontier_size=%d best=%d elapsed=%.1fs",
        gen, variant_id, status,
        eval_result.total_solved, eval_result.total_instances,
        summary["frontier_size"], summary["best_variant_solved"],
        elapsed,
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="GEPA: Genetic-Pareto Evolutionary Prompt Adaptation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  # Dry run with mock evaluator
  python -m experiments.gepa.gepa_runner \\
      --seed-prompt packages/opencode/src/altimate/prompts/builder.txt \\
      --generations 5 --evaluator mock \\
      --mock-scores experiments/gepa/mock_scores.json

  # Full benchmark run
  python -m experiments.gepa.gepa_runner \\
      --seed-prompt packages/opencode/src/altimate/prompts/builder.txt \\
      --generations 10 --evaluator benchmark \\
      --benchmark-script experiments/spider2_dbt/run_benchmark.py \\
      --parallel 4
""",
    )
    parser.add_argument(
        "--seed-prompt",
        type=Path,
        required=True,
        help="Path to the seed prompt (builder.txt)",
    )
    parser.add_argument(
        "--generations",
        type=int,
        default=10,
        help="Number of evolutionary generations (default: 10)",
    )
    parser.add_argument(
        "--population-size",
        type=int,
        default=20,
        help="Max population size hint (default: 20)",
    )
    parser.add_argument(
        "--parallel",
        type=int,
        default=4,
        help="Parallelism for benchmark evaluation (default: 4)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("experiments/gepa/output"),
        help="Output directory for results (default: experiments/gepa/output)",
    )
    parser.add_argument(
        "--evaluator",
        choices=["benchmark", "mock", "results"],
        default="mock",
        help="Evaluator type (default: mock)",
    )
    parser.add_argument(
        "--mock-scores",
        type=Path,
        help="Path to mock scores JSON (required if evaluator=mock)",
    )
    parser.add_argument(
        "--mock-perturbation",
        type=float,
        default=0.05,
        help="Perturbation rate for mock evaluator (default: 0.05)",
    )
    parser.add_argument(
        "--benchmark-script",
        type=str,
        help="Path to benchmark runner script (required if evaluator=benchmark)",
    )
    parser.add_argument(
        "--result-dir",
        type=Path,
        help="Path to existing benchmark results (for evaluator=results or failure metadata)",
    )
    parser.add_argument(
        "--gold-dir",
        type=Path,
        help="Path to gold data directory (used ONLY for scoring, never shown to reflector)",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="claude-sonnet-4-20250514",
        help="Anthropic model for reflection/merging (default: claude-sonnet-4-20250514)",
    )
    parser.add_argument(
        "--max-reflect-failures",
        type=int,
        default=10,
        help="Max failures to reflect on per parent (default: 10)",
    )
    parser.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        default="INFO",
        help="Log level (default: INFO)",
    )

    args = parser.parse_args(argv)

    # Validation
    if args.evaluator == "mock" and not args.mock_scores:
        parser.error("--mock-scores is required when --evaluator=mock")
    if args.evaluator == "benchmark" and not args.benchmark_script:
        parser.error("--benchmark-script is required when --evaluator=benchmark")
    if args.evaluator == "results" and not args.result_dir:
        parser.error("--result-dir is required when --evaluator=results")

    return args


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)

    # Configure logging
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # Create evaluator
    if args.evaluator == "mock":
        evaluator = MockEvaluator(
            scores_path=str(args.mock_scores),
            perturbation=args.mock_perturbation,
        )
    elif args.evaluator == "benchmark":
        evaluator = BenchmarkEvaluator(
            parallel=args.parallel,
            benchmark_script=args.benchmark_script,
        )
    elif args.evaluator == "results":
        evaluator = ResultsEvaluator(
            result_dir=str(args.result_dir),
            gold_dir=str(args.gold_dir) if args.gold_dir else None,
        )
    else:
        raise ValueError(f"Unknown evaluator: {args.evaluator}")

    # Run GEPA
    frontier = run_gepa(
        seed_prompt_path=args.seed_prompt,
        generations=args.generations,
        population_size=args.population_size,
        evaluator=evaluator,
        output_dir=args.output_dir,
        model=args.model,
        max_reflect_failures=args.max_reflect_failures,
        result_dir=args.result_dir,
    )

    # Print final summary
    summary = frontier.summary()
    print("\n" + "=" * 60)
    print("GEPA RUN COMPLETE")
    print("=" * 60)
    print(f"Frontier size:      {summary['frontier_size']}")
    print(f"Total unique solved: {summary['total_unique_solved']}")
    print(f"Best variant:       {summary['best_variant_id']}")
    print(f"Best solved:        {summary['best_variant_solved']}")
    print(f"Output directory:   {args.output_dir}")
    print("=" * 60)


if __name__ == "__main__":
    main()
