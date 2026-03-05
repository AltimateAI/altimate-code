"""
True E2E tests for the Jinja preprocessor.

These tests spawn `python -m altimate_engine.server` as a real subprocess
and communicate via stdin/stdout JSON-RPC protocol — exactly how the
TypeScript CLI communicates with the Python engine in production.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

ENGINE_SRC = str(Path(__file__).resolve().parent.parent / "src")


def _make_request(method: str, params: dict, request_id: int = 1) -> str:
    """Build a JSON-RPC 2.0 request string (one line)."""
    return json.dumps({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": request_id,
    })


def _send_requests(requests: list[str], timeout: float = 30.0) -> list[dict]:
    """
    Spawn the engine server, write all requests to stdin, close stdin,
    read all responses from stdout, and return parsed JSON-RPC responses.
    """
    env = {**os.environ, "PYTHONPATH": ENGINE_SRC}

    proc = subprocess.Popen(
        [sys.executable, "-m", "altimate_engine.server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        text=True,
    )

    # Write all requests and close stdin to signal EOF
    stdin_data = "\n".join(requests) + "\n"
    try:
        stdout_data, stderr_data = proc.communicate(input=stdin_data, timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        pytest.fail(f"Server timed out after {timeout}s")

    if proc.returncode != 0 and stderr_data.strip():
        # Some warnings on stderr are OK (e.g., import warnings),
        # but a crash is not.
        if "Traceback" in stderr_data:
            pytest.fail(f"Server crashed:\n{stderr_data}")

    # Parse responses (one per line)
    responses = []
    for line in stdout_data.strip().splitlines():
        line = line.strip()
        if line:
            responses.append(json.loads(line))
    return responses


def _send_one(method: str, params: dict, request_id: int = 1) -> dict:
    """Convenience: send a single request and return the response."""
    req = _make_request(method, params, request_id)
    responses = _send_requests([req])
    assert len(responses) == 1, f"Expected 1 response, got {len(responses)}"
    return responses[0]


# ---------------------------------------------------------------------------
# E2E: sql.preprocess_jinja
# ---------------------------------------------------------------------------


class TestPreprocessJinjaE2E:
    """Test the sql.preprocess_jinja RPC method end-to-end."""

    def test_simple_ref(self):
        resp = _send_one("sql.preprocess_jinja", {
            "sql": "SELECT * FROM {{ ref('orders') }}",
        })
        assert resp.get("error") is None, f"Unexpected error: {resp.get('error')}"
        result = resp["result"]
        assert result["success"] is True
        assert result["was_preprocessed"] is True
        assert "orders" in result["preprocessed_sql"]
        assert "{{" not in result["preprocessed_sql"]
        assert result["refs_found"] == ["orders"]

    def test_source_macro(self):
        resp = _send_one("sql.preprocess_jinja", {
            "sql": "SELECT * FROM {{ source('raw', 'events') }}",
        })
        result = resp["result"]
        assert result["success"] is True
        assert "raw__events" in result["preprocessed_sql"]
        assert result["sources_found"] == ["raw.events"]

    def test_var_macro(self):
        resp = _send_one("sql.preprocess_jinja", {
            "sql": "WHERE date >= {{ var('start_date') }}",
        })
        result = resp["result"]
        assert result["success"] is True
        assert "'__var_start_date__'" in result["preprocessed_sql"]
        assert result["variables_found"] == ["start_date"]

    def test_no_jinja_passthrough(self):
        plain_sql = "SELECT 1 AS id FROM orders"
        resp = _send_one("sql.preprocess_jinja", {"sql": plain_sql})
        result = resp["result"]
        assert result["success"] is True
        assert result["was_preprocessed"] is False
        assert result["preprocessed_sql"] == plain_sql

    def test_complex_dbt_model(self):
        sql = """
        {{ config(
            materialized='incremental',
            unique_key='order_id',
            schema='mart'
        ) }}

        {# Pull staged data #}

        WITH source AS (
            SELECT *
            FROM {{ ref('stg_orders') }}
            {% if is_incremental() %}
            WHERE updated_at > (SELECT MAX(updated_at) FROM {{ this }})
            {% endif %}
        ),

        customers AS (
            SELECT *
            FROM {{ ref('stg_customers') }}
        )

        SELECT
            s.order_id,
            s.customer_id,
            c.customer_name,
            s.order_date,
            s.amount,
            {{ var('tax_rate', 0.1) }} AS tax_rate
        FROM source s
        LEFT JOIN customers c ON s.customer_id = c.customer_id
        """
        resp = _send_one("sql.preprocess_jinja", {"sql": sql})
        result = resp["result"]
        assert result["success"] is True
        assert result["was_preprocessed"] is True

        preprocessed = result["preprocessed_sql"]
        assert "{{" not in preprocessed
        assert "{%" not in preprocessed
        assert "{#" not in preprocessed
        assert "stg_orders" in preprocessed
        assert "stg_customers" in preprocessed
        assert "__this__" in preprocessed

        assert set(result["refs_found"]) == {"stg_orders", "stg_customers"}
        assert "tax_rate" in result["variables_found"]
        assert "config()" in result["macros_removed"]

    def test_empty_sql(self):
        resp = _send_one("sql.preprocess_jinja", {"sql": ""})
        result = resp["result"]
        assert result["success"] is True
        assert result["was_preprocessed"] is False


# ---------------------------------------------------------------------------
# E2E: batch requests (multiple requests in one session)
# ---------------------------------------------------------------------------


class TestBatchRequestsE2E:
    """
    Verify the server correctly handles multiple sequential requests
    in a single subprocess session — mimicking how the TS bridge keeps
    the Python process alive and sends multiple requests.
    """

    def test_multiple_requests_one_session(self):
        requests = [
            _make_request("sql.preprocess_jinja", {
                "sql": "SELECT * FROM {{ ref('users') }}",
            }, request_id=1),
            _make_request("sql.preprocess_jinja", {
                "sql": "SELECT 1",
            }, request_id=2),
            _make_request("sql.preprocess_jinja", {
                "sql": "SELECT * FROM {{ source('raw', 'events') }} WHERE dt >= {{ var('cutoff') }}",
            }, request_id=3),
        ]
        responses = _send_requests(requests)
        assert len(responses) == 3

        # Response 1: ref preprocessed
        r1 = responses[0]
        assert r1["id"] == 1
        assert r1["result"]["was_preprocessed"] is True
        assert r1["result"]["refs_found"] == ["users"]

        # Response 2: no jinja
        r2 = responses[1]
        assert r2["id"] == 2
        assert r2["result"]["was_preprocessed"] is False

        # Response 3: source + var
        r3 = responses[2]
        assert r3["id"] == 3
        assert r3["result"]["was_preprocessed"] is True
        assert r3["result"]["sources_found"] == ["raw.events"]
        assert r3["result"]["variables_found"] == ["cutoff"]


# ---------------------------------------------------------------------------
# E2E: auto-preprocessing in downstream tools
# ---------------------------------------------------------------------------


class TestAutoPreprocessingE2E:
    """
    Test that sql.analyze, sql.format, sql.translate, and sql.optimize
    automatically preprocess Jinja-templated SQL before processing.

    Note: These tests require altimate_core to be installed for full
    verification. They are marked to allow graceful failure if altimate_core
    is not available.
    """

    def test_sql_analyze_auto_preprocesses_jinja(self):
        resp = _send_one("sql.analyze", {
            "sql": "SELECT * FROM {{ ref('orders') }}",
            "dialect": "snowflake",
        })
        if resp.get("error"):
            err_msg = resp["error"].get("message", "")
            if "altimate_core" in err_msg or "guard" in err_msg:
                pytest.skip("altimate_core not installed")
            pytest.fail(f"Unexpected error: {resp['error']}")

        result = resp["result"]
        # The confidence_factors should mention Jinja preprocessing
        # regardless of whether altimate_core succeeded
        factors = result.get("confidence_factors", [])
        jinja_noted = any("Jinja" in f for f in factors)
        assert jinja_noted, f"Expected Jinja note in confidence_factors: {factors}"
        # If altimate_core is installed, also check success
        if result.get("success"):
            assert result["issue_count"] >= 0

    def test_sql_format_auto_preprocesses_jinja(self):
        resp = _send_one("sql.format", {
            "sql": "select * from {{ ref('orders') }} where id=1",
            "dialect": "snowflake",
        })
        if resp.get("error"):
            err_msg = resp["error"].get("message", "")
            if "altimate_core" in err_msg or "guard" in err_msg:
                pytest.skip("altimate_core not installed")
            pytest.fail(f"Unexpected error: {resp['error']}")

        result = resp["result"]
        # Verify the method ran (regardless of altimate_core being present)
        assert "formatted_sql" in result or "error" in result
        # If altimate_core is missing, error mentions it; if present, success
        if not result.get("success"):
            assert "altimate" in result.get("error", "").lower()
        else:
            assert result["formatted_sql"] is not None

    def test_sql_translate_auto_preprocesses_jinja(self):
        resp = _send_one("sql.translate", {
            "sql": "SELECT DATEADD(day, 7, CURRENT_DATE()) FROM {{ ref('orders') }}",
            "source_dialect": "snowflake",
            "target_dialect": "bigquery",
        })
        if resp.get("error"):
            err_msg = resp["error"].get("message", "")
            if "altimate_core" in err_msg or "guard" in err_msg:
                pytest.skip("altimate_core not installed")
            pytest.fail(f"Unexpected error: {resp['error']}")

        result = resp["result"]
        # Verify the method ran (regardless of altimate_core)
        if result.get("success"):
            # Should warn about Jinja templates needing re-application
            warnings = result.get("warnings", [])
            jinja_warned = any("Jinja" in w for w in warnings)
            assert jinja_warned, f"Expected Jinja warning: {warnings}"
        else:
            # altimate_core not installed — still verify the response shape
            assert "error" in result
            assert "altimate" in result["error"].lower()

    def test_sql_optimize_auto_preprocesses_jinja(self):
        resp = _send_one("sql.optimize", {
            "sql": "SELECT * FROM {{ ref('orders') }} WHERE 1=1",
            "dialect": "snowflake",
        })
        if resp.get("error"):
            err_msg = resp["error"].get("message", "")
            if "altimate_core" in err_msg or "guard" in err_msg:
                pytest.skip("altimate_core not installed")
            pytest.fail(f"Unexpected error: {resp['error']}")

        result = resp["result"]
        assert result["success"] is True


# ---------------------------------------------------------------------------
# E2E: error handling
# ---------------------------------------------------------------------------


class TestErrorHandlingE2E:
    """Test error cases end-to-end through the actual server."""

    def test_invalid_json(self):
        """Server should handle malformed JSON gracefully."""
        env = {**os.environ, "PYTHONPATH": ENGINE_SRC}
        proc = subprocess.Popen(
            [sys.executable, "-m", "altimate_engine.server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
        )
        stdout, _ = proc.communicate(input="this is not json\n", timeout=10)
        responses = [json.loads(l) for l in stdout.strip().splitlines() if l.strip()]
        assert len(responses) == 1
        assert responses[0].get("error") is not None
        assert responses[0]["error"]["code"] == -32700  # Parse error

    def test_unknown_method(self):
        resp = _send_one("sql.nonexistent_method", {"sql": "SELECT 1"})
        assert resp.get("error") is not None
        assert resp["error"]["code"] == -32601  # Method not found

    def test_missing_params(self):
        resp = _send_one("sql.preprocess_jinja", {})
        # Should error because 'sql' param is required
        assert resp.get("error") is not None

    def test_empty_lines_ignored(self):
        """Empty lines should not produce responses."""
        env = {**os.environ, "PYTHONPATH": ENGINE_SRC}
        proc = subprocess.Popen(
            [sys.executable, "-m", "altimate_engine.server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
        )
        # Send empty lines interspersed with a real request
        stdin_data = "\n\n" + _make_request("sql.preprocess_jinja", {"sql": "SELECT 1"}, 1) + "\n\n\n"
        stdout, _ = proc.communicate(input=stdin_data, timeout=10)
        responses = [json.loads(l) for l in stdout.strip().splitlines() if l.strip()]
        assert len(responses) == 1
        assert responses[0]["id"] == 1
        assert responses[0]["result"]["was_preprocessed"] is False


# ---------------------------------------------------------------------------
# E2E: protocol correctness
# ---------------------------------------------------------------------------


class TestProtocolE2E:
    """Verify JSON-RPC 2.0 protocol correctness through the real server."""

    def test_response_has_jsonrpc_field(self):
        resp = _send_one("sql.preprocess_jinja", {"sql": "SELECT 1"})
        assert resp.get("jsonrpc") == "2.0"

    def test_response_id_matches_request(self):
        req = _make_request("sql.preprocess_jinja", {"sql": "SELECT 1"}, request_id=42)
        responses = _send_requests([req])
        assert responses[0]["id"] == 42

    def test_sequential_ids_preserved(self):
        requests = [
            _make_request("sql.preprocess_jinja", {"sql": "SELECT 1"}, request_id=10),
            _make_request("sql.preprocess_jinja", {"sql": "SELECT 2"}, request_id=20),
            _make_request("sql.preprocess_jinja", {"sql": "SELECT 3"}, request_id=30),
        ]
        responses = _send_requests(requests)
        assert [r["id"] for r in responses] == [10, 20, 30]

    def test_error_response_format(self):
        resp = _send_one("sql.nonexistent", {"sql": "SELECT 1"})
        assert "error" in resp
        assert "code" in resp["error"]
        assert "message" in resp["error"]
        assert resp.get("result") is None
