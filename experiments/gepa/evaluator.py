"""Evaluation interface for GEPA prompt optimization.

Provides pluggable evaluators:
- BenchmarkEvaluator: shells out to the Spider 2.0-DBT benchmark runner
- ResultsEvaluator: reads existing results and runs evaluate.py logic
- MockEvaluator: reads pre-computed scores from a JSON file for dev/testing
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import tempfile
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Paths relative to the repo root
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
BUILDER_PROMPT_PATH = REPO_ROOT / "packages" / "opencode" / "src" / "altimate" / "prompts" / "builder.txt"
EVAL_SUITE_DIR = REPO_ROOT / "experiments" / "spider2_dbt" / "spider2_repo" / "spider2-dbt" / "evaluation_suite"
GOLD_DIR = EVAL_SUITE_DIR / "gold"
GOLD_JSONL = GOLD_DIR / "spider2_eval.jsonl"


@dataclass
class EvaluationResult:
    """Per-instance evaluation scores for a prompt variant."""

    prompt_id: str
    scores: dict[str, float]  # instance_id -> score (0.0 or 1.0)
    total_instances: int
    total_solved: int
    metadata: dict[str, Any]

    @property
    def accuracy(self) -> float:
        if self.total_instances == 0:
            return 0.0
        return self.total_solved / self.total_instances

    def failed_instances(self) -> list[str]:
        return [k for k, v in self.scores.items() if v < 1.0]

    def solved_instances(self) -> list[str]:
        return [k for k, v in self.scores.items() if v >= 1.0]


class Evaluator(ABC):
    """Abstract base class for prompt evaluation."""

    @abstractmethod
    def evaluate(self, prompt_text: str, prompt_id: str) -> EvaluationResult:
        """Evaluate a prompt variant and return per-instance scores."""
        ...


class BenchmarkEvaluator(Evaluator):
    """Runs the full Spider 2.0-DBT benchmark with a given prompt.

    Temporarily swaps builder.txt, runs the benchmark, then restores
    the original prompt.
    """

    def __init__(
        self,
        parallel: int = 4,
        benchmark_script: str | None = None,
        workspace_dir: str | None = None,
        timeout: int = 7200,
    ):
        self.parallel = parallel
        self.timeout = timeout
        self.workspace_dir = Path(workspace_dir) if workspace_dir else REPO_ROOT / "experiments" / "spider2_dbt" / "workspace"
        self.benchmark_script = benchmark_script

    def evaluate(self, prompt_text: str, prompt_id: str) -> EvaluationResult:
        """Evaluate by running the full benchmark pipeline."""
        # Save original prompt
        original_prompt = BUILDER_PROMPT_PATH.read_text() if BUILDER_PROMPT_PATH.exists() else None

        result_dir = self.workspace_dir / f"gepa_run_{prompt_id}"
        result_dir.mkdir(parents=True, exist_ok=True)

        try:
            # Write the candidate prompt
            BUILDER_PROMPT_PATH.write_text(prompt_text)
            logger.info("Wrote candidate prompt %s to %s", prompt_id, BUILDER_PROMPT_PATH)

            # Run benchmark
            if self.benchmark_script:
                cmd = [
                    sys.executable, self.benchmark_script,
                    "--parallel", str(self.parallel),
                    "--output-dir", str(result_dir),
                ]
                logger.info("Running benchmark: %s", " ".join(cmd))
                subprocess.run(
                    cmd,
                    cwd=str(REPO_ROOT),
                    timeout=self.timeout,
                    check=True,
                    capture_output=True,
                    text=True,
                )
            else:
                logger.warning(
                    "No benchmark_script configured. "
                    "Set --benchmark-script to the path of run_benchmark.py"
                )
                return EvaluationResult(
                    prompt_id=prompt_id,
                    scores={},
                    total_instances=0,
                    total_solved=0,
                    metadata={"error": "no benchmark_script configured"},
                )

            # Parse results
            return self._parse_results(result_dir, prompt_id)

        finally:
            # Restore original prompt
            if original_prompt is not None:
                BUILDER_PROMPT_PATH.write_text(original_prompt)
                logger.info("Restored original builder.txt")

    def _parse_results(self, result_dir: Path, prompt_id: str) -> EvaluationResult:
        """Parse benchmark results using the evaluation suite logic."""
        evaluator = ResultsEvaluator()
        return evaluator.evaluate_from_dirs(
            result_dir=str(result_dir),
            gold_dir=str(GOLD_DIR),
            prompt_id=prompt_id,
        )


class ResultsEvaluator(Evaluator):
    """Evaluates pre-existing results against gold data.

    Directly uses the evaluation_suite logic without running the benchmark.
    """

    def __init__(self, result_dir: str | None = None, gold_dir: str | None = None):
        self.result_dir = result_dir
        self.gold_dir = gold_dir or str(GOLD_DIR)

    def evaluate(self, prompt_text: str, prompt_id: str) -> EvaluationResult:
        """Evaluate using pre-existing results directory."""
        if not self.result_dir:
            raise ValueError("result_dir must be set for ResultsEvaluator")
        return self.evaluate_from_dirs(self.result_dir, self.gold_dir, prompt_id)

    def evaluate_from_dirs(
        self, result_dir: str, gold_dir: str, prompt_id: str
    ) -> EvaluationResult:
        """Run evaluation logic from evaluate.py against result and gold dirs.

        Imports and uses the evaluation functions directly to get per-instance
        scores, mirroring the logic in evaluate.py but returning structured data.
        """
        gold_jsonl = Path(gold_dir) / "spider2_eval.jsonl"
        result_jsonl = Path(result_dir) / "results_metadata.jsonl"

        if not gold_jsonl.exists():
            raise FileNotFoundError(f"Gold JSONL not found: {gold_jsonl}")
        if not result_jsonl.exists():
            raise FileNotFoundError(f"Results JSONL not found: {result_jsonl}")

        gold_data = _read_jsonl(gold_jsonl)
        result_data = _read_jsonl(result_jsonl)

        gold_dict = {e["instance_id"]: e for e in gold_data}
        result_dict = {e["instance_id"]: e for e in result_data}

        common_ids = set(gold_dict.keys()) & set(result_dict.keys())
        evaluation_data = [{**gold_dict[iid], **result_dict[iid]} for iid in common_ids]

        # Add eval_suite to sys.path for imports
        eval_suite_str = str(EVAL_SUITE_DIR)
        if eval_suite_str not in sys.path:
            sys.path.insert(0, eval_suite_str)

        from eval_utils import string_match, number_match, table_match, duckdb_match, tables_match

        scores: dict[str, float] = {}
        for data in evaluation_data:
            instance_id = data["instance_id"]
            eval_metadata = data.get("evaluation", {})

            if not isinstance(eval_metadata, list):
                eval_metadatas = [eval_metadata]
            else:
                eval_metadatas = eval_metadata

            score = 0.0
            try:
                if data["answer_type"] == "answer":
                    temp_scores = []
                    for em in eval_metadatas:
                        if em["func"] == "string_match":
                            s = string_match(data["answer_or_path"], **em["parameters"])
                        elif em["func"] == "number_match":
                            s = number_match(data["answer_or_path"], **em["parameters"])
                        else:
                            s = 0
                        temp_scores.append(s)
                    score = max(temp_scores) if temp_scores else 0.0

                elif data["answer_type"] == "file":
                    for em in eval_metadatas:
                        if em["func"] == "table_match":
                            gold_param = em["parameters"]["gold"]
                            if isinstance(gold_param, str):
                                em["parameters"]["gold"] = os.path.join(gold_dir, instance_id, gold_param)
                            elif isinstance(gold_param, list):
                                em["parameters"]["gold"] = [
                                    os.path.join(gold_dir, instance_id, g) for g in gold_param
                                ]
                            score = table_match(
                                os.path.join(result_dir, instance_id, data["answer_or_path"]),
                                **em["parameters"],
                            )
                        elif em["func"] == "duckdb_match":
                            em["parameters"]["gold"] = os.path.join(
                                gold_dir, instance_id, em["parameters"]["gold"]
                            )
                            score = duckdb_match(
                                os.path.join(result_dir, instance_id, data["answer_or_path"]),
                                **em["parameters"],
                            )

                elif data["answer_type"] == "files":
                    em = eval_metadatas[0]
                    em["parameters"]["gold"] = [
                        os.path.join(gold_dir, instance_id, g)
                        for g in em["parameters"]["gold"]
                    ]
                    results_paths = [
                        os.path.join(result_dir, instance_id, p)
                        for p in data["answer_or_path"]
                    ]
                    score = tables_match(results_paths, **em["parameters"])

            except Exception as e:
                logger.warning("Evaluation error for %s: %s", instance_id, e)
                score = 0.0

            scores[instance_id] = float(score)

        total_solved = sum(1 for v in scores.values() if v >= 1.0)
        return EvaluationResult(
            prompt_id=prompt_id,
            scores=scores,
            total_instances=len(scores),
            total_solved=total_solved,
            metadata={"result_dir": result_dir, "gold_dir": gold_dir},
        )


class MockEvaluator(Evaluator):
    """Reads pre-computed scores from a JSON file for development/testing.

    Expected JSON format:
    {
        "instance_scores": {
            "instance_id_1": 1.0,
            "instance_id_2": 0.0,
            ...
        }
    }

    If `perturbation` is set, randomly flips some scores to simulate
    the effect of prompt changes.
    """

    def __init__(self, scores_path: str, perturbation: float = 0.0):
        self.scores_path = Path(scores_path)
        self.perturbation = perturbation

        if not self.scores_path.exists():
            raise FileNotFoundError(f"Mock scores file not found: {self.scores_path}")

        with open(self.scores_path) as f:
            data = json.load(f)

        self._base_scores: dict[str, float] = data.get("instance_scores", data)

    def evaluate(self, prompt_text: str, prompt_id: str) -> EvaluationResult:
        """Return scores, optionally perturbed to simulate prompt changes."""
        import random as rng

        scores = dict(self._base_scores)

        if self.perturbation > 0:
            for iid in scores:
                if rng.random() < self.perturbation:
                    scores[iid] = 1.0 - scores[iid]  # flip

        total_solved = sum(1 for v in scores.values() if v >= 1.0)
        return EvaluationResult(
            prompt_id=prompt_id,
            scores=scores,
            total_instances=len(scores),
            total_solved=total_solved,
            metadata={"source": str(self.scores_path), "perturbation": self.perturbation},
        )


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    """Read a JSONL file into a list of dicts."""
    data = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                data.append(json.loads(line))
    return data


def create_evaluator(
    evaluator_type: str,
    **kwargs: Any,
) -> Evaluator:
    """Factory function to create an evaluator by type name."""
    if evaluator_type == "benchmark":
        return BenchmarkEvaluator(**kwargs)
    elif evaluator_type == "results":
        return ResultsEvaluator(**kwargs)
    elif evaluator_type == "mock":
        return MockEvaluator(**kwargs)
    else:
        raise ValueError(f"Unknown evaluator type: {evaluator_type}")
