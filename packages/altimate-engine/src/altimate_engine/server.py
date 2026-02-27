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
    ColumnChange,
    CostGateFileResult,
    CostGateParams,
    CostGateResult,
    DbtManifestParams,
    DbtRunParams,
    JsonRpcError,
    JsonRpcRequest,
    JsonRpcResponse,
    LineageCheckParams,
    SchemaCacheStatusParams,
    SchemaCacheStatusResult,
    SchemaCacheWarehouseStatus,
    SchemaDiffParams,
    SchemaDiffResult,
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
    SqlRewriteParams,
    SqlRewriteResult,
    SqlRewriteRule,
    SqlTranslateParams,
    SqlTranslateResult,
    WarehouseInfo,
    WarehouseListResult,
    WarehouseTestParams,
    WarehouseTestResult,
    QueryHistoryParams,
    QueryHistoryResult,
    CreditAnalysisParams,
    CreditAnalysisResult,
    ExpensiveQueriesParams,
    ExpensiveQueriesResult,
    WarehouseAdvisorParams,
    WarehouseAdvisorResult,
    UnusedResourcesParams,
    UnusedResourcesResult,
    RoleGrantsParams,
    RoleGrantsResult,
    RoleHierarchyParams,
    RoleHierarchyResult,
    UserRolesParams,
    UserRolesResult,
    PiiDetectParams,
    PiiDetectResult,
    PiiFinding,
    TagsGetParams,
    TagsGetResult,
    TagsListParams,
    TagsListResult,
    SqlDiffParams,
    SqlDiffResult,
    SqlGuardValidateParams,
    SqlGuardLintParams,
    SqlGuardSafetyParams,
    SqlGuardTranspileParams,
    SqlGuardExplainParams,
    SqlGuardCheckParams,
    SqlGuardResult,
)
from altimate_engine.sql.executor import execute_sql
from altimate_engine.sql.analyzer import analyze_sql
from altimate_engine.sql.optimizer import optimize_sql
from altimate_engine.sql.translator import translate_sql
from altimate_engine.sql.formatter import format_sql
from altimate_engine.sql.explainer import explain_sql
from altimate_engine.sql.fixer import fix_sql
from altimate_engine.sql.autocomplete import autocomplete_sql
from altimate_engine.sql.diff import diff_sql
from altimate_engine.sql.rewriter import rewrite_sql
from altimate_engine.sql.schema_diff import diff_schema
from altimate_engine.ci.cost_gate import scan_files
from altimate_engine.schema.inspector import inspect_schema
from altimate_engine.schema.pii_detector import detect_pii
from altimate_engine.schema.tags import get_tags, list_tags
from altimate_engine.dbt.runner import run_dbt
from altimate_engine.dbt.manifest import parse_manifest
from altimate_engine.connections import ConnectionRegistry
from altimate_engine.lineage.check import check_lineage
from altimate_engine.sql.feedback_store import FeedbackStore
from altimate_engine.schema.cache import SchemaCache
from altimate_engine.finops.query_history import get_query_history
from altimate_engine.finops.credit_analyzer import (
    analyze_credits,
    get_expensive_queries,
)
from altimate_engine.finops.warehouse_advisor import advise_warehouse_sizing
from altimate_engine.finops.unused_resources import find_unused_resources
from altimate_engine.finops.role_access import (
    query_grants,
    query_role_hierarchy,
    query_user_roles,
)
from altimate_engine.sql.guard import (
    guard_validate,
    guard_lint,
    guard_scan_safety,
    guard_transpile,
    guard_explain,
    guard_check,
)
from altimate_engine.models import (
    SqlGuardValidateParams,
    SqlGuardLintParams,
    SqlGuardSafetyParams,
    SqlGuardTranspileParams,
    SqlGuardExplainParams,
    SqlGuardCheckParams,
    SqlGuardResult,
)


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
    confidences = [getattr(i, "confidence", "high") for i in issues]
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
        if method == "sql.execute":
            result = execute_sql(SqlExecuteParams(**params))
        elif method == "schema.inspect":
            result = inspect_schema(SchemaInspectParams(**params))
        elif method == "sql.analyze":
            params_obj = SqlAnalyzeParams(**params)
            raw_result = analyze_sql(params_obj.sql, params_obj.dialect or "snowflake")
            # Convert raw dict result to SqlAnalyzeResult model
            issues = []
            for issue in raw_result.get("issues", []):
                issues.append(
                    SqlAnalyzeIssue(
                        type=issue["type"],
                        severity=issue.get("severity", "warning"),
                        message=issue["message"],
                        recommendation=issue.get("recommendation", ""),
                        location=issue.get("location"),
                        confidence=issue.get("confidence", "high"),
                    )
                )
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
            result_dict = translate_sql(
                params_obj.sql, params_obj.source_dialect, params_obj.target_dialect
            )
            result = SqlTranslateResult(**result_dict)
        elif method == "sql.optimize":
            params_obj = SqlOptimizeParams(**params)
            result_dict = optimize_sql(
                params_obj.sql, params_obj.dialect, params_obj.schema_context
            )
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
            fmt_result = format_sql(
                fmt_params.sql, fmt_params.dialect, fmt_params.indent
            )
            result = SqlFormatResult(**fmt_result)
        elif method == "sql.explain":
            result = explain_sql(SqlExplainParams(**params))
        elif method == "sql.fix":
            fix_params = SqlFixParams(**params)
            fix_result = fix_sql(
                fix_params.sql, fix_params.error_message, fix_params.dialect
            )
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
                suggestions=[
                    SqlAutocompleteSuggestion(**s) for s in ac_result["suggestions"]
                ],
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
                idx_result = cache.index_warehouse(
                    idx_params.warehouse, wh_type, connector
                )
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
        # --- FinOps methods ---
        elif method == "finops.query_history":
            p = QueryHistoryParams(**params)
            raw = get_query_history(
                p.warehouse, p.days, p.limit, p.user, p.warehouse_filter
            )
            result = QueryHistoryResult(**raw)
        elif method == "finops.analyze_credits":
            p = CreditAnalysisParams(**params)
            raw = analyze_credits(p.warehouse, p.days, p.limit, p.warehouse_filter)
            result = CreditAnalysisResult(**raw)
        elif method == "finops.expensive_queries":
            p = ExpensiveQueriesParams(**params)
            raw = get_expensive_queries(p.warehouse, p.days, p.limit)
            result = ExpensiveQueriesResult(**raw)
        elif method == "finops.warehouse_advice":
            p = WarehouseAdvisorParams(**params)
            raw = advise_warehouse_sizing(p.warehouse, p.days)
            result = WarehouseAdvisorResult(**raw)
        elif method == "finops.unused_resources":
            p = UnusedResourcesParams(**params)
            raw = find_unused_resources(p.warehouse, p.days, p.limit)
            result = UnusedResourcesResult(**raw)
        elif method == "finops.role_grants":
            p = RoleGrantsParams(**params)
            raw = query_grants(p.warehouse, p.role, p.object_name, p.limit)
            result = RoleGrantsResult(**raw)
        elif method == "finops.role_hierarchy":
            p = RoleHierarchyParams(**params)
            raw = query_role_hierarchy(p.warehouse)
            result = RoleHierarchyResult(**raw)
        elif method == "finops.user_roles":
            p = UserRolesParams(**params)
            raw = query_user_roles(p.warehouse, p.user, p.limit)
            result = UserRolesResult(**raw)
        # --- Schema discovery methods ---
        elif method == "schema.detect_pii":
            p = PiiDetectParams(**params)
            cache = _get_schema_cache()
            raw = detect_pii(p.warehouse, p.schema_name, p.table, cache)
            result = PiiDetectResult(
                success=raw["success"],
                findings=[PiiFinding(**f) for f in raw["findings"]],
                finding_count=raw["finding_count"],
                columns_scanned=raw["columns_scanned"],
                by_category=raw["by_category"],
                tables_with_pii=raw["tables_with_pii"],
            )
        elif method == "schema.tags":
            p = TagsGetParams(**params)
            raw = get_tags(p.warehouse, p.object_name, p.tag_name, p.limit)
            result = TagsGetResult(**raw)
        elif method == "schema.tags_list":
            p = TagsListParams(**params)
            raw = list_tags(p.warehouse, p.limit)
            result = TagsListResult(**raw)
        # --- SQL diff ---
        elif method == "sql.diff":
            p = SqlDiffParams(**params)
            raw = diff_sql(p.original, p.modified, p.context_lines)
            result = SqlDiffResult(**raw)
        # --- SQL rewrite ---
        elif method == "sql.rewrite":
            p = SqlRewriteParams(**params)
            raw = rewrite_sql(p.sql, p.dialect, p.schema_context)
            result = SqlRewriteResult(
                success=raw["success"],
                original_sql=raw["original_sql"],
                rewritten_sql=raw.get("rewritten_sql"),
                rewrites_applied=[
                    SqlRewriteRule(**r) for r in raw.get("rewrites_applied", [])
                ],
                error=raw.get("error"),
            )
        # --- sqlguard ---
        elif method == "sqlguard.validate":
            p = SqlGuardValidateParams(**params)
            raw = guard_validate(p.sql, p.schema_path, p.schema_context)
            result = SqlGuardResult(
                success=raw.get("valid", True), data=raw, error=raw.get("error")
            )
        elif method == "sqlguard.lint":
            p = SqlGuardLintParams(**params)
            raw = guard_lint(p.sql, p.schema_path, p.schema_context)
            result = SqlGuardResult(
                success=raw.get("clean", True), data=raw, error=raw.get("error")
            )
        elif method == "sqlguard.safety":
            p = SqlGuardSafetyParams(**params)
            raw = guard_scan_safety(p.sql)
            result = SqlGuardResult(
                success=raw.get("safe", True), data=raw, error=raw.get("error")
            )
        elif method == "sqlguard.transpile":
            p = SqlGuardTranspileParams(**params)
            raw = guard_transpile(p.sql, p.from_dialect, p.to_dialect)
            result = SqlGuardResult(
                success=raw.get("success", True), data=raw, error=raw.get("error")
            )
        elif method == "sqlguard.explain":
            p = SqlGuardExplainParams(**params)
            raw = guard_explain(p.sql, p.schema_path, p.schema_context)
            result = SqlGuardResult(
                success=raw.get("valid", True), data=raw, error=raw.get("error")
            )
        elif method == "sqlguard.check":
            p = SqlGuardCheckParams(**params)
            raw = guard_check(p.sql, p.schema_path, p.schema_context)
            result = SqlGuardResult(success=True, data=raw, error=raw.get("error"))
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
        trace_data = (
            traceback.format_exc() if os.environ.get("ALTIMATE_ENGINE_DEBUG") else None
        )
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
