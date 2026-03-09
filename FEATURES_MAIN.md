# Feature Inventory: origin/main

## Summary

- **Total custom features**: 48
- **Total custom files**: ~340 (across tools, bridge, engine, agent, skills, CI/CD, docs, tests)
- **Forked package name**: `@altimateai/altimate-code` (binaries: `altimate`, `altimate-code`)
- **Core addition**: A full Python sidecar engine (`altimate-engine`) connected to the CLI via JSON-RPC over stdio (the "bridge"), enabling data engineering capabilities (SQL execution, schema introspection, lineage, finops, dbt, PII detection).

---

## Features by Category

---

### Tools (38 features)

All custom tools live in `packages/altimate-code/src/tool/`. They are grouped below by functional area.

---

#### 1. SQL Core Tools (8 tools)

- **Files**:
  - `packages/altimate-code/src/tool/sql-analyze.ts`
  - `packages/altimate-code/src/tool/sql-autocomplete.ts`
  - `packages/altimate-code/src/tool/sql-diff.ts`
  - `packages/altimate-code/src/tool/sql-execute.ts`
  - `packages/altimate-code/src/tool/sql-explain.ts`
  - `packages/altimate-code/src/tool/sql-fix.ts`
  - `packages/altimate-code/src/tool/sql-format.ts`
  - `packages/altimate-code/src/tool/sql-optimize.ts`
  - `packages/altimate-code/src/tool/sql-rewrite.ts`
  - `packages/altimate-code/src/tool/sql-translate.ts`
- **Description**: Core SQL tools that execute against connected data warehouses via the Python bridge. `sql_execute` runs queries and returns tabular results. `sql_analyze` performs static anti-pattern detection (SELECT *, cartesian joins, missing LIMIT, etc.). `sql_autocomplete` provides schema-aware completion from the indexed cache. `sql_diff` compares two SQL queries with unified diff output. `sql_explain` runs EXPLAIN/EXPLAIN ANALYZE against a warehouse. `sql_fix` diagnoses SQL errors and suggests corrections. `sql_format` formats SQL with dialect-aware indentation. `sql_optimize` applies sqlglot optimizer passes and detects anti-patterns. `sql_rewrite` performs deterministic AST transforms (SELECT * expansion, sargable predicates, large IN lists to CTE). `sql_translate` converts SQL between dialects (Snowflake, BigQuery, Postgres, MySQL, TSQL, Redshift, DuckDB, etc.).
- **Category**: Tool

---

#### 2. Schema Tools (6 tools)

- **Files**:
  - `packages/altimate-code/src/tool/schema-cache-status.ts`
  - `packages/altimate-code/src/tool/schema-detect-pii.ts`
  - `packages/altimate-code/src/tool/schema-diff.ts`
  - `packages/altimate-code/src/tool/schema-index.ts`
  - `packages/altimate-code/src/tool/schema-inspect.ts`
  - `packages/altimate-code/src/tool/schema-search.ts`
  - `packages/altimate-code/src/tool/schema-tags.ts`
- **Description**: Schema metadata tools backed by the Python bridge. `schema_index` crawls a connected warehouse and writes a local cache. `schema_inspect` describes a specific table (columns, types, constraints, row count). `schema_search` performs natural-language search over indexed metadata. `schema_cache_status` shows cache state (tables, columns, last refresh). `schema_detect_pii` scans column names for PII patterns (SSN, email, phone, credit card, etc.). `schema_diff` compares two SQL model versions for breaking column-level changes using sqlglot (no warehouse needed). `schema_tags` lists Snowflake object tags (tag name, value, object type).
- **Category**: Tool

---

#### 3. Warehouse Connection Tools (5 tools)

- **Files**:
  - `packages/altimate-code/src/tool/warehouse-add.ts`
  - `packages/altimate-code/src/tool/warehouse-discover.ts`
  - `packages/altimate-code/src/tool/warehouse-list.ts`
  - `packages/altimate-code/src/tool/warehouse-remove.ts`
  - `packages/altimate-code/src/tool/warehouse-test.ts`
- **Description**: Warehouse connection lifecycle management. `warehouse_add` stores connection credentials (in OS keyring when available, metadata in connections.json). `warehouse_list` shows all configured connections. `warehouse_test` verifies connectivity. `warehouse_remove` deletes a connection. `warehouse_discover` auto-detects database containers running in Docker (PostgreSQL, MySQL, SQL Server) by inspecting port mappings and environment variables.
- **Category**: Tool

---

#### 4. dbt Integration Tools (4 tools)

- **Files**:
  - `packages/altimate-code/src/tool/dbt-lineage.ts`
  - `packages/altimate-code/src/tool/dbt-manifest.ts`
  - `packages/altimate-code/src/tool/dbt-profiles.ts`
  - `packages/altimate-code/src/tool/dbt-run.ts`
- **Description**: dbt project integration via the Python bridge. `dbt_run` executes dbt CLI commands (run, test, build, compile, seed, snapshot) and captures stdout/stderr. `dbt_manifest` parses manifest.json to extract models, sources, tests, seeds, and dependency graph. `dbt_lineage` computes column-level lineage for a dbt model using the Rust-based altimate-core engine (reads compiled SQL from manifest). `dbt_profiles` discovers and parses ~/.dbt/profiles.yml to extract warehouse connection configs (Snowflake, BigQuery, Databricks, Postgres, Redshift, MySQL, DuckDB).
- **Category**: Tool

---

#### 5. Lineage Tool (1 tool)

- **Files**:
  - `packages/altimate-code/src/tool/lineage-check.ts`
- **Description**: `lineage_check` traces column-level data flow through a SQL query using the Rust-based altimate-core engine. Accepts schema context (table-to-column mappings) for accurate source-to-output column tracking. Used by analyst, validator, and migrator agents.
- **Category**: Tool

---

#### 6. FinOps Tools (7 tools)

- **Files**:
  - `packages/altimate-code/src/tool/finops-analyze-credits.ts`
  - `packages/altimate-code/src/tool/finops-expensive-queries.ts`
  - `packages/altimate-code/src/tool/finops-formatting.ts`
  - `packages/altimate-code/src/tool/finops-query-history.ts`
  - `packages/altimate-code/src/tool/finops-role-access.ts`
  - `packages/altimate-code/src/tool/finops-unused-resources.ts`
  - `packages/altimate-code/src/tool/finops-warehouse-advice.ts`
- **Description**: Snowflake cost and governance analytics tools. `finops_analyze_credits` queries SNOWFLAKE.ACCOUNT_USAGE to break down credit consumption by warehouse with daily trends. `finops_expensive_queries` identifies the most resource-intensive queries. `finops_query_history` retrieves query execution history with filters. `finops_warehouse_advice` analyzes warehouse sizing, load, and queue times to suggest right-sizing. `finops_unused_resources` finds unused tables, warehouses, and roles. `finops_role_access` inspects role grants and privilege hierarchy (role_grants, role_hierarchy, user_roles sub-operations). `finops-formatting.ts` is a shared utility for byte/query formatting. Supports the executive agent's business-language cost reporting.
- **Category**: Tool

---

#### 7. altimate-core Tools — Phase 1: Basic SQL Analysis (6 tools)

These tools call the Rust-based `altimate-core` library (from Altimate's own package) via the Python bridge.

- **Files**:
  - `packages/altimate-code/src/tool/altimate-core-validate.ts`
  - `packages/altimate-code/src/tool/altimate-core-lint.ts`
  - `packages/altimate-code/src/tool/altimate-core-safety.ts`
  - `packages/altimate-code/src/tool/altimate-core-transpile.ts`
  - `packages/altimate-code/src/tool/altimate-core-check.ts`
  - `packages/altimate-code/src/tool/altimate-core-is-safe.ts`
- **Description**: `altimate_core_validate` validates SQL syntax and schema references. `altimate_core_lint` detects anti-patterns (NULL comparisons, implicit casts, unused CTEs). `altimate_core_safety` scans for injection patterns and destructive statements (DROP, TRUNCATE). `altimate_core_transpile` converts SQL between dialects using the Rust engine. `altimate_core_check` runs the full pipeline (validate + lint + safety + PII) in a single call. `altimate_core_is_safe` returns a quick boolean safety verdict.
- **Category**: Tool

---

#### 8. altimate-core Tools — Phase 2: Advanced Analysis (6 tools)

- **Files**:
  - `packages/altimate-code/src/tool/altimate-core-fix.ts`
  - `packages/altimate-code/src/tool/altimate-core-policy.ts`
  - `packages/altimate-code/src/tool/altimate-core-semantics.ts`
  - `packages/altimate-code/src/tool/altimate-core-testgen.ts`
  - `packages/altimate-code/src/tool/altimate-core-equivalence.ts`
  - `packages/altimate-code/src/tool/altimate-core-migration.ts`
- **Description**: `altimate_core_fix` auto-fixes SQL errors using fuzzy matching and iterative re-validation. `altimate_core_policy` checks SQL against YAML-based governance guardrails (allowed tables, forbidden ops). `altimate_core_semantics` detects logical issues (cartesian products, wrong JOINs, NULL misuse, type mismatches). `altimate_core_testgen` generates automated SQL test cases (boundary values, NULL handling, edge cases). `altimate_core_equivalence` checks semantic equivalence of two queries. `altimate_core_migration` analyzes DDL migration safety (data loss, type narrowing, missing defaults).
- **Category**: Tool

---

#### 9. altimate-core Tools — Phase 3: Schema & Lineage Intelligence (13 tools)

- **Files**:
  - `packages/altimate-code/src/tool/altimate-core-classify-pii.ts`
  - `packages/altimate-code/src/tool/altimate-core-column-lineage.ts`
  - `packages/altimate-code/src/tool/altimate-core-compare.ts`
  - `packages/altimate-code/src/tool/altimate-core-complete.ts`
  - `packages/altimate-code/src/tool/altimate-core-correct.ts`
  - `packages/altimate-code/src/tool/altimate-core-export-ddl.ts`
  - `packages/altimate-code/src/tool/altimate-core-extract-metadata.ts`
  - `packages/altimate-code/src/tool/altimate-core-fingerprint.ts`
  - `packages/altimate-code/src/tool/altimate-core-format.ts`
  - `packages/altimate-code/src/tool/altimate-core-grade.ts`
  - `packages/altimate-code/src/tool/altimate-core-import-ddl.ts`
  - `packages/altimate-code/src/tool/altimate-core-introspection-sql.ts`
  - `packages/altimate-code/src/tool/altimate-core-optimize-context.ts`
  - `packages/altimate-code/src/tool/altimate-core-optimize-for-query.ts`
  - `packages/altimate-code/src/tool/altimate-core-parse-dbt.ts`
  - `packages/altimate-code/src/tool/altimate-core-prune-schema.ts`
  - `packages/altimate-code/src/tool/altimate-core-query-pii.ts`
  - `packages/altimate-code/src/tool/altimate-core-resolve-term.ts`
  - `packages/altimate-code/src/tool/altimate-core-rewrite.ts`
  - `packages/altimate-code/src/tool/altimate-core-schema-diff.ts`
  - `packages/altimate-code/src/tool/altimate-core-track-lineage.ts`
- **Description**: Advanced schema and lineage intelligence tools.
  - `altimate_core_classify_pii`: Classifies PII columns in a schema by name patterns and data types.
  - `altimate_core_column_lineage`: Traces schema-aware column lineage through a query (requires API key init).
  - `altimate_core_compare`: Structurally compares two SQL queries (tables, joins, filters, projections).
  - `altimate_core_complete`: Cursor-aware SQL completion (table names, column names, functions, keywords).
  - `altimate_core_correct`: Iterative propose-verify-refine correction loop for SQL.
  - `altimate_core_export_ddl`: Exports YAML/JSON schema as CREATE TABLE DDL statements.
  - `altimate_core_extract_metadata`: Extracts tables, columns, functions, CTEs from a SQL query.
  - `altimate_core_fingerprint`: Computes SHA-256 fingerprint of a schema for cache invalidation.
  - `altimate_core_format`: Fast Rust-based SQL formatter with dialect-aware keyword casing.
  - `altimate_core_grade`: Grades SQL quality A-F (readability, performance, correctness, best practices).
  - `altimate_core_import_ddl`: Converts CREATE TABLE DDL into YAML schema definition.
  - `altimate_core_introspection_sql`: Generates INFORMATION_SCHEMA queries for a target database type.
  - `altimate_core_optimize_context`: Applies progressive schema disclosure (5 levels) to reduce LLM context size.
  - `altimate_core_optimize_for_query`: Prunes schema to only tables/columns referenced by a specific query.
  - `altimate_core_parse_dbt`: Parses a dbt project directory (models, sources, tests, seeds) via Rust engine.
  - `altimate_core_prune_schema`: Filters schema to SQL-referenced elements only.
  - `altimate_core_query_pii`: Checks if a SQL query accesses PII-classified columns and reports exposure risk.
  - `altimate_core_resolve_term`: Fuzzy-maps business glossary terms to actual table/column names.
  - `altimate_core_rewrite`: Suggests concrete query optimization rewrites.
  - `altimate_core_schema_diff`: Diffs two schemas (altimate-core variant, breaking change detection).
  - `altimate_core_track_lineage`: Builds a combined lineage graph across multiple SQL queries.
- **Category**: Tool

---

### Bridge (1 feature)

#### 10. Python Bridge (JSON-RPC over stdio)

- **Files**:
  - `packages/altimate-code/src/bridge/client.ts`
  - `packages/altimate-code/src/bridge/engine.ts`
  - `packages/altimate-code/src/bridge/protocol.ts`
- **Description**: A typed JSON-RPC 2.0 over stdio bridge between the TypeScript CLI and the Python altimate-engine sidecar. `protocol.ts` defines the full type-safe contract for all ~60 RPC methods (params and result types). `client.ts` manages the child process lifecycle (spawn, restart up to 2 times on failure, 30-second call timeout), serializes requests, deserializes responses, buffers multi-line JSON, and records telemetry for every call. `engine.ts` handles bootstrapping: downloads the `uv` Python package manager, creates an isolated venv, installs `altimate-engine` from PyPI, and maintains a `manifest.json` with version metadata. A mutex prevents concurrent installs from corrupting state. All bridge calls are tracked in telemetry with method name, status, and duration.
- **Category**: Bridge

---

### Prompt/Agent (1 feature)

#### 11. Custom Agent Modes (5 agents)

- **Files**:
  - `packages/altimate-code/src/agent/agent.ts`
  - `packages/altimate-code/src/agent/prompt/analyst.txt`
  - `packages/altimate-code/src/agent/prompt/builder.txt`
  - `packages/altimate-code/src/agent/prompt/executive.txt`
  - `packages/altimate-code/src/agent/prompt/migrator.txt`
  - `packages/altimate-code/src/agent/prompt/validator.txt`
- **Description**: Five domain-specific agent modes tailored for data engineering workflows, all registered as `native: true` primary agents:
  - **builder**: Full read/write access. Specializes in creating/modifying dbt models, SQL files, YAML configs. Encourages use of `sql_analyze`, `schema_inspect`, `lineage_check`.
  - **analyst**: Read-only data exploration. Restricted permission set — can run SELECT queries, validate SQL, inspect schemas, check lineage, browse query history. Cannot modify files or run destructive SQL.
  - **executive**: Same analytical capabilities as analyst but communicates exclusively in business terms. Never shows SQL, column names in backticks, or engineering jargon. Translates all findings into business impact (revenue at risk, cost, compliance exposure). Designed for slide decks and executive emails.
  - **validator**: Read-only quality and integrity verification. Focuses on `sql_analyze` (18 anti-pattern checks), `altimate_core_validate`, `lineage_check`, and the `/lineage-diff` skill. Reports issues with severity levels.
  - **migrator**: Cross-warehouse SQL migration. Read/write access. Specializes in dialect conversion, source/target schema comparison, lineage integrity verification post-migration.
- **Category**: Prompt/Agent

---

### Telemetry (1 feature)

#### 12. Azure Application Insights Telemetry

- **Files**:
  - `packages/altimate-code/src/telemetry/index.ts`
  - `packages/altimate-code/test/telemetry/telemetry.test.ts`
  - `docs/docs/configure/telemetry.md`
- **Description**: A buffered, batched telemetry system sending structured events to Azure Application Insights via the `/v2/track` endpoint. Events are typed and include: `session_start`, `session_end`, `generation`, `tool_call`, `bridge_call`, `error`, `command`, `context_overflow_recovered`, `compaction_triggered`, `tool_outputs_pruned`, `auth_login`, `auth_logout`, `mcp_server_status`, `provider_error`, `engine_started`, `engine_error`, `upgrade_attempted`, `session_forked`, `permission_denied`, `doom_loop_detected`, `environment_census`, `context_utilization`, `agent_outcome`, `error_recovered`, `mcp_server_census`. Buffered in-memory (max 200 events), flushed every 5 seconds and on shutdown. User email is SHA-256 hashed before transmission. Can be disabled via `ALTIMATE_TELEMETRY_DISABLED=true` env var or `telemetry.disabled` config key. The instrumentation key is intentionally hardcoded (public telemetry pattern). Overridable via `APPLICATIONINSIGHTS_CONNECTION_STRING` for dev/testing.
- **Category**: Telemetry

---

### CLI (3 features)

#### 13. Engine CLI Command

- **Files**:
  - `packages/altimate-code/src/cli/cmd/engine.ts`
- **Description**: A `altimate-code engine` top-level command with three subcommands: `status` (shows uv installation state, Python version, engine version, CLI version, install timestamp), `reset` (removes the engine directory and reinstalls from scratch), and `path` (prints the engine directory path). Used for debugging the Python sidecar setup.
- **Category**: CLI

---

#### 14. Custom Binary Names and Launcher Scripts

- **Files**:
  - `packages/altimate-code/bin/altimate`
  - `packages/altimate-code/bin/altimate-code`
  - `packages/altimate-code/package.json` (bin entries: `altimate` and `altimate-code`)
- **Description**: The package exposes two binary names (`altimate` and `altimate-code`) under `@altimateai` npm scope. The launcher scripts perform platform/architecture detection (darwin/linux/win32, x64/arm64, musl vs glibc on Linux, AVX2 support for x64 baseline fallback) and locate the correct pre-built native binary from the appropriate scoped package (e.g., `@altimateai/altimate-code-darwin-arm64`). Supports `ALTIMATE_CODE_BIN_PATH` env var override and a cached `.altimate-code` binary in the bin directory.
- **Category**: CLI

---

#### 15. Feature Flags (ALTIMATE_CLI_* env vars)

- **Files**:
  - `packages/altimate-code/src/flag/flag.ts`
- **Description**: A comprehensive set of environment variable feature flags all prefixed `ALTIMATE_CLI_*`. Custom flags added on top of upstream include: `ALTIMATE_CLI_DISABLE_CLAUDE_CODE` (disables Claude Code integration), `ALTIMATE_CLI_DISABLE_CLAUDE_CODE_PROMPT`, `ALTIMATE_CLI_DISABLE_CLAUDE_CODE_SKILLS`, `ALTIMATE_CLI_DISABLE_EXTERNAL_SKILLS`, `ALTIMATE_CLI_ENABLE_QUESTION_TOOL`, plus all existing upstream flags renamed to the Altimate prefix convention. Dynamic getters via `Object.defineProperty` ensure `ALTIMATE_CLI_DISABLE_PROJECT_CONFIG`, `ALTIMATE_CLI_CONFIG_DIR`, and `ALTIMATE_CLI_CLIENT` are evaluated at access time rather than module load time.
- **Category**: CLI

---

### Python Engine (1 feature)

#### 16. altimate-engine Python Package

- **Files** (complete package at `packages/altimate-engine/`):
  - `src/altimate_engine/server.py` — JSON-RPC stdio server (entry point)
  - `src/altimate_engine/connections.py` — Connection registry
  - `src/altimate_engine/credential_store.py` — OS keyring integration
  - `src/altimate_engine/models.py` — Pydantic request/response models (~60 RPC types)
  - `src/altimate_engine/connectors/` — Database connectors:
    - `base.py`, `bigquery.py`, `databricks.py`, `duckdb.py`, `mysql.py`, `postgres.py`, `redshift.py`, `snowflake.py`, `sqlserver.py`
  - `src/altimate_engine/dbt/` — dbt integration:
    - `lineage.py`, `manifest.py`, `profiles.py`, `runner.py`
  - `src/altimate_engine/docker_discovery.py` — Docker container detection
  - `src/altimate_engine/finops/` — Cost analytics:
    - `credit_analyzer.py`, `query_history.py`, `role_access.py`, `unused_resources.py`, `warehouse_advisor.py`
  - `src/altimate_engine/local/` — Local testing:
    - `schema_sync.py`, `test_local.py`
  - `src/altimate_engine/schema/` — Schema intelligence:
    - `cache.py`, `inspector.py`, `pii_detector.py`, `tags.py`
  - `src/altimate_engine/sql/` — SQL processing:
    - `autocomplete.py`, `diff.py`, `executor.py`, `explainer.py`, `guard.py`
  - `src/altimate_engine/ssh_tunnel.py` — SSH tunnel support
  - `tests/` — 20+ test files covering all modules
  - `pyproject.toml` — Package definition (name: `altimate-engine`, version: `0.2.0`)
- **Description**: A Python sidecar process exposing ~60 JSON-RPC methods over stdio. Implements: SQL execution across 8 warehouse connectors (Snowflake, BigQuery, Databricks, DuckDB, MySQL, PostgreSQL, Redshift, SQL Server), schema inspection and caching, SQL analysis/formatting/optimization/translation via sqlglot, PII column detection, finops analytics (Snowflake ACCOUNT_USAGE queries), dbt project parsing and command execution, Docker-based database discovery, SSH tunnel support for remote databases, OS keyring credential storage, and integration with the Rust-based `altimate-core` PyPI package for advanced lineage/validation. Installed in an isolated managed venv via the `uv` package manager (see Bridge feature).
- **Category**: Python Engine

---

### Skills (1 feature)

#### 17. Data Engineering Skills (11 skills)

- **Files** (all in `.altimate-code/skills/`):
  - `.altimate-code/skills/cost-report/SKILL.md`
  - `.altimate-code/skills/dbt-docs/SKILL.md`
  - `.altimate-code/skills/generate-tests/SKILL.md`
  - `.altimate-code/skills/impact-analysis/SKILL.md`
  - `.altimate-code/skills/incremental-logic/SKILL.md`
  - `.altimate-code/skills/lineage-diff/SKILL.md`
  - `.altimate-code/skills/medallion-patterns/SKILL.md`
  - `.altimate-code/skills/model-scaffold/SKILL.md`
  - `.altimate-code/skills/query-optimize/SKILL.md`
  - `.altimate-code/skills/sql-translate/SKILL.md`
  - `.altimate-code/skills/yaml-config/SKILL.md`
- **Description**: Eleven bundled skills (slash commands) for data engineering workflows:
  - **cost-report**: Analyze Snowflake query costs and identify optimization opportunities.
  - **dbt-docs**: Generate or improve dbt model documentation (column descriptions, model descriptions, doc blocks).
  - **generate-tests**: Generate dbt tests for a model by inspecting schema and SQL, producing schema.yml test definitions.
  - **impact-analysis**: Analyze downstream impact of changes to a dbt model by combining column-level lineage with the dbt dependency graph.
  - **incremental-logic**: Add or fix incremental materialization logic in dbt models (is_incremental(), unique keys, merge strategies).
  - **lineage-diff**: Compare column-level lineage between two SQL query versions to show added, removed, and changed data flow edges.
  - **medallion-patterns**: Apply medallion architecture (bronze/silver/gold) patterns to organize dbt models into clean data layers.
  - **model-scaffold**: Scaffold a new dbt model following staging/intermediate/mart patterns with proper naming, materialization, and structure.
  - **query-optimize**: Analyze and optimize SQL queries for better performance.
  - **sql-translate**: Translate SQL queries between database dialects.
  - **yaml-config**: Generate dbt YAML configuration files (sources.yml, schema.yml, properties.yml) from warehouse schema or existing models.
- **Category**: Skill

---

### CI/CD (3 features)

#### 18. CI Workflow (TypeScript + Python tests)

- **Files**:
  - `.github/workflows/ci.yml`
- **Description**: Runs on push/PR to main. Three parallel jobs: (1) TypeScript — installs Bun 1.3.9 with cache, configures git for tests, runs `bun test` in `packages/altimate-code`; (2) Lint — installs ruff 0.9.10, runs `ruff check src` on `packages/altimate-engine`; (3) Python matrix — tests the Python engine across Python versions.
- **Category**: CI/CD

---

#### 19. Release Workflow (Multi-platform binary builds)

- **Files**:
  - `.github/workflows/release.yml`
- **Description**: Triggered on `v*` tags. Builds native binaries for linux, darwin, and win32 using Bun's cross-compilation. Uploads to GitHub Releases. Then publishes to npm under `@altimateai` scope (not the upstream `opencode` scope). Injects `ALTIMATE_CLI_VERSION`, `ALTIMATE_CLI_CHANNEL`, `ALTIMATE_CLI_RELEASE`, and `GH_REPO=AltimateAI/altimate-code` at build time.
- **Category**: CI/CD

---

#### 20. Publish Engine Workflow (PyPI)

- **Files**:
  - `.github/workflows/publish-engine.yml`
- **Description**: Triggered on `engine-v*` tags. Builds the `altimate-engine` Python package with `python -m build` (hatchling backend) and publishes to PyPI using `pypa/gh-action-pypi-publish` with OIDC trusted publishing. Allows skipping existing versions. This is what the bridge's `ensureEngine()` function installs in the managed venv.
- **Category**: CI/CD

---

### Docs (1 feature)

#### 21. Data Engineering Documentation Site

- **Files** (under `docs/`):
  - `docs/mkdocs.yml` — MkDocs Material configuration
  - `docs/docs/data-engineering/agent-modes.md`
  - `docs/docs/data-engineering/guides/cost-optimization.md`
  - `docs/docs/data-engineering/guides/migration.md`
  - `docs/docs/data-engineering/guides/using-with-claude-code.md`
  - `docs/docs/data-engineering/guides/using-with-codex.md`
  - `docs/docs/data-engineering/tools/dbt-tools.md`
  - `docs/docs/data-engineering/tools/finops-tools.md`
  - `docs/docs/data-engineering/tools/lineage-tools.md`
  - `docs/docs/data-engineering/tools/schema-tools.md`
  - `docs/docs/data-engineering/tools/sql-tools.md`
  - `docs/docs/data-engineering/tools/warehouse-tools.md`
  - `docs/docs/configure/telemetry.md`
  - Plus top-level project docs: `docs/docs/index.md`, `docs/docs/getting-started.md`, `docs/docs/security-faq.md`, `docs/docs/network.md`, `docs/docs/troubleshooting.md`, `docs/docs/windows-wsl.md`
  - `docs/docs/assets/images/altimate-code-banner.png`, `favicon.png`, `logo.png`
  - `.github/workflows/docs.yml`
- **Description**: A full MkDocs Material documentation site for the altimate-code product. Includes a dedicated "Data Engineering" section covering: agent modes (builder, analyst, executive, validator, migrator), workflow guides (cost optimization, migration, integration with Claude Code and Codex), and reference pages for all custom tool categories (SQL, schema, warehouse, dbt, lineage, finops). Also covers telemetry configuration.
- **Category**: Docs

---

### Tests (1 feature)

#### 22. Custom Feature Tests

- **Files**:
  - `packages/altimate-code/test/bridge/client.test.ts`
  - `packages/altimate-code/test/bridge/engine.test.ts`
  - `packages/altimate-code/test/acp/agent-interface.test.ts`
  - `packages/altimate-code/test/acp/event-subscription.test.ts`
  - `packages/altimate-code/test/telemetry/telemetry.test.ts`
  - `packages/altimate-engine/tests/test_autocomplete.py`
  - `packages/altimate-engine/tests/test_connections.py`
  - `packages/altimate-engine/tests/test_connectors.py`
  - `packages/altimate-engine/tests/test_credential_store.py`
  - `packages/altimate-engine/tests/test_dbt_profiles.py`
  - `packages/altimate-engine/tests/test_diff.py`
  - `packages/altimate-engine/tests/test_docker_discovery.py`
  - `packages/altimate-engine/tests/test_enterprise_connectors.py`
  - `packages/altimate-engine/tests/test_env_detect.py`
  - `packages/altimate-engine/tests/test_executor.py`
  - `packages/altimate-engine/tests/test_explainer.py`
  - `packages/altimate-engine/tests/test_finops.py`
  - `packages/altimate-engine/tests/test_guard.py`
  - `packages/altimate-engine/tests/test_guard_new.py`
  - `packages/altimate-engine/tests/test_local.py`
  - `packages/altimate-engine/tests/test_manifest.py`
  - `packages/altimate-engine/tests/test_pii_detector.py`
  - `packages/altimate-engine/tests/test_schema_cache.py`
  - `packages/altimate-engine/tests/test_server.py`
  - `packages/altimate-engine/tests/test_server_guard.py`
  - `packages/altimate-engine/tests/test_server_guard_new.py`
  - `packages/altimate-engine/tests/test_ssh_tunnel.py`
  - `packages/altimate-engine/tests/test_tags.py`
- **Description**: Tests covering the custom bridge client (Python process management, restart behavior, timeout handling), engine bootstrapping, ACP protocol compliance, telemetry buffering/flushing, and the entire Python engine test suite (SQL execution, autocomplete, schema caching, PII detection, finops queries, Docker discovery, SSH tunnels, dbt manifest parsing, SQL guard/safety).
- **Category**: Test

---

### Other / Platform (3 features)

#### 23. ACP (Agent Client Protocol) Server

- **Files**:
  - `packages/altimate-code/src/acp/agent.ts`
  - `packages/altimate-code/src/acp/session.ts`
  - `packages/altimate-code/src/acp/types.ts`
  - `packages/altimate-code/src/acp/README.md`
  - `packages/altimate-code/src/cli/cmd/acp.ts`
  - `packages/altimate-code/test/acp/agent-interface.test.ts`
  - `packages/altimate-code/test/acp/event-subscription.test.ts`
- **Description**: A protocol-compliant implementation of the Agent Client Protocol (ACP) using `@agentclientprotocol/sdk`. Exposes altimate-code as an ACP-compatible agent server, enabling integration with clients such as Zed. Implements: `initialize` with capability negotiation, `session/new` (creates internal sessions), `session/load` (basic resume), `session/prompt` (processes messages, returns responses). Session state management maps ACP sessions to internal altimate-code sessions with working directory context. The ACP server starts via `altimate-code acp` CLI command. `ALTIMATE_CLI_ENABLE_QUESTION_TOOL` env var enables the question tool for ACP clients that support interactive prompts.
- **Category**: Other

---

#### 24. Rebranded Package Identity

- **Files**:
  - `packages/altimate-code/package.json` (name: `@altimateai/altimate-code`)
  - `packages/altimate-code/bin/altimate`
  - `packages/altimate-code/bin/altimate-code`
  - `README.md` (root)
  - `CHANGELOG.md`
  - `CODE_OF_CONDUCT.md`
  - `CONTRIBUTING.md`
  - `RELEASING.md`
  - `SECURITY.md`
  - `PROGRESS.md`
  - `packages/altimate-code/AGENTS.md`
  - `packages/altimate-code/Dockerfile`
  - `packages/altimate-code/src/cli/cmd/tui/context/theme/altimate-code.json`
- **Description**: Complete rebranding of the upstream `opencode` project to `altimate-code` under the `@altimateai` npm scope. Includes a custom Altimate Code TUI theme (`altimate-code.json`), a Dockerfile for containerized deployment, updated project governance documents (CODE_OF_CONDUCT, CONTRIBUTING, RELEASING, SECURITY), and a `PROGRESS.md` tracking the upstream merge state.
- **Category**: Other

---

#### 25. Local Schema Sync and SQL Testing

- **Files**:
  - `packages/altimate-engine/src/altimate_engine/local/schema_sync.py`
  - `packages/altimate-engine/src/altimate_engine/local/test_local.py`
  - `packages/altimate-engine/tests/test_local.py`
- **Description**: A local-first SQL testing workflow accessible via the bridge (`local.schema_sync` and `local.test`). `schema_sync` pulls schema metadata from a live warehouse into a local YAML file (tables, columns, sample rows). `local.test` executes a SQL query against the locally synced schema using DuckDB as a local executor — with optional dialect transpilation via sqlglot. This enables SQL testing without a live warehouse connection, useful for CI environments.
- **Category**: Other

---

## Consolidated Tool Count by Type

| Category | Tool Names |
|---|---|
| SQL Core | sql_execute, sql_analyze, sql_autocomplete, sql_diff, sql_explain, sql_fix, sql_format, sql_optimize, sql_rewrite, sql_translate |
| Schema | schema_cache_status, schema_detect_pii, schema_diff, schema_index, schema_inspect, schema_search, schema_tags |
| Warehouse | warehouse_add, warehouse_discover, warehouse_list, warehouse_remove, warehouse_test |
| dbt | dbt_lineage, dbt_manifest, dbt_profiles, dbt_run |
| Lineage | lineage_check |
| FinOps | finops_analyze_credits, finops_expensive_queries, finops_query_history, finops_role_grants, finops_role_hierarchy, finops_unused_resources, finops_user_roles, finops_warehouse_advice |
| altimate-core Phase 1 | altimate_core_validate, altimate_core_lint, altimate_core_safety, altimate_core_transpile, altimate_core_check, altimate_core_is_safe |
| altimate-core Phase 2 | altimate_core_fix, altimate_core_policy, altimate_core_semantics, altimate_core_testgen, altimate_core_equivalence, altimate_core_migration |
| altimate-core Phase 3 | altimate_core_classify_pii, altimate_core_column_lineage, altimate_core_compare, altimate_core_complete, altimate_core_correct, altimate_core_export_ddl, altimate_core_extract_metadata, altimate_core_fingerprint, altimate_core_format, altimate_core_grade, altimate_core_import_ddl, altimate_core_introspection_sql, altimate_core_optimize_context, altimate_core_optimize_for_query, altimate_core_parse_dbt, altimate_core_prune_schema, altimate_core_query_pii, altimate_core_resolve_term, altimate_core_rewrite, altimate_core_schema_diff, altimate_core_track_lineage |

**Total custom tools: ~56 tool functions across 38 TypeScript tool files**

---

## Bridge RPC Method Registry (complete)

The bridge (`packages/altimate-code/src/bridge/protocol.ts`) defines 61 typed RPC methods:

```
sql.execute, sql.analyze, sql.optimize, sql.translate, sql.explain,
sql.format, sql.fix, sql.autocomplete, sql.diff, sql.rewrite, sql.schema_diff
schema.inspect, schema.index, schema.search, schema.cache_status,
schema.detect_pii, schema.tags, schema.tags_list
lineage.check
dbt.run, dbt.manifest, dbt.lineage, dbt.profiles
warehouse.list, warehouse.test, warehouse.add, warehouse.remove, warehouse.discover
finops.query_history, finops.analyze_credits, finops.expensive_queries,
finops.warehouse_advice, finops.unused_resources, finops.role_grants,
finops.role_hierarchy, finops.user_roles
local.schema_sync, local.test
altimate_core.validate, altimate_core.lint, altimate_core.safety,
altimate_core.transpile, altimate_core.explain, altimate_core.check,
altimate_core.fix, altimate_core.policy, altimate_core.semantics, altimate_core.testgen,
altimate_core.equivalence, altimate_core.migration, altimate_core.schema_diff,
altimate_core.rewrite, altimate_core.correct, altimate_core.grade,
altimate_core.classify_pii, altimate_core.query_pii, altimate_core.resolve_term,
altimate_core.column_lineage, altimate_core.track_lineage,
altimate_core.format, altimate_core.metadata, altimate_core.compare,
altimate_core.complete, altimate_core.optimize_context, altimate_core.optimize_for_query,
altimate_core.prune_schema, altimate_core.import_ddl, altimate_core.export_ddl,
altimate_core.fingerprint, altimate_core.introspection_sql, altimate_core.parse_dbt,
altimate_core.is_safe
ping
```
