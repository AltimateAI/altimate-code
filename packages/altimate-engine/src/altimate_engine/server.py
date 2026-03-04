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
    WarehouseAddParams,
    WarehouseAddResult,
    WarehouseRemoveParams,
    WarehouseRemoveResult,
    DockerContainer,
    WarehouseDiscoverResult,
    DbtLineageParams,
    DbtManifestParams,
    DbtRunParams,
    DbtProfilesParams,
    DbtProfileConnection,
    DbtProfilesResult,
    JsonRpcError,
    JsonRpcRequest,
    JsonRpcResponse,
    LineageCheckParams,
    LocalSchemaSyncParams,
    LocalSchemaSyncResult,
    LocalTestParams,
    LocalTestResult,
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
    SqlExecuteParams,
    SqlExplainParams,
    SqlFixParams,
    SqlFixResult,
    SqlFixSuggestion,
    SqlFormatParams,
    SqlFormatResult,
    SqlOptimizeParams,
    SqlOptimizeResult,
    SqlOptimizeSuggestion,
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
    AltimateCoreValidateParams,
    AltimateCoreLintParams,
    AltimateCoreSafetyParams,
    AltimateCoreTranspileParams,
    AltimateCoreExplainParams,
    AltimateCoreCheckParams,
    AltimateCoreResult,
)
from altimate_engine.sql.executor import execute_sql
from altimate_engine.sql.explainer import explain_sql
from altimate_engine.sql.autocomplete import autocomplete_sql
from altimate_engine.sql.diff import diff_sql
from altimate_engine.schema.inspector import inspect_schema
from altimate_engine.schema.pii_detector import detect_pii
from altimate_engine.schema.tags import get_tags, list_tags
from altimate_engine.dbt.runner import run_dbt
from altimate_engine.dbt.manifest import parse_manifest
from altimate_engine.dbt.lineage import dbt_lineage
from altimate_engine.connections import ConnectionRegistry

# lineage.check delegates to guard_column_lineage
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
    # Phase 1 (P0)
    guard_fix as guard_fix_sql,
    guard_check_policy,
    guard_check_semantics,
    guard_generate_tests,
    # Phase 2 (P1)
    guard_check_equivalence,
    guard_analyze_migration,
    guard_diff_schemas,
    guard_rewrite as guard_rewrite_sql,
    guard_correct,
    guard_evaluate,
    # Phase 3 (P2)
    guard_classify_pii,
    guard_check_query_pii,
    guard_resolve_term,
    guard_column_lineage,
    guard_track_lineage,
    guard_format_sql,
    guard_extract_metadata,
    guard_compare_queries,
    guard_complete,
    guard_optimize_context,
    guard_optimize_for_query,
    guard_prune_schema,
    guard_import_ddl,
    guard_export_ddl,
    guard_schema_fingerprint,
    guard_introspection_sql,
    guard_parse_dbt_project,
    guard_is_safe,
)
from altimate_engine.dbt.profiles import discover_dbt_connections
from altimate_engine.local.schema_sync import sync_schema
from altimate_engine.local.test_local import test_sql_local
from altimate_engine.models import (
    AltimateCoreFixParams,
    AltimateCorePolicyParams,
    AltimateCoreSemanticsParams,
    AltimateCoreTestgenParams,
    # Phase 2 (P1)
    AltimateCoreEquivalenceParams,
    AltimateCoreMigrationParams,
    AltimateCoreSchemaDiffParams,
    AltimateCoreGuardRewriteParams,
    AltimateCoreCorrectParams,
    AltimateCoreGradeParams,
    # Phase 3 (P2)
    AltimateCoreClassifyPiiParams,
    AltimateCoreQueryPiiParams,
    AltimateCoreResolveTermParams,
    AltimateCoreColumnLineageParams,
    AltimateCoreTrackLineageParams,
    AltimateCoreFormatSqlParams,
    AltimateCoreExtractMetadataParams,
    AltimateCoreCompareQueriesParams,
    AltimateCoreCompleteParams,
    AltimateCoreOptimizeContextParams,
    AltimateCoreOptimizeForQueryParams,
    AltimateCorePruneSchemaParams,
    AltimateCoreImportDdlParams,
    AltimateCoreExportDdlParams,
    AltimateCoreSchemaFingerprintParams,
    AltimateCoreIntrospectionSqlParams,
    AltimateCoreParseDbtProjectParams,
    AltimateCoreIsSafeParams,
)


# JSON-RPC error codes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


# Lazily-initialized singletons
def _schema_context_to_dict(
    schema_context: dict[str, list] | None,
) -> dict | None:
    """Convert LineageCheckParams schema_context to guard.py format.

    Input:  {"table_name": [ModelColumn(name=..., data_type=...), ...]}
    Output: {"tables": {"table_name": {"columns": [{"name": ..., "type": ...}]}}, "version": "1"}
    """
    if not schema_context:
        return None
    tables = {}
    for table_name, columns in schema_context.items():
        cols = []
        for col in columns:
            if hasattr(col, "name"):
                cols.append({"name": col.name, "type": getattr(col, "data_type", "")})
            elif isinstance(col, dict):
                cols.append(
                    {"name": col.get("name", ""), "type": col.get("data_type", "")}
                )
        tables[table_name] = {"columns": cols}
    return {"tables": tables, "version": "1"}


_schema_cache: SchemaCache | None = None


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


def _split_sql_statements(sql: str) -> list[str]:
    """Split SQL by semicolons, ignoring those inside string literals."""
    stmts, current, in_str, str_char = [], [], False, None
    for ch in sql:
        if not in_str and ch in ("'", '"'):
            in_str, str_char = True, ch
        elif in_str and ch == str_char:
            in_str = False
        elif ch == ";" and not in_str:
            s = "".join(current).strip()
            if s and not all(
                line.strip().startswith("--") or not line.strip()
                for line in s.splitlines()
            ):
                stmts.append(s)
            current = []
            continue
        current.append(ch)
    s = "".join(current).strip()
    if s:
        stmts.append(s)
    return stmts or [sql]


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
            statements = _split_sql_statements(params_obj.sql)
            issues = []
            any_error = None

            for stmt_idx, stmt in enumerate(statements):
                label = f"[Query {stmt_idx + 1}] " if len(statements) > 1 else ""

                lint_result = guard_lint(stmt, schema_context=params_obj.schema_context)
                if lint_result.get("error"):
                    any_error = lint_result["error"]
                    continue
                for issue in lint_result.get("findings", lint_result.get("issues", [])):
                    issues.append(
                        SqlAnalyzeIssue(
                            type=issue.get("rule", issue.get("type", "LINT")),
                            severity=issue.get("severity", "warning"),
                            message=label + issue.get("message", ""),
                            recommendation=issue.get(
                                "suggestion", issue.get("recommendation", "")
                            ),
                            location=issue.get("location"),
                            confidence=issue.get("confidence", "high"),
                        )
                    )

                sem_result = guard_check_semantics(
                    stmt, schema_context=params_obj.schema_context
                )
                for si in sem_result.get("issues", []):
                    issues.append(
                        SqlAnalyzeIssue(
                            type=f"SEMANTIC_{si.get('rule', si.get('type', 'UNKNOWN'))}",
                            severity=si.get("severity", "warning"),
                            message=label + si.get("message", ""),
                            recommendation=si.get(
                                "suggestion", si.get("recommendation", "")
                            ),
                            location=si.get("location"),
                            confidence=si.get("confidence", "medium"),
                        )
                    )

                safety_result = guard_scan_safety(stmt)
                for threat in safety_result.get("threats", []):
                    issues.append(
                        SqlAnalyzeIssue(
                            type=f"SAFETY_{threat.get('type', 'THREAT')}",
                            severity=threat.get("severity", "error"),
                            message=label
                            + threat.get("description", threat.get("message", "")),
                            recommendation="Review this SQL for potential security risks.",
                            location=threat.get("location"),
                            confidence="high",
                        )
                    )

            result = SqlAnalyzeResult(
                success=any_error is None,
                issues=issues,
                issue_count=len(issues),
                confidence=_compute_overall_confidence(issues),
                confidence_factors=[]
                if any_error is None
                else [f"Parse failed on one statement: {any_error}"],
                error=any_error,
            )
        elif method == "sql.translate":
            params_obj = SqlTranslateParams(**params)
            raw = guard_transpile(
                params_obj.sql, params_obj.source_dialect, params_obj.target_dialect
            )
            result = SqlTranslateResult(
                success=raw.get("success", True),
                translated_sql=raw.get("sql", raw.get("translated_sql")),
                source_dialect=params_obj.source_dialect,
                target_dialect=params_obj.target_dialect,
                warnings=raw.get("warnings", []),
                error=raw.get("error"),
            )
        elif method == "sql.optimize":
            params_obj = SqlOptimizeParams(**params)
            # Rewrite for optimization
            rw = guard_rewrite_sql(
                params_obj.sql, schema_context=params_obj.schema_context
            )
            # Lint for remaining issues
            lint = guard_lint(params_obj.sql, schema_context=params_obj.schema_context)

            suggestions = []
            for r in rw.get("rewrites", []):
                suggestions.append(
                    SqlOptimizeSuggestion(
                        type="REWRITE",
                        description=r.get("explanation", "Optimization rewrite"),
                        before=r.get("original_fragment", ""),
                        after=r.get("rewritten_fragment", ""),
                    )
                )

            optimized_sql = rw.get("rewritten_sql", params_obj.sql)
            if not suggestions and optimized_sql.strip() != params_obj.sql.strip():
                suggestions.append(
                    SqlOptimizeSuggestion(
                        type="REWRITE",
                        description="Query rewritten for performance",
                        before=params_obj.sql,
                        after=optimized_sql,
                    )
                )

            anti_patterns = []
            for issue in lint.get("findings", lint.get("issues", [])):
                anti_patterns.append(
                    {
                        "type": issue.get("rule", issue.get("type", "LINT")),
                        "message": issue.get("message", ""),
                        "suggestion": issue.get("suggestion", ""),
                    }
                )

            result = SqlOptimizeResult(
                success=True,
                original_sql=params_obj.sql,
                optimized_sql=rw.get("rewritten_sql", params_obj.sql),
                suggestions=suggestions,
                anti_patterns=anti_patterns,
                error=rw.get("error"),
            )
        elif method == "lineage.check":
            p = LineageCheckParams(**params)
            raw = guard_column_lineage(
                p.sql,
                dialect=p.dialect or "",
                schema_context=_schema_context_to_dict(p.schema_context)
                if p.schema_context
                else None,
            )
            _err = raw.get("error")
            result = AltimateCoreResult(
                success=_err is None,
                data=raw if _err is None else None,
                error=_err,
            )
        elif method == "dbt.run":
            result = run_dbt(DbtRunParams(**params))
        elif method == "dbt.manifest":
            result = parse_manifest(DbtManifestParams(**params))
        elif method == "dbt.lineage":
            result = dbt_lineage(DbtLineageParams(**params))
        elif method == "warehouse.list":
            warehouses = [WarehouseInfo(**w) for w in ConnectionRegistry.list()]
            result = WarehouseListResult(warehouses=warehouses)
        elif method == "warehouse.test":
            test_params = WarehouseTestParams(**params)
            test_result = ConnectionRegistry.test(test_params.name)
            result = WarehouseTestResult(**test_result)
        elif method == "warehouse.add":
            p = WarehouseAddParams(**params)
            try:
                ConnectionRegistry.add(p.name, p.config)
                result = WarehouseAddResult(
                    success=True, name=p.name, type=p.config.get("type", "unknown")
                )
            except Exception as e:
                result = WarehouseAddResult(
                    success=False, name=p.name, type="", error=str(e)
                )
        elif method == "warehouse.remove":
            p = WarehouseRemoveParams(**params)
            try:
                removed = ConnectionRegistry.remove(p.name)
                result = WarehouseRemoveResult(success=removed)
            except Exception as e:
                result = WarehouseRemoveResult(success=False, error=str(e))
        elif method == "warehouse.discover":
            from altimate_engine.docker_discovery import discover_containers

            try:
                containers = discover_containers()
                result = WarehouseDiscoverResult(
                    containers=[DockerContainer(**c) for c in containers],
                    container_count=len(containers),
                )
            except Exception as e:
                result = WarehouseDiscoverResult(error=str(e))

        elif method == "sql.format":
            fmt_params = SqlFormatParams(**params)
            raw = guard_format_sql(fmt_params.sql, fmt_params.dialect)
            result = SqlFormatResult(
                success=raw.get("success", True),
                formatted_sql=raw.get("formatted_sql", raw.get("sql")),
                statement_count=raw.get("statement_count", 1),
                error=raw.get("error"),
            )
        elif method == "sql.explain":
            result = explain_sql(SqlExplainParams(**params))
        elif method == "sql.fix":
            fix_params = SqlFixParams(**params)
            guard_result = guard_fix_sql(fix_params.sql)
            fixed = guard_result.get("fixed", guard_result.get("success", False))
            fixed_sql = guard_result.get("fixed_sql")
            if fixed and fixed_sql:
                result = SqlFixResult(
                    success=True,
                    original_sql=fix_params.sql,
                    fixed_sql=fixed_sql,
                    error_message=fix_params.error_message,
                    suggestions=[
                        SqlFixSuggestion(
                            type="ALTIMATE_CORE_FIX",
                            message="Auto-fixed by altimate_core engine",
                            confidence="high",
                            fixed_sql=fixed_sql,
                        )
                    ],
                    suggestion_count=1,
                )
            else:
                result = SqlFixResult(
                    success=False,
                    original_sql=fix_params.sql,
                    fixed_sql=fixed_sql,
                    error_message=fix_params.error_message,
                    suggestions=[],
                    suggestion_count=0,
                    error=guard_result.get("error", "Unable to auto-fix"),
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
            try:
                raw = get_query_history(
                    p.warehouse, p.days, p.limit, p.user, p.warehouse_filter
                )
                result = QueryHistoryResult(**raw)
            except Exception as e:
                raise RuntimeError(
                    f"finops.query_history failed: {e}. "
                    f"For non-Snowflake warehouses, query directly: "
                    f"SELECT user_name, query_text, total_elapsed_time, bytes_scanned, credits_used "
                    f"FROM query_history ORDER BY start_time DESC LIMIT {p.limit}"
                )
        elif method == "finops.analyze_credits":
            p = CreditAnalysisParams(**params)
            try:
                raw = analyze_credits(p.warehouse, p.days, p.limit, p.warehouse_filter)
                result = CreditAnalysisResult(**raw)
            except Exception as e:
                raise RuntimeError(
                    f"finops.analyze_credits failed: {e}. "
                    f"For non-Snowflake warehouses, query directly: "
                    f"SELECT warehouse_name, SUM(credits_used) AS credits, COUNT(*) AS queries "
                    f"FROM query_history WHERE start_time >= CURRENT_DATE - INTERVAL '{p.days} days' "
                    f"GROUP BY 1 ORDER BY 2 DESC LIMIT {p.limit}"
                )
        elif method == "finops.expensive_queries":
            p = ExpensiveQueriesParams(**params)
            try:
                raw = get_expensive_queries(p.warehouse, p.days, p.limit)
                result = ExpensiveQueriesResult(**raw)
            except Exception as e:
                raise RuntimeError(
                    f"finops.expensive_queries failed: {e}. "
                    f"For non-Snowflake warehouses, query directly: "
                    f"SELECT query_text, bytes_scanned, total_elapsed_time, credits_used "
                    f"FROM query_history ORDER BY bytes_scanned DESC LIMIT {p.limit}"
                )
        elif method == "finops.warehouse_advice":
            p = WarehouseAdvisorParams(**params)
            try:
                raw = advise_warehouse_sizing(p.warehouse, p.days)
                result = WarehouseAdvisorResult(**raw)
            except Exception as e:
                raise RuntimeError(
                    f"finops.warehouse_advice failed: {e}. "
                    f"For non-Snowflake warehouses, analyze warehouse usage directly: "
                    f"SELECT warehouse_name, COUNT(*) AS queries, AVG(total_elapsed_time) AS avg_ms, "
                    f"SUM(credits_used) AS credits FROM query_history GROUP BY 1 ORDER BY 4 DESC"
                )
        elif method == "finops.unused_resources":
            p = UnusedResourcesParams(**params)
            try:
                raw = find_unused_resources(p.warehouse, p.days, p.limit)
                result = UnusedResourcesResult(**raw)
            except Exception as e:
                raise RuntimeError(
                    f"finops.unused_resources failed: {e}. "
                    f"For non-Snowflake warehouses, find idle resources directly: "
                    f"SELECT table_name, last_altered FROM information_schema.tables "
                    f"WHERE last_altered < CURRENT_DATE - INTERVAL '{p.days} days' LIMIT {p.limit}"
                )
        elif method == "finops.role_grants":
            p = RoleGrantsParams(**params)
            try:
                raw = query_grants(p.warehouse, p.role, p.object_name, p.limit)
                result = RoleGrantsResult(**raw)
            except Exception as e:
                raise RuntimeError(f"finops.role_grants failed: {e}. This tool requires Snowflake.")
        elif method == "finops.role_hierarchy":
            p = RoleHierarchyParams(**params)
            try:
                raw = query_role_hierarchy(p.warehouse)
                result = RoleHierarchyResult(**raw)
            except Exception as e:
                raise RuntimeError(f"finops.role_hierarchy failed: {e}. This tool requires Snowflake.")
        elif method == "finops.user_roles":
            p = UserRolesParams(**params)
            try:
                raw = query_user_roles(p.warehouse, p.user, p.limit)
                result = UserRolesResult(**raw)
            except Exception as e:
                raise RuntimeError(f"finops.user_roles failed: {e}. This tool requires Snowflake.")
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
            # Add semantic equivalence check via altimate_core
            equiv = guard_check_equivalence(p.original, p.modified)
            if equiv.get("equivalent") is not None:
                raw["semantic_equivalent"] = equiv["equivalent"]
            result = SqlDiffResult(**raw)
        # --- SQL rewrite ---
        elif method == "sql.rewrite":
            p = SqlRewriteParams(**params)
            guard_rw = guard_rewrite_sql(p.sql, schema_context=p.schema_context)
            if guard_rw.get("success") and guard_rw.get("rewritten_sql"):
                rewrites = []
                for r in guard_rw.get("rewrites", []):
                    rewrites.append(
                        SqlRewriteRule(
                            rule=r.get("rule", "ALTIMATE_CORE_REWRITE"),
                            original_fragment=r.get("original_fragment", ""),
                            rewritten_fragment=r.get("rewritten_fragment", ""),
                            explanation=r.get("explanation", "Rewritten by altimate_core"),
                            can_auto_apply=True,
                        )
                    )
                result = SqlRewriteResult(
                    success=True,
                    original_sql=p.sql,
                    rewritten_sql=guard_rw["rewritten_sql"],
                    rewrites_applied=rewrites,
                )
            else:
                result = SqlRewriteResult(
                    success=False,
                    original_sql=p.sql,
                    rewritten_sql=None,
                    rewrites_applied=[],
                    error=guard_rw.get("error", "No rewrites applicable"),
                )
        # --- altimate_core ---
        elif method == "altimate_core.validate":
            p = AltimateCoreValidateParams(**params)
            raw = guard_validate(p.sql, p.schema_path, p.schema_context)
            result = AltimateCoreResult(
                success=raw.get("valid", True), data=raw, error=raw.get("error")
            )
        elif method == "altimate_core.lint":
            p = AltimateCoreLintParams(**params)
            raw = guard_lint(p.sql, p.schema_path, p.schema_context)
            result = AltimateCoreResult(
                success=raw.get("clean", True), data=raw, error=raw.get("error")
            )
        elif method == "altimate_core.safety":
            p = AltimateCoreSafetyParams(**params)
            raw = guard_scan_safety(p.sql)
            result = AltimateCoreResult(
                success=raw.get("safe", True), data=raw, error=raw.get("error")
            )
        elif method == "altimate_core.transpile":
            p = AltimateCoreTranspileParams(**params)
            raw = guard_transpile(p.sql, p.from_dialect, p.to_dialect)
            result = AltimateCoreResult(
                success=raw.get("success", True), data=raw, error=raw.get("error")
            )
        elif method == "altimate_core.explain":
            p = AltimateCoreExplainParams(**params)
            raw = guard_explain(p.sql, p.schema_path, p.schema_context)
            result = AltimateCoreResult(
                success=raw.get("valid", True), data=raw, error=raw.get("error")
            )
        elif method == "altimate_core.check":
            p = AltimateCoreCheckParams(**params)
            raw = guard_check(p.sql, p.schema_path, p.schema_context)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        # --- altimate_core Phase 1 (P0) ---
        elif method == "altimate_core.fix":
            p = AltimateCoreFixParams(**params)
            raw = guard_fix_sql(
                p.sql, p.schema_path, p.schema_context, p.max_iterations
            )
            result = AltimateCoreResult(
                success=raw.get("success", True), data=raw, error=raw.get("error")
            )
        elif method == "altimate_core.policy":
            p = AltimateCorePolicyParams(**params)
            raw = guard_check_policy(
                p.sql, p.policy_json, p.schema_path, p.schema_context
            )
            result = AltimateCoreResult(
                success=raw.get("pass", True), data=raw, error=raw.get("error")
            )
        elif method == "altimate_core.semantics":
            p = AltimateCoreSemanticsParams(**params)
            raw = guard_check_semantics(p.sql, p.schema_path, p.schema_context)
            result = AltimateCoreResult(
                success=raw.get("valid", True), data=raw, error=raw.get("error")
            )
        elif method == "altimate_core.testgen":
            p = AltimateCoreTestgenParams(**params)
            raw = guard_generate_tests(p.sql, p.schema_path, p.schema_context)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        # --- altimate_core Phase 2 (P1) ---
        elif method == "altimate_core.equivalence":
            p = AltimateCoreEquivalenceParams(**params)
            raw = guard_check_equivalence(
                p.sql1, p.sql2, p.schema_path, p.schema_context
            )
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        elif method == "altimate_core.migration":
            p = AltimateCoreMigrationParams(**params)
            raw = guard_analyze_migration(p.old_ddl, p.new_ddl, p.dialect)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        elif method == "altimate_core.schema_diff":
            p = AltimateCoreSchemaDiffParams(**params)
            raw = guard_diff_schemas(
                p.schema1_path,
                p.schema2_path,
                p.schema1_context,
                p.schema2_context,
            )
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        elif method == "altimate_core.rewrite":
            p = AltimateCoreGuardRewriteParams(**params)
            raw = guard_rewrite_sql(p.sql, p.schema_path, p.schema_context)
            result = AltimateCoreResult(
                success=raw.get("success", True), data=raw, error=raw.get("error")
            )
        elif method == "altimate_core.correct":
            p = AltimateCoreCorrectParams(**params)
            raw = guard_correct(p.sql, p.schema_path, p.schema_context)
            result = AltimateCoreResult(
                success=raw.get("success", True), data=raw, error=raw.get("error")
            )
        elif method == "altimate_core.grade":
            p = AltimateCoreGradeParams(**params)
            raw = guard_evaluate(p.sql, p.schema_path, p.schema_context)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        # --- altimate_core Phase 3 (P2) ---
        elif method == "altimate_core.classify_pii":
            p = AltimateCoreClassifyPiiParams(**params)
            raw = guard_classify_pii(p.schema_path, p.schema_context)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        elif method == "altimate_core.query_pii":
            p = AltimateCoreQueryPiiParams(**params)
            raw = guard_check_query_pii(p.sql, p.schema_path, p.schema_context)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        elif method == "altimate_core.resolve_term":
            p = AltimateCoreResolveTermParams(**params)
            raw = guard_resolve_term(p.term, p.schema_path, p.schema_context)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        elif method == "altimate_core.column_lineage":
            p = AltimateCoreColumnLineageParams(**params)
            raw = guard_column_lineage(
                p.sql, p.dialect, p.schema_path, p.schema_context
            )
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        elif method == "altimate_core.track_lineage":
            p = AltimateCoreTrackLineageParams(**params)
            raw = guard_track_lineage(p.queries, p.schema_path, p.schema_context)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        elif method == "altimate_core.format":
            p = AltimateCoreFormatSqlParams(**params)
            raw = guard_format_sql(p.sql, p.dialect)
            result = AltimateCoreResult(
                success=raw.get("success", True), data=raw, error=raw.get("error")
            )
        elif method == "altimate_core.metadata":
            p = AltimateCoreExtractMetadataParams(**params)
            raw = guard_extract_metadata(p.sql, p.dialect)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        elif method == "altimate_core.compare":
            p = AltimateCoreCompareQueriesParams(**params)
            raw = guard_compare_queries(p.left_sql, p.right_sql, p.dialect)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        elif method == "altimate_core.complete":
            p = AltimateCoreCompleteParams(**params)
            raw = guard_complete(p.sql, p.cursor_pos, p.schema_path, p.schema_context)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        elif method == "altimate_core.optimize_context":
            p = AltimateCoreOptimizeContextParams(**params)
            raw = guard_optimize_context(p.schema_path, p.schema_context)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        elif method == "altimate_core.optimize_for_query":
            p = AltimateCoreOptimizeForQueryParams(**params)
            raw = guard_optimize_for_query(p.sql, p.schema_path, p.schema_context)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        elif method == "altimate_core.prune_schema":
            p = AltimateCorePruneSchemaParams(**params)
            raw = guard_prune_schema(p.sql, p.schema_path, p.schema_context)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        elif method == "altimate_core.import_ddl":
            p = AltimateCoreImportDdlParams(**params)
            raw = guard_import_ddl(p.ddl, p.dialect)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        elif method == "altimate_core.export_ddl":
            p = AltimateCoreExportDdlParams(**params)
            raw = guard_export_ddl(p.schema_path, p.schema_context)
            result = AltimateCoreResult(
                success=raw.get("success", True), data=raw, error=raw.get("error")
            )
        elif method == "altimate_core.fingerprint":
            p = AltimateCoreSchemaFingerprintParams(**params)
            raw = guard_schema_fingerprint(p.schema_path, p.schema_context)
            result = AltimateCoreResult(
                success=raw.get("success", True), data=raw, error=raw.get("error")
            )
        elif method == "altimate_core.introspection_sql":
            p = AltimateCoreIntrospectionSqlParams(**params)
            raw = guard_introspection_sql(p.db_type, p.database, p.schema_name)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        elif method == "altimate_core.parse_dbt":
            p = AltimateCoreParseDbtProjectParams(**params)
            raw = guard_parse_dbt_project(p.project_dir)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        elif method == "altimate_core.is_safe":
            p = AltimateCoreIsSafeParams(**params)
            raw = guard_is_safe(p.sql)
            result = AltimateCoreResult(success=True, data=raw, error=raw.get("error"))
        # --- dbt discovery ---
        elif method == "dbt.profiles":
            p = DbtProfilesParams(**params)
            raw = discover_dbt_connections(p.path)
            connections = [
                DbtProfileConnection(
                    name=name,
                    type=config.get("type", "unknown"),
                    config=config,
                )
                for name, config in raw.items()
            ]
            result = DbtProfilesResult(
                success=True,
                connections=connections,
                connection_count=len(connections),
            )
        # --- Local testing ---
        elif method == "local.schema_sync":
            p = LocalSchemaSyncParams(**params)
            raw = sync_schema(
                warehouse=p.warehouse,
                target_path=p.target_path,
                schemas=p.schemas,
                sample_rows=p.sample_rows,
                limit=p.limit,
            )
            result = LocalSchemaSyncResult(**raw)
        elif method == "local.test":
            p = LocalTestParams(**params)
            raw = test_sql_local(
                sql=p.sql,
                target_path=p.target_path,
                target_dialect=p.target_dialect,
            )
            result = LocalTestResult(**raw)
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
