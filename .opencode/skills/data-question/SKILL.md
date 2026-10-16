---
name: data-question
description: Answer an analytical question from connected databases, explore data to answer a question, or perform cross-database analysis.
---

# Data Question

Use the available read-only tools to answer the user's question. Source databases and project files stay unchanged; when exposed, `sql_materialize` may create session-local tables in the `scratch` warehouse. All examples below use synthetic tables. Adapt names and dialects after inspection. This skill is self-contained.

## Workflow

1. **Inspect.** Use `warehouse_list`, `schema_inspect` and small `sql_execute` queries as needed. Inspect actual keys and text before choosing joins, casts or parsing rules: schemas alone hide whitespace, case, prefixes and mixed formats. Preserve meaningful leading zeros; check that normalization does not merge distinct identities.
2. **Plan.** State the population, row grain, denominator, units and material assumptions. Decide which joins and aggregation levels preserve them. Keep this brief; a trivial lookup does not need a checklist or several validation scans.
3. **Compute in-engine.** Filter and aggregate close to the source. Derive large intermediate sets with joins/CTEs or the scratch bridge below, rather than copying rows into `IN (...)` or `VALUES`. Small user-supplied constants are fine. Keep LIMIT, sampling and approximate functions exploratory unless the user requests an estimate. For exact final answers, aggregate the full intended population in SQL.
4. **Verify relevant invariants.** Check key uniqueness, before/after join counts, missing matches and null share when they affect the answer. Use `sql_check` for these invariants and extraction coverage; for cross-warehouse comparisons, first materialize both sides into `scratch` with `sql_materialize`. Reconcile components with totals and preserve weighting. `SUM(group_mean * contributing_count) / SUM(contributing_count)` recovers the overall mean for disjoint, complete groups using unrounded means and counts of the same non-null measure; `AVG(group_mean)` gives each group equal weight. `sql_analyze` is optional. If available, a read-only `data-explorer` via `task` can independently re-derive a difficult result.
5. **Answer.** Explain the basis in one or two sentences (population, grain, caveats), retaining useful tables or explanation before it. Finish with `**Answer:** <requested value(s), with units>`. If evidence or available tools are insufficient, finish with `**Answer:** unable to determine — <why>`. Never guess a missing result.

Select needed columns and useful partition filters to control cost; LIMIT need not reduce scanned bytes. Report measured costs, not invented estimates. After a timeout, revise the query or split work along exhaustive, disjoint partitions; a failed query is not a zero count.

## Cross-engine bridge

**Prerequisites:** both source warehouses are connected; `scratch` is available and uses DuckDB; `sql_materialize` is exposed. Source queries use their own engine's dialect. The synthetic source tables here are `orders(order_id, customer_code, amount, status)` on `sales_db` and `customers(customer_code, region)` on `crm_db`, with text customer codes.

After inspecting examples and checking normalization collisions, invoke `sql_materialize` twice:

- `source_warehouse: "sales_db"`, `target_table: "orders_stage"`, `sql`:

  ```sql
  SELECT order_id, LOWER(TRIM(customer_code)) AS customer_key, amount
  FROM orders
  WHERE status = 'paid'
  ```

- `source_warehouse: "crm_db"`, `target_table: "customers_stage"`, `sql`:

  ```sql
  SELECT LOWER(TRIM(customer_code)) AS customer_key, region
  FROM customers
  ```

These are complete derived relations, without exploratory LIMITs. Check reported materialization completeness/counts against the intended scope. A partial transfer cannot support an exact cross-engine answer. Query with `sql_execute` on warehouse `scratch`, using the returned table names:

```sql
SELECT c.region, COUNT(*) AS paid_orders,
       SUM(o.amount) AS total_amount, AVG(o.amount) AS mean_order_amount
FROM orders_stage AS o
LEFT JOIN customers_stage AS c ON c.customer_key = o.customer_key
GROUP BY c.region;
```

First verify the customer key is unique and quantify unmatched orders with the next pattern. Do not silently remove unmatched orders; decide how they affect the requested population.

**If the bridge is unavailable:** use existing views, federation or an already connected engine that can access both relations. Independent aggregates can be combined only if sufficient for the requested statistic (for example, sums and contributing counts over disjoint partitions). Otherwise state that the cross-engine join cannot be completed with available tools. Do not invent a local scripting/write capability or hand-transcribe a large key list.

## Fan-out and nulls

**Prerequisites:** ordinary SELECT/CTE support; this pattern works in DuckDB and SQLite. `order_id` is the intended unique left-side grain. Run on the warehouse holding both staged relations, or adapt to source tables on one engine.

```sql
SELECT customer_key, COUNT(*) AS occurrences
FROM customers_stage
GROUP BY customer_key
HAVING COUNT(*) > 1;

WITH joined AS (
  SELECT o.order_id, o.customer_key AS source_key,
         c.customer_key AS matched_key
  FROM orders_stage AS o
  LEFT JOIN customers_stage AS c ON c.customer_key = o.customer_key
)
SELECT
  (SELECT COUNT(*) FROM orders_stage) AS rows_before,
  COUNT(*) AS rows_after,
  COUNT(DISTINCT order_id) AS distinct_orders_after,
  SUM(CASE WHEN matched_key IS NULL THEN 1 ELSE 0 END) AS unmatched_rows,
  1.0 * SUM(CASE WHEN source_key IS NULL THEN 1 ELSE 0 END)
      / NULLIF(COUNT(*), 0) AS source_key_null_share
FROM joined;
```

Submit the two SELECTs separately if the connector accepts only one statement. For a many-to-one left join, row counts should match; also verify left-side IDs are unique and non-null. Resolve unintended fan-out at the correct business grain, not by adding an arbitrary DISTINCT. The reported null share is at joined grain; interpret it as source share only after ruling out fan-out. Empty-population ratios are undefined, not zero.

## Many similarly shaped tables

**Prerequisites:** inspect the engine/version and table schemas. `information_schema`, DuckDB `query_table` and `UNION ALL BY NAME` are not portable to SQLite. Confirm compatible types and that all intended tables are included exactly once; name-based unions fill absent columns with NULL. Reconcile union counts with the sum of source counts and account for overlapping row identities.

For DuckDB, first generate a single SELECT from the catalog of synthetic `orders_*` partitions:

```sql
WITH catalog AS (
  SELECT '"' || replace(table_catalog, '"', '""') || '"."' ||
         replace(table_schema, '"', '""') || '"."' ||
         replace(table_name, '"', '""') || '"' AS qualified_name
  FROM information_schema.tables
  WHERE table_catalog = current_database()
    AND table_schema = 'main' AND table_type = 'BASE TABLE'
    AND starts_with(table_name, 'orders_')
)
SELECT COUNT(*) AS table_count,
       'SELECT COUNT(*) AS order_count, SUM(amount) AS total_amount ' ||
       'FROM query_table([' ||
       string_agg('''' || replace(qualified_name, '''', '''''') || '''',
                  ', ' ORDER BY qualified_name) || '], true)' AS sql
FROM catalog;
```

Check the catalog scope and `table_count`, then execute the complete generated `sql`. `query_table([...], true)` requires a constant list and unions by name; it does not accept a catalog subquery as its argument. It adds no source-table column. If provenance matters, or table names contain embedded double quotes, generate ordinary quoted SELECTs joined with `UNION ALL BY NAME` instead. For two known synthetic partitions:

```sql
SELECT 'orders_jan' AS source_table, * FROM "main"."orders_jan"
UNION ALL BY NAME
SELECT 'orders_feb' AS source_table, * FROM "main"."orders_feb";
```

For a large family, generate those SELECT branches from the catalog, escaping SQL string literals and identifiers separately; do not enumerate tables from memory. Reserve a provenance column name absent from the input tables. The star here intentionally aligns the inspected partition schemas; project needed columns for the final computation.

SQLite has no `query_table` or `UNION ALL BY NAME`. Query `sqlite_master` to build a complete statement with quoted identifiers and a consistent explicit column order:

```sql
SELECT COUNT(*) AS table_count,
       'WITH combined AS (' ||
       group_concat(
         'SELECT ' || quote(name) || ' AS source_table, order_id, amount ' ||
         'FROM main."' || replace(name, '"', '""') || '"',
         ' UNION ALL '
       ) || ') SELECT COUNT(*) AS order_count, SUM(amount) AS total_amount ' ||
       'FROM combined' AS sql
FROM main.sqlite_master
WHERE type = 'table' AND substr(name, 1, 7) = 'orders_';
```

Inspect the catalog, then execute the returned statement. Every SQLite partition must have `order_id` and `amount` with compatible meaning/types, or each generated branch needs explicit casts/NULL placeholders. `UNION ALL` retains rows; `UNION` would silently deduplicate them. Respect the engine's compound-query limit; if batching is necessary, combine disjoint batches using sufficient statistics (sum/count, not averages of averages).

In both generators, zero matching tables yields `table_count = 0` and `sql = NULL`: investigate coverage instead of claiming a zero total. Never execute clipped generated SQL. Read its spill if available, or generate smaller catalog batches if `read` also clips a long line. These queries generate SQL from metadata, not lists of copied business keys.

Dialect references: [DuckDB query_table](https://www.duckdb.org/docs/current/guides/sql_features/query_and_query_table_functions), [DuckDB union-by-name option](https://www.duckdb.org/docs/lts/sql/functions/utility), [SQLite compound SELECT](https://www.sqlite.org/lang_select.html). All essential examples are above; no external file is required.

## Batch semantic labels, then count

Treat inferred labels as new data, not ground truth. Define a fixed rubric, allowed labels and uncertainty policy before classifying. For synthetic `messages(message_id, body)`, a rubric might classify a request to reverse a charge as `refund`, a question about shipping progress as `delivery`, and ambiguous text as `uncertain`. Specify tie-breaking for multi-topic messages.

Inspect text, then define the complete population of stable IDs. If `task` and read-only `data-explorer` are available, assign disjoint ID ranges or catalog-defined batches with the same rubric/version. Each child returns exactly one `{message_id, label, rubric_version}` record per assigned ID, including `uncertain`; request records, not a guessed count. Otherwise label manageable batches directly using the same contract. Review uncertain cases consistently; batching makes counting reproducible, not classification inherently correct.

Use an available permitted ingestion path to turn these records into a relation `labels(message_id, label, rubric_version)`. When `scratch` and `sql_materialize` are available, small audited annotation batches can be expressed as a SELECT relation and materialized there. For example (DuckDB/SQLite SELECT syntax):

```sql
WITH annotations(message_id, label, rubric_version) AS (
  VALUES (101, 'refund', 'v1'),
         (102, 'delivery', 'v1'),
         (103, 'uncertain', 'v1')
)
SELECT * FROM annotations;
```

These literals are newly inferred annotations, not a copied intermediate database result. Do not scale this into hand-copying thousands of IDs. For large jobs require a permitted way to ingest complete returned annotation records; `sql_materialize` alone does not imply an arbitrary file writer. If unavailable, report the coverage limitation. With no persistence tool, a small complete annotation CTE can still be checked and counted in a read-only query.

**Prerequisites for the following SQL:** DuckDB/SQLite; `population(message_id)` contains exactly the intended unique IDs and `labels` contains the annotation records in the same engine. They may be scratch tables or CTEs. Run each SELECT separately as needed:

```sql
-- Must return no rows: includes duplicates across batches.
SELECT message_id, COUNT(*) AS copies
FROM labels GROUP BY message_id HAVING COUNT(*) <> 1;

-- Missing IDs, extra IDs and invalid records must all be zero.
SELECT
  (SELECT COUNT(*) FROM population AS p
   WHERE NOT EXISTS (SELECT 1 FROM labels AS l
                     WHERE l.message_id = p.message_id)) AS missing_ids,
  (SELECT COUNT(*) FROM labels AS l
   WHERE NOT EXISTS (SELECT 1 FROM population AS p
                     WHERE p.message_id = l.message_id)) AS extra_ids,
  (SELECT COUNT(*) FROM labels
   WHERE message_id IS NULL OR label IS NULL
      OR label NOT IN ('refund', 'delivery', 'uncertain')
      OR rubric_version IS NULL OR rubric_version <> 'v1') AS invalid_records;

-- Only count after the invariants pass; retain uncertain in the denominator.
SELECT label, COUNT(*) AS messages
FROM labels GROUP BY label ORDER BY label;
```

Verify the label counts sum to the full population count. Use these computed counts in the answer; do not re-count labels by eye or combine unverified child summaries.

## Reading spilled results

When `sql_execute` reports `Preview: N of M returned rows ... saved to <path>`, N is the displayed preview and M is the connector-returned count, not necessarily the number of matches. A row-limit warning still applies to the spill. If a JSONL path is supplied, inspect it with `read`, for example:

```json
{"filePath":"<absolute path reported by sql_execute>","offset":1,"limit":50}
```

Inspect any metadata/schema record before interpreting row records; preserve encoded types and distinguish NULL from the string "NULL". Continue using line offsets from the read output, accounting for metadata lines. Read may itself clip long lines or total output: recover only the needed fields with a SQL projection/filter instead of guessing missing cell contents. For exact totals, compute `COUNT(*)`, SUM or other requested aggregates in the engine; a spill cannot recover rows discarded by a connector limit. If no spill is available, narrow or aggregate the query and respect its returned-row limit.
