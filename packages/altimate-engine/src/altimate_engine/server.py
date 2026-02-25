"""JSON-RPC server over stdio for DataPilot Engine.

Reads JSON-RPC requests from stdin (one per line), dispatches to handlers,
and writes JSON-RPC responses to stdout.

Usage:
    echo '{"jsonrpc":"2.0","method":"sql.validate","params":{"sql":"SELECT 1"},"id":1}' | python -m altimate_engine.server
"""

from __future__ import annotations

import json
import os
import sys
import traceback

from altimate_engine.models import (
    DbtManifestParams,
    DbtRunParams,
    JsonRpcError,
    JsonRpcRequest,
    JsonRpcResponse,
    LineageCheckParams,
    SchemaCacheStatusParams,
    SchemaCacheStatusResult,
    SchemaCacheWarehouseStatus,
    SchemaIndexParams,
    SchemaIndexResult,
    SchemaInspectParams,
    SchemaSearchColumnResult,
    SchemaSearchParams,
    SchemaSearchResult,
    SchemaSearchTableResult,
    SqlAnalyzeIssue,
    SqlAnalyzeParams,
    SqlAnalyzeResult,
    SqlAutocompleteParams,
    SqlAutocompleteResult,
    SqlAutocompleteSuggestion,
    SqlCheckParams,
    SqlExecuteParams,
    SqlExplainParams,
    SqlExplainResult,
    SqlFixParams,
    SqlFixResult,
    SqlFixSuggestion,
    SqlFormatParams,
    SqlFormatResult,
    SqlOptimizeParams,
    SqlOptimizeResult,
    SqlPredictCostParams,
    SqlPredictCostResult,
    SqlRecordFeedbackParams,
    SqlRecordFeedbackResult,
    SqlTranslateParams,
    SqlTranslateResult,
    SqlValidateParams,
    WarehouseInfo,
    WarehouseListResult,
    WarehouseTestParams,
    WarehouseTestResult,
)
from altimate_engine.sql.guard import check_sql, validate_sql
from altimate_engine.sql.executor import execute_sql
from altimate_engine.sql.analyzer import analyze_sql
from altimate_engine.sql.optimizer import optimize_sql
from altimate_engine.sql.translator import translate_sql
from altimate_engine.sql.formatter import format_sql
from altimate_engine.sql.explainer import explain_sql
from altimate_engine.sql.fixer import fix_sql
from altimate_engine.sql.autocomplete import autocomplete_sql
from altimate_engine.schema.inspector import inspect_schema
from altimate_engine.dbt.runner import run_dbt
from altimate_engine.dbt.manifest import parse_manifest
from altimate_engine.connections import ConnectionRegistry
from altimate_engine.lineage.check import check_lineage
from altimate_engine.sql.feedback_store import FeedbackStore
from altimate_engine.schema.cache import SchemaCache


# JSON-RPC error codes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

# Lazily-initialized singletons
_feedback_store: FeedbackStore | None = None
_schema_cache: SchemaCache | None = None


def _get_feedback_store() -> FeedbackStore:
    """Return the singleton FeedbackStore, creating it on first use."""
    global _feedback_store
    if _feedback_store is None:
        _feedback_store = FeedbackStore()
    return _feedback_store


def _get_schema_cache() -> SchemaCache:
    """Return the singleton SchemaCache, creating it on first use."""
    global _schema_cache
    if _schema_cache is None:
        _schema_cache = SchemaCache()
    return _schema_cache


def _compute_overall_confidence(issues: list) -> str:
    """Compute overall confidence from individual issue confidences."""
    if not issues:
        return "high"
    confidences = [getattr(i, 'confidence', 'high') for i in issues]
    if "low" in confidences:
        return "low"
    if "medium" in confidences:
        return "medium"
    return "high"


def _get_confidence_factors(raw_result: dict) -> list[str]:
    """Extract confidence factors from analysis result."""
    factors = []
    if not raw_result.get("success", True):
        factors.append("SQL parse failed — results may be incomplete")
    return factors


def dispatch(request: JsonRpcRequest) -> JsonRpcResponse:
    """Dispatch a JSON-RPC request to the appropriate handler."""
    method = request.method
    params = request.params or {}

    try:
        if method == "sql.validate":
            result = validate_sql(SqlValidateParams(**params))
        elif method == "sql.check":
            result = check_sql(SqlCheckParams(**params))
        elif method == "sql.execute":
            result = execute_sql(SqlExecuteParams(**params))
        elif method == "schema.inspect":
            result = inspect_schema(SchemaInspectParams(**params))
        elif method == "sql.analyze":
            params_obj = SqlAnalyzeParams(**params)
            raw_result = analyze_sql(params_obj.sql, params_obj.dialect or "snowflake")
            # Convert raw dict result to SqlAnalyzeResult model
            issues = []
            for issue in raw_result.get("issues", []):
                issues.append(SqlAnalyzeIssue(
                    type=issue["type"],
                    severity=issue.get("severity", "warning"),
                    message=issue["message"],
                    recommendation=issue.get("recommendation", ""),
                    location=issue.get("location"),
                    confidence=issue.get("confidence", "high"),
                ))
            result = SqlAnalyzeResult(
                success=raw_result.get("success", True),
                issues=issues,
                issue_count=len(issues),
                confidence=_compute_overall_confidence(issues),
                confidence_factors=_get_confidence_factors(raw_result),
                error=raw_result.get("error"),
            )
        elif method == "sql.translate":
            params_obj = SqlTranslateParams(**params)
            result_dict = translate_sql(params_obj.sql, params_obj.source_dialect, params_obj.target_dialect)
            result = SqlTranslateResult(**result_dict)
        elif method == "sql.optimize":
            params_obj = SqlOptimizeParams(**params)
            result_dict = optimize_sql(params_obj.sql, params_obj.dialect, params_obj.schema_context)
            result = SqlOptimizeResult(**result_dict)
        elif method == "lineage.check":
            result = check_lineage(LineageCheckParams(**params))
        elif method == "dbt.run":
            result = run_dbt(DbtRunParams(**params))
        elif method == "dbt.manifest":
            result = parse_manifest(DbtManifestParams(**params))
        elif method == "warehouse.list":
            warehouses = [WarehouseInfo(**w) for w in ConnectionRegistry.list()]
            result = WarehouseListResult(warehouses=warehouses)
        elif method == "warehouse.test":
            test_params = WarehouseTestParams(**params)
            test_result = ConnectionRegistry.test(test_params.name)
            result = WarehouseTestResult(**test_result)
        elif method == "sql.record_feedback":
            fb_params = SqlRecordFeedbackParams(**params)
            store = _get_feedback_store()
            store.record(
                sql=fb_params.sql,
                dialect=fb_params.dialect,
                bytes_scanned=fb_params.bytes_scanned,
                rows_produced=fb_params.rows_produced,
                execution_time_ms=fb_params.execution_time_ms,
                credits_used=fb_params.credits_used,
                warehouse_size=fb_params.warehouse_size,
            )
            result = SqlRecordFeedbackResult(recorded=True)
        elif method == "sql.predict_cost":
            pc_params = SqlPredictCostParams(**params)
            store = _get_feedback_store()
            prediction = store.predict(sql=pc_params.sql, dialect=pc_params.dialect)
            result = SqlPredictCostResult(**prediction)
        elif method == "sql.format":
            fmt_params = SqlFormatParams(**params)
            fmt_result = format_sql(fmt_params.sql, fmt_params.dialect, fmt_params.indent)
            result = SqlFormatResult(**fmt_result)
        elif method == "sql.explain":
            result = explain_sql(SqlExplainParams(**params))
        elif method == "sql.fix":
            fix_params = SqlFixParams(**params)
            fix_result = fix_sql(fix_params.sql, fix_params.error_message, fix_params.dialect)
            result = SqlFixResult(
                success=fix_result["success"],
                original_sql=fix_result["original_sql"],
                fixed_sql=fix_result.get("fixed_sql"),
                error_message=fix_result["error_message"],
                suggestions=[SqlFixSuggestion(**s) for s in fix_result["suggestions"]],
                suggestion_count=fix_result["suggestion_count"],
            )
        elif method == "sql.autocomplete":
            ac_params = SqlAutocompleteParams(**params)
            cache = _get_schema_cache()
            ac_result = autocomplete_sql(
                prefix=ac_params.prefix,
                position=ac_params.position,
                warehouse=ac_params.warehouse,
                table_context=ac_params.table_context,
                limit=ac_params.limit,
                cache=cache,
            )
            result = SqlAutocompleteResult(
                suggestions=[SqlAutocompleteSuggestion(**s) for s in ac_result["suggestions"]],
                prefix=ac_result["prefix"],
                position=ac_result["position"],
                suggestion_count=ac_result["suggestion_count"],
            )
        elif method == "schema.index":
            idx_params = SchemaIndexParams(**params)
            connector = ConnectionRegistry.get(idx_params.warehouse)
            connector.connect()
            try:
                # Look up warehouse type from registry
                wh_list = ConnectionRegistry.list()
                wh_type = "unknown"
                for wh in wh_list:
                    if wh["name"] == idx_params.warehouse:
                        wh_type = wh.get("type", "unknown")
                        break
                cache = _get_schema_cache()
                idx_result = cache.index_warehouse(idx_params.warehouse, wh_type, connector)
                result = SchemaIndexResult(**idx_result)
            finally:
                connector.close()
        elif method == "schema.search":
            search_params = SchemaSearchParams(**params)
            cache = _get_schema_cache()
            raw = cache.search(
                query=search_params.query,
                warehouse=search_params.warehouse,
                limit=search_params.limit,
            )
            result = SchemaSearchResult(
                tables=[SchemaSearchTableResult(**t) for t in raw["tables"]],
                columns=[SchemaSearchColumnResult(**c) for c in raw["columns"]],
                query=raw["query"],
                match_count=raw["match_count"],
            )
        elif method == "schema.cache_status":
            cache = _get_schema_cache()
            raw = cache.cache_status()
            result = SchemaCacheStatusResult(
                warehouses=[SchemaCacheWarehouseStatus(**w) for w in raw["warehouses"]],
                total_tables=raw["total_tables"],
                total_columns=raw["total_columns"],
                cache_path=raw["cache_path"],
            )
        elif method == "ping":
            return JsonRpcResponse(result={"status": "ok"}, id=request.id)
        else:
            return JsonRpcResponse(
                error=JsonRpcError(
                    code=METHOD_NOT_FOUND,
                    message=f"Method not found: {method}",
                ),
                id=request.id,
            )

        return JsonRpcResponse(
            result=result.model_dump(),
            id=request.id,
        )
    except TypeError as e:
        return JsonRpcResponse(
            error=JsonRpcError(
                code=INVALID_PARAMS,
                message=f"Invalid params: {e}",
            ),
            id=request.id,
        )
    except Exception as e:
        trace_data = traceback.format_exc() if os.environ.get("ALTIMATE_ENGINE_DEBUG") else None
        return JsonRpcResponse(
            error=JsonRpcError(
                code=INTERNAL_ERROR,
                message=str(e),
                data=trace_data,
            ),
            id=request.id,
        )


def handle_line(line: str) -> str | None:
    """Parse a JSON-RPC request line and return the response JSON string."""
    line = line.strip()
    if not line:
        return None

    try:
        data = json.loads(line)
    except json.JSONDecodeError as e:
        response = JsonRpcResponse(
            error=JsonRpcError(code=PARSE_ERROR, message=f"Parse error: {e}"),
            id=None,
        )
        return response.model_dump_json()

    try:
        request = JsonRpcRequest(**data)
    except Exception as e:
        response = JsonRpcResponse(
            error=JsonRpcError(code=INVALID_REQUEST, message=f"Invalid request: {e}"),
            id=data.get("id"),
        )
        return response.model_dump_json()

    response = dispatch(request)
    return response.model_dump_json()


def main() -> None:
    """Run the JSON-RPC server, reading from stdin and writing to stdout."""
    for line in sys.stdin:
        result = handle_line(line)
        if result is not None:
            sys.stdout.write(result + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
