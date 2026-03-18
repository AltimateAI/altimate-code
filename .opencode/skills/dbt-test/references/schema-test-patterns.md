# Schema Test Patterns

## Test Generation Rules

Apply tests based on column name patterns:

| Column Pattern | Tests |
|---|---|
| `*_id` (primary key) | `unique`, `not_null` |
| `*_id` (foreign key) | `not_null`, `relationships: {to: ref('parent'), field: id}` |
| `status`, `type`, `category` | `accepted_values` (discover values with `altimate-dbt column-values`) |
| `*_at`, `*_date`, `*_timestamp` | `not_null` (if event timestamp that should always exist) |
| `is_*`, `has_*` (booleans) | `accepted_values: [true, false]` |
| Columns in JOIN conditions | `not_null` (nulls cause dropped rows in INNER JOIN) |

## Test Priority Framework

Not every column needs every test. Prioritize:

### Tier 1: Always Test (Primary Keys)
```yaml
- name: order_id
  tests:
    - unique
    - not_null
```

### Tier 2: Test Foreign Keys
```yaml
- name: customer_id
  tests:
    - not_null
    - relationships:
        to: ref('dim_customers')
        field: customer_id
```

### Tier 3: Test Business-Critical Columns
```yaml
- name: order_status
  tests:
    - not_null
    - accepted_values:
        values: ['pending', 'shipped', 'delivered', 'cancelled']
```

### Tier 4: Test Derived Columns (When Logic is Complex)
```yaml
- name: net_revenue
  tests:
    - not_null
    - dbt_utils.expression_is_true:
        expression: ">= 0"
```

## Discovering Values for accepted_values

Before adding `accepted_values`, discover what actually exists:

```bash
altimate-dbt column-values --model <name> --column status
```

This prevents false test failures from values you didn't know about.

## Cost-Conscious Testing

For large tables, add `where` clauses to expensive tests:

```yaml
- name: order_id
  tests:
    - unique:
        config:
          where: "order_date >= current_date - interval '30 days'"
```

## dbt-utils Test Extensions

Common additional tests from `dbt-utils`:

```yaml
# Ensure expression evaluates to true for all rows
- dbt_utils.expression_is_true:
    expression: "amount >= 0"

# Ensure no duplicate combinations
- dbt_utils.unique_combination_of_columns:
    combination_of_columns:
      - date_day
      - customer_id

# Ensure referential integrity across multiple columns
- dbt_utils.relationships_where:
    to: ref('dim_products')
    field: product_id
    from_condition: "product_id is not null"
```

## Official Documentation

- **dbt tests**: https://docs.getdbt.com/docs/build/data-tests
- **dbt-utils tests**: https://github.com/dbt-labs/dbt-utils#generic-tests
