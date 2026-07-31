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

## What to try

**If you got here via altimate-code's activation menu**, the chat is already
offering you a numbered menu — pick a number (or say what else you want to
do). Every option is wired to a real workflow:

- **See what breaks downstream before you change a model** — try `customers`
  or `orders`.
- **Review the SQL in this project with every finding explained** — targets
  the mart models.
- **Build & query it** — altimate-code detects whether dbt-core + dbt-duckdb
  are installed, offers to reuse an existing dbt binary if you paste its
  path, and walks you through the run. Auto-registers the DuckDB file as a
  warehouse so `sql_execute` connects to the database dbt just built.

**If you `cd`'d into `~/altimate-sample-dbt/` from a different shell** — no
activation menu, no LLM in the loop. You can drive dbt yourself:

```bash
# Three PyPI packages that do different jobs:
#   - dbt-core:   provides the `dbt` binary (the entry point)
#   - dbt-duckdb: adapter — teaches dbt-core how to talk to DuckDB
#   - duckdb-cli: standalone `duckdb` binary the ad-hoc query line uses
# `pip install dbt-duckdb` pulls dbt-core as a dependency, so pip is fine.
# `pipx install dbt-duckdb` does NOT — pipx only exposes entry points from the
# named package, and dbt-duckdb has none. Use `--include-deps` if you go pipx.
pip install dbt-duckdb duckdb-cli         # PEP 668 alternatives below
cd ~/altimate-sample-dbt                  # wherever you materialized the sample
dbt seed                                  # load the CSVs into DuckDB
dbt build                                 # run models + tests
duckdb target/jaffle.duckdb -c 'select * from customers'
```

If plain `pip` fails with `externally-managed-environment` (PEP 668, common
on modern macOS Homebrew and Debian/Ubuntu Python), use one of these instead:

```bash
pipx install --include-deps dbt-duckdb && pipx install duckdb-cli
# or
uv tool install dbt-core --with dbt-duckdb && uv tool install duckdb-cli
```

Once `dbt` is discoverable (venv, pipx, conda, uv, poetry, homebrew — the CLI
walks every common Python env manager), altimate-code's "Build & query"
option surfaces the same actions inside the chat.

## Bringing your own project

When you're ready to switch to your real dbt project, `cd` into it and run
altimate-code again. The scan will pick up your `dbt_project.yml` and offer
to connect its warehouse.
