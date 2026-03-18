# SQL Tools

## sql_execute

Run SQL queries against your connected warehouse.

```
> sql_execute "SELECT department, COUNT(*) as headcount FROM employees GROUP BY 1 ORDER BY 2 DESC LIMIT 10" --warehouse prod-snowflake

┌────────────┬───────────┐
│ department │ headcount │
├────────────┼───────────┤
│ Engineering│ 342       │
│ Sales      │ 218       │
│ Marketing  │ 156       │
└────────────┴───────────┘
3 rows returned (limit: 100)
```

**Parameters:**
- `query` (required): SQL to execute
- `warehouse` (optional): Connection name from config. Uses default if omitted
- `limit` (optional, default: 100): Max rows returned

---

## sql_analyze

Static analysis that detects 19 SQL anti-patterns before you run anything.

```
> sql_analyze "SELECT * FROM events e JOIN users u ON e.user_id = u.id WHERE LOWER(u.email) LIKE '%@gmail.com'"

Issues found (3):

  ⚠ SELECT_STAR (warning, confidence: high)
    Line 1: Use explicit column list instead of SELECT *
    → Reduces data scanned and improves lineage tracking

  ⚠ FUNCTION_IN_FILTER (warning, confidence: high)
    Line 1: LOWER(u.email) prevents index usage
    → Pre-compute or use ILIKE: u.email ILIKE '%@gmail.com'

  ⚠ LIKE_LEADING_WILDCARD (info, confidence: high)
    Line 1: LIKE '%@gmail.com' cannot use indexes
    → Consider a computed column or reverse index if this is a hot path
```

### All 19 rules

| Rule | Severity | What it catches |
|---|---|---|
| `SELECT_STAR` | warning | `SELECT *` instead of explicit columns |
| `SELECT_STAR_IN_SUBQUERY` | warning | `SELECT *` in subqueries (breaks lineage) |
| `CARTESIAN_PRODUCT` | critical | Missing JOIN condition |
| `IMPLICIT_CARTESIAN` | critical | Cross join without explicit CROSS JOIN |
| `CORRELATED_SUBQUERY` | warning | Subquery referencing outer query (performance) |
| `MISSING_LIMIT` | info | No LIMIT on potentially large result sets |
| `ORDER_BY_WITHOUT_LIMIT` | warning | ORDER BY without LIMIT (sorts entire result) |
| `ORDER_BY_IN_SUBQUERY` | info | Unnecessary ORDER BY in subquery |
| `FUNCTION_IN_FILTER` | warning | Functions on columns in WHERE (non-sargable) |
| `FUNCTION_IN_JOIN` | warning | Functions on columns in JOIN conditions |
| `NON_EQUI_JOIN` | info | Non-equality joins (`<`, `>`, `!=`) |
| `OR_IN_JOIN` | warning | OR in JOIN conditions (cross join risk) |
| `LIKE_LEADING_WILDCARD` | info | `LIKE '%pattern'` prevents index usage |
| `LARGE_IN_LIST` | info | IN clause with many values |
| `NOT_IN_WITH_SUBQUERY` | warning | NOT IN with subquery (NULL handling issues) |
| `UNION_INSTEAD_OF_UNION_ALL` | info | UNION vs UNION ALL (unnecessary dedup) |
| `UNUSED_CTE` | info | CTE defined but never referenced |
| `GROUP_BY_PRIMARY_KEY` | info | GROUP BY on primary key (redundant) |
| `WINDOW_WITHOUT_PARTITION` | warning | Window function without PARTITION BY |

Each rule includes a **confidence score** (high/medium/low) based on AST complexity:
- Wildcards, EXISTS clauses, correlated subqueries, multi-joins with OR, and non-equi joins reduce confidence
- High confidence = definite anti-pattern. Medium/low = review recommended

---

## sql_optimize

Get optimization suggestions with rewritten SQL.

```
> sql_optimize "SELECT * FROM orders o JOIN customers c ON o.customer_id = c.id WHERE YEAR(o.order_date) = 2026"

Suggestions:
  1. Replace SELECT * with explicit columns (saves ~70% scan)
  2. Replace YEAR(o.order_date) = 2026 with:
     o.order_date >= '2026-01-01' AND o.order_date < '2027-01-01'
     (enables partition pruning)

Optimized SQL:
  SELECT o.order_id, o.amount, o.order_date, c.name, c.email
  FROM orders o
  JOIN customers c ON o.customer_id = c.id
  WHERE o.order_date >= '2026-01-01'
    AND o.order_date < '2027-01-01'

Estimated improvement: 70-80% reduction in bytes scanned
```

---

## sql_translate

Translate SQL between warehouse dialects.

```
> sql_translate \
    --source snowflake \
    --target bigquery \
    "SELECT
        DATEADD(day, -30, CURRENT_TIMESTAMP()) AS thirty_days_ago,
        IFF(status = 'active', 1, 0) AS is_active,
        TRY_TO_NUMBER(amount_str) AS amount,
        ARRAY_AGG(tag) WITHIN GROUP (ORDER BY tag) AS tags
     FROM my_table
     QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY updated_at DESC) = 1"

Translated (BigQuery):
  SELECT
      DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY) AS thirty_days_ago,
      IF(status = 'active', 1, 0) AS is_active,
      SAFE_CAST(amount_str AS NUMERIC) AS amount,
      ARRAY_AGG(tag ORDER BY tag) AS tags
  FROM `my_table`
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY updated_at DESC) = 1

Warnings:
  - TRY_TO_NUMBER → SAFE_CAST: returns NULL on failure (same behavior)
  - ARRAY_AGG: WITHIN GROUP syntax removed, ORDER BY moved inline
```

### Supported dialects

`snowflake`, `bigquery`, `databricks`, `redshift`, `postgres`, `mysql`, `sqlserver`, `duckdb`

---

## sql_format

Format SQL for readability.

```
> sql_format "select a.id,b.name,count(*) as cnt from table_a a join table_b b on a.id=b.a_id where a.status='active' group by 1,2 order by 3 desc"

SELECT
  a.id,
  b.name,
  COUNT(*) AS cnt
FROM table_a a
JOIN table_b b
  ON a.id = b.a_id
WHERE a.status = 'active'
GROUP BY 1, 2
ORDER BY 3 DESC
```

---

## sql_fix

Diagnose and auto-fix SQL errors.

```
> sql_fix \
    --error "SQL compilation error: Object 'ANALYTICS.PUBLIC.USERSS' does not exist" \
    "SELECT * FROM analytics.public.userss"

Diagnosis: Typo in table name. 'userss' should be 'users'

Fixed SQL:
  SELECT * FROM analytics.public.users

Additional suggestions:
  - Use schema_search to find the correct table name
  - Replace SELECT * with explicit columns
```

---

## sql_diff

Compare two versions of a SQL query.

```
> sql_diff \
    --original "SELECT id, name FROM users WHERE active = true" \
    --modified "SELECT id, name, email FROM users WHERE active = true AND created_at > '2026-01-01'"

Diff:
  - SELECT id, name FROM users WHERE active = true
  + SELECT id, name, email FROM users WHERE active = true AND created_at > '2026-01-01'

Changes:
  + Added column: email
  + Added filter: created_at > '2026-01-01'
  Additions: 2 | Deletions: 0 | Modifications: 0
```

---

## sql_rewrite

Apply automatic SQL rewrites for optimization.

```
> sql_rewrite "SELECT * FROM orders WHERE YEAR(order_date) = 2026 AND status IN ('shipped', 'delivered') ORDER BY order_date"

Rewrites applied:
  1. Predicate pushdown: YEAR(order_date) = 2026 → order_date >= '2026-01-01' AND order_date < '2027-01-01'
  2. SELECT pruning: SELECT * → explicit columns (when schema context available)

Rewritten SQL:
  SELECT *
  FROM orders
  WHERE order_date >= '2026-01-01'
    AND order_date < '2027-01-01'
    AND status IN ('shipped', 'delivered')
  ORDER BY order_date
```

### Rewrite strategies

1. **Predicate pushdown.** Move filters closer to data source
2. **SELECT pruning.** Replace `*` with explicit columns
3. **Function elimination.** Replace non-sargable functions with range predicates
4. **JOIN reordering.** Smaller tables first
5. **Subquery flattening.** Convert to JOINs where possible
6. **UNION ALL promotion.** Replace UNION with UNION ALL when safe

---

## sql_explain

Generate execution plans.

```
> sql_explain "SELECT * FROM orders JOIN customers ON orders.customer_id = customers.id" --warehouse prod-snowflake

EXPLAIN output:
  GlobalStats:
    partitionsTotal=1024
    partitionsAssigned=1024
    bytesAssigned=4.2GB
  Operations:
    1. TableScan: orders (1024 partitions, 4.2GB)
    2. TableScan: customers (8 partitions, 12MB)
    3. Join: HASH (orders.customer_id = customers.id)
    4. Result: 15 columns
```

---

## sql_autocomplete

Schema-aware SQL completion.

```
> sql_autocomplete --prefix "SELECT o.order_id, o.amo" --table_context ["orders"]

Suggestions:
  1. o.amount (DECIMAL), from orders.amount
  2. o.amount_usd (DECIMAL), from orders.amount_usd
```
