"""dbt CLI wrapper for running dbt commands."""

from __future__ import annotations

import subprocess

from altimate_engine.models import DbtRunParams, DbtRunResult


def run_dbt(params: DbtRunParams) -> DbtRunResult:
    """Run a dbt CLI command via subprocess."""
    cmd = ["dbt", params.command]

    if params.select:
        cmd.extend(["--select", params.select])

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
