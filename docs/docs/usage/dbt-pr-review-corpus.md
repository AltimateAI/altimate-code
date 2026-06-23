# dbt PR Review — real-world issue corpus

A living, **sourced** corpus of real dbt/SQL pitfalls practitioners report (dbt
Discourse/Slack, Reddit, StackOverflow, engineering blogs), each turned into a
reproducible test. Every entry is a problem someone actually hit — not a
synthetic example — and the reviewer is held to catching it **with zero false
positives on the correct version**.

Reproduce: `bun run --conditions=browser script/review-realworld-eval.ts`
(detection + precision) and `script/review-dialect-coverage.ts` (10-dialect
coverage). Verified end-to-end on a real third-party repo (`jaffle_shop`, DuckDB).

## Latest measured results
- **Caught: 15/15** sourced pitfalls
- **False positives on the *correct* version: 0/5**
- **Dialect coverage (10 dialects):** function precision 100%, recall 95.7%, structural/type 100%
- **Real repo (jaffle_shop PR):** every finding tied to the change; **no noise** about pre-existing code (diff-scoped)

## The corpus

| # | Pitfall | Where practitioners report it | What the reviewer emits |
|---|---|---|---|
| 1 | **LEFT JOIN silently becomes INNER** — a filter on the right table in `WHERE` drops the unmatched rows | sqlbenjamin.wordpress.com "LEFT JOINs and WHERE clauses", SQLShack, Toad forum | `join_risk` (critical) — move the predicate to the `ON` clause |
| 2 | **Fan-out** — one-to-many join inflates `SUM`/`COUNT` | [dbt join-logic docs](https://docs.getdbt.com/docs/build/join-logic), Holistics fan-out docs | `fanout` / `join_risk` — aggregate before joining, or `count(distinct …)` |
| 3 | **`NOT IN (subquery)` with NULLs returns no rows** | classic SQL gotcha (StackOverflow) | `sql_correctness` — use `NOT EXISTS` |
| 4 | **Incremental model with no `is_incremental()` guard** → full reprocess / dupes | [dbt incremental-models docs](https://docs.getdbt.com/docs/build/incremental-models) | `materialization` |
| 5 | **Dedup `row_number()` with no `ORDER BY`** → which row survives flaps between runs | [dbt "remove partial duplicates" blog](https://docs.getdbt.com/blog/how-we-remove-partial-duplicates) | `dedup` (warning) |
| 6 | **Clock (`current_timestamp`/`getdate`) baked into a transform** → non-idempotent | dbt Slack / idempotency guidance | `idempotency` |
| 7 | **`SELECT *` in a mart** → breaks downstream on upstream schema change; scan cost | dbt style guides | `warehouse_cost` / `sql_quality` |
| 8 | **`= NULL` instead of `IS NULL`** → always false | classic SQL gotcha | `sql_correctness` |
| 9 | **Division with no zero-guard** → divide-by-zero failures | dbt Slack (`safe_divide`/`nullif`) | `sql_correctness` (core L032) |
| 10 | **Non-portable function for the project's dialect** (e.g. `NVL` on BigQuery) | cross-warehouse migration pain (dbt Discourse, SQLGlot) | `sql_quality` (core L033, dialect-aware) |
| 11 | **Comma / implicit cross join** | SQL joins tutorials, cartesian-product warnings | `join_risk` |
| 12 | **Unguarded `COUNT(DISTINCT)` at scale** → cost | BigQuery/Snowflake cost threads (`approx_count_distinct`) | `warehouse_cost` |
| 13 | **`BETWEEN` on a timestamp drops the last day's afternoon** (inclusive upper bound → `00:00:00`) | [SO "Exclude rows with certain time of day"](https://stackoverflow.com/questions/12891232/exclude-rows-with-certain-time-of-day) | `sql_correctness` — use half-open `>= / <` |
| 14 | **String `\|\|` concat NULL-propagation** — any NULL operand → whole result NULL | [Baeldung "Concatenate with NULL Values in SQL"](https://www.baeldung.com/sql/concatenate-null) | `sql_correctness` — use `concat_ws`/`coalesce` |
| 15 | **Hand-rolled surrogate key over raw concat** — NULL field nulls the key / NULL-vs-`''` collisions | [dbt-utils #488](https://github.com/dbt-labs/dbt-utils/issues/488), [dbt Discourse surrogate-key](https://discourse.getdbt.com/t/surrogate-key-dbt-upgrade/6813) | `sql_correctness` / `dedup` |

Plus the **incremental `unique_key` with NULL components → duplicate rows**
class ([dbt Discourse #17298](https://discourse.getdbt.com/t/incremental-model-unique-constraint-still-allows-duplicates/17298),
[dbt-core #7597](https://github.com/dbt-labs/dbt-core/issues/7597)) is covered by
the incremental + surrogate-key detectors.

## Precision — the *correct* versions stay silent
The corpus pairs each pitfall with its fix and asserts **no finding**: a LEFT
JOIN anti-join (`WHERE right.key IS NULL`), `nullif`-guarded division, `NOT
EXISTS`, `row_number()` **with** an `ORDER BY`, and a dialect's **native**
function (e.g. `NVL` on Snowflake). Several real false positives were found and
removed via this corpus (blanket `SAFE_CAST` nag, `ARRAY_AGG`-without-`WITHIN
GROUP` on the wrong dialect, `ORDER BY DESC` without `NULLS LAST`, and
OLTP/index rules like correlated-subquery / function-on-filter that don't apply
to columnar warehouses).

> The bar: a first-time user opening a PR should see findings that map exactly
> to what they changed, are correct for their warehouse's dialect, and never nag
> about code they didn't touch.
