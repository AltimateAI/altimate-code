# Edge Case Patterns by SQL Construct

## CASE/WHEN

**What to test:** Every branch, including ELSE/default.

```yaml
# Test the TRUE branch
- { status: "completed", amount: 100 }
# Expected: { category: "done" }

# Test the FALSE/ELSE branch
- { status: "unknown", amount: 100 }
# Expected: { category: "other" }

# Test NULL input
- { status: null, amount: 100 }
# Expected: depends on whether NULL matches any WHEN
```

**Common bugs:**
- NULL doesn't match `WHEN status = 'active'` — it falls to ELSE
- Multiple WHEN clauses: first match wins, test ordering

## COALESCE / NVL / IFNULL

**What to test:** NULL in each position.

```yaml
# COALESCE(a, b, c) — test a=NULL
- { a: null, b: "fallback", c: "default" }
# Expected: { result: "fallback" }

# COALESCE(a, b, c) — test a=NULL, b=NULL
- { a: null, b: null, c: "default" }
# Expected: { result: "default" }

# All non-null
- { a: "primary", b: "fallback", c: "default" }
# Expected: { result: "primary" }
```

## JOINs

**What to test:** Matching rows, non-matching rows, NULL join keys.

```yaml
# LEFT JOIN — matching row
orders: [{ order_id: 1, customer_id: 1 }]
customers: [{ customer_id: 1, name: "Alice" }]
# Expected: { order_id: 1, name: "Alice" }

# LEFT JOIN — no match (customer missing)
orders: [{ order_id: 2, customer_id: 99 }]
customers: [{ customer_id: 1, name: "Alice" }]
# Expected: { order_id: 2, name: null }

# JOIN with NULL key
orders: [{ order_id: 3, customer_id: null }]
customers: [{ customer_id: 1, name: "Alice" }]
# Expected: depends on join type
```

**Common bugs:**
- INNER JOIN drops rows when key is NULL or missing
- Fan-out: duplicate keys in right table multiply left rows

## Window Functions

**What to test:** Ordering, partitioning, boundary rows.

```yaml
# ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date)
- { customer_id: 1, order_date: "2024-01-01", amount: 50 }
- { customer_id: 1, order_date: "2024-01-15", amount: 75 }
- { customer_id: 2, order_date: "2024-01-10", amount: 30 }
# Expected:
# { customer_id: 1, order_date: "2024-01-01", row_num: 1 }
# { customer_id: 1, order_date: "2024-01-15", row_num: 2 }
# { customer_id: 2, order_date: "2024-01-10", row_num: 1 }
```

**What to test for LAG/LEAD:**
- First/last row in partition (LAG returns NULL for first row)
- Single-row partition

## Aggregations (GROUP BY)

**What to test:** Multiple groups, single group, empty group.

```yaml
# SUM(amount) GROUP BY customer_id
- { customer_id: 1, amount: 50 }
- { customer_id: 1, amount: 25 }
- { customer_id: 2, amount: 100 }
# Expected:
# { customer_id: 1, total_amount: 75 }
# { customer_id: 2, total_amount: 100 }

# Single row group
- { customer_id: 3, amount: 10 }
# Expected: { customer_id: 3, total_amount: 10 }

# NULL in aggregated column
- { customer_id: 4, amount: null }
# Expected: { customer_id: 4, total_amount: null }  # SUM of NULLs = NULL
```

## Division

**What to test:** Normal, divide by zero, NULL.

```yaml
# amount / quantity
- { amount: 100, quantity: 4 }
# Expected: { unit_price: 25 }

# Divide by zero
- { amount: 100, quantity: 0 }
# Expected: depends — NULL, error, or COALESCE fallback?

# NULL divisor
- { amount: 100, quantity: null }
# Expected: { unit_price: null }
```

## Date/Timestamp Logic

**What to test:** Boundaries, NULL dates, timezone edge cases.

```yaml
# DATEDIFF or date filtering
- { event_date: "2024-01-01" }  # start of year
- { event_date: "2024-12-31" }  # end of year
- { event_date: "2024-02-29" }  # leap year
- { event_date: null }           # NULL date
```

## Type Coercion

**What to test:** Implicit casts that may fail.

```yaml
# String that looks like a number
- { amount_str: "100.50" }  # CAST to DECIMAL
- { amount_str: "not_a_number" }  # should this fail?
- { amount_str: "" }  # empty string cast
- { amount_str: null }  # NULL cast
```

## Incremental Models

**What to test:** Full refresh vs incremental path.

```yaml
# Test 1: Full refresh (is_incremental = false, default)
# All rows processed

# Test 2: Incremental (is_incremental = true)
unit_tests:
  - name: test_incremental_new_rows_only
    model: fct_orders
    overrides:
      macros:
        is_incremental: true
    given:
      - input: this  # existing table state
        rows:
          - { order_id: 1, updated_at: "2024-01-14" }
      - input: ref('stg_orders')
        rows:
          - { order_id: 1, updated_at: "2024-01-14" }  # old, should be skipped
          - { order_id: 2, updated_at: "2024-01-15" }  # new, should be processed
    expect:
      rows:
        - { order_id: 2, updated_at: "2024-01-15" }
```

## Empty Inputs

**What to test:** Model behavior when upstream has zero rows.

```yaml
given:
  - input: ref('stg_orders')
    rows: []
expect:
  rows: []  # or specific default behavior
```
