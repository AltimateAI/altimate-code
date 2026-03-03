---
name: generate-tests
description: Generate dbt tests for models using built-in tests, dbt_expectations, dbt_utils, and elementary. Use when the user wants to add data tests, improve test coverage, scaffold test definitions, or validate data quality for a dbt model.
---

# Generate dbt Tests

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** dbt_manifest, glob, read, schema_inspect, write, edit

> **When to use this vs other skills:** Use /generate-tests for automated test scaffolding based on column patterns and data quality best practices. Use /yaml-config for generating full schema.yml from scratch. Use /dbt-docs for adding descriptions to existing YAML.

Generate comprehensive dbt test definitions for a model. This skill discovers existing tests, inspects the model's schema and SQL, and produces appropriate tests using built-in generics, `dbt_utils`, `dbt_expectations`, and `elementary`.

## Workflow
1. **Discover existing tests** -- Use `dbt_manifest` to load the project manifest. Extract:
   - All tests already defined for the target model (avoid duplicates)
   - Which test packages are installed (`dbt_utils`, `dbt_expectations`, `elementary`)
   - Upstream/downstream model dependencies
3. **Find the model file** -- Use `glob` to locate the model SQL file and any existing schema YAML (`schema.yml`, `_schema.yml`, `_<model>__models.yml`) in the same directory.
4. **Read the model SQL** -- Understand transformations, joins, filters, GROUP BY, window functions, and column expressions.
5. **Inspect the schema** -- Use `schema_inspect` to get column names, types, nullability, and constraints from the warehouse. If no warehouse connection is available, infer columns from the SQL.
6. **Generate tests** based on column patterns, model layer, and installed packages:

### Built-in Tests (always available)

| Column Pattern | Tests |
|---|---|
| Primary key columns | `unique`, `not_null` |
| `*_id` foreign key columns | `not_null`, `relationships` (if source table identifiable) |
| `status`, `type`, `category` columns | `accepted_values` (infer values from SQL or leave placeholder) |
| Date/timestamp columns | `not_null` |
| Boolean columns | `accepted_values: [true, false]` |
| Columns marked NOT NULL in schema | `not_null` |
| Columns in JOIN or WHERE clauses | Consider `not_null` |

### dbt_utils Tests (if installed)

| Scenario | Test |
|---|---|
| Composite primary key (multiple columns) | `dbt_utils.unique_combination_of_columns` |
| Column should never be empty string | `dbt_utils.not_empty_string` |
| Column should vary across rows | `dbt_utils.not_constant` |
| Column must have at least one non-null value | `dbt_utils.at_least_one` |
| Cross-column validation (e.g., end_date >= start_date) | `dbt_utils.expression_is_true` |
| Timestamp freshness (e.g., updated_at within 24h) | `dbt_utils.recency` |
| Row count comparison with source | `dbt_utils.equal_rowcount` |
| Referential integrity with filter | `dbt_utils.relationships_where` |
| Non-overlapping date ranges | `dbt_utils.mutually_exclusive_ranges` |
| Sequential IDs or dates | `dbt_utils.sequential_values` |

### dbt_expectations Tests (if installed)

| Scenario | Test |
|---|---|
| Numeric column within range | `dbt_expectations.expect_column_values_to_be_between` |
| Row count within expected range | `dbt_expectations.expect_table_row_count_to_be_between` |
| Column matches regex pattern (emails, codes) | `dbt_expectations.expect_column_values_to_match_regex` |
| String length validation | `dbt_expectations.expect_column_value_lengths_to_be_between` |
| Column type enforcement | `dbt_expectations.expect_column_values_to_be_of_type` |
| Expected set of distinct values | `dbt_expectations.expect_column_distinct_values_to_equal_set` |
| Data completeness per time period | `dbt_expectations.expect_row_values_to_have_data_for_every_n_datepart` |
| Aggregate bounds (mean, sum, stdev) | `dbt_expectations.expect_column_mean_to_be_between` |
| Column pair comparison (A > B) | `dbt_expectations.expect_column_pair_values_A_to_be_greater_than_B` |
| Table has recent data | `dbt_expectations.expect_row_values_to_have_recent_data` |

> For the full catalog of 50+ dbt_expectations tests, read `references/test-packages.md`.

### elementary Tests (if installed)

| Scenario | Test |
|---|---|
| Detect row count spikes/drops | `elementary.volume_anomalies` |
| Detect data delivery delays | `elementary.freshness_anomalies` |
| Detect distribution shifts in a dimension | `elementary.dimension_anomalies` |
| Detect changes in column metrics (null rate, avg, etc.) | `elementary.column_anomalies` |

### Test Coverage Strategy by Model Layer

| Layer | Minimum Tests | Recommended Additions |
|---|---|---|
| **Sources** | `not_null` + `unique` on PK, `dbt_utils.recency` on timestamp | `elementary.freshness_anomalies`, `elementary.volume_anomalies` |
| **Staging** | `not_null` + `unique` on PK, `accepted_values` on enums | `dbt_expectations.expect_column_values_to_be_of_type`, `dbt_utils.not_empty_string` |
| **Intermediate** | `unique_combination_of_columns` on composite keys | `dbt_utils.expression_is_true` for cross-column logic |
| **Marts (fact)** | PK tests, `not_null` on measures, `relationships` on FKs | `dbt_expectations.expect_column_values_to_be_between` on metrics, `elementary.volume_anomalies` |
| **Marts (dim)** | PK tests, `accepted_values` on type columns | `elementary.dimension_anomalies`, `dbt_expectations.expect_table_row_count_to_be_between` |

> For detailed strategy guidance, read `references/coverage-strategy.md`.

### Output Format

Generate a YAML block that merges into the model's `schema.yml`. Use the appropriate package prefix:

```yaml
models:
  - name: model_name
    columns:
      - name: order_id
        tests:
          - unique
          - not_null
      - name: status
        tests:
          - accepted_values:
              values: ['pending', 'shipped', 'delivered', 'cancelled']
      - name: amount
        tests:
          - not_null
          - dbt_expectations.expect_column_values_to_be_between:
              min_value: 0
    tests:
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns:
            - order_id
            - line_item_id
```
7. **Write or patch the schema.yml** -- If a schema.yml exists, use `edit` to merge new tests (skip any that already exist). If none exists, use `write` to create one in the same directory as the model.
8. **Suggest package installation** -- If the model would benefit from tests in a package that is not installed, suggest adding it to `packages.yml`:

```yaml
packages:
  - package: dbt-labs/dbt_utils
    version: [">=1.0.0", "<2.0.0"]
  - package: calogica/dbt_expectations
    version: [">=0.10.0", "<0.11.0"]
  - package: elementary-data/elementary
    version: [">=0.16.0", "<0.17.0"]
```

## Usage

The user invokes this skill with a model name or path:
- `/generate-tests models/staging/stg_orders.sql`
- `/generate-tests stg_orders`
- `/generate-tests --all models/staging/stripe/` -- Generate tests for all models in a directory

Use the tools: `dbt_manifest`, `glob`, `read`, `schema_inspect`, `write`, `edit`.
