"""Tests for PII detection — identify columns likely to contain personally identifiable information."""

import os
import tempfile

import pytest

from altimate_engine.schema.cache import SchemaCache
from altimate_engine.schema.pii_detector import detect_pii, _check_column_pii


# --- Helper to build a SchemaCache with test data ---

class PiiTestConnector:
    """Connector stub that exposes schemas/tables/columns for PII testing."""

    def __init__(self, schemas):
        self._schemas = schemas

    def list_schemas(self):
        return list(self._schemas.keys())

    def list_tables(self, schema_name):
        tables = self._schemas.get(schema_name, [])
        return [{"name": t["name"], "type": "TABLE"} for t in tables]

    def describe_table(self, schema_name, table_name):
        tables = self._schemas.get(schema_name, [])
        for t in tables:
            if t["name"] == table_name:
                return t["columns"]
        return []


@pytest.fixture
def pii_cache():
    """SchemaCache pre-loaded with tables that have PII-like columns."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    cache = SchemaCache(db_path=path)

    connector = PiiTestConnector({
        "public": [
            {
                "name": "users",
                "columns": [
                    {"name": "id", "data_type": "INTEGER", "nullable": False},
                    {"name": "email", "data_type": "VARCHAR(255)", "nullable": False},
                    {"name": "first_name", "data_type": "VARCHAR(100)", "nullable": True},
                    {"name": "last_name", "data_type": "VARCHAR(100)", "nullable": True},
                    {"name": "ssn", "data_type": "VARCHAR(11)", "nullable": True},
                    {"name": "phone_number", "data_type": "VARCHAR(20)", "nullable": True},
                    {"name": "date_of_birth", "data_type": "DATE", "nullable": True},
                    {"name": "password", "data_type": "VARCHAR(256)", "nullable": False},
                    {"name": "ip_address", "data_type": "VARCHAR(45)", "nullable": True},
                    {"name": "credit_card", "data_type": "VARCHAR(19)", "nullable": True},
                ],
            },
            {
                "name": "orders",
                "columns": [
                    {"name": "id", "data_type": "INTEGER", "nullable": False},
                    {"name": "user_id", "data_type": "INTEGER", "nullable": False},
                    {"name": "total_amount", "data_type": "DECIMAL(10,2)", "nullable": True},
                    {"name": "created_at", "data_type": "TIMESTAMP", "nullable": True},
                ],
            },
            {
                "name": "employees",
                "columns": [
                    {"name": "id", "data_type": "INTEGER", "nullable": False},
                    {"name": "salary", "data_type": "DECIMAL(10,2)", "nullable": True},
                    {"name": "bank_account", "data_type": "VARCHAR(30)", "nullable": True},
                    {"name": "address", "data_type": "VARCHAR(500)", "nullable": True},
                    {"name": "zip_code", "data_type": "VARCHAR(10)", "nullable": True},
                    {"name": "nationality", "data_type": "VARCHAR(50)", "nullable": True},
                ],
            },
        ],
    })
    cache.index_warehouse("test-wh", "duckdb", connector)
    yield cache
    cache.close()
    os.unlink(path)


@pytest.fixture
def empty_cache():
    """SchemaCache with no data."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    cache = SchemaCache(db_path=path)
    yield cache
    cache.close()
    os.unlink(path)


class TestCheckColumnPii:
    """Unit tests for the _check_column_pii helper (no DB required)."""

    def test_ssn_detected(self):
        matches = _check_column_pii("ssn", "VARCHAR")
        categories = [m["category"] for m in matches]
        assert "SSN" in categories

    def test_email_detected(self):
        matches = _check_column_pii("email", "VARCHAR")
        categories = [m["category"] for m in matches]
        assert "EMAIL" in categories

    def test_email_address_detected(self):
        matches = _check_column_pii("email_address", "VARCHAR")
        categories = [m["category"] for m in matches]
        assert "EMAIL" in categories

    def test_phone_detected(self):
        matches = _check_column_pii("phone_number", "VARCHAR")
        categories = [m["category"] for m in matches]
        assert "PHONE" in categories

    def test_first_name_detected(self):
        matches = _check_column_pii("first_name", "VARCHAR")
        categories = [m["category"] for m in matches]
        assert "PERSON_NAME" in categories

    def test_last_name_detected(self):
        matches = _check_column_pii("last_name", "VARCHAR")
        categories = [m["category"] for m in matches]
        assert "PERSON_NAME" in categories

    def test_credit_card_detected(self):
        matches = _check_column_pii("credit_card", "VARCHAR")
        categories = [m["category"] for m in matches]
        assert "CREDIT_CARD" in categories

    def test_date_of_birth_detected(self):
        matches = _check_column_pii("date_of_birth", "DATE")
        categories = [m["category"] for m in matches]
        assert "DATE_OF_BIRTH" in categories

    def test_password_detected(self):
        matches = _check_column_pii("password", "VARCHAR")
        categories = [m["category"] for m in matches]
        assert "CREDENTIAL" in categories

    def test_ip_address_detected(self):
        matches = _check_column_pii("ip_address", "VARCHAR")
        categories = [m["category"] for m in matches]
        assert "IP_ADDRESS" in categories

    def test_bank_account_detected(self):
        matches = _check_column_pii("bank_account", "VARCHAR")
        categories = [m["category"] for m in matches]
        assert "BANK_ACCOUNT" in categories

    def test_salary_detected(self):
        matches = _check_column_pii("salary", "DECIMAL")
        categories = [m["category"] for m in matches]
        assert "FINANCIAL" in categories

    def test_address_detected(self):
        matches = _check_column_pii("address", "VARCHAR")
        categories = [m["category"] for m in matches]
        assert "ADDRESS" in categories

    def test_passport_detected(self):
        matches = _check_column_pii("passport_number", "VARCHAR")
        categories = [m["category"] for m in matches]
        assert "PASSPORT" in categories

    def test_drivers_license_detected(self):
        matches = _check_column_pii("drivers_license", "VARCHAR")
        categories = [m["category"] for m in matches]
        assert "DRIVERS_LICENSE" in categories

    def test_latitude_detected(self):
        matches = _check_column_pii("latitude", "FLOAT")
        categories = [m["category"] for m in matches]
        assert "GEOLOCATION" in categories

    def test_biometric_detected(self):
        matches = _check_column_pii("fingerprint", "BLOB")
        categories = [m["category"] for m in matches]
        assert "BIOMETRIC" in categories

    def test_non_pii_column(self):
        matches = _check_column_pii("order_id", "INTEGER")
        assert len(matches) == 0

    def test_non_pii_amount(self):
        matches = _check_column_pii("total_amount", "DECIMAL")
        assert len(matches) == 0

    def test_non_pii_created_at(self):
        matches = _check_column_pii("created_at", "TIMESTAMP")
        assert len(matches) == 0

    def test_case_insensitive(self):
        matches = _check_column_pii("EMAIL", "VARCHAR")
        categories = [m["category"] for m in matches]
        assert "EMAIL" in categories

    def test_confidence_levels(self):
        """Verify that matches include expected confidence levels."""
        # SSN should be high confidence
        ssn_matches = _check_column_pii("ssn", "VARCHAR")
        assert any(m["confidence"] == "high" for m in ssn_matches)

        # zip_code should be medium confidence
        zip_matches = _check_column_pii("zip_code", "VARCHAR")
        assert any(m["confidence"] == "medium" for m in zip_matches)

        # city should be low confidence
        city_matches = _check_column_pii("city", "VARCHAR")
        assert any(m["confidence"] == "low" for m in city_matches)

    # --- False-positive filtering tests ---

    def test_metadata_suffix_email_sent_count(self):
        """email_sent_count is about email delivery, not PII."""
        matches = _check_column_pii("email_sent_count", "INTEGER")
        # Should either be empty or have reduced confidence (not high)
        for m in matches:
            assert m["confidence"] != "high", f"email_sent_count should not be high confidence: {m}"

    def test_metadata_suffix_phone_validated_at(self):
        """phone_validated_at is a timestamp, not a phone number."""
        matches = _check_column_pii("phone_validated_at", "TIMESTAMP")
        # With both metadata suffix + non-text type, should be filtered
        for m in matches:
            assert m["confidence"] != "high"

    def test_metadata_suffix_address_type(self):
        """address_type is a category field, not an address."""
        matches = _check_column_pii("address_type", "VARCHAR")
        for m in matches:
            assert m["confidence"] != "high"

    def test_metadata_prefix_is_email(self):
        """is_email_verified is a boolean flag, not PII."""
        matches = _check_column_pii("is_email_verified", "BOOLEAN")
        # Should be filtered out completely (metadata prefix + non-text type)
        assert len(matches) == 0

    def test_metadata_prefix_num_phone(self):
        """num_phone_calls is a count, not PII."""
        matches = _check_column_pii("num_phone_calls", "INTEGER")
        assert len(matches) == 0

    def test_metadata_suffix_hash(self):
        """email_hash is a hashed value, not raw PII."""
        matches = _check_column_pii("email_hash", "VARCHAR")
        for m in matches:
            assert m["confidence"] != "high"

    def test_real_email_still_detected(self):
        """email (without metadata suffix) should still be high confidence."""
        matches = _check_column_pii("email", "VARCHAR")
        assert any(m["confidence"] == "high" and m["category"] == "EMAIL" for m in matches)

    def test_real_ssn_still_detected(self):
        """ssn should still be high confidence."""
        matches = _check_column_pii("ssn", "VARCHAR")
        assert any(m["confidence"] == "high" and m["category"] == "SSN" for m in matches)

    # --- Data type compatibility tests ---

    def test_email_integer_downgraded(self):
        """email column with INTEGER type is suspicious — downgrade confidence."""
        matches = _check_column_pii("email", "INTEGER")
        for m in matches:
            if m["category"] == "EMAIL":
                assert m["confidence"] != "high", "INTEGER email should not be high confidence"

    def test_ssn_boolean_downgraded(self):
        """ssn column with BOOLEAN type doesn't make sense."""
        matches = _check_column_pii("ssn", "BOOLEAN")
        for m in matches:
            if m["category"] == "SSN":
                assert m["confidence"] != "high"

    def test_phone_float_downgraded(self):
        """phone with FLOAT type — unusual, should downgrade."""
        matches = _check_column_pii("phone", "FLOAT")
        for m in matches:
            if m["category"] == "PHONE":
                assert m["confidence"] != "high"

    def test_salary_decimal_not_downgraded(self):
        """salary with DECIMAL is expected — FINANCIAL is not a text PII category."""
        matches = _check_column_pii("salary", "DECIMAL")
        assert any(m["category"] == "FINANCIAL" for m in matches)

    def test_latitude_float_not_downgraded(self):
        """latitude with FLOAT is expected — GEOLOCATION is not a text PII category."""
        matches = _check_column_pii("latitude", "FLOAT")
        assert any(m["category"] == "GEOLOCATION" for m in matches)

    def test_varchar_precision_stripped(self):
        """VARCHAR(255) should be treated as VARCHAR (text type, no downgrade)."""
        matches = _check_column_pii("email", "VARCHAR(255)")
        assert any(m["confidence"] == "high" and m["category"] == "EMAIL" for m in matches)

    def test_none_data_type_no_crash(self):
        """None data_type should not crash, just skip type check."""
        matches = _check_column_pii("email", None)
        assert any(m["category"] == "EMAIL" for m in matches)


class TestDetectPii:
    """Integration tests for detect_pii with a real SchemaCache."""

    def test_finds_pii_columns(self, pii_cache):
        result = detect_pii(cache=pii_cache)
        assert result["success"] is True
        assert result["finding_count"] > 0
        assert result["columns_scanned"] > 0

    def test_finds_email_in_users(self, pii_cache):
        result = detect_pii(cache=pii_cache)
        email_findings = [f for f in result["findings"] if f["pii_category"] == "EMAIL"]
        assert len(email_findings) > 0
        assert any(f["column"] == "email" for f in email_findings)

    def test_finds_ssn(self, pii_cache):
        result = detect_pii(cache=pii_cache)
        ssn_findings = [f for f in result["findings"] if f["pii_category"] == "SSN"]
        assert len(ssn_findings) > 0

    def test_no_pii_in_orders(self, pii_cache):
        """orders table has no PII columns."""
        result = detect_pii(table="orders", cache=pii_cache)
        assert result["success"] is True
        assert result["finding_count"] == 0

    def test_filter_by_warehouse(self, pii_cache):
        result = detect_pii(warehouse="test-wh", cache=pii_cache)
        assert result["success"] is True
        assert result["finding_count"] > 0

    def test_filter_by_table(self, pii_cache):
        result = detect_pii(table="users", cache=pii_cache)
        assert result["success"] is True
        assert result["finding_count"] > 0
        # All findings should be from the users table
        for f in result["findings"]:
            assert f["table"] == "users"

    def test_by_category_dict(self, pii_cache):
        result = detect_pii(cache=pii_cache)
        assert isinstance(result["by_category"], dict)
        assert len(result["by_category"]) > 0
        # Should have some common categories
        all_categories = set(result["by_category"].keys())
        assert len(all_categories) > 0

    def test_tables_with_pii_count(self, pii_cache):
        result = detect_pii(cache=pii_cache)
        # users and employees have PII; orders does not
        assert result["tables_with_pii"] >= 2

    def test_empty_cache_returns_zero(self, empty_cache):
        result = detect_pii(cache=empty_cache)
        assert result["success"] is True
        assert result["finding_count"] == 0
        assert result["columns_scanned"] == 0

    def test_finding_structure(self, pii_cache):
        result = detect_pii(cache=pii_cache)
        for f in result["findings"]:
            assert "warehouse" in f
            assert "schema" in f
            assert "table" in f
            assert "column" in f
            assert "pii_category" in f
            assert "confidence" in f

    def test_filter_by_schema(self, pii_cache):
        result = detect_pii(schema_name="public", cache=pii_cache)
        assert result["success"] is True
        assert result["finding_count"] > 0
