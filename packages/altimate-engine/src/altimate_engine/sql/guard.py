"""SQL validation and safety checking using sqlglot."""

from __future__ import annotations

import sqlglot
from sqlglot import exp

from altimate_engine.models import (
    SqlCheckIssue,
    SqlCheckMode,
    SqlCheckParams,
    SqlCheckResult,
    SqlValidateParams,
    SqlValidateResult,
)

# Statement types that modify data or schema
_WRITE_TYPES = (
    exp.Insert,
    exp.Update,
    exp.Delete,
    exp.Drop,
    exp.Create,
    exp.Alter,
    exp.AlterColumn,
    exp.Merge,
)

# Statement types considered dangerous/DDL
_DDL_TYPES = (
    exp.Drop,
    exp.Create,
    exp.Alter,
    exp.AlterColumn,
)


def validate_sql(params: SqlValidateParams) -> SqlValidateResult:
    """Validate SQL syntax by parsing with sqlglot."""
    dialect = params.dialect or None
    errors: list[str] = []

    try:
        parsed = sqlglot.parse(params.sql, dialect=dialect)
        if not parsed or all(p is None for p in parsed):
            errors.append("Empty or unparseable SQL")
            return SqlValidateResult(valid=False, errors=errors)

        normalized = None
        if not errors and len(parsed) == 1 and parsed[0] is not None:
            try:
                normalized = parsed[0].sql(dialect=dialect)
            except Exception:
                pass

        return SqlValidateResult(
            valid=len(errors) == 0,
            errors=errors,
            normalized=normalized,
        )
    except sqlglot.errors.ParseError as e:
        errors.append(str(e))
        return SqlValidateResult(valid=False, errors=errors)
    except Exception as e:
        errors.append(f"Validation error: {e}")
        return SqlValidateResult(valid=False, errors=errors)


def check_sql(params: SqlCheckParams) -> SqlCheckResult:
    """Check SQL for safety issues and read-only enforcement using sqlglot AST."""
    dialect = params.dialect or None
    issues: list[SqlCheckIssue] = []

    try:
        parsed = sqlglot.parse(params.sql, dialect=dialect)
    except sqlglot.errors.ParseError as e:
        issues.append(
            SqlCheckIssue(
                code="PARSE_ERROR",
                message=f"SQL parse error: {e}",
                severity="error",
            )
        )
        return SqlCheckResult(safe=False, issues=issues)
    except Exception as e:
        issues.append(
            SqlCheckIssue(
                code="PARSE_ERROR",
                message=f"Unexpected parse error: {e}",
                severity="error",
            )
        )
        return SqlCheckResult(safe=False, issues=issues)

    if not parsed or all(p is None for p in parsed):
        issues.append(
            SqlCheckIssue(
                code="EMPTY_SQL",
                message="Empty or unparseable SQL",
                severity="error",
            )
        )
        return SqlCheckResult(safe=False, issues=issues)

    for statement in parsed:
        if statement is None:
            continue

        # Check for DDL (DROP, CREATE, ALTER)
        if isinstance(statement, _DDL_TYPES):
            stmt_type = type(statement).__name__.upper()
            issues.append(
                SqlCheckIssue(
                    code="DDL_DETECTED",
                    message=f"{stmt_type} statement detected — modifies database schema",
                    severity="error",
                )
            )

        # Check for DML writes (INSERT, UPDATE, DELETE, MERGE)
        if isinstance(statement, _WRITE_TYPES) and not isinstance(statement, _DDL_TYPES):
            stmt_type = type(statement).__name__.upper()
            issues.append(
                SqlCheckIssue(
                    code="DML_WRITE",
                    message=f"{stmt_type} statement modifies data",
                    severity="info",
                )
            )

        # Check for DROP TABLE/DATABASE specifically
        if isinstance(statement, exp.Drop):
            drop_kind = statement.args.get("kind", "")
            issues.append(
                SqlCheckIssue(
                    code="DROP_DETECTED",
                    message=f"DROP {drop_kind} detected — destructive operation",
                    severity="error",
                )
            )

        # Check for TRUNCATE
        if isinstance(statement, exp.Command) and statement.this and str(statement.this).upper().startswith("TRUNCATE"):
            issues.append(
                SqlCheckIssue(
                    code="TRUNCATE_DETECTED",
                    message="TRUNCATE statement detected — removes all rows",
                    severity="error",
                )
            )

        # Enforce read-only mode
        if params.mode == SqlCheckMode.READ_ONLY:
            if isinstance(statement, _WRITE_TYPES):
                stmt_type = type(statement).__name__.upper()
                issues.append(
                    SqlCheckIssue(
                        code="READ_ONLY_VIOLATION",
                        message=f"{stmt_type} statement not allowed in read-only mode",
                        severity="error",
                    )
                )

    safe = not any(i.severity == "error" for i in issues)
    return SqlCheckResult(safe=safe, issues=issues)
