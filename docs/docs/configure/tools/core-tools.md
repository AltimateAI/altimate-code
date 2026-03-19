# Core Tools

The `altimate_core_*` tools are powered by a Rust-based SQL engine that provides fast, deterministic analysis without LLM calls. These tools handle validation, linting, safety scanning, lineage, formatting, and more.

## Analysis & Validation

### altimate_core_check

Run the full analysis pipeline — validate + lint + safety scan + PII check — in a single call.

**Parameters:** `sql` (required), `schema_path` (optional), `schema_context` (optional)

---

### altimate_core_validate

Validate SQL syntax and schema references. Checks if tables and columns exist in the schema and if SQL is valid for the target dialect.

**Parameters:** `sql` (required), `schema_path` (optional), `schema_context` (optional)

---

### altimate_core_lint

Lint SQL for anti-patterns — NULL comparisons, implicit casts, unused CTEs, and dialect-specific problems.

**Parameters:** `sql` (required), `schema_path` (optional), `schema_context` (optional)

---

### altimate_core_grade

Grade SQL quality on an A–F scale. Evaluates readability, performance, correctness, and best practices.

**Parameters:** `sql` (required), `schema_path` (optional), `schema_context` (optional)

---

## Safety & Governance

### altimate_core_safety

Scan SQL for injection patterns, dangerous statements (DROP, TRUNCATE), and security threats.

**Parameters:** `sql` (required)

---

### altimate_core_is_safe

Quick boolean safety check — returns true/false indicating whether SQL is safe to execute.

**Parameters:** `sql` (required)

---

### altimate_core_policy

Check SQL against YAML-based governance policy guardrails. Validates compliance with custom rules like allowed tables, forbidden operations, and data access restrictions.

**Parameters:** `sql` (required), `policy_json` (required), `schema_path` (optional), `schema_context` (optional)

---

### altimate_core_classify_pii

Classify PII columns in a schema by name patterns and data types. Identifies columns likely containing personal identifiable information.

**Parameters:** `schema_path` (optional), `schema_context` (optional)

---

### altimate_core_query_pii

Analyze query-level PII exposure. Checks if a SQL query accesses columns classified as PII and reports the exposure risk.

**Parameters:** `sql` (required), `schema_path` (optional), `schema_context` (optional)

---

## SQL Transformation

### altimate_core_fix

Auto-fix SQL errors using fuzzy matching and iterative re-validation to correct syntax errors, typos, and schema reference issues.

**Parameters:** `sql` (required), `schema_path` (optional), `schema_context` (optional), `max_iterations` (optional)

---

### altimate_core_correct

Iteratively correct SQL using a propose-verify-refine loop. More thorough than `fix` — applies multiple correction rounds.

**Parameters:** `sql` (required), `schema_path` (optional), `schema_context` (optional)

---

### altimate_core_format

Format SQL with dialect-aware keyword casing and indentation. Fast and deterministic.

**Parameters:** `sql` (required), `dialect` (optional)

---

### altimate_core_rewrite

Suggest query optimization rewrites — analyzes SQL and proposes concrete rewrites for better performance.

**Parameters:** `sql` (required), `schema_path` (optional), `schema_context` (optional)

---

### altimate_core_transpile

Translate SQL between dialects using the Rust engine.

**Parameters:** `sql` (required), `source_dialect` (required), `target_dialect` (required)

---

## Comparison & Equivalence

### altimate_core_compare

Structurally compare two SQL queries. Identifies differences in table references, join conditions, filters, projections, and aggregations.

**Parameters:** `left_sql` (required), `right_sql` (required), `dialect` (optional)

---

### altimate_core_equivalence

Check semantic equivalence of two SQL queries — determines if they produce the same result set regardless of syntactic differences.

**Parameters:** `sql1` (required), `sql2` (required), `schema_path` (optional), `schema_context` (optional)

---

## Lineage & Metadata

### altimate_core_column_lineage

Trace schema-aware column lineage. Maps how columns flow through a query from source tables to output.

**Parameters:** `sql` (required), `dialect` (optional), `schema_path` (optional), `schema_context` (optional)

---

### altimate_core_track_lineage

Track lineage across multiple SQL statements.

**Parameters:** `sql` (required), `schema_path` (optional), `schema_context` (optional)

---

### altimate_core_extract_metadata

Extract metadata from SQL — identifies tables, columns, functions, CTEs, and other structural elements referenced in a query.

**Parameters:** `sql` (required), `dialect` (optional)

---

### altimate_core_resolve_term

Resolve a business glossary term to schema elements using fuzzy matching. Maps human-readable terms like "revenue" or "customer" to actual table/column names.

**Parameters:** `term` (required), `schema_path` (optional), `schema_context` (optional)

---

### altimate_core_semantics

Analyze semantic meaning of SQL elements.

**Parameters:** `sql` (required), `schema_path` (optional), `schema_context` (optional)

---

## Schema Operations

### altimate_core_schema_diff

Diff two schema versions to detect structural changes.

**Parameters:** `old_ddl` (required), `new_ddl` (required), `dialect` (optional)

---

### altimate_core_migration

Analyze DDL migration safety. Detects potential data loss, type narrowing, missing defaults, and other risks in schema migration statements.

**Parameters:** `old_ddl` (required), `new_ddl` (required), `dialect` (optional)

---

### altimate_core_export_ddl

Export a YAML/JSON schema as CREATE TABLE DDL statements.

**Parameters:** `schema_path` (optional), `schema_context` (optional)

---

### altimate_core_import_ddl

Convert CREATE TABLE DDL into a structured YAML schema definition that other core tools can consume.

**Parameters:** `ddl` (required), `dialect` (optional)

---

### altimate_core_fingerprint

Compute a SHA-256 fingerprint of a schema. Useful for cache invalidation and change detection.

**Parameters:** `schema_path` (optional), `schema_context` (optional)

---

### altimate_core_introspection_sql

Generate INFORMATION_SCHEMA introspection queries for a given database type. Supports postgres, bigquery, snowflake, mysql, mssql, redshift.

**Parameters:** `db_type` (required), `database` (required), `schema_name` (optional)

---

## Context Optimization

### altimate_core_optimize_context

Optimize schema for LLM context window. Applies 5-level progressive disclosure to reduce schema size while preserving essential information.

**Parameters:** `schema_path` (optional), `schema_context` (optional)

---

### altimate_core_optimize_for_query

Prune schema to only tables and columns relevant to a specific query. Reduces context size for LLM prompts.

**Parameters:** `sql` (required), `schema_path` (optional), `schema_context` (optional)

---

### altimate_core_prune_schema

Filter schema to only tables and columns referenced by a SQL query.

**Parameters:** `sql` (required), `schema_path` (optional), `schema_context` (optional)

---

## dbt & Autocomplete

### altimate_core_parse_dbt

Parse a dbt project directory. Extracts models, sources, tests, and project structure for analysis.

**Parameters:** `project_dir` (required)

---

### altimate_core_complete

Get cursor-aware SQL completion suggestions. Returns table names, column names, functions, and keywords relevant to the cursor position.

**Parameters:** `sql` (required), `cursor_pos` (required), `schema_path` (optional), `schema_context` (optional)

---

### altimate_core_testgen

Generate test cases for SQL queries.

**Parameters:** `sql` (required), `schema_path` (optional), `schema_context` (optional)
