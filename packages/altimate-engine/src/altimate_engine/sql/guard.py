"""SQL validation and safety checking via sqlguard bindings."""

from __future__ import annotations

from altimate_engine.models import (
    SqlCheckIssue,
    SqlCheckMode,
    SqlCheckParams,
    SqlCheckResult,
    SqlValidateParams,
    SqlValidateResult,
)

try:
    import sqlguard

    SQLGUARD_AVAILABLE = True
except ImportError:
    sqlguard = None
    SQLGUARD_AVAILABLE = False


def validate_sql(params: SqlValidateParams) -> SqlValidateResult:
    """Validate SQL syntax and optionally normalize it."""
    if not SQLGUARD_AVAILABLE:
        return SqlValidateResult(
            valid=False,
            errors=["sqlguard is not installed. Install with: pip install altimate-engine[sqlguard]"],
        )

    result = sqlguard.validate(params.sql, dialect=params.dialect)
    return SqlValidateResult(
        valid=result.get("valid", False),
        errors=result.get("errors", []),
        normalized=result.get("normalized"),
    )


def check_sql(params: SqlCheckParams) -> SqlCheckResult:
    """Check SQL for safety issues, lint warnings, and read-only enforcement."""
    if not SQLGUARD_AVAILABLE:
        return SqlCheckResult(
            safe=False,
            issues=[
                SqlCheckIssue(
                    code="SQLGUARD_MISSING",
                    message="sqlguard is not installed. Install with: pip install altimate-engine[sqlguard]",
                    severity="error",
                )
            ],
        )

    issues: list[SqlCheckIssue] = []

    # Run safety scan
    safety = sqlguard.scan_safety(params.sql, dialect=params.dialect)
    for finding in safety.get("findings", []):
        issues.append(
            SqlCheckIssue(
                code=finding.get("code", "SAFETY"),
                message=finding.get("message", "Safety issue detected"),
                severity=finding.get("severity", "warning"),
                line=finding.get("line"),
                column=finding.get("column"),
            )
        )

    # Enforce read-only mode
    if params.mode == SqlCheckMode.READ_ONLY:
        is_write = safety.get("is_write", False)
        if is_write:
            issues.append(
                SqlCheckIssue(
                    code="READ_ONLY_VIOLATION",
                    message="Statement modifies data but read-only mode is enabled",
                    severity="error",
                )
            )

    # Run lint checks
    lint_results = sqlguard.lint(params.sql, dialect=params.dialect)
    for lint_issue in lint_results.get("issues", []):
        issues.append(
            SqlCheckIssue(
                code=lint_issue.get("code", "LINT"),
                message=lint_issue.get("message", "Lint issue"),
                severity="warning",
                line=lint_issue.get("line"),
                column=lint_issue.get("column"),
            )
        )

    safe = not any(i.severity == "error" for i in issues)
    return SqlCheckResult(safe=safe, issues=issues)


def lint_sql(sql: str, dialect: str | None = None) -> list[SqlCheckIssue]:
    """Run lint checks on SQL."""
    if not SQLGUARD_AVAILABLE:
        return []

    result = sqlguard.lint(sql, dialect=dialect)
    return [
        SqlCheckIssue(
            code=issue.get("code", "LINT"),
            message=issue.get("message", "Lint issue"),
            severity="warning",
            line=issue.get("line"),
            column=issue.get("column"),
        )
        for issue in result.get("issues", [])
    ]


def scan_safety(sql: str, dialect: str | None = None) -> dict:
    """Scan SQL for safety concerns (DDL, DML, etc.)."""
    if not SQLGUARD_AVAILABLE:
        return {"safe": False, "error": "sqlguard not installed"}

    return sqlguard.scan_safety(sql, dialect=dialect)
