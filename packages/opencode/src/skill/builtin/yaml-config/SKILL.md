---
name: yaml-config
description: Generate or update sources.yml and schema.yml from warehouse schema. Use when setting up source definitions, adding column metadata, or refreshing YAML config from actual table structure.
---

# YAML Config Generation

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** bash (runs `altimate-dbt` commands), read, write, edit, schema_inspect, dbt_profiles

## When to Use This Skill

**Use when the user wants to:**
- Generate a `sources.yml` block for a new data source
- Scaffold a `schema.yml` with all columns from an existing model
- Refresh YAML config after a source table schema change
- Add metadata (descriptions, tests, tags) to existing YAML files

**Do NOT use for:**
- Writing model SQL → use `dbt-develop` or `model-scaffold`
- Adding tests to an existing schema.yml → use `generate-tests`
- Writing documentation descriptions → use `dbt-docs`

## Core Workflow

### 1. Discover the Source Schema

```bash
dbt_profiles                                               # find available connections
altimate-dbt columns-source --source <src> --table <tbl>  # get source table columns
altimate-dbt columns --model <name>                        # get model output columns
schema_inspect(table: "<schema>.<table>")                  # direct warehouse inspection
```

### 2. Generate sources.yml

Create or update `models/<layer>/sources.yml`:

```yaml
version: 2

sources:
  - name: <source_name>
    description: "<source system description>"
    database: <database>
    schema: <schema>
    tables:
      - name: <table_name>
        description: "<table description>"
        columns:
          - name: id
            description: "Primary key"
            tests:
              - not_null
              - unique
          - name: created_at
            description: "Record creation timestamp"
            tests:
              - not_null
```

### 3. Generate schema.yml for Models

Create or update `schema.yml` in the model directory:

```yaml
version: 2

models:
  - name: <model_name>
    description: "<model description>"
    config:
      tags: ['<layer>']
    columns:
      - name: <pk>
        description: "Primary key — unique per <entity>"
        tests:
          - not_null
          - unique
      - name: <fk>
        description: "Foreign key to <parent>"
        tests:
          - not_null
          - relationships:
              to: ref('<parent_model>')
              field: id
```

### 4. Map All Columns

For each column from the discovered schema, add:
- `name`: exact column name from warehouse
- `description`: infer from column name and context
- `tests`: not_null for required fields, unique for keys, accepted_values for categoricals

### 5. Validate

```bash
altimate-dbt compile                   # validate YAML parses correctly
altimate-dbt build --model <name>      # confirm tests pass
```

## Iron Rules

1. **Never invent column descriptions** — infer from names or leave blank rather than guess incorrectly.
2. **Match the `version: 2` header** — required for dbt to parse the file.
3. **Source database/schema must match actual warehouse** — verify with `dbt_profiles` and `schema_inspect`.
4. **Always run `altimate-dbt compile`** after editing YAML — YAML syntax errors are silent until compile.
