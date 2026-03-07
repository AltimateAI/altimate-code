"""Configuration constants for Spider 2.0-DBT benchmark evaluation."""

from __future__ import annotations

import os
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────────

BASE_DIR = Path(__file__).resolve().parent
SPIDER2_REPO_DIR = BASE_DIR / "spider2_repo"
SPIDER2_DBT_DIR = SPIDER2_REPO_DIR / "spider2-dbt"
TASK_JSONL = SPIDER2_DBT_DIR / "examples" / "spider2-dbt.jsonl"
EXAMPLES_DIR = SPIDER2_DBT_DIR / "examples"
GOLD_EVAL_JSONL = SPIDER2_DBT_DIR / "evaluation_suite" / "gold" / "spider2_eval.jsonl"
EVAL_UTILS_DIR = SPIDER2_DBT_DIR / "evaluation_suite"
WORKSPACE_DIR = BASE_DIR / "workspace"
RESULTS_DIR = BASE_DIR / "results"
INCREMENTAL_DIR = RESULTS_DIR / "incremental"
REPORTS_DIR = BASE_DIR / "reports"

# ── Spider2 Repository ─────────────────────────────────────────────────────────

SPIDER2_REPO_URL = "https://github.com/xlang-ai/Spider2.git"
# Pin to a known-good commit for reproducibility
SPIDER2_COMMIT = "main"

# Google Drive file IDs for DuckDB database zips (from Spider2 README)
# Format: (gdrive_id, expected_filename)
DUCKDB_ZIP_DOWNLOADS = [
    ("1N3f7BSWC4foj-V-1C9n8M2XmgV7FOcqL", "DBT_start_db.zip"),
    ("1s0USV_iQLo4oe05QqAMnhGGp5jeejCzp", "dbt_gold.zip"),
]

# ── Execution ──────────────────────────────────────────────────────────────────

ALTIMATE_CODE_BIN = os.environ.get("ALTIMATE_CODE_BIN", "altimate-code")
DEFAULT_TIMEOUT = 600  # seconds per task
DEFAULT_PARALLEL = 4  # concurrent tasks
DEFAULT_MODEL = "anthropic/claude-opus-4-6"
DEFAULT_AGENT = "coder"

# ── Leaderboard Data (Spider 2.0-DBT, as of 2025) ─────────────────────────────
# Source: https://spider2-dbt.github.io/
# Format: (agent_name, pass_rate)

LEADERBOARD: list[tuple[str, float]] = [
    ("Databao Agent", 44.11),
    ("MLE-Bench Agent", 38.24),
    ("Claude 3.5 Sonnet (CoT)", 36.76),
    ("GPT-4o (CoT)", 33.82),
    ("CodeS Agent", 32.35),
    ("OpenHands Agent", 30.88),
    ("SWE-Agent", 27.94),
    ("Gemini 1.5 Pro (CoT)", 26.47),
    ("Llama 3.1 405B (CoT)", 22.06),
    ("GPT-4o mini (CoT)", 19.12),
    ("Claude 3 Haiku (CoT)", 16.18),
]

# ── Task Categories (domain grouping for report) ──────────────────────────────
# Extract domain from instance_id by stripping trailing digits

import re


def get_task_domain(instance_id: str) -> str:
    """Extract domain from instance_id by stripping trailing digits.

    e.g. 'shopify002' -> 'shopify', 'f1003' -> 'f1', 'tpch001' -> 'tpch'
    """
    return re.sub(r"\d+$", "", instance_id)
