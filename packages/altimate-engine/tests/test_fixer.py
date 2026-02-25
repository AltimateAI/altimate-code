"""Tests for sql.fix — SQL error diagnosis and fix suggestions."""

from altimate_engine.sql.fixer import fix_sql


class TestFixSqlSyntax:
    def test_detects_syntax_error(self):
        result = fix_sql("SELECT FROM t", "syntax error", dialect="snowflake")
        assert result["success"] is True
        assert result["suggestion_count"] >= 1

    def test_fixes_missing_paren(self):
        result = fix_sql("SELECT COUNT(a FROM t", "unexpected token FROM", dialect="snowflake")
        assert result["success"] is True
        has_syntax = any(s["type"] == "SYNTAX_ERROR" for s in result["suggestions"])
        assert has_syntax
        # Should attempt auto-fix with closing paren
        syntax_fix = next(s for s in result["suggestions"] if s["type"] == "SYNTAX_ERROR")
        if syntax_fix.get("fixed_sql"):
            assert ")" in syntax_fix["fixed_sql"]

    def test_fixes_trailing_comma(self):
        # sqlglot may or may not flag a trailing comma as a syntax error depending on dialect
        result = fix_sql("SELECT a, b, FROM t", "unexpected token FROM", dialect="snowflake")
        assert result["success"] is True
        assert result["suggestion_count"] >= 1

    def test_valid_sql_no_syntax_fix(self):
        # Valid SQL should not produce SYNTAX_ERROR suggestions
        result = fix_sql(
            "SELECT a FROM t",
            "object 't' does not exist",
            dialect="snowflake",
        )
        has_syntax = any(s["type"] == "SYNTAX_ERROR" for s in result["suggestions"])
        assert not has_syntax


class TestFixSqlPatterns:
    def test_ambiguous_column(self):
        result = fix_sql(
            "SELECT id FROM a JOIN b ON a.id = b.id",
            "ambiguous column 'id'",
            dialect="snowflake",
        )
        has_ambiguous = any(s["type"] == "AMBIGUOUS_COLUMN" for s in result["suggestions"])
        assert has_ambiguous

    def test_object_not_found(self):
        result = fix_sql(
            "SELECT * FROM nonexistent_table",
            "Object 'nonexistent_table' does not exist",
            dialect="snowflake",
        )
        has_not_found = any(s["type"] == "OBJECT_NOT_FOUND" for s in result["suggestions"])
        assert has_not_found

    def test_snowflake_case_sensitivity_hint(self):
        result = fix_sql(
            "SELECT * FROM myTable",
            "Object 'myTable' does not exist",
            dialect="snowflake",
        )
        has_case = any(s["type"] == "CASE_SENSITIVITY" for s in result["suggestions"])
        assert has_case

    def test_no_case_hint_for_postgres(self):
        result = fix_sql(
            "SELECT * FROM myTable",
            "relation 'myTable' does not exist",
            dialect="postgres",
        )
        has_case = any(s["type"] == "CASE_SENSITIVITY" for s in result["suggestions"])
        assert not has_case

    def test_division_by_zero(self):
        result = fix_sql(
            "SELECT a / b FROM t",
            "Division by zero",
            dialect="snowflake",
        )
        has_div = any(s["type"] == "DIVISION_BY_ZERO" for s in result["suggestions"])
        assert has_div
        # Should suggest NULLIF fix
        div_fix = next(s for s in result["suggestions"] if s["type"] == "DIVISION_BY_ZERO")
        assert "NULLIF" in div_fix["message"]

    def test_type_mismatch(self):
        result = fix_sql(
            "SELECT * FROM t WHERE id = 'abc'",
            "type mismatch: expected NUMBER got VARCHAR",
            dialect="snowflake",
        )
        has_type = any(s["type"] == "TYPE_MISMATCH" for s in result["suggestions"])
        assert has_type

    def test_group_by_missing(self):
        result = fix_sql(
            "SELECT name, COUNT(*) FROM t",
            "Column 'name' must appear in the GROUP BY clause",
            dialect="snowflake",
        )
        has_group = any(s["type"] == "GROUP_BY_MISSING" for s in result["suggestions"])
        assert has_group

    def test_permission_denied(self):
        result = fix_sql(
            "SELECT * FROM secret_table",
            "Insufficient privileges to operate on table 'secret_table'",
            dialect="snowflake",
        )
        has_perm = any(s["type"] == "PERMISSION_DENIED" for s in result["suggestions"])
        assert has_perm

    def test_duplicate_column(self):
        result = fix_sql(
            "SELECT a.id, b.id FROM a JOIN b ON a.x = b.x",
            "duplicate column name 'id'",
            dialect="snowflake",
        )
        has_dup = any(s["type"] == "DUPLICATE_COLUMN" for s in result["suggestions"])
        assert has_dup


class TestFixSqlGeneral:
    def test_unknown_error_gives_general_suggestion(self):
        result = fix_sql(
            "SELECT 1",
            "some completely unknown error xyz",
            dialect="snowflake",
        )
        assert result["success"] is True
        has_general = any(s["type"] == "GENERAL" for s in result["suggestions"])
        assert has_general

    def test_preserves_original_sql(self):
        sql = "SELECT * FROM t"
        result = fix_sql(sql, "some error", dialect="snowflake")
        assert result["original_sql"] == sql

    def test_preserves_error_message(self):
        msg = "Column 'foo' not found"
        result = fix_sql("SELECT foo FROM t", msg, dialect="snowflake")
        assert result["error_message"] == msg
