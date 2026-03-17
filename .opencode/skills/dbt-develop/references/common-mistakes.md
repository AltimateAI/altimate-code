# Common dbt Development Mistakes

## SQL Mistakes

| Mistake | Why It's Wrong | Fix |
|---------|---------------|-----|
| `SELECT *` in mart/fact models | Breaks contracts when upstream adds columns | Explicitly list all columns |
| Hardcoded table names | Breaks when schema/database changes | Use `{{ ref() }}` and `{{ source() }}` |
| Business logic in staging models | Staging = 1:1 source mirror | Move logic to intermediate layer |
| JOINs in staging models | Same as above | Move JOINs to intermediate layer |
| `LEFT JOIN` when `INNER JOIN` is correct | Returns NULLs for unmatched rows | Think about what NULL means for your use case |
| Missing `GROUP BY` columns | Query fails or returns wrong results | Every non-aggregate column must be in GROUP BY |
| Window functions without `PARTITION BY` | Aggregates across entire table | Add appropriate partitioning |

## Project Structure Mistakes

| Mistake | Fix |
|---------|-----|
| Models in wrong layer directory | staging/ for source mirrors, intermediate/ for transforms, marts/ for business tables |
| No schema.yml for new models | Always create companion YAML with at minimum `unique` + `not_null` on primary key |
| Naming doesn't match convention | Check existing models: `stg_`, `int_`, `fct_`, `dim_` prefixes |
| Missing `{{ config() }}` block | Every model should declare materialization explicitly or inherit from dbt_project.yml |

## Incremental Mistakes

| Mistake | Fix |
|---------|-----|
| No `unique_key` on merge strategy | Causes duplicates. Set `unique_key` to your primary key |
| Using `created_at` for mutable records | Use `updated_at` — `created_at` misses updates |
| No lookback window | Use `max(ts) - interval '1 hour'` to catch late-arriving data |
| Forgetting `is_incremental()` returns false on first run | The `WHERE` clause only applies after first run |

## Validation Mistakes

| Mistake | Fix |
|---------|-----|
| "It compiled, ship it" | Compilation only checks Jinja syntax. Always `altimate-dbt build` |
| Not spot-checking output data | Run `altimate-dbt execute --query "SELECT * FROM {{ ref('model') }}" --limit 10` |
| Not checking row counts | Compare source vs output: `SELECT count(*) FROM {{ ref('model') }}` |
| Skipping downstream builds | Use `altimate-dbt build --model <name> --downstream` |

## Rationalizations to Resist

| You're Thinking... | Reality |
|--------------------|---------|
| "I'll add tests later" | You won't. Add them now. |
| "SELECT * is fine for now" | It will break when upstream changes. List columns explicitly. |
| "This model is temporary" | Nothing is more permanent than a temporary solution. |
| "The data looks right at a glance" | Run the build. Check the tests. Spot-check edge cases. |
