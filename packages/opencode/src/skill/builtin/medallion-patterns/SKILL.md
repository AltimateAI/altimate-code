---
name: medallion-patterns
description: Guide for bronze/silver/gold (medallion) layer architecture in dbt. Use when organizing models into layers, naming conventions, materializations, or migrating from a flat structure to medallion.
---

# Medallion Architecture in dbt

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** bash (runs `altimate-dbt` commands), read, write, glob, dbt_profiles

## When to Use This Skill

**Use when the user wants to:**
- Reorganize a flat dbt project into bronze/silver/gold layers
- Understand naming conventions and materialization for each layer
- Migrate existing staging/intermediate/mart models to medallion naming
- Decide which layer a new model belongs to

**Do NOT use for:**
- Writing specific model SQL → use `dbt-develop`
- Converting a model to incremental → use `incremental-logic`
- Generating YAML configs → use `yaml-config`

## Layer Definitions

### Bronze (Raw)
- **Purpose:** 1:1 copy of source data with no transformation
- **Naming:** `bronze_<source>__<table>` or `brz_<source>__<table>`
- **Materialization:** `view` or `incremental` (large tables)
- **Location:** `models/bronze/`
- **Rules:** No business logic. No joins. Rename columns only if needed for clarity.

### Silver (Cleaned / Conformed)
- **Purpose:** Cleaned, validated, typed, and conformed data. Light joins to resolve foreign keys.
- **Naming:** `silver_<entity>` or `slv_<entity>`
- **Materialization:** `table` or `incremental`
- **Location:** `models/silver/`
- **Rules:** Apply data types, nullability, deduplication, basic transformations. No heavy aggregations.

### Gold (Business / Serving)
- **Purpose:** Business-ready aggregations, metrics, and serving tables for dashboards and applications.
- **Naming:** `gold_<domain>_<metric>` or `fct_<entity>`, `dim_<entity>`
- **Materialization:** `table` (always — gold is queried directly by BI tools)
- **Location:** `models/gold/`
- **Rules:** Optimized for query performance. May include pre-aggregations. Joins silver/bronze only, never raw sources.

## Mapping from staging/intermediate/mart

| Old Layer | New Layer | Notes |
|---|---|---|
| `staging/` | `bronze/` | Direct source reads, minimal transform |
| `intermediate/` | `silver/` | Joins, cleaning, typing |
| `marts/fct_*` | `gold/fct_*` | Fact tables, aggregations |
| `marts/dim_*` | `gold/dim_*` | Dimension tables |

## Migration Workflow

### 1. Audit Existing Structure
```bash
glob models/**/*.sql         # list all models
altimate-dbt info            # confirm project name and adapter
```
Read 3-5 models from each current layer to understand what's there.

### 2. Classify Each Model
For each model, decide: bronze, silver, or gold?
- Reads directly from `{{ source() }}`? → **bronze**
- Joins multiple bronze/staging models, applies cleaning? → **silver**
- Produces metrics, KPIs, reporting aggregates? → **gold**

### 3. Rename and Move Files
```bash
# Example: staging → bronze
# mv models/staging/stg_salesforce__accounts.sql models/bronze/bronze_salesforce__accounts.sql
```
Update all `{{ ref('old_name') }}` references in downstream models.

### 4. Update Materializations
- Bronze: check if views are OK or if size demands incremental
- Silver: set `{{ config(materialized='table') }}` for most models
- Gold: always `{{ config(materialized='table') }}`

### 5. Validate
```bash
altimate-dbt compile              # catch broken refs
altimate-dbt build                # full rebuild to verify
```

## Iron Rules

1. **Bronze never reads from another dbt model** — only from `{{ source() }}`.
2. **Gold never reads from raw sources** — only from silver or bronze via `{{ ref() }}`.
3. **Materialization by layer:** bronze=view/incremental, silver=table/incremental, gold=table.
4. **One direction only:** bronze → silver → gold. Never skip layers for complex logic.
5. **Match naming conventions across all models in each layer** — consistency is non-negotiable.
