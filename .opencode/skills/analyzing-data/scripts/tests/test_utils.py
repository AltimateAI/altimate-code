"""Tests for connector utilities."""

import pytest

from connectors import substitute_env_vars


class TestSubstituteEnvVars:
    """Tests for substitute_env_vars function."""

    @pytest.mark.parametrize(
        "value",
        [123, None, ["a", "b"], True, {"key": "value"}],
        ids=["int", "none", "list", "bool", "dict"],
    )
    def test_non_string_passthrough(self, value):
        result, env_var = substitute_env_vars(value)
        assert result == value
        assert env_var is None

    @pytest.mark.parametrize(
        "value",
        [
            "hello",
            "prefix${VAR}",
            "${VAR}suffix",
            "prefix${VAR}suffix",
            "$VAR",
            "${VAR",
            "${}",
            "",
        ],
        ids=[
            "plain_string",
            "prefix_before_var",
            "suffix_after_var",
            "var_in_middle",
            "dollar_without_braces",
            "unclosed_brace",
            "empty_var_name",
            "empty_string",
        ],
    )
    def test_no_substitution(self, value):
        """Values that don't match the exact ${VAR} pattern are unchanged."""
        result, env_var = substitute_env_vars(value)
        assert result == value
        assert env_var is None

    def test_substitution_when_env_var_exists(self, monkeypatch):
        monkeypatch.setenv("MY_VAR", "my_value")
        result, env_var = substitute_env_vars("${MY_VAR}")
        assert result == "my_value"
        assert env_var == "MY_VAR"

    def test_returns_original_when_env_var_missing(self):
        result, env_var = substitute_env_vars("${NONEXISTENT_VAR}")
        assert result == "${NONEXISTENT_VAR}"
        assert env_var == "NONEXISTENT_VAR"

    def test_returns_original_when_env_var_empty(self, monkeypatch):
        monkeypatch.setenv("EMPTY_VAR", "")
        result, env_var = substitute_env_vars("${EMPTY_VAR}")
        # Empty string is falsy, so original is returned
        assert result == "${EMPTY_VAR}"
        assert env_var == "EMPTY_VAR"

    @pytest.mark.parametrize(
        "var_name",
        ["MY_VAR_NAME", "VAR123", "A", "VERY_LONG_VARIABLE_NAME_123"],
    )
    def test_various_valid_var_names(self, monkeypatch, var_name):
        monkeypatch.setenv(var_name, "value")
        result, env_var = substitute_env_vars(f"${{{var_name}}}")
        assert result == "value"
        assert env_var == var_name
