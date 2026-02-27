"""dbt CLI wrapper for running dbt commands."""

from __future__ import annotations

import subprocess

from altimate_engine.models import DbtRunParams, DbtRunResult


def _ensure_upstream_selector(select: str, command: str) -> str:
    """Prepend + to selector for build/run/test to include upstream deps.

    The + operator tells dbt to also build all upstream dependencies of the
    selected node, which prevents partial builds from failing due to missing
    upstream models.
    """
    if command not in ("build", "run", "test"):
        return select

    # Already has + prefix — nothing to do
    if select.startswith("+"):
        return select

    # Tag/path/source selectors: tag:daily, path:models/, source:raw
    # Don't touch these — + doesn't apply the same way
    if ":" in select and not select.startswith("+"):
        return select

    return f"+{select}"


def run_dbt(params: DbtRunParams) -> DbtRunResult:
    """Run a dbt CLI command via subprocess."""
    cmd = ["dbt", params.command]

    if params.select:
        select = _ensure_upstream_selector(params.select, params.command)
        cmd.extend(["--select", select])

    cmd.extend(params.args)

    if params.project_dir:
        cmd.extend(["--project-dir", params.project_dir])

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,
        )
        return DbtRunResult(
            stdout=result.stdout,
            stderr=result.stderr,
            exit_code=result.returncode,
        )
    except FileNotFoundError:
        return DbtRunResult(
            stdout="",
            stderr="dbt CLI not found. Install with: pip install dbt-core",
            exit_code=127,
        )
    except subprocess.TimeoutExpired:
        return DbtRunResult(
            stdout="",
            stderr="dbt command timed out after 300 seconds",
            exit_code=124,
        )
