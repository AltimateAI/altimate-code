# Testing Incremental dbt Models

Incremental models have two code paths controlled by `{% if is_incremental() %}`. Both paths must be tested.

## The Two Paths

```sql
SELECT * FROM {{ ref('stg_orders') }}

{% if is_incremental() %}
  -- Incremental path: only process new rows
  WHERE updated_at > (SELECT MAX(updated_at) FROM {{ this }})
{% endif %}
```

## Test 1: Full Refresh

```yaml
unit_tests:
  - name: test_fct_orders_full_refresh
    description: "Full refresh processes all rows"
    model: fct_orders
    # No overrides needed — is_incremental defaults to false
    given:
      - input: ref('stg_orders')
        rows:
          - { order_id: 1, amount: 100, updated_at: "2024-01-10" }
          - { order_id: 2, amount: 200, updated_at: "2024-01-15" }
    expect:
      rows:
        - { order_id: 1, amount: 100, updated_at: "2024-01-10" }
        - { order_id: 2, amount: 200, updated_at: "2024-01-15" }
```

## Test 2: Incremental — New Rows Only

```yaml
unit_tests:
  - name: test_fct_orders_incremental_new_only
    description: "Incremental run only processes rows newer than existing max"
    model: fct_orders
    overrides:
      macros:
        is_incremental: true
    given:
      - input: this   # mock the existing target table
        rows:
          - { order_id: 1, amount: 100, updated_at: "2024-01-10" }
      - input: ref('stg_orders')
        rows:
          - { order_id: 1, amount: 100, updated_at: "2024-01-10" }  # old
          - { order_id: 2, amount: 200, updated_at: "2024-01-15" }  # new
    expect:
      rows:
        - { order_id: 2, amount: 200, updated_at: "2024-01-15" }
```

## Test 3: Incremental — Updated Rows

If your model uses `unique_key` for merge/upsert:

```yaml
unit_tests:
  - name: test_fct_orders_incremental_update
    description: "Updated rows are captured in incremental run"
    model: fct_orders
    overrides:
      macros:
        is_incremental: true
    given:
      - input: this
        rows:
          - { order_id: 1, amount: 100, updated_at: "2024-01-10" }
      - input: ref('stg_orders')
        rows:
          - { order_id: 1, amount: 150, updated_at: "2024-01-15" }  # updated
    expect:
      rows:
        - { order_id: 1, amount: 150, updated_at: "2024-01-15" }
```

## Test 4: Incremental — Empty Source

```yaml
unit_tests:
  - name: test_fct_orders_incremental_no_new_data
    description: "No new rows when source has nothing newer"
    model: fct_orders
    overrides:
      macros:
        is_incremental: true
    given:
      - input: this
        rows:
          - { order_id: 1, amount: 100, updated_at: "2024-01-15" }
      - input: ref('stg_orders')
        rows:
          - { order_id: 1, amount: 100, updated_at: "2024-01-10" }  # older
    expect:
      rows: []
```

## Key Points

1. **Always mock `this`** when testing incremental path — it represents the existing target table
2. **Set `is_incremental: true`** in overrides.macros to activate the incremental code path
3. **Test both paths** — full refresh AND incremental
4. **Include overlap rows** — rows that exist in both `this` and source to verify filtering
5. **Test the merge key** — if `unique_key` is set, verify upsert behavior
