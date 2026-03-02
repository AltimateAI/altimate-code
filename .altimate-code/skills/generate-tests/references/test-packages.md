# dbt Test Package Catalog

Complete reference for tests available in each package. Use this when you need the full test name, parameters, or YAML syntax for a specific test.

---

## Built-in Generic Tests (dbt-core)

Four tests available in every dbt project with no packages required.

| Test | Purpose | YAML Example |
|---|---|---|
| `unique` | Column has no duplicate values | `- unique` |
| `not_null` | Column has no NULL values | `- not_null` |
| `accepted_values` | Column only contains listed values | `- accepted_values: {values: ['a','b']}` |
| `relationships` | Every value exists in another model's column | `- relationships: {to: ref('other'), field: id}` |

---

## dbt_utils (dbt-labs/dbt_utils)

16 generic tests for common validation patterns.

### Uniqueness and Integrity

| Test | Purpose | Key Parameters |
|---|---|---|
| `unique_combination_of_columns` | Composite key uniqueness | `combination_of_columns: [col_a, col_b]` |
| `relationships_where` | Referential integrity with filter | `to`, `field`, `from_condition`, `to_condition` |
| `cardinality_equality` | Same distinct value count across models | `field`, `to`, `to_field` |

### Value Assertions

| Test | Purpose | Key Parameters |
|---|---|---|
| `at_least_one` | Column has at least one non-null value | -- |
| `not_constant` | Column values are not all the same | -- |
| `not_empty_string` | No empty strings | -- |
| `not_accepted_values` | Column does NOT contain listed values | `values: [...]` |
| `expression_is_true` | Arbitrary SQL expression is true for all rows | `expression: "end_date >= start_date"` |

### Comparison and Shape

| Test | Purpose | Key Parameters |
|---|---|---|
| `equal_rowcount` | Two models have the same row count | `compare_model: ref('other')` |
| `fewer_rows_than` | Model has fewer rows than another | `compare_model: ref('other')` |
| `equality` | Two relations are identical | `compare_model`, `compare_columns` |

### Temporal and Sequential

| Test | Purpose | Key Parameters |
|---|---|---|
| `recency` | Column has data within N time units | `datepart: 'day'`, `field`, `interval: 1` |
| `sequential_values` | Values increase sequentially | `interval: 1` |
| `mutually_exclusive_ranges` | Date/number ranges do not overlap | `lower_bound_column`, `upper_bound_column` |

### Null Proportion

| Test | Purpose | Key Parameters |
|---|---|---|
| `not_null_proportion` | Non-null ratio within expected bounds | `at_least: 0.95` |

### YAML Example

```yaml
models:
  - name: fct_orders
    tests:
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns: [order_id, line_item_id]
      - dbt_utils.equal_rowcount:
          compare_model: ref('stg_orders')
    columns:
      - name: updated_at
        tests:
          - dbt_utils.recency:
              datepart: day
              field: updated_at
              interval: 1
      - name: amount
        tests:
          - dbt_utils.expression_is_true:
              expression: ">= 0"
```

---

## dbt_expectations (calogica/dbt_expectations)

50+ tests modeled after the Great Expectations Python library.

### Table Shape

| Test | Purpose |
|---|---|
| `expect_table_row_count_to_equal` | Exact row count |
| `expect_table_row_count_to_be_between` | Row count within min/max |
| `expect_table_row_count_to_equal_other_table` | Row count matches another table |
| `expect_table_row_count_to_equal_other_table_times_factor` | Row count equals other table x factor |
| `expect_table_column_count_to_equal` | Exact number of columns |
| `expect_table_column_count_to_be_between` | Column count within range |
| `expect_table_column_count_to_equal_other_table` | Same column count as another table |
| `expect_table_columns_to_match_set` | Table has exactly these columns |
| `expect_table_columns_to_contain_set` | Table contains at least these columns |
| `expect_table_columns_to_not_contain_set` | Table does not contain these columns |
| `expect_table_columns_to_match_ordered_list` | Columns in exact order |
| `expect_column_to_exist` | Specific column exists |
| `expect_table_aggregation_to_equal_other_table` | Aggregate comparison across tables |

### Freshness

| Test | Purpose |
|---|---|
| `expect_row_values_to_have_recent_data` | Table has data within N time units |
| `expect_grouped_row_values_to_have_recent_data` | Each group has recent data |

### Missing Values, Uniqueness, and Types

| Test | Purpose |
|---|---|
| `expect_column_values_to_not_be_null` | No NULLs |
| `expect_column_values_to_be_null` | All NULLs (for expected-empty columns) |
| `expect_column_values_to_be_unique` | No duplicates |
| `expect_column_values_to_be_of_type` | Column matches specific type |
| `expect_column_values_to_be_in_type_list` | Column is one of listed types |
| `expect_column_values_to_have_consistent_casing` | No mixed-case values |

### Sets and Ranges

| Test | Purpose |
|---|---|
| `expect_column_values_to_be_in_set` | Values in allowed set |
| `expect_column_values_to_not_be_in_set` | Values not in disallowed set |
| `expect_column_values_to_be_between` | Values within numeric/date range |
| `expect_column_values_to_be_increasing` | Values monotonically increasing |
| `expect_column_values_to_be_decreasing` | Values monotonically decreasing |

### String Matching

| Test | Purpose |
|---|---|
| `expect_column_values_to_match_regex` | Values match regex pattern |
| `expect_column_values_to_not_match_regex` | Values do not match regex |
| `expect_column_values_to_match_regex_list` | Values match one of listed regexes |
| `expect_column_values_to_not_match_regex_list` | Values do not match any listed regex |
| `expect_column_values_to_match_like_pattern` | Values match SQL LIKE pattern |
| `expect_column_values_to_not_match_like_pattern` | Values do not match LIKE |
| `expect_column_values_to_match_like_pattern_list` | Values match one of LIKE patterns |
| `expect_column_values_to_not_match_like_pattern_list` | Values do not match any LIKE |
| `expect_column_value_lengths_to_be_between` | String length within range |
| `expect_column_value_lengths_to_equal` | String length equals N |

### Aggregate Functions

| Test | Purpose |
|---|---|
| `expect_column_mean_to_be_between` | Average within range |
| `expect_column_median_to_be_between` | Median within range |
| `expect_column_stdev_to_be_between` | Standard deviation within range |
| `expect_column_sum_to_be_between` | Sum within range |
| `expect_column_min_to_be_between` | Minimum value within range |
| `expect_column_max_to_be_between` | Maximum value within range |
| `expect_column_quantile_values_to_be_between` | Quantile values within range |
| `expect_column_unique_value_count_to_be_between` | Distinct count within range |
| `expect_column_proportion_of_unique_values_to_be_between` | Uniqueness ratio within range |
| `expect_column_most_common_value_to_be_in_set` | Mode is one of expected values |
| `expect_column_distinct_count_to_equal` | Exact distinct count |
| `expect_column_distinct_count_to_be_greater_than` | Distinct count above threshold |
| `expect_column_distinct_count_to_be_less_than` | Distinct count below threshold |
| `expect_column_distinct_count_to_equal_other_table` | Same distinct count as another table |
| `expect_column_distinct_values_to_equal_set` | Distinct values are exactly this set |
| `expect_column_distinct_values_to_contain_set` | Distinct values contain this set |
| `expect_column_distinct_values_to_be_in_set` | All distinct values in this set |

### Multi-Column

| Test | Purpose |
|---|---|
| `expect_column_pair_values_A_to_be_greater_than_B` | Column A > Column B |
| `expect_column_pair_values_to_be_equal` | Two columns are equal |
| `expect_column_pair_values_to_be_in_set` | Column pair combinations in set |
| `expect_compound_columns_to_be_unique` | Compound uniqueness |
| `expect_multicolumn_sum_to_equal` | Sum of columns equals value |
| `expect_select_column_values_to_be_unique_within_record` | Selected columns unique per row |

### Distributional

| Test | Purpose |
|---|---|
| `expect_column_values_to_be_within_n_stdevs` | Values within N standard deviations |
| `expect_column_values_to_be_within_n_moving_stdevs` | Values within N moving stdevs |
| `expect_row_values_to_have_data_for_every_n_datepart` | No gaps in time series |

### YAML Example

```yaml
models:
  - name: fct_revenue
    tests:
      - dbt_expectations.expect_table_row_count_to_be_between:
          min_value: 1000
          max_value: 1000000
      - dbt_expectations.expect_row_values_to_have_data_for_every_n_datepart:
          date_col: date_day
          date_part: day
          test_start_date: "cast('2024-01-01' as date)"
    columns:
      - name: revenue
        tests:
          - dbt_expectations.expect_column_values_to_be_between:
              min_value: 0
          - dbt_expectations.expect_column_mean_to_be_between:
              min_value: 10
              max_value: 10000
      - name: email
        tests:
          - dbt_expectations.expect_column_values_to_match_regex:
              regex: "^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\\.[a-zA-Z0-9-.]+$"
      - name: currency_code
        tests:
          - dbt_expectations.expect_column_value_lengths_to_equal:
              value: 3
```

---

## elementary (elementary-data/elementary)

6 anomaly detection tests that compare current data against historical baselines. No hardcoded thresholds required -- Elementary learns normal patterns automatically.

| Test | Purpose | Key Parameters |
|---|---|---|
| `volume_anomalies` | Row count spikes or drops | `timestamp_column`, `time_bucket` |
| `freshness_anomalies` | Data delivery delays | `timestamp_column`, `time_bucket` |
| `event_freshness_anomalies` | Gap between event time and load time | `timestamp_column`, `event_timestamp_column` |
| `dimension_anomalies` | Distribution shift in a categorical column | `timestamp_column`, `dimensions` |
| `column_anomalies` | Changes in column metrics (null rate, avg, min, max, etc.) | `timestamp_column`, `column_anomalies` |
| `all_columns_anomalies` | Column anomalies across all columns | `timestamp_column`, `exclude_columns` |

### Common Parameters

All elementary anomaly tests accept:
- `timestamp_column` -- The column used to bucket data over time
- `time_bucket` -- Bucket size (default: `{period: 'day', count: 1}`)
- `training_period` -- How far back to look for baseline (default: `{period: 'day', count: 14}`)
- `detection_period` -- How recent to check for anomalies (default: `{period: 'day', count: 2}`)
- `sensitivity` -- Anomaly threshold (default: 3 standard deviations)
- `where_expression` -- Optional SQL filter

### YAML Example

```yaml
models:
  - name: fct_orders
    tests:
      - elementary.volume_anomalies:
          timestamp_column: created_at
          time_bucket:
            period: day
            count: 1
      - elementary.freshness_anomalies:
          timestamp_column: created_at
    columns:
      - name: status
        tests:
          - elementary.dimension_anomalies:
              timestamp_column: created_at
              dimensions:
                - status
      - name: amount
        tests:
          - elementary.column_anomalies:
              timestamp_column: created_at
              column_anomalies:
                - zero_count
                - average
                - standard_deviation
```
