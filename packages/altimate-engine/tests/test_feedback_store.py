"""Tests for sql/feedback_store.py — query execution metrics and cost prediction."""

import os
import tempfile

import pytest

from altimate_engine.sql.feedback_store import FeedbackStore, _regex_strip_literals


@pytest.fixture
def store(tmp_path):
    """Create a FeedbackStore backed by a temp SQLite DB."""
    db_path = str(tmp_path / "test_feedback.db")
    s = FeedbackStore(db_path=db_path)
    yield s
    s.close()


@pytest.fixture
def populated_store(store):
    """Store with 5 observations of the same query."""
    sql = "SELECT id, name FROM users WHERE status = 'active'"
    for i in range(5):
        store.record(
            sql=sql,
            dialect="snowflake",
            bytes_scanned=1_000_000 + i * 100_000,
            rows_produced=1000 + i * 100,
            execution_time_ms=200 + i * 50,
            credits_used=0.001 + i * 0.0002,
            warehouse_size="X-SMALL",
        )
    return store


class TestFeedbackStoreInitialization:
    """Schema creation and DB setup."""

    def test_creates_database_file(self, tmp_path):
        """The store should create the SQLite file on init."""
        db_path = str(tmp_path / "init_test.db")
        assert not os.path.exists(db_path)
        s = FeedbackStore(db_path=db_path)
        assert os.path.exists(db_path)
        s.close()

    def test_creates_table_and_indexes(self, store):
        """query_feedback table and indexes should exist after init."""
        cursor = store._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='query_feedback'"
        )
        assert cursor.fetchone() is not None

        cursor = store._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_fingerprint'"
        )
        assert cursor.fetchone() is not None

        cursor = store._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_template'"
        )
        assert cursor.fetchone() is not None

    def test_idempotent_init(self, tmp_path):
        """Opening the same DB twice should not fail (IF NOT EXISTS)."""
        db_path = str(tmp_path / "idem.db")
        s1 = FeedbackStore(db_path=db_path)
        s1.close()
        s2 = FeedbackStore(db_path=db_path)
        s2.close()

    def test_default_db_path_fallback(self):
        """When no path is given, it uses ~/.altimate/feedback.db."""
        from altimate_engine.sql.feedback_store import _default_db_path

        default = _default_db_path()
        assert "feedback.db" in default
        assert ".altimate" in default


class TestRecord:
    """Recording execution metrics."""

    def test_record_inserts_row(self, store):
        """record() should insert exactly one row."""
        store.record(
            sql="SELECT 1",
            bytes_scanned=100,
            rows_produced=1,
            execution_time_ms=10,
        )
        cursor = store._conn.execute("SELECT COUNT(*) FROM query_feedback")
        assert cursor.fetchone()[0] == 1

    def test_record_with_all_fields(self, store):
        """All fields should be stored correctly."""
        store.record(
            sql="SELECT * FROM orders",
            dialect="snowflake",
            bytes_scanned=5_000_000,
            rows_produced=10000,
            execution_time_ms=500,
            credits_used=0.005,
            warehouse_size="MEDIUM",
        )
        cursor = store._conn.execute("SELECT * FROM query_feedback")
        row = cursor.fetchone()
        assert row["bytes_scanned"] == 5_000_000
        assert row["rows_produced"] == 10000
        assert row["execution_time_ms"] == 500
        assert row["credits_used"] == 0.005
        assert row["warehouse_size"] == "MEDIUM"
        assert row["dialect"] == "snowflake"
        assert row["timestamp"] is not None

    def test_record_with_none_fields(self, store):
        """Optional fields can be None."""
        store.record(sql="SELECT 1")
        cursor = store._conn.execute("SELECT * FROM query_feedback")
        row = cursor.fetchone()
        assert row["bytes_scanned"] is None
        assert row["credits_used"] is None

    def test_record_multiple_queries(self, store):
        """Multiple records should accumulate."""
        store.record(sql="SELECT 1", bytes_scanned=100)
        store.record(sql="SELECT 2", bytes_scanned=200)
        store.record(sql="SELECT 3", bytes_scanned=300)
        cursor = store._conn.execute("SELECT COUNT(*) FROM query_feedback")
        assert cursor.fetchone()[0] == 3


class TestFingerprint:
    """Fingerprint generation consistency."""

    def test_same_query_same_fingerprint(self, store):
        """Identical SQL should produce the same fingerprint."""
        fp1 = store._fingerprint("SELECT id FROM users WHERE id = 1", "snowflake")
        fp2 = store._fingerprint("SELECT id FROM users WHERE id = 1", "snowflake")
        assert fp1 == fp2

    def test_different_literals_same_fingerprint(self, store):
        """Queries differing only in literal values should share a fingerprint."""
        fp1 = store._fingerprint("SELECT id FROM users WHERE id = 1", "snowflake")
        fp2 = store._fingerprint("SELECT id FROM users WHERE id = 42", "snowflake")
        assert fp1 == fp2

    def test_different_string_literals_same_fingerprint(self, store):
        """Queries differing only in string literals should share a fingerprint."""
        fp1 = store._fingerprint("SELECT * FROM users WHERE name = 'alice'", "snowflake")
        fp2 = store._fingerprint("SELECT * FROM users WHERE name = 'bob'", "snowflake")
        assert fp1 == fp2

    def test_different_structure_different_fingerprint(self, store):
        """Structurally different queries should have different fingerprints."""
        fp1 = store._fingerprint("SELECT id FROM users", "snowflake")
        fp2 = store._fingerprint("SELECT id FROM orders", "snowflake")
        assert fp1 != fp2

    def test_fingerprint_is_hex_hash(self, store):
        """Fingerprint should be a hex-encoded SHA256 hash (64 chars)."""
        fp = store._fingerprint("SELECT 1", "snowflake")
        assert len(fp) == 64
        assert all(c in "0123456789abcdef" for c in fp)


class TestTemplateHash:
    """Template hash normalization."""

    def test_same_template_same_hash(self, store):
        """Same query template with different values should produce the same hash."""
        h1 = store._template_hash("SELECT * FROM t WHERE x = 1 AND y = 'a'", "snowflake")
        h2 = store._template_hash("SELECT * FROM t WHERE x = 99 AND y = 'z'", "snowflake")
        assert h1 == h2

    def test_different_template_different_hash(self, store):
        """Different query structures produce different template hashes."""
        h1 = store._template_hash("SELECT * FROM t WHERE x = 1", "snowflake")
        h2 = store._template_hash("SELECT * FROM t WHERE x = 1 AND y = 2", "snowflake")
        assert h1 != h2

    def test_template_hash_is_hex(self, store):
        """Template hash should be a hex-encoded SHA256."""
        h = store._template_hash("SELECT 1", "snowflake")
        assert len(h) == 64


class TestRegexStripLiterals:
    """The regex fallback for literal stripping."""

    def test_strips_string_literals(self):
        result = _regex_strip_literals("SELECT * FROM t WHERE name = 'alice'")
        assert "'alice'" not in result
        assert "'?'" in result

    def test_strips_numeric_literals(self):
        result = _regex_strip_literals("SELECT * FROM t WHERE id = 42")
        assert "42" not in result
        assert "?" in result

    def test_normalizes_whitespace(self):
        result = _regex_strip_literals("SELECT   *   FROM   t")
        assert "   " not in result

    def test_uppercases_result(self):
        result = _regex_strip_literals("select * from users")
        assert result == result.upper()


class TestPredictTier1Fingerprint:
    """Tier 1: Fingerprint match with >= 3 observations."""

    def test_tier1_with_exact_query(self, populated_store):
        """With 5 observations of the same query, predict should use tier 1."""
        prediction = populated_store.predict("SELECT id, name FROM users WHERE status = 'active'")
        assert prediction["tier"] == 1
        assert prediction["method"] == "fingerprint_match"
        assert prediction["observation_count"] == 5
        assert prediction["predicted_bytes"] is not None
        assert prediction["predicted_time_ms"] is not None
        assert prediction["predicted_credits"] is not None

    def test_tier1_with_different_literal(self, populated_store):
        """Same structure different literal should also match fingerprint."""
        prediction = populated_store.predict("SELECT id, name FROM users WHERE status = 'inactive'")
        assert prediction["tier"] == 1
        assert prediction["method"] == "fingerprint_match"

    def test_tier1_confidence_levels(self, store):
        """Confidence depends on observation count."""
        sql = "SELECT * FROM confidence_test WHERE x = 1"
        # 3 observations => low confidence
        for i in range(3):
            store.record(sql=sql, bytes_scanned=1000, execution_time_ms=100, credits_used=0.001)
        pred = store.predict(sql)
        assert pred["confidence"] == "low"

        # Add to 5 => medium
        for i in range(2):
            store.record(sql=sql, bytes_scanned=1000, execution_time_ms=100, credits_used=0.001)
        pred = store.predict(sql)
        assert pred["confidence"] == "medium"

        # Add to 10 => high
        for i in range(5):
            store.record(sql=sql, bytes_scanned=1000, execution_time_ms=100, credits_used=0.001)
        pred = store.predict(sql)
        assert pred["confidence"] == "high"


class TestPredictTier2Template:
    """Tier 2: Template match with >= 3 observations."""

    def test_tier2_template_match(self, store):
        """Queries with same template (structure) should match at tier 2 if fingerprint has < 3."""
        # Record 3 observations with different WHERE values but same structure
        # Use sufficiently different SQL to get different fingerprints but same template
        base_sql = "SELECT id, name FROM users WHERE id = {}"
        for i in range(3):
            store.record(
                sql=base_sql.format(i + 1),
                bytes_scanned=2_000_000,
                execution_time_ms=300,
                credits_used=0.003,
            )
        # Predict for a new literal value
        prediction = store.predict(base_sql.format(999))
        # Should match at tier 1 or 2 (fingerprint normalizes literals, so tier 1 is likely)
        assert prediction["tier"] in (1, 2)
        assert prediction["predicted_bytes"] is not None


class TestPredictTier3TableEstimate:
    """Tier 3: Table-based estimation when < 3 fingerprint or template matches."""

    def test_tier3_with_few_observations(self, store):
        """With only 1-2 observations, tier 3 should kick in if table extraction works,
        otherwise falls through to tier 4 (heuristic)."""
        sql = "SELECT * FROM orders WHERE amount > 100"
        store.record(sql=sql, bytes_scanned=5_000_000, execution_time_ms=400, credits_used=0.004)
        prediction = store.predict(sql)
        # Tier 3 requires table extraction; if metadata returns empty tables, falls to tier 4
        assert prediction["tier"] in (3, 4)
        assert prediction["predicted_bytes"] is not None


class TestPredictTier4Heuristic:
    """Tier 4: Static heuristic with no prior observations."""

    def test_tier4_no_observations(self, store):
        """With no observations at all, tier 4 heuristic should be used."""
        prediction = store.predict("SELECT * FROM brand_new_table WHERE x = 1")
        assert prediction["tier"] == 4
        assert prediction["confidence"] == "very_low"
        assert prediction["method"] == "static_heuristic"
        assert prediction["observation_count"] == 0
        assert prediction["predicted_bytes"] > 0
        assert prediction["predicted_time_ms"] > 0
        assert prediction["predicted_credits"] > 0

    def test_tier4_complexity_scaling(self, store):
        """More complex queries should produce equal or higher cost estimates."""
        simple = store.predict("SELECT 1")
        complex_q = store.predict("""
            SELECT a.id, b.name, c.total
            FROM orders a
            JOIN customers b ON a.customer_id = b.id
            JOIN order_totals c ON a.id = c.order_id
            WHERE a.status = 'active'
            ORDER BY c.total DESC
        """)
        assert complex_q["predicted_bytes"] >= simple["predicted_bytes"]
        assert complex_q["predicted_time_ms"] >= simple["predicted_time_ms"]

    def test_tier4_with_aggregation(self, store):
        """Aggregation queries should have higher complexity."""
        simple = store.predict("SELECT id FROM t")
        agg = store.predict("SELECT COUNT(*), SUM(amount) FROM orders GROUP BY status")
        assert agg["predicted_bytes"] >= simple["predicted_bytes"]

    def test_tier4_with_window_functions(self, store):
        """Window functions should increase complexity."""
        base = store.predict("SELECT id FROM t")
        windowed = store.predict("SELECT id, ROW_NUMBER() OVER (ORDER BY id) FROM t")
        assert windowed["predicted_bytes"] >= base["predicted_bytes"]

    def test_tier4_cross_join_high_complexity(self, store):
        """CROSS JOINs should significantly increase the estimate."""
        simple = store.predict("SELECT id FROM t")
        cross = store.predict("SELECT * FROM a CROSS JOIN b")
        assert cross["predicted_bytes"] > simple["predicted_bytes"]

    def test_tier4_unparseable_sql_falls_back_to_length(self, store):
        """If SQL can't be parsed, heuristic uses length."""
        # This is valid-ish but may or may not parse
        prediction = store.predict("INVALID SQL THAT WILL NOT PARSE !@#$")
        assert prediction["tier"] == 4
        assert prediction["method"] == "static_heuristic"


class TestPredictMedianCalculation:
    """Verify median-based aggregation."""

    def test_median_of_three(self, store):
        """With 3 observations, median should be the middle value."""
        sql = "SELECT * FROM median_test WHERE x = 1"
        store.record(sql=sql, bytes_scanned=100, execution_time_ms=10, credits_used=0.001)
        store.record(sql=sql, bytes_scanned=200, execution_time_ms=20, credits_used=0.002)
        store.record(sql=sql, bytes_scanned=300, execution_time_ms=30, credits_used=0.003)
        pred = store.predict(sql)
        assert pred["predicted_bytes"] == 200
        assert pred["predicted_time_ms"] == 20
        assert pred["predicted_credits"] == 0.002

    def test_median_with_none_values(self, store):
        """None values in observations should be excluded from median."""
        sql = "SELECT * FROM partial_data WHERE x = 1"
        store.record(sql=sql, bytes_scanned=100, execution_time_ms=None, credits_used=None)
        store.record(sql=sql, bytes_scanned=200, execution_time_ms=None, credits_used=None)
        store.record(sql=sql, bytes_scanned=300, execution_time_ms=None, credits_used=None)
        pred = store.predict(sql)
        assert pred["predicted_bytes"] == 200
        assert pred["predicted_time_ms"] is None
        assert pred["predicted_credits"] is None


class TestSafeMedian:
    """Test _safe_median and _safe_median_float static methods."""

    def test_safe_median_empty(self):
        assert FeedbackStore._safe_median([]) is None

    def test_safe_median_single(self):
        assert FeedbackStore._safe_median([42]) == 42

    def test_safe_median_even_count(self):
        result = FeedbackStore._safe_median([10, 20])
        assert result == 15

    def test_safe_median_float_empty(self):
        assert FeedbackStore._safe_median_float([]) is None

    def test_safe_median_float_precision(self):
        result = FeedbackStore._safe_median_float([0.001, 0.002, 0.003])
        assert result == 0.002


class TestStoreClose:
    """Test cleanup."""

    def test_close(self, tmp_path):
        db_path = str(tmp_path / "close_test.db")
        s = FeedbackStore(db_path=db_path)
        s.close()
        # After close, operations should fail
        with pytest.raises(Exception):
            s._conn.execute("SELECT 1")

    def test_del_is_safe(self, tmp_path):
        """__del__ should not raise even if called multiple times."""
        db_path = str(tmp_path / "del_test.db")
        s = FeedbackStore(db_path=db_path)
        s.close()
        s.__del__()  # Should not raise
