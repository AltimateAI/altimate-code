"""Feedback store for query execution metrics — enables cost prediction."""

from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from altimate_engine.sql.guard import guard_extract_metadata, guard_complexity_score


_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS query_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT NOT NULL,
    template_hash TEXT NOT NULL,
    bytes_scanned INTEGER,
    rows_produced INTEGER,
    execution_time_ms INTEGER,
    credits_used REAL,
    warehouse_size TEXT,
    dialect TEXT DEFAULT 'snowflake',
    timestamp TEXT NOT NULL
);
"""

_CREATE_INDEX_FINGERPRINT = (
    "CREATE INDEX IF NOT EXISTS idx_fingerprint ON query_feedback(fingerprint);"
)
_CREATE_INDEX_TEMPLATE = (
    "CREATE INDEX IF NOT EXISTS idx_template ON query_feedback(template_hash);"
)


def _default_db_path() -> str:
    """Return the default feedback database path: ~/.altimate/feedback.db"""
    altimate_dir = Path.home() / ".altimate"
    altimate_dir.mkdir(parents=True, exist_ok=True)
    return str(altimate_dir / "feedback.db")


def _regex_strip_literals(sql: str) -> str:
    """Regex-based literal stripping for SQL fingerprinting.

    Replaces string literals, numeric literals, and boolean literals with
    placeholders. Normalizes whitespace.
    """
    # Replace single-quoted strings
    result = re.sub(r"'[^']*'", "'?'", sql)
    # Replace double-quoted strings (that are not identifiers in some dialects)
    # Be conservative — skip this for Snowflake where double quotes are identifiers
    # Replace numeric literals (integers and floats, but not in identifiers)
    result = re.sub(r"\b\d+(\.\d+)?\b", "?", result)
    # Normalize whitespace
    result = re.sub(r"\s+", " ", result).strip()
    return result.upper()


class FeedbackStore:
    """Local SQLite-based feedback store that records query execution metrics
    and uses them for cost prediction via a multi-tier hierarchy."""

    def __init__(self, db_path: str | None = None):
        """Initialize with optional db path. Defaults to ~/.altimate/feedback.db"""
        self._db_path = db_path or _default_db_path()
        self._conn = sqlite3.connect(self._db_path)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        """Create tables and indexes if they don't exist."""
        cursor = self._conn.cursor()
        cursor.execute(_CREATE_TABLE_SQL)
        cursor.execute(_CREATE_INDEX_FINGERPRINT)
        cursor.execute(_CREATE_INDEX_TEMPLATE)
        self._conn.commit()

    def record(
        self,
        sql: str,
        dialect: str = "snowflake",
        bytes_scanned: int | None = None,
        rows_produced: int | None = None,
        execution_time_ms: int | None = None,
        credits_used: float | None = None,
        warehouse_size: str | None = None,
    ) -> None:
        """Record a query execution observation."""
        fingerprint = self._fingerprint(sql, dialect)
        template_hash = self._template_hash(sql, dialect)
        timestamp = datetime.now(timezone.utc).isoformat()

        self._conn.execute(
            """
            INSERT INTO query_feedback
                (fingerprint, template_hash, bytes_scanned, rows_produced,
                 execution_time_ms, credits_used, warehouse_size, dialect, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                fingerprint,
                template_hash,
                bytes_scanned,
                rows_produced,
                execution_time_ms,
                credits_used,
                warehouse_size,
                dialect,
                timestamp,
            ),
        )
        self._conn.commit()

    def predict(self, sql: str, dialect: str = "snowflake") -> dict[str, Any]:
        """Predict cost for a query using a multi-tier hierarchy.

        Tiers:
            1. Fingerprint match (>= 3 observations) — median of matching fingerprints
            2. Template match (>= 3 observations) — median of matching templates
            3. Table scan estimate — sum of estimated table sizes from schema
            4. Static heuristic — based on query complexity (joins, aggregations, etc.)

        Returns:
            Dictionary with keys: tier, confidence, predicted_bytes, predicted_time_ms,
            predicted_credits, method, observation_count
        """
        # Tier 1: Fingerprint match
        fingerprint = self._fingerprint(sql, dialect)
        rows = self._fetch_observations_by_fingerprint(fingerprint)
        if len(rows) >= 3:
            return self._aggregate_predictions(rows, tier=1, method="fingerprint_match")

        # Tier 2: Template match
        template_hash = self._template_hash(sql, dialect)
        rows = self._fetch_observations_by_template(template_hash)
        if len(rows) >= 3:
            return self._aggregate_predictions(rows, tier=2, method="template_match")

        # Tier 3: Table scan estimate
        table_estimate = self._estimate_from_tables(sql, dialect)
        if table_estimate is not None:
            return {
                "tier": 3,
                "confidence": "low",
                "predicted_bytes": table_estimate["predicted_bytes"],
                "predicted_time_ms": table_estimate["predicted_time_ms"],
                "predicted_credits": table_estimate["predicted_credits"],
                "method": "table_scan_estimate",
                "observation_count": table_estimate["observation_count"],
            }

        # Tier 4: Static heuristic
        return self._static_heuristic(sql, dialect)

    def _fingerprint(self, sql: str, dialect: str) -> str:
        """Normalize SQL to a canonical fingerprint (strip literals, normalize whitespace)."""
        normalized = _regex_strip_literals(sql)
        return hashlib.sha256(normalized.encode()).hexdigest()

    def _template_hash(self, sql: str, dialect: str) -> str:
        """Generalized hash: preserve table structure, replace all literals with ?."""
        # Replace string literals with '?', numbers with ?
        result = re.sub(r"'[^']*'", "'?'", sql)
        result = re.sub(r"\b\d+(\.\d+)?\b", "?", result)
        result = re.sub(r"\s+", " ", result).strip().upper()
        return hashlib.sha256(result.encode()).hexdigest()

    # --- Internal helpers ---

    def _fetch_observations_by_fingerprint(self, fingerprint: str) -> list[sqlite3.Row]:
        """Fetch all observations matching a fingerprint."""
        cursor = self._conn.execute(
            "SELECT * FROM query_feedback WHERE fingerprint = ? ORDER BY timestamp DESC",
            (fingerprint,),
        )
        return cursor.fetchall()

    def _fetch_observations_by_template(self, template_hash: str) -> list[sqlite3.Row]:
        """Fetch all observations matching a template hash."""
        cursor = self._conn.execute(
            "SELECT * FROM query_feedback WHERE template_hash = ? ORDER BY timestamp DESC",
            (template_hash,),
        )
        return cursor.fetchall()

    def _aggregate_predictions(
        self, rows: list[sqlite3.Row], tier: int, method: str
    ) -> dict[str, Any]:
        """Compute median-based predictions from a list of observations."""
        count = len(rows)

        bytes_values = [
            r["bytes_scanned"] for r in rows if r["bytes_scanned"] is not None
        ]
        time_values = [
            r["execution_time_ms"] for r in rows if r["execution_time_ms"] is not None
        ]
        credit_values = [
            r["credits_used"] for r in rows if r["credits_used"] is not None
        ]

        predicted_bytes = int(statistics.median(bytes_values)) if bytes_values else None
        predicted_time_ms = int(statistics.median(time_values)) if time_values else None
        predicted_credits = (
            round(statistics.median(credit_values), 6) if credit_values else None
        )

        # Confidence based on observation count
        if count >= 10:
            confidence = "high"
        elif count >= 5:
            confidence = "medium"
        else:
            confidence = "low"

        return {
            "tier": tier,
            "confidence": confidence,
            "predicted_bytes": predicted_bytes,
            "predicted_time_ms": predicted_time_ms,
            "predicted_credits": predicted_credits,
            "method": method,
            "observation_count": count,
        }

    def _estimate_from_tables(self, sql: str, dialect: str) -> dict[str, Any] | None:
        """Tier 3: Estimate cost based on historical data for the tables in the query.

        Looks up all observations involving the same tables (via template patterns)
        and produces a rough average. Returns None if no relevant data is found.
        """
        metadata = guard_extract_metadata(sql, dialect)
        table_names = set()
        for t in metadata.get("tables", []):
            name = t.get("name", t) if isinstance(t, dict) else str(t)
            if name:
                table_names.add(name.upper())

        if not table_names:
            return None

        # If we have any fingerprint observations (even < 3), use them
        fingerprint = self._fingerprint(sql, dialect)
        rows = self._fetch_observations_by_fingerprint(fingerprint)
        if rows:
            # We have some observations but less than 3 (otherwise tier 1 would catch it)
            return {
                "predicted_bytes": self._safe_median(
                    [r["bytes_scanned"] for r in rows if r["bytes_scanned"] is not None]
                ),
                "predicted_time_ms": self._safe_median(
                    [
                        r["execution_time_ms"]
                        for r in rows
                        if r["execution_time_ms"] is not None
                    ]
                ),
                "predicted_credits": self._safe_median_float(
                    [r["credits_used"] for r in rows if r["credits_used"] is not None]
                ),
                "observation_count": len(rows),
            }

        # Check template observations
        template_hash = self._template_hash(sql, dialect)
        rows = self._fetch_observations_by_template(template_hash)
        if rows:
            return {
                "predicted_bytes": self._safe_median(
                    [r["bytes_scanned"] for r in rows if r["bytes_scanned"] is not None]
                ),
                "predicted_time_ms": self._safe_median(
                    [
                        r["execution_time_ms"]
                        for r in rows
                        if r["execution_time_ms"] is not None
                    ]
                ),
                "predicted_credits": self._safe_median_float(
                    [r["credits_used"] for r in rows if r["credits_used"] is not None]
                ),
                "observation_count": len(rows),
            }

        return None

    # Dialect-specific base cost profiles for the static heuristic.
    # bytes_scanned and credits are None for databases that don't expose them.
    _HEURISTIC_PROFILES: dict[str, dict[str, int | float | None]] = {
        "snowflake": {
            "base_bytes": 10_000_000,
            "base_time_ms": 500,
            "base_credits": 0.001,
        },
        "postgres": {
            "base_bytes": None,
            "base_time_ms": 100,
            "base_credits": None,
        },
        "duckdb": {
            "base_bytes": None,
            "base_time_ms": 10,
            "base_credits": None,
        },
        "bigquery": {
            "base_bytes": 10_000_000,
            "base_time_ms": 500,
            "base_credits": None,
        },
        "databricks": {
            "base_bytes": 10_000_000,
            "base_time_ms": 500,
            "base_credits": None,
        },
    }

    _DEFAULT_HEURISTIC_PROFILE: dict[str, int | float | None] = {
        "base_bytes": 10_000_000,
        "base_time_ms": 500,
        "base_credits": 0.001,
    }

    def _static_heuristic(self, sql: str, dialect: str) -> dict[str, Any]:
        """Tier 4: Estimate cost based on query complexity analysis.

        Uses sqlguard complexity scoring, falling back to length-based heuristic.
        Base costs are dialect-dependent: Snowflake uses bytes-scanned and
        credit metrics, while Postgres and DuckDB use execution-time only.
        """
        complexity = guard_complexity_score(sql)
        complexity_score = complexity.get("total", complexity.get("score"))
        if not complexity_score:
            complexity_score = max(1.0, len(sql) / 100.0)

        # Select dialect-specific base costs
        d = (dialect or "").lower()
        profile = self._HEURISTIC_PROFILES.get(d, self._DEFAULT_HEURISTIC_PROFILE)

        base_bytes = profile["base_bytes"]
        base_time_ms = profile["base_time_ms"]
        base_credits = profile["base_credits"]

        predicted_bytes = (
            int(base_bytes * complexity_score) if base_bytes is not None else None
        )
        predicted_time_ms = (
            int(base_time_ms * complexity_score) if base_time_ms is not None else None
        )
        predicted_credits = (
            round(base_credits * complexity_score, 6)
            if base_credits is not None
            else None
        )

        return {
            "tier": 4,
            "confidence": "very_low",
            "predicted_bytes": predicted_bytes,
            "predicted_time_ms": predicted_time_ms,
            "predicted_credits": predicted_credits,
            "method": "static_heuristic",
            "observation_count": 0,
        }

    @staticmethod
    def _safe_median(values: list[int]) -> int | None:
        """Compute median of integer values, returning None for empty lists."""
        if not values:
            return None
        return int(statistics.median(values))

    @staticmethod
    def _safe_median_float(values: list[float]) -> float | None:
        """Compute median of float values, returning None for empty lists."""
        if not values:
            return None
        return round(statistics.median(values), 6)

    def close(self) -> None:
        """Close the database connection."""
        self._conn.close()

    def __del__(self) -> None:
        """Ensure connection is closed on garbage collection."""
        try:
            self._conn.close()
        except Exception:
            pass
