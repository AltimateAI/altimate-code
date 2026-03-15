"""Pareto frontier management for GEPA prompt optimization.

Tracks prompt variants across a multi-objective space where each benchmark
instance is a separate objective (solved=1.0, failed=0.0). A variant dominates
another if it solves a strict superset of instances.
"""

from __future__ import annotations

import json
import logging
import random
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class PromptVariant:
    """A single prompt variant with its evaluation scores."""

    id: str
    text: str
    scores: dict[str, float]  # instance_id -> score (0.0 or 1.0)
    parent_ids: list[str] = field(default_factory=list)
    generation: int = 0
    lessons: list[dict[str, Any]] = field(default_factory=list)

    @property
    def total_solved(self) -> int:
        return sum(1 for v in self.scores.values() if v >= 1.0)

    @property
    def solved_set(self) -> set[str]:
        return {k for k, v in self.scores.items() if v >= 1.0}

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> PromptVariant:
        return cls(
            id=data["id"],
            text=data["text"],
            scores=data["scores"],
            parent_ids=data.get("parent_ids", []),
            generation=data.get("generation", 0),
            lessons=data.get("lessons", []),
        )


class ParetoFrontier:
    """Maintains a set of non-dominated prompt variants.

    Dominance is defined over instance-level scores: variant A dominates
    variant B if A solves every instance B solves, plus at least one more.
    """

    def __init__(self) -> None:
        self._variants: dict[str, PromptVariant] = {}

    @property
    def variants(self) -> list[PromptVariant]:
        return list(self._variants.values())

    def __len__(self) -> int:
        return len(self._variants)

    def dominates(self, a: PromptVariant, b: PromptVariant) -> bool:
        """Check if variant `a` dominates variant `b`.

        A dominates B iff A's solved set is a strict superset of B's solved set.
        """
        a_solved = a.solved_set
        b_solved = b.solved_set
        return b_solved < a_solved  # strict subset

    def add(self, variant: PromptVariant) -> bool:
        """Add a variant to the frontier, pruning dominated members.

        Returns True if the variant was added (i.e., not dominated by any
        existing frontier member).
        """
        # Check if new variant is dominated by any existing member
        for existing in list(self._variants.values()):
            if self.dominates(existing, variant):
                logger.debug(
                    "Variant %s dominated by existing %s (%d vs %d solved)",
                    variant.id,
                    existing.id,
                    variant.total_solved,
                    existing.total_solved,
                )
                return False

        # Remove existing members dominated by new variant
        to_remove = []
        for vid, existing in self._variants.items():
            if self.dominates(variant, existing):
                to_remove.append(vid)

        for vid in to_remove:
            logger.info(
                "Pruning dominated variant %s (solved %d, new variant %s solves %d)",
                vid,
                self._variants[vid].total_solved,
                variant.id,
                variant.total_solved,
            )
            del self._variants[vid]

        self._variants[variant.id] = variant
        logger.info(
            "Added variant %s to frontier (solved %d/%d, frontier size %d)",
            variant.id,
            variant.total_solved,
            len(variant.scores),
            len(self._variants),
        )
        return True

    def select_parents(self, n: int = 2) -> list[PromptVariant]:
        """Tournament selection: pick n variants from the frontier.

        Selects variants weighted by total_solved to bias toward
        higher-performing parents while maintaining diversity.
        """
        if len(self._variants) == 0:
            raise ValueError("Cannot select parents from empty frontier")

        variants = list(self._variants.values())

        if len(variants) <= n:
            return variants[:n] if len(variants) >= n else variants * n

        # Weighted selection by total_solved (with minimum weight of 1)
        weights = [max(v.total_solved, 1) for v in variants]
        selected = random.choices(variants, weights=weights, k=n)

        # Ensure diversity: if same variant selected twice, retry
        attempts = 0
        while len(set(v.id for v in selected)) < min(n, len(variants)) and attempts < 10:
            selected = random.choices(variants, weights=weights, k=n)
            attempts += 1

        return selected

    def summary(self) -> dict[str, Any]:
        """Return summary statistics of the frontier."""
        if not self._variants:
            return {
                "frontier_size": 0,
                "total_unique_solved": 0,
                "best_variant_id": None,
                "best_variant_solved": 0,
            }

        all_solved: set[str] = set()
        best_variant: PromptVariant | None = None

        for v in self._variants.values():
            all_solved |= v.solved_set
            if best_variant is None or v.total_solved > best_variant.total_solved:
                best_variant = v

        assert best_variant is not None
        return {
            "frontier_size": len(self._variants),
            "total_unique_solved": len(all_solved),
            "best_variant_id": best_variant.id,
            "best_variant_solved": best_variant.total_solved,
            "best_variant_generation": best_variant.generation,
            "solved_instances": sorted(all_solved),
        }

    def save(self, path: str | Path) -> None:
        """Persist frontier to a JSON file."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        data = {
            "variants": [v.to_dict() for v in self._variants.values()],
            "summary": self.summary(),
        }
        path.write_text(json.dumps(data, indent=2))
        logger.info("Saved frontier with %d variants to %s", len(self._variants), path)

    @classmethod
    def load(cls, path: str | Path) -> ParetoFrontier:
        """Load frontier from a JSON file."""
        path = Path(path)
        data = json.loads(path.read_text())

        frontier = cls()
        for vdata in data["variants"]:
            variant = PromptVariant.from_dict(vdata)
            frontier._variants[variant.id] = variant

        logger.info("Loaded frontier with %d variants from %s", len(frontier), path)
        return frontier
