# dbt Unit Test YAML Specification

Available in dbt-core 1.8+ (released mid-2024).

## Top-Level Structure

Unit tests are defined under the `unit_tests:` key in any YAML file within your dbt project (typically `schema.yml` or `_unit_tests.yml`).

```yaml
unit_tests:
  - name: <test_name>           # required, snake_case
    description: <string>        # optional but recommended
    model: <model_name>          # required, the model being tested
    given: <list of inputs>      # required, mock input data
    expect: <expected output>    # required, expected output rows
    overrides: <overrides>       # optional, macro/var overrides
    config: <config>             # optional, test configuration
    tags: <list>                 # optional, for filtering
```

## Input Formats

### Dict Format (default, preferred)

```yaml
given:
  - input: ref('stg_orders')
    rows:
      - { order_id: 1, amount: 100.00, status: "completed" }
      - { order_id: 2, amount: null, status: "pending" }
```

**Rules:**
- Only include columns that the model actually uses
- Column names must match the upstream model exactly
- Use `null` for NULL values (not empty string)
- Dates as strings: `"2024-01-15"`
- Timestamps as strings: `"2024-01-15 10:30:00"`
- Booleans: `true` / `false`
- Numbers: no quotes (`100.00`, not `"100.00"`)

### SQL Format (required for ephemeral models)

```yaml
given:
  - input: ref('ephemeral_model')
    format: sql
    rows: |
      SELECT 1 AS id, 'test' AS name
      UNION ALL
      SELECT 2 AS id, 'other' AS name
```

**When to use SQL format:**
- Upstream model is materialized as `ephemeral`
- Complex data types that dict can't represent
- Need to use SQL functions in mock data

### Empty Input

```yaml
given:
  - input: ref('stg_orders')
    rows: []
```

Tests behavior with no input rows (empty table).

## Expected Output

```yaml
expect:
  rows:
    - { order_id: 1, net_revenue: 85.00 }
    - { order_id: 2, net_revenue: 50.00 }
```

**Rules:**
- Only include columns you want to assert on (subset is OK)
- Row order matters — rows are compared positionally
- Use exact values for numeric assertions
- `null` to assert NULL output

## Overrides

### Macro Overrides

```yaml
overrides:
  macros:
    is_incremental: true          # boolean
    current_timestamp: "2024-01-15 00:00:00"  # string
```

Common macros to override:
- `is_incremental` — test incremental vs full-refresh path
- `current_timestamp` / `current_date` — deterministic date testing

### Variable Overrides

```yaml
overrides:
  vars:
    run_date: "2024-01-15"
    lookback_days: 30
```

## Input Sources

### ref() — Model references

```yaml
- input: ref('model_name')
```

### source() — Source table references

```yaml
- input: source('source_name', 'table_name')
```

### this — Self-reference for incremental models

```yaml
- input: this
  rows:
    - { order_id: 1, updated_at: "2024-01-14" }
```

Used with `overrides.macros.is_incremental: true` to mock the existing table state.

## Configuration

Tags can be set at the top level (sibling of `config`) or nested under `config`:

```yaml
unit_tests:
  - name: test_example
    model: fct_orders
    tags: ["unit-test", "revenue"]
    # ... rest of test
```

Or via config:

```yaml
unit_tests:
  - name: test_example
    model: fct_orders
    config:
      tags: ["unit-test", "revenue"]
```

## Naming Conventions

- Test names: `test_<model>_<what_it_tests>`
- Examples:
  - `test_fct_orders_happy_path`
  - `test_fct_orders_null_discount`
  - `test_fct_orders_zero_quantity`
  - `test_fct_orders_incremental_new_rows`

## Running Unit Tests

```bash
dbt test --select test_type:unit                    # all unit tests
dbt test --select test_type:unit,model_name:fct_orders  # unit tests for one model
dbt build --select +fct_orders                      # build + all tests
```

## Official Documentation

- https://docs.getdbt.com/docs/build/unit-tests
- https://docs.getdbt.com/reference/resource-properties/unit-tests
