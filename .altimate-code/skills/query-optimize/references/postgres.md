# PostgreSQL Query Optimization

## Indexes
PostgreSQL relies on indexes for efficient query execution. Unlike columnar warehouses, row-oriented PostgreSQL benefits enormously from proper indexing.

### Index Types
- **B-tree** (default): Equality and range queries (`=`, `<`, `>`, `BETWEEN`). Supports `ORDER BY`.
- **Hash**: Equality-only lookups. Rarely better than B-tree.
- **GIN**: Arrays, JSONB, full-text search. Essential for `@>`, `?`, `@@` operators.
- **GiST**: Geometric/range types, nearest-neighbor. Used with PostGIS.
- **BRIN**: Tiny index for naturally ordered data (timestamps in append-only tables).

### Index Strategy
- Index columns in WHERE, JOIN ON, and ORDER BY clauses
- Composite indexes: put equality columns first, range columns last
- Partial indexes: `CREATE INDEX ... WHERE status = 'active'` for filtered subsets
- Covering indexes: `INCLUDE (col)` to enable index-only scans

## EXPLAIN ANALYZE
Always use `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)` to understand query plans:
- **Seq Scan**: Full table scan; add an index or check if table is small enough
- **Index Scan**: Uses index to find rows, then fetches from heap
- **Index Only Scan**: Best case; all needed data comes from the index
- **Hash/Merge Join**: Hash join for equality; merge join for pre-sorted data
- **Nested Loop**: Fine for small outer tables; problematic for large ones

## Vacuum and Analyze
- `VACUUM` reclaims dead tuple space; `VACUUM FULL` rewrites the table (locks it)
- `ANALYZE` updates statistics for the query planner; stale stats = bad plans
- Autovacuum handles both, but heavy-write tables may need manual `ANALYZE`
- After bulk loads: always run `ANALYZE` before querying

## Key Optimizations
- **Avoid functions on indexed columns**: `WHERE UPPER(name) = 'FOO'` cannot use a B-tree index on `name`; create a functional index or use `citext`
- **Use CTEs carefully**: Before PG 12, CTEs were optimization fences. PG 12+ can inline them.
- **Connection pooling**: Use PgBouncer; too many connections degrade performance
- **Partitioning**: Declarative partitioning (PG 10+) for tables over ~100M rows; partition by date or key range
