"""Graders for agent-task eval.

Each grader takes an `answer` (string produced by an agent or by the
reference-answer path in deterministic mode) and `grader_args` (per-task
config). Returns (passed: bool, detail: str).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Callable

# Import the SQL rule engine
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sql_correctness"))
from rule_engine import evaluate  # noqa: E402


def grade_must_mention_all(answer: str, args: dict) -> tuple[bool, str]:
    """Answer must contain every phrase (case-insensitive)."""
    phrases: list[str] = args["phrases"]
    a = answer.lower()
    missing = [p for p in phrases if p.lower() not in a]
    if missing:
        return False, f"missing phrases: {missing}"
    return True, f"all {len(phrases)} phrases present"


def grade_must_mention_any(answer: str, args: dict) -> tuple[bool, str]:
    """Answer must contain at least one phrase."""
    phrases: list[str] = args["phrases"]
    a = answer.lower()
    hits = [p for p in phrases if p.lower() in a]
    if not hits:
        return False, f"none of the required phrases matched: {phrases}"
    return True, f"matched: {hits}"


def grade_sql_correctness(answer: str, args: dict) -> tuple[bool, str]:
    """Answer is the SQL under review; the rule engine must produce exactly the expected violations.

    `answer` is ignored here — the sql field in args is what we grade.
    (This is a self-contained grader: given a stored bad SQL snippet, we
    verify the rule engine catches the violations the task expects.
    In LLM mode, `answer` would be the LLM's diagnosis instead.)
    """
    sql: str = args["sql"]
    structure: str = args["structure"]
    expected = set(args["expected_violations"])

    detected = set(evaluate(sql, structure))
    fp = sorted(detected - expected)
    fn = sorted(expected - detected)
    if not fp and not fn:
        return True, f"detected exactly the expected violations: {sorted(expected)}"
    parts = []
    if fp: parts.append(f"unexpected: {fp}")
    if fn: parts.append(f"missing: {fn}")
    return False, "; ".join(parts)


GRADERS: dict[str, Callable[[str, dict], tuple[bool, str]]] = {
    "must_mention_all": grade_must_mention_all,
    "must_mention_any": grade_must_mention_any,
    "sql_correctness":  grade_sql_correctness,
}
