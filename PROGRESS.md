# altimate Implementation Progress
Last updated: 2026-02-27 00:40

## Current Phase: COMPLETE (all unblocked phases done)
## Status: Phase 0-7 complete + Phase 8 BigQuery/Databricks connectors (except 3B blocked, 3E blocked)

### Completed
- [x] Phase 1A: Bridge contract parity + warehouse tools (18 rules, 10 bridge methods)
- [x] Phase 1B: Static query analyzer (`sql.analyze`) — 19 anti-pattern checks with confidence
- [x] Phase 1C: Column-level lineage (`lineage.check`) — sqlglot AST traversal + Func/Window/Case edge extraction
- [x] Phase 1D: Permission enforcement — all new tools registered in agent rulesets
- [x] Phase 1E: Skills — generate-tests + lineage-diff
- [x] Phase 1F: Agent prompt/tool alignment — all 4 agent prompts updated
- [x] Phase 0, Step 1: Harness scaffolding — `generate_queries.py --count 10` works
- [x] Phase 0, Step 2: First 100 queries benchmarked — 18 queries, 0 parse failures
- [x] Phase 0, Step 3: First stratified accuracy report — 94.44% on 18 queries
- [x] Phase 0, Step 4: Scale to 1K — 1077 queries, **100.00% overall accuracy**
- [x] Phase 0, Step 5: Lineage baseline — 500 queries, **100.0% edge match**, 100.0% confidence match
- [x] Phase 0, Step 6: Weak spots documented and fixed (IMPLICIT_CARTESIAN + CORRELATED_SUBQUERY + lineage bugs)
- [x] Phase 1 TODO: ConfidenceTracker with 7 AST detection rules — all 7 working
- [x] Phase 1 TODO: Confidence signals on lineage.check — 4 signal types
- [x] Phase 2A: Snowflake connector — password + key-pair auth, registered in ConnectionRegistry
- [x] Phase 2B: Cost report skill
- [x] Phase 2C: dbt manifest parser — columns, sources, test/snapshot/seed counting
- [x] Phase 3A: Impact analysis skill — downstream dependency graph + column-level impact classification
- [x] Phase 3C: SQL translation skill — sqlglot transpile, 10 dialect-pair warnings, TS tool + skill
- [x] Phase 3D: Query optimization skill — sqlglot optimizer passes + anti-pattern suggestions, TS tool + skill
- [x] Lineage engine hardening — fixed `_get_target_table` (v29 compat), added Func/Window/Case edge extraction
- [x] Phase 4: Benchmark & documentation — published benchmarks with methodology
- [x] Phase 5: Schema cache — SQLite-backed warehouse metadata indexing + search + agent permissions
- [x] TypeScript type fixes — all 16 tool files now pass `tsgo --noEmit` (metadata shape consistency)
- [x] Phase 6: DX tools — sql.explain, sql.format, sql.fix, sql.autocomplete (4 bridge methods, 4 TS tools, 55 new tests)
- [x] Phase 7: CoCo parity — Close all Cortex Code feature gaps (13 bridge methods, 13 TS tools, 5 skills, 131 new tests)
  - FinOps: query history, credit analysis, expensive queries, warehouse advice, unused resources, role grants/hierarchy/user roles
  - Schema: PII detection, metadata tags (get + list)
  - SQL: diff view (Updated to character-based stats for snippet precision)
  - Skills: model-scaffold, yaml-config, dbt-docs, medallion-patterns, incremental-logic
- [x] Fixed `sql.diff` benchmark — parameters renamed to original/modified, expectations updated to character-level (100% pass)
- [x] Phase 8: BigQuery + Databricks connectors — 2 new connectors, FinOps parity, dryRun cost prediction
  - BigQuery: service account JSON + ADC auth, INFORMATION_SCHEMA.JOBS, dryRun cost prediction
  - Databricks: PAT auth, Unity Catalog + Hive metastore fallback, system.query.history
  - FinOps: BigQuery JOBS, Databricks query.history SQL templates

### Blocked
- [ ] Phase 3B: dbt runner completion (needs real dbt project for testing)
- [ ] Phase 3E: Snowflake OAuth/SSO

### Progress Dashboard

| Phase | Metric | Current | Target |
|-------|--------|---------|--------|
| 0 | Rules with known accuracy | **19/19** | 19/19 |
| 0 | Analyzer overall accuracy | **100.00%** | measured |
| 0 | Lineage edge match rate | **100.0%** | measured |
| 1-7 | Working bridge methods | **32/32** | 32/32 |
| 1 | ConfidenceTracker rules | **7/7** | 7/7 |
| 2 | Snowflake connector | **imports OK** | live test |
| 3 | Skills functional end-to-end | **6** | 5+ |
| 4 | Rules with published benchmarks | **19/19** | 19/19 |
| 5 | Schema cache tests | **20/20** | 20/20 |
| 5 | TypeScript typecheck | **PASS** | PASS |
| 6 | DX bridge methods | **4/4** | 4/4 |
| 6 | DX tools tests | **55/55** | 55/55 |
| 7 | CoCo parity bridge methods | **13/13** | 13/13 |
| 7 | CoCo parity skills | **5/5** | 5/5 |
| 7 | CoCo parity tests | **131/131** | 131/131 |
| All | Total Python tests | **283/283** | PASS |

### Accuracy Reports

**SQL Analyzer (1077 queries, 2026-02-25):**
All 19 rules at F1=1.00 (perfect): CARTESIAN_PRODUCT, CORRELATED_SUBQUERY,
FUNCTION_IN_FILTER, FUNCTION_IN_JOIN, GROUP_BY_PRIMARY_KEY, IMPLICIT_CARTESIAN,
LARGE_IN_LIST, LIKE_LEADING_WILDCARD, MISSING_LIMIT, NON_EQUI_JOIN,
NOT_IN_WITH_SUBQUERY, ORDER_BY_IN_SUBQUERY, ORDER_BY_WITHOUT_LIMIT,
OR_IN_JOIN, SELECT_STAR, SELECT_STAR_IN_SUBQUERY, UNION_INSTEAD_OF_UNION_ALL,
UNUSED_CTE, WINDOW_WITHOUT_PARTITION

**Lineage Engine (500 queries, 13 categories, 2026-02-25, post-hardening):**
- Perfect edge match: 500/500 (100.0%)
- Confidence match: 500/500 (100.0%)
- Factor subset match: 500/500 (100.0%)
- Avg precision: 1.0, Avg recall: 1.0, Avg F1: 1.0
- Avg latency: 0.26ms
- Now correctly resolves target_table, Func/Window/Case edges

### Lineage Engine Improvements (post-validation hardening)
1. **FIXED**: `_get_target_table` now returns actual FROM table name (was "unknown" due to sqlglot v29 `from_` key)
2. **FIXED**: Aggregation functions (COUNT/SUM/AVG) with aliases now produce edges to inner Column references
3. **FIXED**: CASE expressions with aliases now produce edges to inner Column references (condition + branches)
4. **FIXED**: Window functions with aliases now produce edges (PARTITION BY + ORDER BY columns)
5. **Remaining limitation**: CTEs/subqueries produce independent edges per SELECT — no cross-CTE lineage tracing

### Published Benchmarks (Phase 4)
- `experiments/BENCHMARKS.md` — Human-readable benchmark report with per-rule accuracy, per-category breakdown, methodology, known limitations, and reproducibility instructions
- `experiments/benchmark_report.json` — Machine-readable benchmark artifact with stratified accuracy, confidence distribution, and per-rule TP/FP/FN counts

### File Inventory

**Phase 0 (validation harness):**
- `experiments/sql_analyze_validation/generate_queries.py` — 908 lines, 18 categories, seeded
- `experiments/sql_analyze_validation/run_benchmark.py` — Stratified per-rule benchmark
- `experiments/sql_analyze_validation/report.py` — Formatted accuracy report
- `experiments/lineage_validation/generate_lineage_queries.py` — 13 categories, ground truth edges (updated for hardened engine)
- `experiments/lineage_validation/run_lineage_benchmark.py` — Edge precision/recall/F1 benchmark
- `experiments/lineage_validation/report_lineage.py` — Formatted lineage accuracy report

**Phase 1 (core engine):**
- `packages/altimate-engine/src/altimate_engine/sql/analyzer.py` — 19 rules + ConfidenceTracker
- `packages/altimate-engine/src/altimate_engine/sql/confidence.py` — 7 AST detection rules
- `packages/altimate-engine/src/altimate_engine/lineage/check.py` — lineage + 4 confidence signals + Func/Window/Case edges
- `packages/altimate-engine/src/altimate_engine/server.py` — JSON-RPC dispatch (32 methods)
- `packages/altimate-engine/src/altimate_engine/models.py` — All Pydantic models

**Phase 2 (connectors + parsers + feedback):**
- `packages/altimate-engine/src/altimate_engine/connectors/snowflake.py` — password + key-pair auth
- `packages/altimate-engine/src/altimate_engine/connections.py` — ConnectionRegistry with Snowflake
- `packages/altimate-engine/src/altimate_engine/dbt/manifest.py` — Enhanced manifest parser

**Phase 3 (skills + tools):**
- `packages/altimate-engine/src/altimate_engine/sql/translator.py` — sqlglot transpile with lossy warnings
- `packages/altimate-engine/src/altimate_engine/sql/optimizer.py` — sqlglot optimizer + anti-pattern suggestions
- `packages/altimate-code/src/tool/sql-translate.ts` — TS tool for sql.translate
- `packages/altimate-code/src/tool/sql-optimize.ts` — TS tool for sql.optimize
- `packages/altimate-code/src/bridge/protocol.ts` — Updated with translate + optimize + optimize interfaces
- `packages/altimate-code/src/tool/registry.ts` — Updated with SqlTranslateTool + SqlOptimizeTool
- `.altimate-code/skills/cost-report/SKILL.md` — Cost report skill
- `.altimate-code/skills/sql-translate/SKILL.md` — SQL translation skill
- `.altimate-code/skills/query-optimize/SKILL.md` — Query optimization skill
- `.altimate-code/skills/impact-analysis/SKILL.md` — Impact analysis skill

**Phase 5 (schema cache):**
- `packages/altimate-engine/src/altimate_engine/schema/cache.py` — SQLite-backed SchemaCache (index, search, status)
- `packages/altimate-code/src/tool/schema-index.ts` — Index warehouse tool
- `packages/altimate-code/src/tool/schema-search.ts` — Search warehouse tool
- `packages/altimate-code/src/tool/schema-cache-status.ts` — Cache status tool
- `packages/altimate-engine/tests/test_schema_cache.py` — 20 tests

**Phase 6 (DX tools):**
- `packages/altimate-engine/src/altimate_engine/sql/formatter.py` — SQL formatting via sqlglot pretty-print
- `packages/altimate-engine/src/altimate_engine/sql/explainer.py` — EXPLAIN query builder (Snowflake/PG/DuckDB)
- `packages/altimate-engine/src/altimate_engine/sql/fixer.py` — SQL error diagnosis + auto-fix suggestions
- `packages/altimate-engine/src/altimate_engine/sql/autocomplete.py` — Schema-aware autocomplete from cache
- `packages/altimate-code/src/tool/sql-explain.ts` — TS tool for sql.explain
- `packages/altimate-code/src/tool/sql-format.ts` — TS tool for sql.format
- `packages/altimate-code/src/tool/sql-fix.ts` — TS tool for sql.fix
- `packages/altimate-code/src/tool/sql-autocomplete.ts` — TS tool for sql.autocomplete
- `packages/altimate-engine/tests/test_formatter.py` — 9 tests
- `packages/altimate-engine/tests/test_fixer.py` — 14 tests
- `packages/altimate-engine/tests/test_autocomplete.py` — 14 tests
- `packages/altimate-engine/tests/test_explainer.py` — 12 tests

**Phase 7 (CoCo parity — FinOps, PII, Tags, Diff, Skills):**
- `packages/altimate-engine/src/altimate_engine/finops/query_history.py` — QUERY_HISTORY + pg_stat_statements
- `packages/altimate-engine/src/altimate_engine/finops/credit_analyzer.py` — Credit analysis + expensive queries
- `packages/altimate-engine/src/altimate_engine/finops/warehouse_advisor.py` — Warehouse sizing recommendations
- `packages/altimate-engine/src/altimate_engine/finops/unused_resources.py` — Stale tables + idle warehouses
- `packages/altimate-engine/src/altimate_engine/finops/role_access.py` — RBAC grants, role hierarchy, user roles
- `packages/altimate-engine/src/altimate_engine/schema/pii_detector.py` — 30+ regex PII patterns, 15 categories
- `packages/altimate-engine/src/altimate_engine/schema/tags.py` — Snowflake TAG_REFERENCES queries
- `packages/altimate-engine/src/altimate_engine/sql/diff.py` — SQL diff via difflib (unified diff, similarity)
- `packages/altimate-code/src/tool/finops-query-history.ts` — TS tool
- `packages/altimate-code/src/tool/finops-analyze-credits.ts` — TS tool
- `packages/altimate-code/src/tool/finops-expensive-queries.ts` — TS tool
- `packages/altimate-code/src/tool/finops-warehouse-advice.ts` — TS tool
- `packages/altimate-code/src/tool/finops-unused-resources.ts` — TS tool
- `packages/altimate-code/src/tool/finops-role-access.ts` — 3 TS tools (grants, hierarchy, user roles)
- `packages/altimate-code/src/tool/schema-detect-pii.ts` — TS tool
- `packages/altimate-code/src/tool/schema-tags.ts` — 2 TS tools (tags, tags_list)
- `packages/altimate-code/src/tool/sql-diff.ts` — TS tool
- `.altimate-code/skills/model-scaffold/SKILL.md` — dbt model scaffolding skill
- `.altimate-code/skills/yaml-config/SKILL.md` — YAML config generation skill
- `.altimate-code/skills/dbt-docs/SKILL.md` — dbt documentation generation skill
- `.altimate-code/skills/medallion-patterns/SKILL.md` — Medallion architecture patterns skill
- `.altimate-code/skills/incremental-logic/SKILL.md` — Incremental logic assistance skill
- `packages/altimate-engine/tests/test_diff.py` — 24 tests
- `packages/altimate-engine/tests/test_pii_detector.py` — 33 tests
- `packages/altimate-engine/tests/test_finops.py` — 39 tests
- `packages/altimate-engine/tests/test_tags.py` — 14 tests
- `packages/altimate-engine/tests/test_server.py` — +14 dispatch tests for new methods

**Phase 4 (benchmarks):**
- `experiments/BENCHMARKS.md` — Published benchmark report
- `experiments/benchmark_report.json` — Machine-readable benchmark data

### Bridge Methods (32 total)
1. `ping` — Health check
2. `sql.validate` — SQL syntax validation
3. `sql.check` — Read-only/mutation safety check
4. `sql.execute` — SQL execution (PG/DuckDB)
5. `sql.analyze` — 19 anti-pattern checks with confidence
6. `sql.translate` — Cross-dialect SQL translation
7. `sql.optimize` — Query optimization with suggestions
8. `schema.inspect` — Table schema inspection
9. `lineage.check` — Column-level lineage with confidence
10. `dbt.run` — dbt CLI execution
11. `dbt.manifest` — Manifest parsing
12. `warehouse.list` — List configured warehouses
13. `warehouse.test` — Test warehouse connection
14. `schema.index` — Index warehouse metadata into SQLite cache
15. `schema.search` — Search indexed metadata (tables/columns) with natural language
16. `schema.cache_status` — Show cache status (warehouses indexed, counts, timestamps)
17. `sql.explain` — Run EXPLAIN on a query (Snowflake/PG/DuckDB dialect-specific syntax)
18. `sql.format` — Format/beautify SQL via sqlglot pretty-print
19. `sql.fix` — Diagnose SQL errors and suggest fixes (syntax, patterns, resolution)
20. `sql.autocomplete` — Schema-aware auto-complete suggestions from cache
21. `sql.diff` — Compare two SQL queries (unified diff, similarity score)
22. `finops.query_history` — Query execution history (Snowflake QUERY_HISTORY, PG pg_stat_statements)
23. `finops.analyze_credits` — Credit consumption analysis with recommendations
24. `finops.expensive_queries` — Identify most expensive queries by bytes scanned
25. `finops.warehouse_advice` — Warehouse sizing recommendations (scale up/down/burst)
26. `finops.unused_resources` — Find stale tables and idle warehouses
27. `finops.role_grants` — Query RBAC grants on objects/roles
28. `finops.role_hierarchy` — Map role inheritance hierarchy
29. `finops.user_roles` — List user-to-role assignments
30. `schema.detect_pii` — Scan columns for PII patterns (30+ regex, 15 categories)
31. `schema.tags` — Query metadata/governance tags on objects (Snowflake TAG_REFERENCES)
32. `schema.tags_list` — List all available tags with usage counts

### Skills (11 total)
1. `generate-tests` — Generate dbt test definitions
2. `lineage-diff` — Compare lineage between SQL versions
3. `cost-report` — Snowflake cost analysis + optimization suggestions
4. `sql-translate` — Cross-dialect SQL translation
5. `query-optimize` — Query optimization with impact-ranked suggestions
6. `impact-analysis` — Downstream impact analysis using lineage + dbt manifest
7. `model-scaffold` — Staging/intermediate/mart dbt model scaffolding
8. `yaml-config` — Generate sources.yml, schema.yml, properties.yml
9. `dbt-docs` — Generate model/column descriptions and doc blocks
10. `medallion-patterns` — Bronze/silver/gold architecture patterns
11. `incremental-logic` — Append-only, merge/upsert, insert overwrite strategies
