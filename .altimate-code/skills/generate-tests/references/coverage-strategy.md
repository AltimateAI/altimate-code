# Test Coverage Strategy

How to decide which tests to generate for a model based on its layer, purpose, and data characteristics.

---

## The Test Pyramid for dbt

**Every model must have:**
- `unique` + `not_null` on its primary key (or `dbt_utils.unique_combination_of_columns` for composite keys)

**Most models should have:**
- `not_null` on business-critical columns
- `accepted_values` on enum/status columns
- `relationships` on foreign keys

**Many models benefit from:**
- Volume/freshness monitoring (elementary)
- Range validation on numeric measures (dbt_expectations)
- Cross-column integrity checks (dbt_utils)

---

## Coverage by Model Layer

### Sources

Sources are the entry point. Catch problems here before they propagate.

| Priority | Test | Why |
|---|---|---|
| Required | `not_null` + `unique` on PK | Ensure raw data identity |
| Required | `not_null` on critical columns | Catch upstream nulls early |
| High | `dbt_utils.recency` on timestamp column | Detect stale source data |
| High | `elementary.volume_anomalies` | Detect missing or duplicate loads |
| High | `elementary.freshness_anomalies` | Alert when source stops updating |
| Medium | `dbt_expectations.expect_column_values_to_be_of_type` | Catch schema drift |
| Medium | `dbt_expectations.expect_table_columns_to_contain_set` | Catch dropped columns |

### Staging (stg_)

Staging models rename and cast. Tests verify the transformation was clean.

| Priority | Test | Why |
|---|---|---|
| Required | `not_null` + `unique` on PK | PK carried from source |
| High | `accepted_values` on status/type columns | Validate enum mapping |
| High | `dbt_utils.not_empty_string` on text columns | Catch empty string casting |
| Medium | `dbt_expectations.expect_column_values_to_match_regex` | Validate formats (email, codes) |
| Medium | `dbt_expectations.expect_column_value_lengths_to_be_between` | Validate code lengths |

### Intermediate (int_)

Intermediate models join and aggregate. Tests verify join correctness.

| Priority | Test | Why |
|---|---|---|
| Required | `unique` (or `unique_combination_of_columns`) on grain | Verify join did not fan out |
| High | `dbt_utils.expression_is_true` | Cross-column logic (end >= start) |
| High | `dbt_utils.equal_rowcount` against source | Detect fan-out or dropped rows |
| Medium | `not_null` on columns used downstream | Prevent null propagation |

### Marts -- Fact Tables (fct_)

Fact tables are the most queried. Tests protect consumers.

| Priority | Test | Why |
|---|---|---|
| Required | `not_null` + `unique` on PK | Identity guarantee for BI tools |
| Required | `not_null` on measures (revenue, count, etc.) | Nulls break aggregations |
| Required | `relationships` on FK columns | Ensure dimension lookups work |
| High | `dbt_expectations.expect_column_values_to_be_between` on measures | Catch negative revenue, impossible counts |
| High | `elementary.volume_anomalies` | Detect load failures |
| Medium | `dbt_expectations.expect_row_values_to_have_data_for_every_n_datepart` | No gaps in time series |
| Medium | `dbt_expectations.expect_table_row_count_to_be_between` | Sanity check on table size |

### Marts -- Dimension Tables (dim_)

Dimension tables should be stable and well-bounded.

| Priority | Test | Why |
|---|---|---|
| Required | `not_null` + `unique` on PK | Must be a valid join target |
| High | `accepted_values` on type/category columns | Validate dimension members |
| High | `dbt_expectations.expect_table_row_count_to_be_between` | Detect unexpected growth/shrinkage |
| Medium | `elementary.dimension_anomalies` on key categorical columns | Detect distribution shifts |
| Medium | `dbt_utils.not_constant` on descriptive columns | Ensure variety |

---

## When to Suggest Package Installation

| Condition | Recommendation |
|---|---|
| Model has composite PK and `dbt_utils` not installed | Suggest `dbt_utils` for `unique_combination_of_columns` |
| Model has numeric measures and `dbt_expectations` not installed | Suggest `dbt_expectations` for range validation |
| Model is a source or fact and `elementary` not installed | Suggest `elementary` for anomaly detection |
| All needed tests are built-in | No package suggestion needed |

---

## Anti-Patterns to Avoid

- **Testing every column with `not_null`** -- Only test columns where nulls are genuinely problematic
- **Hardcoding `accepted_values` that change frequently** -- Use `dbt_expectations.expect_column_distinct_values_to_contain_set` instead to allow new values
- **Duplicating tests across model and source** -- Test at the earliest point; downstream gets it for free
- **Ignoring test severity** -- Use `config: {severity: warn}` for soft checks vs `error` for hard failures
- **No volume monitoring** -- A passing test suite means nothing if the table is empty
