# Jaffle Shop — altimate-code starter sample

Everything below runs against a local DuckDB file — no cloud warehouse, no
credentials, no network calls.

## What's in here

```
dbt_project.yml         dbt project config
profiles.yml            DuckDB profile — path is project-relative
sample-manifest.json    version metadata used by altimate-code to detect
                        stale copies on upgrade
models/
  staging/
    stg_customers.sql   renames raw customer columns to snake_case
    stg_orders.sql      renames raw order columns
    schema.yml          column descriptions + unique/not_null tests
  marts/
    customers.sql       one row per customer, joins in order counts
    orders.sql          one row per order, joins in customer names
    schema.yml          column descriptions + tests + relationships
seeds/
  raw_customers.csv     3 rows of test data
  raw_orders.csv        4 rows of test data
target/
  manifest.json         PRE-COMPILED dbt manifest — ships with the sample so
                        altimate-code's static workflows (/discover, /review)
                        work without dbt-core / dbt-duckdb installed
```

## What to try (works with zero external tools)

- `/discover stg_customers` — walk the DAG and see what depends on this model
- `/review models/marts/customers.sql` — run the reviewer against a mart model
- Open any `.sql` file and ask altimate-code to explain the transformation
- Ask altimate-code "what tests would you recommend for `orders`?"

## What to try (needs `dbt-core` + `dbt-duckdb` installed)

```bash
pip install dbt-duckdb
cd ~/altimate-sample-dbt         # or wherever you materialized the sample
dbt seed                          # load the CSVs into DuckDB
dbt build                         # run models + tests
duckdb target/jaffle.duckdb -c 'select * from customers'
```

Once `dbt-duckdb` is on your `$PATH`, altimate-code detects it automatically
and the "run" workflows appear in `/help`.

## Bringing your own project

When you're ready to switch to your real dbt project, `cd` into it and run
altimate-code again. The scan will pick up your `dbt_project.yml` and offer
to connect its warehouse.
