---
name: generate-tests
description: Generate dbt tests for a model by inspecting its schema and SQL, producing schema.yml test definitions.
---

# Generate dbt Tests

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** glob, read, schema_inspect, write, edit

> **When to use this vs other skills:** Use /generate-tests for automated test scaffolding based on column patterns. Use /yaml-config for generating full schema.yml from scratch. Use /dbt-docs for adding descriptions to existing YAML.

Generate comprehensive dbt test definitions for a model. This skill inspects the model's schema, reads its SQL, and produces appropriate tests.

## Workflow

1. **Find the model file** — Use `glob` to locate the model SQL file
2. **Read the model SQL** — Understand the transformations, joins, and column expressions
3. **Inspect the schema** — Use `schema_inspect` to get column names, types, and constraints if a warehouse connection is available. If not, infer columns from the SQL.
4. **Read existing schema.yml** — Use `glob` and `read` to find and load any existing `schema.yml` or `_schema.yml` in the same directory
5. **Generate tests** based on column patterns:

### Test Generation Rules

| Column Pattern | Tests to Generate |
|---|---|
| `*_id` columns | `unique`, `not_null`, `relationships` (if source table is identifiable) |
| `status`, `type`, `category` columns | `accepted_values` (infer values from SQL if possible, otherwise leave as placeholder) |
| Date/timestamp columns | `not_null` |
| Boolean columns | `accepted_values: [true, false]` |
| Columns in PRIMARY KEY | `unique`, `not_null` |
| Columns marked NOT NULL in schema | `not_null` |
| All columns | Consider `not_null` if they appear in JOIN conditions or WHERE filters |

### Output Format

Generate a YAML block that can be merged into the model's `schema.yml`:

```yaml
models:
  - name: model_name
    columns:
      - name: column_name
        tests:
          - unique
          - not_null
          - relationships:
              to: ref('source_model')
              field: id
```

6. **Write or patch the schema.yml** — If a schema.yml exists, merge the new tests into it (don't duplicate existing tests). If none exists, create one in the same directory as the model.

## Usage

The user invokes this skill with a model name or path:
- `/generate-tests models/staging/stg_orders.sql`
- `/generate-tests stg_orders`

Use the tools: `glob`, `read`, `schema_inspect` (if warehouse available), `write` or `edit`.
