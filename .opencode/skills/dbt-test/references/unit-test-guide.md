# dbt Unit Tests

Unit tests validate model logic by mocking inputs and asserting expected outputs. Available in dbt-core 1.8+.

## When to Unit Test

**DO unit test:**
- Complex calculations (revenue attribution, MRR changes, scoring)
- Business logic with edge cases (null handling, date boundaries, status transitions)
- Models with conditional logic (`CASE WHEN`, `IFF`, `COALESCE`)
- Aggregations where correctness is critical

**Do NOT unit test:**
- Simple staging models (just rename/cast)
- Pass-through models with no logic
- Built-in dbt functions

## Basic Structure

Unit tests live in schema.yml (or a dedicated `_unit_tests.yml` file):

```yaml
unit_tests:
  - name: test_net_revenue_calculation
    description: Verify net_revenue = gross - refunds - discounts
    model: fct_daily_revenue
    given:
      - input: ref('stg_orders')
        rows:
          - { order_id: 1, gross_amount: 100.00, refund_amount: 10.00, discount_amount: 5.00 }
          - { order_id: 2, gross_amount: 50.00, refund_amount: 0.00, discount_amount: 0.00 }
    expect:
      rows:
        - { order_id: 1, net_revenue: 85.00 }
        - { order_id: 2, net_revenue: 50.00 }
```

## Mocking Multiple Inputs

```yaml
unit_tests:
  - name: test_customer_lifetime_value
    model: dim_customers
    given:
      - input: ref('stg_customers')
        rows:
          - { customer_id: 1, name: "Alice" }
      - input: ref('stg_orders')
        rows:
          - { order_id: 1, customer_id: 1, amount: 50.00 }
          - { order_id: 2, customer_id: 1, amount: 75.00 }
    expect:
      rows:
        - { customer_id: 1, lifetime_value: 125.00 }
```

## Testing Edge Cases

```yaml
unit_tests:
  - name: test_handles_null_discounts
    model: fct_orders
    given:
      - input: ref('stg_orders')
        rows:
          - { order_id: 1, amount: 100.00, discount: null }
    expect:
      rows:
        - { order_id: 1, net_amount: 100.00 }

  - name: test_handles_zero_quantity
    model: fct_orders
    given:
      - input: ref('stg_orders')
        rows:
          - { order_id: 1, quantity: 0, unit_price: 10.00 }
    expect:
      rows:
        - { order_id: 1, order_total: 0.00 }
```

## Overriding Macros and Vars

```yaml
unit_tests:
  - name: test_with_specific_date
    model: fct_daily_metrics
    overrides:
      vars:
        run_date: "2024-01-15"
      macros:
        - name: current_timestamp
          result: "2024-01-15 00:00:00"
    given:
      - input: ref('stg_events')
        rows:
          - { event_id: 1, event_date: "2024-01-15" }
    expect:
      rows:
        - { event_date: "2024-01-15", event_count: 1 }
```

## Running Unit Tests

```bash
altimate-dbt test --model <name>          # runs all tests including unit tests
altimate-dbt build --model <name>         # build + test
```

## Test-Driven Development Pattern

1. Write the unit test YAML first (expected inputs → outputs)
2. Run it — it should fail (model doesn't exist yet or logic is missing)
3. Write/fix the model SQL
4. Run again — it should pass
5. Add schema tests for data quality

## Official Documentation

- **dbt unit tests**: https://docs.getdbt.com/docs/build/unit-tests
- **Unit test YAML spec**: https://docs.getdbt.com/reference/resource-properties/unit-tests
