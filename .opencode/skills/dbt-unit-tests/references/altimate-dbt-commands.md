# altimate-dbt Command Reference

All dbt operations use the `altimate-dbt` CLI. Output is JSON to stdout; logs go to stderr.

```bash
altimate-dbt <command> [args...]
altimate-dbt <command> [args...] --format text    # Human-readable output
```

## First-Time Setup

```bash
altimate-dbt init                          # Auto-detect project root
altimate-dbt init --project-root /path     # Explicit root
altimate-dbt init --python-path /path      # Override Python
altimate-dbt doctor                        # Verify setup
altimate-dbt info                          # Project name, adapter, root
```

## Build & Run

```bash
altimate-dbt build                                  # full project build (compile + run + test)
altimate-dbt build --model <name> [--downstream]   # build a single model
altimate-dbt run --model <name> [--downstream]      # materialize only
altimate-dbt test --model <name>                     # run tests only
```

## Compile

```bash
altimate-dbt compile --model <name>
altimate-dbt compile-query --query "SELECT * FROM {{ ref('stg_orders') }}" [--model <context>]
```

## Execute SQL

```bash
altimate-dbt execute --query "SELECT count(*) FROM {{ ref('orders') }}" --limit 100
```

## Schema & DAG

```bash
altimate-dbt columns --model <name>                         # column names and types
altimate-dbt columns-source --source <src> --table <tbl>    # source table columns
altimate-dbt column-values --model <name> --column <col>    # sample values
altimate-dbt children --model <name>                        # downstream models
altimate-dbt parents --model <name>                         # upstream models
```

## Packages

```bash
altimate-dbt deps                                           # install packages.yml
altimate-dbt add-packages --packages dbt-utils,dbt-expectations
```

## Error Handling

All errors return JSON with `error` and `fix` fields:
```json
{ "error": "dbt-core is not installed", "fix": "Install it: python3 -m pip install dbt-core" }
```

Run `altimate-dbt doctor` as the first diagnostic step for any failure.
