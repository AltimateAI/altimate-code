"""CI cost gate — scan changed SQL files for critical issues.

Reads SQL files, runs existing analyze_sql(), and returns
pass/fail based on whether CRITICAL severity issues are found.

Skips:
  - Jinja templates ({{ }}, {% %})
  - sqlglot parse errors (likely Jinja or non-standard SQL)
  - Non-SQL files
"""

from __future__ import annotations

import os
import re
from typing import Any

from altimate_engine.sql.analyzer import analyze_sql


# Jinja pattern: {{ ... }} or {% ... %} or {# ... #}
_JINJA_PATTERN = re.compile(r"\{\{.*?\}\}|\{%.*?%\}|\{#.*?#\}", re.DOTALL)


def _has_jinja(sql: str) -> bool:
    """Check if SQL contains Jinja template syntax."""
    return bool(_JINJA_PATTERN.search(sql))


def _split_statements(sql: str) -> list[str]:
    """Split SQL on semicolons, filtering empty statements."""
    statements = []
    for stmt in sql.split(";"):
        stmt = stmt.strip()
        if stmt:
            statements.append(stmt)
    return statements


def scan_files(
    file_paths: list[str],
    dialect: str = "snowflake",
) -> dict[str, Any]:
    """Scan SQL files for critical issues.

    Args:
        file_paths: List of SQL file paths to scan.
        dialect: SQL dialect for analysis (default: snowflake).

    Returns:
        Dict with pass/fail status, per-file results, and summary.
    """
    file_results: list[dict[str, Any]] = []
    total_issues = 0
    critical_count = 0
    files_scanned = 0
    files_skipped = 0

    for path in file_paths:
        # Skip non-SQL files
        if not path.endswith(".sql"):
            files_skipped += 1
            file_results.append({
                "file": path,
                "status": "skipped",
                "reason": "not a SQL file",
                "issues": [],
            })
            continue

        # Read file
        if not os.path.isfile(path):
            files_skipped += 1
            file_results.append({
                "file": path,
                "status": "skipped",
                "reason": "file not found",
                "issues": [],
            })
            continue

        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception as e:
            files_skipped += 1
            file_results.append({
                "file": path,
                "status": "skipped",
                "reason": f"read error: {e}",
                "issues": [],
            })
            continue

        # Skip Jinja templates
        if _has_jinja(content):
            files_skipped += 1
            file_results.append({
                "file": path,
                "status": "skipped",
                "reason": "contains Jinja templates",
                "issues": [],
            })
            continue

        # Split and analyze each statement
        statements = _split_statements(content)
        if not statements:
            files_skipped += 1
            file_results.append({
                "file": path,
                "status": "skipped",
                "reason": "empty file",
                "issues": [],
            })
            continue

        files_scanned += 1
        file_issues: list[dict[str, Any]] = []

        for stmt in statements:
            # Run analyzer
            analysis = analyze_sql(stmt, dialect)
            if not analysis.get("success", True):
                # Parse error — skip this statement (likely incomplete SQL)
                continue

            for issue in analysis.get("issues", []):
                severity = issue.get("severity", "warning")
                file_issues.append({
                    "type": issue.get("type", "UNKNOWN"),
                    "severity": severity,
                    "message": issue.get("message", ""),
                    "source": "analyzer",
                })
                total_issues += 1
                if severity in ("error", "critical"):
                    critical_count += 1

        status = "fail" if any(
            i["severity"] in ("error", "critical") for i in file_issues
        ) else "pass"

        file_results.append({
            "file": path,
            "status": status,
            "issues": file_issues,
        })

    passed = critical_count == 0

    return {
        "success": True,
        "passed": passed,
        "exit_code": 0 if passed else 1,
        "files_scanned": files_scanned,
        "files_skipped": files_skipped,
        "total_issues": total_issues,
        "critical_count": critical_count,
        "file_results": file_results,
        "error": None,
    }
