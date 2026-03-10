# Common Analysis Patterns

SQL templates for frequent analysis types.

> **Note:** Examples use Snowflake syntax. For other databases:
> - `DATEADD(day, -7, x)` → PostgreSQL: `x - INTERVAL '7 days'` → BigQuery: `DATE_SUB(x, INTERVAL 7 DAY)`
> - `DATE_TRUNC('week', x)` → BigQuery: `DATE_TRUNC(x, WEEK)`

## Trend Over Time
```sql
SELECT
    DATE_TRUNC('week', event_date) as week,
    COUNT(*) as events,
    COUNT(DISTINCT user_id) as unique_users
FROM events
WHERE event_date >= DATEADD(month, -3, CURRENT_DATE)
GROUP BY 1
ORDER BY 1
```

## Comparison (Period over Period)
```sql
SELECT
    CASE
        WHEN date_col >= DATEADD(day, -7, CURRENT_DATE) THEN 'This Week'
        ELSE 'Last Week'
    END as period,
    SUM(amount) as total,
    COUNT(DISTINCT customer_id) as customers
FROM orders
WHERE date_col >= DATEADD(day, -14, CURRENT_DATE)
GROUP BY 1
```

## Top N Analysis
```sql
SELECT
    customer_name,
    SUM(revenue) as total_revenue,
    COUNT(*) as order_count
FROM orders
JOIN customers USING (customer_id)
WHERE order_date >= '2024-01-01'
GROUP BY customer_name
ORDER BY total_revenue DESC
LIMIT 10
```

## Distribution / Histogram
```sql
SELECT
    FLOOR(amount / 100) * 100 as bucket,
    COUNT(*) as frequency
FROM orders
GROUP BY 1
ORDER BY 1
```

## Cohort Analysis
```sql
WITH first_purchase AS (
    SELECT
        customer_id,
        DATE_TRUNC('month', MIN(order_date)) as cohort_month
    FROM orders
    GROUP BY customer_id
)
SELECT
    fp.cohort_month,
    DATE_TRUNC('month', o.order_date) as activity_month,
    COUNT(DISTINCT o.customer_id) as active_customers
FROM orders o
JOIN first_purchase fp USING (customer_id)
GROUP BY 1, 2
ORDER BY 1, 2
```
