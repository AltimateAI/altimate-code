# PostgreSQL Cost Queries

Use `sql_execute` to run these queries against the connected PostgreSQL warehouse. Requires the `pg_stat_statements` extension to be enabled.

## Check pg_stat_statements is Available

```sql
SELECT * FROM pg_available_extensions WHERE name = 'pg_stat_statements';
```

If not enabled, the DBA must run `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` and restart the server.

## Top Expensive Queries (by execution time)

```sql
SELECT
    queryid,
    LEFT(query, 500) AS query_text,
    calls,
    ROUND(total_exec_time::numeric, 2) AS total_exec_time_ms,
    ROUND(mean_exec_time::numeric, 2) AS mean_exec_time_ms,
    ROUND((shared_blks_hit + shared_blks_read)::numeric * 8 / 1024, 2) AS total_mb_processed,
    shared_blks_hit,
    shared_blks_read,
    CASE
        WHEN shared_blks_hit + shared_blks_read > 0
        THEN ROUND(shared_blks_hit::numeric / (shared_blks_hit + shared_blks_read) * 100, 1)
        ELSE 0
    END AS cache_hit_pct,
    rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT @limit
```

Replace `@limit` with the query count (default 20). PostgreSQL does not have a built-in date filter on `pg_stat_statements` — statistics are cumulative since the last reset. Use `pg_stat_statements_reset()` to reset counters.

## Cost by Query Pattern

```sql
SELECT
    queryid,
    LEFT(query, 200) AS query_pattern,
    calls,
    ROUND(total_exec_time::numeric / 1000, 2) AS total_exec_seconds,
    ROUND(mean_exec_time::numeric, 2) AS mean_exec_time_ms,
    rows AS total_rows_returned,
    ROUND(rows::numeric / NULLIF(calls, 0), 0) AS avg_rows_per_call
FROM pg_stat_statements
WHERE calls > 1
ORDER BY total_exec_time DESC
LIMIT 50
```

## Table I/O Statistics

```sql
SELECT
    schemaname,
    relname AS table_name,
    seq_scan,
    seq_tup_read,
    idx_scan,
    idx_tup_fetch,
    n_tup_ins + n_tup_upd + n_tup_del AS total_writes,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
ORDER BY seq_tup_read DESC
LIMIT 20
```

## Index Usage

```sql
SELECT
    schemaname,
    relname AS table_name,
    indexrelname AS index_name,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 20
```

This query finds **unused indexes** — indexes that consume storage but are never scanned.

## Cost Thresholds

PostgreSQL has no direct cost metric like credits or bytes billed. Use execution time as a proxy:

| Tier | Total Exec Time | Label |
|------|----------------|-------|
| 1 | < 100 ms | Cheap |
| 2 | 100 ms – 10 s | Moderate |
| 3 | 10 s – 5 min | Expensive |
| 4 | > 5 min | Dangerous |

For RDS/Aurora, cross-reference with CloudWatch metrics (ReadIOPS, WriteIOPS, CPUUtilization) and the AWS Cost Explorer for actual dollar costs.
