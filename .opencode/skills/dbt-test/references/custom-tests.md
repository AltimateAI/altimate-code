# Custom dbt Tests

## Generic Tests (Reusable)

Generic tests are macros in `tests/generic/` or `macros/` that accept parameters:

```sql
-- tests/generic/test_positive_values.sql
{% test positive_values(model, column_name) %}

select *
from {{ model }}
where {{ column_name }} < 0

{% endtest %}
```

Usage in schema.yml:
```yaml
columns:
  - name: amount
    tests:
      - positive_values
```

## Singular Tests (One-Off)

Singular tests are standalone SQL files in `tests/` that return failing rows:

```sql
-- tests/assert_no_orphan_orders.sql
-- Orders must have a matching customer
select o.order_id
from {{ ref('fct_orders') }} o
left join {{ ref('dim_customers') }} c on o.customer_id = c.customer_id
where c.customer_id is null
```

A passing test returns zero rows.

## When to Use Which

| Type | Use When |
|------|----------|
| Schema tests (built-in) | `unique`, `not_null`, `accepted_values`, `relationships` |
| dbt-utils tests | `expression_is_true`, `unique_combination_of_columns` |
| Generic tests (custom) | Reusable validation logic across multiple models |
| Singular tests | One-off business rules, cross-model assertions |
| Unit tests | Testing calculation logic with mocked inputs |

## Naming Conventions

- Generic tests: `test_<what_it_checks>.sql` in `tests/generic/`
- Singular tests: `assert_<business_rule>.sql` in `tests/`

## Official Documentation

- **Data tests**: https://docs.getdbt.com/docs/build/data-tests
- **Custom generic tests**: https://docs.getdbt.com/docs/build/data-tests#generic-data-tests
