# Fault-injection fixture

A minimal dbt-duckdb project for `fault-injection-e2e.test.ts`: two seeds, a staging view and one
aggregate table. `status` and `amount` are deliberately untested, so faults in them slip through,
while the keys carry `unique`, `not_null` and `relationships` tests that catch duplicated rows,
NULL keys and orphaned foreign keys.

The DuckDB file is not checked in. The test copies this directory to a temp dir and runs
`dbt build` there to create it.
