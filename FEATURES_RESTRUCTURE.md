# Feature Inventory: restructure/main

## Summary

- **Total custom features**: 60
- **Total custom files**: ~244 (altimate-specific) across the entire branch
- **Product name**: altimate-code (fork of opencode, re-branded as a data engineering platform)
- **Binary names added**: `altimate`, `altimate-code` (alongside upstream `opencode`)
- **Core architecture**: TypeScript CLI (opencode fork) + Python engine sidecar (`altimate-engine`) communicating over JSON-RPC via stdio

---

## Features by Category

---

### Bridge (3 features)

The bridge subsystem connects the TypeScript CLI to the Python `altimate-engine` sidecar via JSON-RPC over stdio.

#### 1. Bridge Client (JSON-RPC over stdio)
- **Files**: `packages/opencode/src/altimate/bridge/client.ts`
- **Description**: Spawns the Python `altimate-engine` sidecar as a child process and communicates with it via newline-delimited JSON-RPC. Handles timeouts (30s), automatic restart on crash (up to 2 restarts), pending request tracking, and per-call telemetry instrumentation.
- **Category**: Bridge

#### 2. Bridge Engine Bootstrap
- **Files**: `packages/opencode/src/altimate/bridge/engine.ts`
- **Description**: Downloads and manages the `uv` Python package manager, creates an isolated Python venv, installs the `altimate-engine` PyPI package at the pinned version embedded at build time, and stores a manifest file with version metadata. Supports cross-platform (macOS arm64/x64, Linux arm64/x64, Windows x64). Provides `ensureEngine()`, `engineStatus()`, `resetEngine()`, and `enginePythonPath()` functions. Uses a mutex to prevent concurrent install races.
- **Category**: Bridge

#### 3. Bridge Protocol (RPC Contract)
- **Files**: `packages/opencode/src/altimate/bridge/protocol.ts`
- **Description**: Complete TypeScript type definitions for all ~70 JSON-RPC methods between the CLI and Python engine. Defines request/response types for SQL, schema, lineage, dbt, warehouse, FinOps, altimate-core, and local testing namespaces. Acts as the single source of truth for the CLI↔engine interface.
- **Category**: Bridge

---

### Tools (5 groups, 83 tools total)

All custom tools live in `packages/opencode/src/altimate/tools/` and are registered in `packages/opencode/src/tool/registry.ts` via `altimate_change` markers.

#### 4. SQL Tools (10 tools)
- **Files**:
  - `packages/opencode/src/altimate/tools/sql-analyze.ts`
  - `packages/opencode/src/altimate/tools/sql-autocomplete.ts`
  - `packages/opencode/src/altimate/tools/sql-diff.ts`
  - `packages/opencode/src/altimate/tools/sql-execute.ts`
  - `packages/opencode/src/altimate/tools/sql-explain.ts`
  - `packages/opencode/src/altimate/tools/sql-fix.ts`
  - `packages/opencode/src/altimate/tools/sql-format.ts`
  - `packages/opencode/src/altimate/tools/sql-optimize.ts`
  - `packages/opencode/src/altimate/tools/sql-rewrite.ts`
  - `packages/opencode/src/altimate/tools/sql-translate.ts`
- **Description**: Comprehensive SQL developer experience tools. `sql_execute` runs queries against connected warehouses. `sql_analyze` detects anti-patterns (19 rules: SELECT *, cartesian products, correlated subqueries, missing LIMIT, etc.). `sql_optimize` suggests query optimizations. `sql_translate` converts between dialects. `sql_explain` fetches query execution plans. `sql_format` formats SQL. `sql_fix` repairs broken SQL given an error message. `sql_autocomplete` provides schema-aware completion suggestions. `sql_diff` diffs two SQL strings. `sql_rewrite` applies automated rewrites (SELECT_STAR, NON_SARGABLE, LARGE_IN_LIST rules).
- **Category**: Tool

#### 5. Schema Tools (8 tools)
- **Files**:
  - `packages/opencode/src/altimate/tools/schema-cache-status.ts`
  - `packages/opencode/src/altimate/tools/schema-detect-pii.ts`
  - `packages/opencode/src/altimate/tools/schema-diff.ts`
  - `packages/opencode/src/altimate/tools/schema-index.ts`
  - `packages/opencode/src/altimate/tools/schema-inspect.ts`
  - `packages/opencode/src/altimate/tools/schema-search.ts`
  - `packages/opencode/src/altimate/tools/schema-tags.ts` (2 tools: `schema_tags`, `schema_tags_list`)
- **Description**: Schema management and discovery tools. `schema_inspect` describes a table's columns/types. `schema_index` crawls a warehouse and builds a local SQLite search index. `schema_search` performs full-text search across indexed tables and columns. `schema_cache_status` reports index freshness per warehouse. `schema_detect_pii` scans column names for PII patterns (30+ categories). `schema_diff` detects breaking schema changes between two DDL versions. `schema_tags` and `schema_tags_list` query Snowflake metadata tags.
- **Category**: Tool

#### 6. Warehouse Tools (5 tools)
- **Files**:
  - `packages/opencode/src/altimate/tools/warehouse-add.ts`
  - `packages/opencode/src/altimate/tools/warehouse-discover.ts`
  - `packages/opencode/src/altimate/tools/warehouse-list.ts`
  - `packages/opencode/src/altimate/tools/warehouse-remove.ts`
  - `packages/opencode/src/altimate/tools/warehouse-test.ts`
- **Description**: Warehouse connection lifecycle management. `warehouse_list` enumerates configured connections. `warehouse_test` verifies connectivity. `warehouse_add` saves a new connection configuration. `warehouse_remove` deletes a connection. `warehouse_discover` scans running Docker containers and extracts database connection details (PostgreSQL, MySQL/MariaDB, SQL Server) from port mappings and environment variables.
- **Category**: Tool

#### 7. dbt Tools (4 tools)
- **Files**:
  - `packages/opencode/src/altimate/tools/dbt-lineage.ts`
  - `packages/opencode/src/altimate/tools/dbt-manifest.ts`
  - `packages/opencode/src/altimate/tools/dbt-profiles.ts`
  - `packages/opencode/src/altimate/tools/dbt-run.ts`
- **Description**: dbt integration tools. `dbt_run` executes dbt commands (run, test, compile, etc.) with selector support. `dbt_manifest` parses a `manifest.json` and returns models, sources, tests, snapshots, and seeds with counts. `dbt_lineage` extracts compiled SQL and column-level lineage from a specific dbt model via the manifest. `dbt_profiles` discovers database connections from `~/.dbt/profiles.yml`.
- **Category**: Tool

#### 8. FinOps Tools (7 tools)
- **Files**:
  - `packages/opencode/src/altimate/tools/finops-analyze-credits.ts`
  - `packages/opencode/src/altimate/tools/finops-expensive-queries.ts`
  - `packages/opencode/src/altimate/tools/finops-formatting.ts`
  - `packages/opencode/src/altimate/tools/finops-query-history.ts`
  - `packages/opencode/src/altimate/tools/finops-role-access.ts` (3 tools: `finops_role_grants`, `finops_role_hierarchy`, `finops_user_roles`)
  - `packages/opencode/src/altimate/tools/finops-unused-resources.ts`
  - `packages/opencode/src/altimate/tools/finops-warehouse-advice.ts`
- **Description**: Cloud cost optimization and governance tools (primarily Snowflake-focused). `finops_query_history` retrieves query execution history with cost metadata. `finops_analyze_credits` analyzes daily/warehouse credit consumption trends. `finops_expensive_queries` identifies the costliest queries over a time window. `finops_warehouse_advice` provides warehouse sizing recommendations. `finops_unused_resources` identifies stale tables and idle warehouses. `finops_role_grants`, `finops_role_hierarchy`, and `finops_user_roles` analyze Snowflake RBAC structure.
- **Category**: Tool

#### 9. altimate-core Tools (29 tools)
- **Files** (all in `packages/opencode/src/altimate/tools/`):
  - `altimate-core-check.ts` — `altimate_core_check`
  - `altimate-core-classify-pii.ts` — `altimate_core_classify_pii`
  - `altimate-core-column-lineage.ts` — `altimate_core_column_lineage`
  - `altimate-core-compare.ts` — `altimate_core_compare`
  - `altimate-core-complete.ts` — `altimate_core_complete`
  - `altimate-core-correct.ts` — `altimate_core_correct`
  - `altimate-core-equivalence.ts` — `altimate_core_equivalence`
  - `altimate-core-export-ddl.ts` — `altimate_core_export_ddl`
  - `altimate-core-extract-metadata.ts` — `altimate_core_metadata`
  - `altimate-core-fingerprint.ts` — `altimate_core_fingerprint`
  - `altimate-core-fix.ts` — `altimate_core_fix`
  - `altimate-core-format.ts` — `altimate_core_format`
  - `altimate-core-grade.ts` — `altimate_core_grade`
  - `altimate-core-import-ddl.ts` — `altimate_core_import_ddl`
  - `altimate-core-introspection-sql.ts` — `altimate_core_introspection_sql`
  - `altimate-core-is-safe.ts` — `altimate_core_is_safe`
  - `altimate-core-lint.ts` — `altimate_core_lint`
  - `altimate-core-migration.ts` — `altimate_core_migration`
  - `altimate-core-optimize-context.ts` — `altimate_core_optimize_context`
  - `altimate-core-optimize-for-query.ts` — `altimate_core_optimize_for_query`
  - `altimate-core-parse-dbt.ts` — `altimate_core_parse_dbt`
  - `altimate-core-policy.ts` — `altimate_core_policy`
  - `altimate-core-prune-schema.ts` — `altimate_core_prune_schema`
  - `altimate-core-query-pii.ts` — `altimate_core_query_pii`
  - `altimate-core-resolve-term.ts` — `altimate_core_resolve_term`
  - `altimate-core-rewrite.ts` — `altimate_core_rewrite`
  - `altimate-core-safety.ts` — `altimate_core_safety`
  - `altimate-core-schema-diff.ts` — `altimate_core_schema_diff`
  - `altimate-core-semantics.ts` — `altimate_core_semantics`
  - `altimate-core-testgen.ts` — `altimate_core_testgen`
  - `altimate-core-track-lineage.ts` — `altimate_core_track_lineage`
  - `altimate-core-transpile.ts` — `altimate_core_transpile`
  - `altimate-core-validate.ts` — `altimate_core_validate`
- **Description**: Wrappers around the Rust-based `altimate-core` library (accessed via the Python bridge). Organized in three phases: P0 (validate, lint, safety, transpile, check, fix, policy, semantics, testgen), P1 (equivalence, migration, schema_diff, rewrite, correct, grade), and P2 (classify_pii, query_pii, resolve_term, column_lineage, track_lineage, format, metadata, compare, complete, optimize_context, optimize_for_query, prune_schema, import_ddl, export_ddl, fingerprint, introspection_sql, parse_dbt, is_safe). These provide deep SQL static analysis, semantic understanding, lineage tracking, PII classification, query equivalence checking, DDL migration, and policy enforcement.
- **Category**: Tool

#### 10. Miscellaneous Tools (2 tools)
- **Files**:
  - `packages/opencode/src/altimate/tools/project-scan.ts`
  - `packages/opencode/src/altimate/tools/lineage-check.ts`
- **Description**: `project_scan` detects the full data engineering environment: git repository details, dbt project structure (models/sources/tests counts), configured and newly discovered warehouse connections (from dbt profiles, Docker containers, and env vars), schema cache status, and installed data tools (dbt, sqlfluff, etc.). `lineage_check` computes column-level data lineage for a SQL query, tracing source-to-target column flows through joins, transforms, and CTEs.
- **Category**: Tool

---

### Prompt/Agent (5 features)

Custom agent modes added to `packages/opencode/src/agent/agent.ts` via `altimate_change` markers. Each mode has a custom system prompt and a permission ruleset controlling which tools are available.

#### 11. Builder Agent Mode
- **Files**: `packages/opencode/src/altimate/prompts/builder.txt`, `packages/opencode/src/agent/agent.ts`
- **Description**: Full read/write data engineering agent for creating and modifying dbt models, SQL files, and YAML configs. Enforces a mandatory pre-execution protocol (analyze → validate → execute) before any SQL execution. Includes a dbt verification workflow and self-review requirement before declaring tasks complete. Replaces the upstream default `build` agent.
- **Category**: Prompt/Agent

#### 12. Analyst Agent Mode
- **Files**: `packages/opencode/src/altimate/prompts/analyst.txt`, `packages/opencode/src/agent/agent.ts`
- **Description**: Read-only data exploration agent with a restricted permission set (denies all write tools, allows SQL/schema/lineage/FinOps read tools). Enforces cost-conscious exploration protocols (LIMIT clauses, iterative optimization, session cost tracking). Surfaces available read-only skills.
- **Category**: Prompt/Agent

#### 13. Executive Agent Mode
- **Files**: `packages/opencode/src/altimate/prompts/executive.txt`, `packages/opencode/src/agent/agent.ts`
- **Description**: Read-only agent calibrated for non-technical business stakeholders. Strictly prohibits SQL, jargon, and technical notation in output. Translates all technical findings into business impact (revenue, cost, compliance risk). Formats output for slide decks and executive emails.
- **Category**: Prompt/Agent

#### 14. Migrator Agent Mode
- **Files**: `packages/opencode/src/altimate/prompts/migrator.txt`, `packages/opencode/src/agent/agent.ts`
- **Description**: Cross-warehouse SQL migration agent with read/write access scoped to migration tasks. Validates source SQL, converts between dialects, verifies lineage preservation, compares schemas between source and target, and documents incompatibilities. Has access to sql-translate, lineage-diff, and all dbt skills.
- **Category**: Prompt/Agent

#### 15. Validator Agent Mode
- **Files**: `packages/opencode/src/altimate/prompts/validator.txt`, `packages/opencode/src/agent/agent.ts`
- **Description**: Read-only data quality and integrity verification agent. Uses a structured findings format (Critical/Warning/Info severity tiers) and a dbt model verification checklist covering correctness, testing, performance, and documentation. Cannot modify files. Enforces a comprehensive validation protocol across SQL analysis, lineage, and dbt test coverage.
- **Category**: Prompt/Agent

---

### Plugin (1 feature)

#### 16. Anthropic OAuth Plugin
- **Files**: `packages/opencode/src/altimate/plugin/anthropic.ts`
- **Description**: Custom plugin implementing Anthropic OAuth 2.0 authentication via PKCE flow. Supports two login modes: Claude Pro/Max subscription (claude.ai) and API key creation via console (console.anthropic.com). Handles token refresh, injects required OAuth beta headers, prefixes all tool names with `mcp_` as required by Anthropic's OAuth endpoint, strips the prefix in streaming responses, and sanitizes system prompts (replaces "OpenCode" with "Claude Code"). Also zeroes out model costs for Pro/Max subscribers.
- **Category**: Plugin

---

### CLI (1 feature)

#### 17. Engine CLI Command
- **Files**: `packages/opencode/src/altimate/cli/engine.ts`
- **Description**: Adds an `engine` subcommand group to the CLI with three sub-commands: `status` (shows uv, Python, and engine versions + install path), `reset` (removes and reinstalls the engine), and `path` (prints the engine directory). Registered at the CLI root alongside standard opencode commands.
- **Category**: CLI

---

### Config (4 features)

These are modifications to upstream opencode files, marked with `// altimate_change` comments.

#### 18. Dual Config Directory Support
- **Files**: `packages/opencode/src/config/config.ts`
- **Description**: Extends config file discovery to look in both `.altimate-code/` and `.opencode/` directories, enabling users migrating from opencode to pick up their existing config without renaming the directory.
- **Category**: Config

#### 19. CLI Script Name and Binary Aliases
- **Files**: `packages/opencode/src/index.ts`, `packages/opencode/bin/altimate`, `packages/opencode/package.json`
- **Description**: Sets the yargs script name to `altimate-code`, adds `altimate` and `altimate-code` bin entries in package.json pointing to `./bin/altimate`, and sets `process.env.DATAPILOT = "1"` as a runtime identifier. The original `opencode` binary is retained for backward compatibility.
- **Category**: Config

#### 20. ALTIMATE_CLI_CLIENT Flag
- **Files**: `packages/opencode/src/flag/flag.ts`
- **Description**: Adds `ALTIMATE_CLI_CLIENT` as a dual-env-var flag (primary: `ALTIMATE_CLI_CLIENT`, fallback: `OPENCODE_CLIENT`) with helper functions `altTruthy()` and `altEnv()` for reading flags that support both naming conventions.
- **Category**: Config

#### 21. App Name and Data Directory Branding
- **Files**: `packages/opencode/src/global/index.ts`, `packages/opencode/src/installation/index.ts`
- **Description**: Changes the application data directory name from `opencode` to `altimate-code` (XDG data/cache/config/state paths), updates the database marker file name, and sets the user-agent string to `altimate-code/{CHANNEL}/{VERSION}/{CLIENT}`. The database marker (`altimate-code.db`) prevents re-running one-time migrations.
- **Category**: Config

---

### Telemetry (1 feature)

#### 22. Altimate Telemetry System
- **Files**: `packages/opencode/src/altimate/telemetry/index.ts`, `packages/opencode/src/telemetry/index.ts`
- **Description**: Full telemetry pipeline sending events to Azure Application Insights (hardcoded instrumentation key, overridable via `APPLICATIONINSIGHTS_CONNECTION_STRING`). Tracks 30+ event types including: `session_start/end`, `generation`, `tool_call` (with category classification for SQL/schema/dbt/finops/warehouse/lineage/file tools), `bridge_call` (Python RPC timing), `engine_started/error`, `auth_login/logout`, `mcp_server_status/census`, `context_overflow_recovered`, `compaction_triggered`, `doom_loop_detected`, `environment_census` (warehouse types, dbt detection, MCP count, OS), `context_utilization`, `agent_outcome`, `error_recovered`, `upgrade_attempted`, `permission_denied`, and `session_forked`. User email is SHA-256 hashed before sending. Supports opt-out via `ALTIMATE_TELEMETRY_DISABLED=true` or config. Uses a 5-second flush interval with a 200-event buffer and retry logic.
- **Category**: Telemetry

---

### Python Engine (14 features)

The `packages/altimate-engine/` package is a complete Python application published to PyPI as `altimate-engine`. It runs as a JSON-RPC sidecar process.

#### 23. JSON-RPC Server
- **Files**: `packages/altimate-engine/src/altimate_engine/server.py`
- **Description**: Reads newline-delimited JSON-RPC 2.0 requests from stdin, dispatches to handlers across all engine modules, and writes responses to stdout. Entry point for the sidecar process (`python -m altimate_engine.server`).
- **Category**: Python Engine

#### 24. Database Connector Framework
- **Files**:
  - `packages/altimate-engine/src/altimate_engine/connectors/base.py`
  - `packages/altimate-engine/src/altimate_engine/connectors/bigquery.py`
  - `packages/altimate-engine/src/altimate_engine/connectors/databricks.py`
  - `packages/altimate-engine/src/altimate_engine/connectors/duckdb.py`
  - `packages/altimate-engine/src/altimate_engine/connectors/mysql.py`
  - `packages/altimate-engine/src/altimate_engine/connectors/postgres.py`
  - `packages/altimate-engine/src/altimate_engine/connectors/redshift.py`
  - `packages/altimate-engine/src/altimate_engine/connectors/snowflake.py`
  - `packages/altimate-engine/src/altimate_engine/connectors/sqlserver.py`
- **Description**: Abstract `Connector` base class with concrete implementations for 8 warehouse types (Snowflake, BigQuery, Databricks, PostgreSQL, MySQL, Redshift, DuckDB, SQL Server). Each connector implements `connect()`, `execute()`, `list_schemas()`, `list_tables()`, `describe_table()`, and `close()`. Optional `set_statement_timeout()` for query time limits.
- **Category**: Python Engine

#### 25. Connection Registry
- **Files**: `packages/altimate-engine/src/altimate_engine/connections.py`
- **Description**: Manages named warehouse connections loaded from `~/.altimate-code/connections.json`, `.altimate-code/connections.json` (project-level), and `ALTIMATE_CODE_CONN_*` environment variables. Resolves credentials from the keyring store and transparently starts SSH tunnels when tunnel configuration is present.
- **Category**: Python Engine

#### 26. Credential Store
- **Files**: `packages/altimate-engine/src/altimate_engine/credential_store.py`
- **Description**: Stores and retrieves sensitive connection fields (password, private_key_passphrase, access_token, ssh_password, connection_string) in the OS keyring (`keyring` library) under the `altimate-code` service name. Falls back gracefully when keyring is unavailable. Integrates with `ConnectionRegistry` to resolve stored credentials at connection time.
- **Category**: Python Engine

#### 27. SQL Executor
- **Files**: `packages/altimate-engine/src/altimate_engine/sql/executor.py`
- **Description**: Executes SQL against any registered warehouse connector, returns rows as lists of lists with column names, and truncates results at a configurable limit. Used by the `sql_execute` tool.
- **Category**: Python Engine

#### 28. SQL Static Analyzer
- **Files**: `packages/altimate-engine/src/altimate_engine/sql/` (analyzer component)
- **Description**: Rule-based SQL anti-pattern detector with 19 rules (SELECT_STAR, SELECT_STAR_IN_SUBQUERY, CARTESIAN_PRODUCT, IMPLICIT_CARTESIAN, MISSING_LIMIT, ORDER_BY_WITHOUT_LIMIT, ORDER_BY_IN_SUBQUERY, CORRELATED_SUBQUERY, NOT_IN_WITH_SUBQUERY, LARGE_IN_LIST, LIKE_LEADING_WILDCARD, NON_EQUI_JOIN, OR_IN_JOIN, UNION_INSTEAD_OF_UNION_ALL, UNUSED_CTE, FUNCTION_IN_FILTER, FUNCTION_IN_JOIN, WINDOW_WITHOUT_PARTITION, GROUP_BY_PRIMARY_KEY). Each issue includes severity, recommendation, location, and per-issue confidence scoring via `ConfidenceTracker`. Benchmarked at F1=1.00 on 1,077 test queries at 0.48ms/query average latency.
- **Category**: Python Engine

#### 29. SQL Diff Engine
- **Files**: `packages/altimate-engine/src/altimate_engine/sql/diff.py`
- **Description**: Computes a unified diff between two SQL strings, returning additions, deletions, similarity ratio, and a structured list of changes. Used by the `sql_diff` tool.
- **Category**: Python Engine

#### 30. SQL Explainer
- **Files**: `packages/altimate-engine/src/altimate_engine/sql/explainer.py`
- **Description**: Fetches query execution plans from connected warehouses (EXPLAIN / EXPLAIN ANALYZE), returning the plan as text and structured rows. Warehouse-aware: handles Snowflake, PostgreSQL, MySQL, and BigQuery plan output formats.
- **Category**: Python Engine

#### 31. SQL Guard (Safety)
- **Files**: `packages/altimate-engine/src/altimate_engine/sql/guard.py`
- **Description**: Thin wrapper around the `altimate-core` Rust bindings providing graceful fallback when the Rust library is not installed. Bridges Python server handlers to the `altimate_core` module functions for validate, lint, safety, transpile, and all Phase 1-3 operations. Handles schema resolution from file paths or inline JSON dictionaries.
- **Category**: Python Engine

#### 32. Schema Cache (SQLite Index)
- **Files**: `packages/altimate-engine/src/altimate_engine/schema/cache.py`
- **Description**: Builds and queries a local SQLite database indexing all warehouse metadata (databases, schemas, tables, columns). Enables fast full-text search without live warehouse queries. Tracks indexing timestamps and row counts per warehouse. Described internally as "altimate-code's answer to Snowflake's Horizon Catalog integration."
- **Category**: Python Engine

#### 33. Schema Inspector
- **Files**: `packages/altimate-engine/src/altimate_engine/schema/inspector.py`
- **Description**: Inspects a specific table's column definitions using the `ConnectionRegistry`. Falls back to direct Postgres connection string for backward compatibility. Returns column names, data types, nullability, and primary key flags.
- **Category**: Python Engine

#### 34. PII Detector
- **Files**: `packages/altimate-engine/src/altimate_engine/schema/pii_detector.py`
- **Description**: Detects columns likely to contain PII using regex patterns against column names. Covers 30+ PII categories (SSN, passport, drivers license, email, phone, address, names, credit cards, bank accounts, salary, dates of birth, passwords/tokens, IP addresses, health data, biometric data, demographics, geolocation). Each match includes a confidence level (high/medium/low). Filters out metadata columns (e.g., `email_sent_count`) that reference PII without containing it.
- **Category**: Python Engine

#### 35. Metadata Tags
- **Files**: `packages/altimate-engine/src/altimate_engine/schema/tags.py`
- **Description**: Queries Snowflake metadata tag assignments and tag definitions using `SNOWFLAKE.ACCOUNT_USAGE` views. Returns tag-to-object mappings and a summary of tag usage counts.
- **Category**: Python Engine

#### 36. FinOps Modules
- **Files**:
  - `packages/altimate-engine/src/altimate_engine/finops/credit_analyzer.py`
  - `packages/altimate-engine/src/altimate_engine/finops/query_history.py`
  - `packages/altimate-engine/src/altimate_engine/finops/role_access.py`
  - `packages/altimate-engine/src/altimate_engine/finops/unused_resources.py`
  - `packages/altimate-engine/src/altimate_engine/finops/warehouse_advisor.py`
- **Description**: Python implementations for all FinOps analytics. `credit_analyzer` queries `SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY` for daily/per-warehouse credit consumption with configurable time windows. `query_history` retrieves `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY`. `role_access` queries role grants, role hierarchy (`SHOW ROLES`), and user-role assignments. `unused_resources` identifies tables not accessed in N days and idle warehouses. `warehouse_advisor` queries warehouse load and performance metrics.
- **Category**: Python Engine

---

### Skills (11 features)

Skills are `.opencode/skills/<name>/SKILL.md` prompt files invoked via `/skill-name` commands in chat.

#### 37. cost-report Skill
- **Files**: `.opencode/skills/cost-report/SKILL.md`
- **Description**: Analyzes Snowflake query costs by querying `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY`, groups results by user/warehouse/query type, runs `sql_analyze` on the top 10 most expensive queries, classifies queries into cost tiers, and produces prioritized optimization recommendations.
- **Category**: Skill

#### 38. dbt-docs Skill
- **Files**: `.opencode/skills/dbt-docs/SKILL.md`
- **Description**: Generates or improves dbt model and column descriptions in `schema.yml` files. Inspects the source table schema, reviews existing model SQL, and produces business-friendly documentation.
- **Category**: Skill

#### 39. generate-tests Skill
- **Files**: `.opencode/skills/generate-tests/SKILL.md`
- **Description**: Auto-generates dbt test definitions (not_null, unique, relationships, accepted_values) for specified models or all models in the project. Reads the dbt manifest to understand model grain and key columns.
- **Category**: Skill

#### 40. impact-analysis Skill
- **Files**: `.opencode/skills/impact-analysis/SKILL.md`
- **Description**: Performs downstream impact analysis for a given model or column using lineage data and the dbt manifest. Identifies which models, dashboards, and consumers are affected by a proposed change.
- **Category**: Skill

#### 41. incremental-logic Skill
- **Files**: `.opencode/skills/incremental-logic/SKILL.md`
- **Description**: Guides implementation of incremental materialization strategies in dbt, including merge keys, delete+insert patterns, and partition-aware incrementals.
- **Category**: Skill

#### 42. lineage-diff Skill
- **Files**: `.opencode/skills/lineage-diff/SKILL.md`
- **Description**: Compares column-level lineage between two versions of a SQL query or dbt model, highlighting columns whose data flow has changed or been broken.
- **Category**: Skill

#### 43. medallion-patterns Skill
- **Files**: `.opencode/skills/medallion-patterns/SKILL.md`
- **Description**: Guides implementing bronze/silver/gold (medallion) data architecture patterns in dbt, including layer separation, materialization choices, and data quality contracts.
- **Category**: Skill

#### 44. model-scaffold Skill
- **Files**: `.opencode/skills/model-scaffold/SKILL.md`
- **Description**: Scaffolds new dbt staging, intermediate, or mart models following project naming conventions. Generates the SQL skeleton, schema.yml entry, and recommended tests.
- **Category**: Skill

#### 45. query-optimize Skill
- **Files**: `.opencode/skills/query-optimize/SKILL.md`
- **Description**: Optimizes a SQL query by running `sql_analyze` for anti-pattern detection and `sql_optimize` for rewrite suggestions, then produces a before/after comparison with cost impact estimates.
- **Category**: Skill

#### 46. sql-translate Skill
- **Files**: `.opencode/skills/sql-translate/SKILL.md`
- **Description**: Translates SQL from one dialect to another (e.g., Snowflake to BigQuery), validates the result with `sql_validate`, and documents any functions or features that require manual adjustment.
- **Category**: Skill

#### 47. yaml-config Skill
- **Files**: `.opencode/skills/yaml-config/SKILL.md`
- **Description**: Generates `sources.yml` and `schema.yml` configuration files from a live warehouse schema inspection, pre-populating table and column definitions.
- **Category**: Skill

---

### Python Engine (Additional features)

#### 48. dbt Integration Modules
- **Files**:
  - `packages/altimate-engine/src/altimate_engine/dbt/lineage.py`
  - `packages/altimate-engine/src/altimate_engine/dbt/manifest.py`
  - `packages/altimate-engine/src/altimate_engine/dbt/profiles.py`
  - `packages/altimate-engine/src/altimate_engine/dbt/runner.py`
- **Description**: Python modules backing the dbt tools. `manifest.py` parses `manifest.json` to extract models, sources, tests, snapshots, and seeds. `lineage.py` extracts compiled SQL and column-level lineage for a specific model from the manifest. `profiles.py` reads `~/.dbt/profiles.yml` and converts profiles into connection configs. `runner.py` executes dbt CLI commands as subprocesses, capturing stdout/stderr and exit codes.
- **Category**: Python Engine

#### 49. Docker Discovery
- **Files**: `packages/altimate-engine/src/altimate_engine/docker_discovery.py`
- **Description**: Scans running Docker containers using the Docker SDK, matches known database images (postgres, mysql, mariadb, SQL Server), extracts host port mappings, and infers credentials from container environment variables. Returns a list of discovered database containers ready for `warehouse_add`.
- **Category**: Python Engine

#### 50. SSH Tunnel Manager
- **Files**: `packages/altimate-engine/src/altimate_engine/ssh_tunnel.py`
- **Description**: Starts and manages SSH tunnels using `sshtunnel` and `paramiko`. Supports key-based and password-based authentication. Tunnels are registered by connection name and automatically stopped on process exit via `atexit`. Integrates transparently with `ConnectionRegistry` when tunnel config fields are present.
- **Category**: Python Engine

#### 51. Local Schema Sync & Testing
- **Files**:
  - `packages/altimate-engine/src/altimate_engine/local/schema_sync.py`
  - `packages/altimate-engine/src/altimate_engine/local/test_local.py`
- **Description**: `schema_sync` syncs a remote warehouse schema into a local DuckDB database (empty stub tables, optionally with sample rows), enabling offline SQL development and testing. `test_local` executes SQL against a local DuckDB snapshot with optional dialect transpilation from the warehouse's native dialect.
- **Category**: Python Engine

---

### Tests (3 features)

Custom tests for the altimate-specific components.

#### 52. Bridge Client Tests
- **Files**: `packages/opencode/test/bridge/client.test.ts`
- **Description**: Tests the `resolvePython()` function in `bridge/client.ts`, verifying Python binary resolution priority: `OPENCODE_PYTHON` env var, local dev venv, cwd venv, managed engine venv, and `python3` fallback. Uses `mock.module()` to stub `bridge/engine`.
- **Category**: Test

#### 53. Bridge Engine Tests
- **Files**: `packages/opencode/test/bridge/engine.test.ts`
- **Description**: E2E tests verifying that `execFileSync` with `{ stdio: "pipe" }` prevents subprocess output from leaking to the parent process stdout/stderr. Validates the noise-suppression approach used in `engine.ts` for all subprocess calls (uv, python, tar).
- **Category**: Test

#### 54. Python Engine Tests
- **Files**: `packages/altimate-engine/tests/` (27 test files)
- **Description**: Comprehensive pytest test suite for `altimate-engine`. Tests cover: autocomplete, connections, connectors (per-warehouse), credential store, dbt profiles, SQL diff, Docker discovery, enterprise connectors, environment detection, SQL execution, SQL explain, FinOps modules, SQL guard, local schema sync/testing, dbt manifest parsing, PII detection, schema cache, JSON-RPC server, server-level guard, SSH tunnels, and metadata tags.
- **Category**: Test

---

### Experiments (2 features)

#### 55. SQL Analyze Validation Benchmark
- **Files**:
  - `experiments/sql_analyze_validation/__init__.py`
  - `experiments/sql_analyze_validation/generate_queries.py`
  - `experiments/sql_analyze_validation/queries.json`
  - `experiments/sql_analyze_validation/report.py`
  - `experiments/sql_analyze_validation/run_benchmark.py`
  - `experiments/sql_analyze_validation/results/` (benchmark result files)
- **Description**: Accuracy benchmark framework for the `sql.analyze` engine. Generates 1,077 test queries across 18 categories with ground-truth expected positive/negative rules, runs the `StaticQueryAnalyzer`, computes per-rule precision/recall/F1, and generates a benchmark report. Published results show F1=1.00 on all 19 rules at 0.48ms/query average latency.
- **Category**: Experiment

#### 56. Lineage Validation Benchmark
- **Files**:
  - `experiments/lineage_validation/__init__.py`
  - `experiments/lineage_validation/generate_lineage_queries.py`
  - `experiments/lineage_validation/lineage_queries.json`
  - `experiments/lineage_validation/report_lineage.py`
  - `experiments/lineage_validation/run_lineage_benchmark.py`
  - `experiments/lineage_validation/results/` (benchmark result files)
  - `experiments/BENCHMARKS.md`
- **Description**: Accuracy benchmark for the `lineage.check` engine. Generates queries with expected column-level lineage edges, runs `check_lineage`, computes edge-level precision/recall/F1 using multiset matching (handles duplicate edges), and generates timestamped result files.
- **Category**: Experiment

---

### CI/CD (2 features)

#### 57. Publish Engine CI Workflow
- **Files**: `.github/workflows/publish-engine.yml`
- **Description**: GitHub Actions workflow that publishes the `altimate-engine` Python package to PyPI on `engine-v*` git tags. Uses OIDC trusted publishing (`id-token: write`) via the official PyPA action. Builds with `python -m build` and skips existing versions.
- **Category**: CI/CD

#### 58. Upstream Merge Tooling
- **Files**:
  - `script/upstream/merge.ts`
  - `script/upstream/merge-config.json`
  - `script/upstream/analyze.ts`
  - `script/upstream/package.json`
  - `script/upstream/transforms/keep-ours.ts`
  - `script/upstream/transforms/lock-files.ts`
  - `script/upstream/transforms/skip-files.ts`
  - `script/upstream/utils/config.ts`
  - `script/upstream/utils/git.ts`
- **Description**: Automated tooling to merge upstream opencode releases into the fork. Given a version tag, the script: validates prerequisites, creates a merge branch, runs `git merge`, automatically resolves conflicts using three strategies (keep-ours for custom code paths like `src/altimate/**`, skip-files for unused upstream packages like `packages/app/**`, and lock-files), reports remaining conflicts for manual resolution, and regenerates the lockfile. The `analyze.ts` script does a dry-run conflict analysis. Configuration in `merge-config.json` specifies `keepOurs` paths, `skipFiles` patterns, package name mappings, and the `altimate_change` marker name.
- **Category**: CI/CD

---

### Docs (1 feature)

#### 59. Data Engineering Documentation Site
- **Files** (all under `docs/docs/data-engineering/`):
  - `agent-modes.md` — Builder, Analyst, Validator, Migrator, Executive mode docs
  - `guides/cost-optimization.md`
  - `guides/index.md`
  - `guides/migration.md`
  - `guides/using-with-claude-code.md`
  - `guides/using-with-codex.md`
  - `tools/dbt-tools.md`
  - `tools/finops-tools.md`
  - `tools/index.md`
  - `tools/lineage-tools.md`
  - `tools/schema-tools.md`
  - `tools/sql-tools.md`
  - `tools/warehouse-tools.md`
  - `docs/docs/index.md` (custom homepage: "The data engineering agent for dbt, SQL, and cloud warehouses")
  - `docs/docs/assets/` (custom logo, banner, favicon, CSS)
  - `CHANGELOG.md`, `RELEASING.md`, `CODE_OF_CONDUCT.md`
- **Description**: Complete documentation site for the altimate-code product. Covers all five agent modes with examples, all 55+ custom tools organized by category (SQL, schema, dbt, FinOps, warehouse, lineage), integration guides for Claude Code and Codex, and the release/publishing process. Custom branding assets (altimate-code logo, banner, favicon) and theme-aware CSS. The RELEASING.md documents the dual-package (npm + PyPI) release process with version bumping scripts.
- **Category**: Docs

---

### Other (1 feature)

#### 60. Paid Context Management Feature Planning
- **Files**: `packages/opencode/src/altimate/session/PAID_CONTEXT_FEATURES.md`
- **Description**: Design document for six planned paid-tier context management features to be implemented in `altimate-core` (Rust) behind license key verification: (1) Precise token counting via tiktoken-rs, (2) Smart context scoring via local embedding-based relevance, (3) Schema compression using ILP optimization (~2x token reduction), (4) Lineage-aware context selection from the dbt DAG, (5) Semantic schema catalog generation (YAML-based business descriptions), and (6) Context budget allocator with per-category token allocation.
- **Category**: Other

---

## Additional Modified Upstream Files (via `altimate_change` markers)

These upstream opencode files were modified to wire in the custom code:

| File | Change |
|------|--------|
| `packages/opencode/src/tool/registry.ts` | Imports and registers all 83 custom tools |
| `packages/opencode/src/agent/agent.ts` | Imports 5 custom agent mode prompts and adds builder/analyst/executive/migrator/validator agents |
| `packages/opencode/src/index.ts` | Sets script name, `DATAPILOT` env var, telemetry init, DB marker name |
| `packages/opencode/src/flag/flag.ts` | Adds `ALTIMATE_CLI_CLIENT` dual env var flag |
| `packages/opencode/src/global/index.ts` | Changes app name for XDG data directories |
| `packages/opencode/src/installation/index.ts` | Updates user-agent string, imports telemetry |
| `packages/opencode/src/config/config.ts` | Adds `.altimate-code` config dir support |
| `packages/opencode/src/telemetry/index.ts` | Re-exports from altimate telemetry module |
| `packages/opencode/src/altimate/cli/theme/altimate-code.json` | Custom dark/light color theme |

---

## File Count Summary

| Area | Files |
|------|-------|
| `packages/opencode/src/altimate/` | 86 files |
| `packages/altimate-engine/src/` | 38 files |
| `packages/altimate-engine/tests/` | 27 files |
| `.opencode/skills/` | 11 files |
| `experiments/` | 20 files |
| `docs/docs/data-engineering/` | 13 files |
| `docs/docs/` (other custom) | ~10 files |
| `.github/workflows/publish-engine.yml` | 1 file |
| `script/upstream/` | 9 files |
| `CHANGELOG.md`, `RELEASING.md`, `CODE_OF_CONDUCT.md` | 3 files |
| Modified upstream files | ~9 files |
| **Total custom/modified** | **~227 files** |
