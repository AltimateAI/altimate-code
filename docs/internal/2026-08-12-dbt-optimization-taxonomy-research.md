# A Production dbt Optimization Agent Taxonomy

## Executive Summary

- **Incremental Grain**: dbt incremental models process only rows selected by the model's incremental logic, which can reduce transformation runtime and resources [31]. The agent should first prove the model grain, change cursor, late-arrival window, delete behavior, and unique key, then propose incrementalization.
- **Strategy Fit**: `append`, `merge`, `delete+insert`, `insert_overwrite`, and `microbatch` have different correctness and scan behavior. `append` does not deduplicate, `merge` depends on a usable key, and `insert_overwrite` replaces affected partitions rather than individual rows [24]. The agent should recommend a strategy, not merely add `materialized: incremental`.
- **Physical Layout**: Partitioning, clustering, sort keys, distribution keys, and data skipping pay only when they match observed predicates and joins. A layout recommendation without query-history evidence should be low confidence.
- **SQL Shape**: Late filters, `SELECT *`, exploding joins, repair-by-`DISTINCT`, unnecessary `ORDER BY`, and repeated scans multiply bytes and rows. Query plans and row-count ratios should outrank stylistic preferences.
- **Graph Economics**: A cheap model can be expensive when it is upstream of many consumers or is repeatedly recomputed as a view. Rank changes by downstream weighted cost, not by the runtime of one node.
- **Run Selection**: `state:modified`, `--defer`, Slim CI, targeted backfills, and sensible thread counts reduce work without changing business SQL. Increasing threads increases warehouse load and can affect other workloads [13].
- **Quality as Cost**: Tests and freshness checks are part of the bill. dbt supports a `where` clause for source freshness specifically to limit scanned data [20], and test configurations also expose a `where` control [27].
- **Recovery First**: dbt documents `--full-refresh` as the rebuild path when incremental logic changes [22]. Microbatch guidance recommends disabling accidental full refreshes and using targeted event-time backfills instead [31].
- **Automation Boundary**: Formatting, lineage reports, cost attribution, dead-resource reports, and clearly proven SQL rewrites can be automated. Materialization, key, join, partition, retention, and snapshot changes should normally be proposal-only.
- **Evidence Gap**: Existing tools cover project hygiene, SQL linting, lineage/data diffs, and cost observability, but no single tool covers semantic safety, warehouse physical design, graph economics, and cost attribution end to end. Recce, for example, documents lineage and data/profile/schema diffs rather than a static performance rule catalog [62] [54].
- **Practitioner Signal**: The strongest recurring wins are incremental processing, materialization schedules, selective CI, and query-history-driven prioritization. A dbt Discourse example reports a model taking 20 seconds incrementally versus 1,500 seconds for a full refresh [66], while a Slim CI case reports a 10x CI speedup [67]. Treat these as case evidence, not universal forecasts.

## 1. Evidence Model: What the Agent Must Join Before It Recommends Anything

The agent should build one normalized record per dbt resource and one normalized record per warehouse execution. The dbt side comes from `manifest.json`, `run_results.json`, compiled SQL, project configuration, source definitions, exposures, tests, snapshots, and the catalog. The manifest provides resource identity, dependencies, configurations, relation names, and compiled or raw code; `run_results.json` provides invocation status and timing for executed nodes [18]. The model-performance and model-query-history features in dbt similarly use historical execution metadata to surface execution time and cost trends [17] [68].

The warehouse side should be collected through native history and profile surfaces. Use query text, normalized query hash, start and end timestamps, user or role, warehouse or cluster, database/schema/relation references, bytes or partitions read, rows produced, spill or shuffle indicators, queue time, execution time, and cache-hit information where the engine supplies them. Snowflake exposes the `QUERY_HISTORY` family [69]; BigQuery exposes the `INFORMATION_SCHEMA.JOBS` view [63]; Databricks exposes a query-history system table for SQL warehouse and serverless queries [65]; Redshift exposes `SYS_QUERY_HISTORY` and related detail/system views. PostgreSQL's `pg_stat_statements` is an extension for accumulated planning and execution statistics [57]. DuckDB normally needs explicit profiling or an execution wrapper because it is embedded rather than a managed warehouse with a universal retained query history.

Attribution should use the strongest available key in this order:

1. A dbt invocation ID, model unique ID, query tag, or structured query comment.
2. A relation name in `CREATE`, `MERGE`, `INSERT`, `DELETE`, or `ALTER` statements.
3. The compiled SQL hash and a time-window match to `run_results.json`.
4. A lineage-aware match of referenced relations when the engine rewrites SQL.
5. A probabilistic match, explicitly labeled low confidence.

For each candidate, calculate baseline frequency, median and p95 runtime, bytes or partitions read, rows read and written, queue time, spill/shuffle, warehouse/cluster size, and estimated spend. Estimate impact as `execution frequency x avoidable work x unit cost`, with separate estimates for compute, elapsed runtime, storage, and concurrency relief. Never turn a bytes-scanned reduction into a dollar estimate without the engine's billing model. For Snowflake, credits and warehouse time differ from BigQuery bytes-billed; Databricks DBUs, Redshift cluster time, PostgreSQL resource utilization, and DuckDB local compute need separate estimators.

Confidence should be a product of evidence quality and semantic certainty. A repeated `SELECT *` is statically detectable but its safe replacement requires a schema contract. A table that scans the entire source every hour and has a stable event cursor is a strong incremental candidate, but correctness still depends on deletes, updates, late arrivals, and backfills. The agent should show the evidence, the expected work avoided, the assumptions, and a rollback command for every proposal.

## 2. Materialization and Incremental Processing Taxonomy

The built-in dbt materialization choice is a physical and operational decision, not a style choice. Current dbt documentation describes incremental models as warehouse tables whose first build processes all source rows and whose later builds process only rows selected by incremental logic [22]. The materialization decision should be based on access frequency, reuse, data volume, freshness, update pattern, and whether a warehouse-native object can maintain the result.

| Use-case | Detection signal and evidence needed | Proposed fix | Impact | Risk and preconditions | Agent confidence |
|---|---|---|---|---|---|
| Table rebuilt more often than data changes | Full-table scan/write on every run; low changed-row ratio; high frequency; stable cursor | Convert to incremental; add an explicit `is_incremental()` filter | C, R | Must define grain, cursor, updates, deletes, late arrivals, and backfill | Medium |
| Incremental config exists but no effective filter | `is_incremental()` absent, tautological, or applied after a large upstream join | Push the change filter into the earliest source scan | C, R | Filter must preserve late and updated records | Medium |
| Incremental filter scans too much history | Query history shows target/source scan far larger than changed window | Add or tighten `incremental_predicates`; cluster or partition on the predicate columns | C, R | dbt does not validate predicate SQL; target aliases and engine syntax must be correct [22] | Medium |
| Append used for mutable data | Updates/deletes in source; duplicate-key growth; append strategy in config | Use `merge`, `delete+insert`, or a partition replacement strategy | C, R, Q | Need a stable, non-null unique key or a full replacement grain; append does not check duplicates [24] | Low to medium |
| Merge scans an unnecessarily large destination | Merge query scans old target partitions unrelated to incoming rows | Add destination-side `incremental_predicates`; align target layout with merge key/time | C, R | Predicate must not exclude an older row that can be updated | Medium |
| Delete plus insert is used where partition replacement is cheaper | Date-partitioned target; changed data is whole partitions; delete and merge spend is high | Use `insert_overwrite` or adapter-equivalent partition replacement | C, R | Requires correct partition boundary and complete replacement data | Medium |
| Insert overwrite used at row grain | Strategy replaces partitions but model produces incomplete partitions | Switch to merge/delete+insert or make each run produce complete affected partitions | Q, C | A partial partition can silently delete valid rows | Low |
| Microbatch candidate missed | Large time-series model; event-time cursor; independent bounded periods; long serial run | Use `microbatch` with `event_time`, batch size, parallelism, retry, and targeted backfill | C, R | Needs time column, bounded batches, idempotent batch logic, and late-arrival policy. Microbatch is designed for large time-series data and independent retryable batches [31] | Medium |
| Microbatch adapter mismatch | Project/adapter version or strategy support does not match target engine | Use adapter-supported strategy; emit compatibility warning | Q, R | Current docs show different adapter mechanisms, including merge for Postgres, delete+insert for Redshift/Snowflake, insert_overwrite for BigQuery/Spark, and replace_where for Databricks [31] | High |
| Late-arriving data is lost | Cursor is `max(event_time)` with no lookback; backfilled source rows appear in history | Add a measured lookback window, reprocess affected partitions, or use source update timestamp | Q, C | Lookback increases work; deduplication must be deterministic. dbt puts responsibility for the lookback in model SQL [31] | Medium |
| Unique key is absent, nullable, or not unique | Incremental model has no key; key columns contain nulls; duplicate-key test failures | Define a real composite key or surrogate key; add uniqueness/not-null tests; choose replacement strategy if grain is not unique | Q, C, R | A bad key causes duplicates or merge failure. dbt warns that nullable key columns can prevent matching [22] | Medium |
| Incremental logic is not idempotent | Re-running the same window changes row counts or duplicates records | Deduplicate source, use deterministic windowing, and validate repeat-run equality | Q, M | Must compare row counts and checksums at the intended grain | Medium |
| Full refresh runs too frequently | Job arguments include `--full-refresh`; schedule history shows frequent rebuilds; incremental tables rebuilt without incident | Remove the flag from routine jobs; create an explicit backfill/rebuild job; set model-level `full_refresh: false` where appropriate | C, R | Schema changes and logic changes still need controlled rebuilds; preserve a documented escape hatch | High |
| Full refresh is used for a bounded correction | Operator refreshes an entire history for a date-range correction | Use event-time start/end, partition backfill, or targeted selection | C, R | Requires complete correction window and downstream rebuild policy. dbt recommends targeted microbatch backfills [31] | High |
| View used for a hot, expensive, repeatedly queried model | Same expensive view query appears in BI/query history many times; no cache benefit | Materialize as table, incremental table, materialized view, or dynamic table | C, R | Adds storage and freshness lag; must measure downstream reuse and update SLA | Medium |
| Table used only once and rarely queried | Low downstream count; low query frequency; rebuild is cheap; storage dominates | Use a view or ephemeral model | C, S, M | A view can move cost to every consumer; ephemeral SQL can duplicate work across consumers | Medium |
| Ephemeral model is reused across many branches | Same compiled CTE logic appears repeatedly in multiple downstream queries; large scan/CPU | Materialize as an intermediate table or incremental model | C, R | Changes relation boundaries and ownership; requires contracts/tests | Medium |
| Intermediate table is not reused | One consumer, small transformation, low runtime, high table count | Make it ephemeral or a view | C, M, S | Do not inline a costly or reused subquery; inspect compiled SQL and downstream count | High |
| Materialized view candidate | Stable deterministic query; frequent reads; warehouse supports automatic maintenance; source change pattern fits | Use dbt materialized view or native equivalent | C, R | Refresh cost, feature restrictions, staleness, and unsupported SQL can outweigh benefit | Low to medium |
| Dynamic table candidate on Snowflake | Continuous freshness requirement; transformation is supported; refresh lag and target lag are measurable | Use `materialized: dynamic_table`; set target lag and warehouse policy | R, C | Dynamic tables are warehouse-managed objects created by dbt-snowflake [7]; monitor refresh spend and dependencies | Low to medium |
| Incremental model should be rebuilt after logic change | Compiled SQL/config changes alter historical semantics; existing target is stale | Run targeted or full refresh, compare old/new outputs, then resume incremental | Q, C | Rebuild can be expensive; dbt documents `--full-refresh` for this recovery path [22] | High |
| `on_schema_change` is mismatched to the model contract | New source columns are silently ignored, fail builds, or trigger expensive full handling | Choose `ignore`, `append_new_columns`, `sync_all_columns`, or explicit migration based on contract | Q, R | It does not repair historical rows; `sync_all_columns` can be expensive on some engines | Low to medium |

The key implementation rule is to recommend a strategy together with its failure policy. A `unique_key` makes matching possible, but it does not prove uniqueness. A merge can still be expensive if the destination scan is broad; a partition overwrite can be cheaper but is unsafe when the model does not fully reconstruct each replaced partition. dbt's incremental strategy documentation explicitly frames strategy choice around volume, key reliability, and adapter support [24].

## 3 Warehouse Physical Design and Storage Taxonomy

Physical design should be inferred from recurring filters, join keys, partition coverage, and query profiles. It should not be generated from column names alone. Snowflake's micro-partition metadata supports runtime pruning [33], while Databricks liquid clustering is documented as a data-layout technique that replaces traditional partitioning and ZORDER [21]. Those mechanisms are similar in purpose but not interchangeable.

| Engine and use-case | Detection signal and evidence needed | Proposed fix | Impact | Risk and preconditions | Agent confidence |
|---|---|---|---|---|---|
| Snowflake clustering key missing | Large table, high scan-to-return ratio, repeated selective filters, poor partition pruning, high clustering depth/overlap | Add or revise `cluster_by` on high-value filter/join dimensions; measure reclustering credits | C, R | Clustering maintenance costs credits; key order and cardinality matter; only recommend above measured table/query threshold | Medium |
| Snowflake clustering key stale | DML-heavy table becomes poorly clustered; pruning degrades over time | Recluster, change key, or rebuild in a controlled window | C, R | Reclustering can increase spend and lock/maintenance activity | Low to medium |
| Snowflake search is defeated by expressions | Filters wrap clustered/date columns in casts or functions; pruning ratio is poor | Normalize types and use sargable predicates; preserve timestamp/date boundaries | C, R | Time-zone and null semantics can change | Medium |
| Snowflake transient staging candidate | Short-lived staging/intermediate table; no disaster-recovery requirement; storage charges observed | Use transient materialization or transient schema for staging | S, C | Transient tables have no Fail-safe period and therefore avoid storage beyond Time Travel retention [11]; do not use for irreplaceable production data | Medium |
| Snowflake Time Travel/retention excess | Storage grows after rebuilds/drops; retention exceeds recovery policy; transient/permanent mismatch | Reduce retention where policy permits; use transient/temporary for disposable layers; avoid repeated full rebuild churn | S, C | Compliance, recovery, and incident response requirements override cost | Low to medium |
| BigQuery partitioning missing | Large table repeatedly filtered by date/time but `total_bytes_processed` remains near table size | Partition by the dominant time/date or integer-range predicate; use ingestion-time only when appropriate | C, R | Partition skew, too many partitions, and changed query semantics are possible | Medium |
| BigQuery partition pruning defeated | Partition filter is wrapped in a function, uses a mismatched type, or is applied after a broad subquery | Use direct partition-column predicates and push them to the scan | C, R | Correctness depends on timezone and inclusive boundary rules | Medium |
| BigQuery required partition filter missing | Large partitioned table is queried without a bounded partition predicate | Set `require_partition_filter`; add model/source conventions and tests | C, Q | It can break legitimate unbounded jobs and BI queries, so propose with affected-consumer list | Medium |
| BigQuery clustering missing or wrong | Repeated filters after partition pruning still scan many blocks; common equality/range columns are visible in query history | Add up to the engine-supported clustering columns in predicate/join order; validate bytes and slot time | C, R | Clustering is not a substitute for partitioning; high-cardinality or unstable keys may not help | Medium |
| Databricks liquid clustering candidate | Delta table has recurring filters on dimensions, poor data skipping, and frequent schema/query evolution | Use liquid clustering on observed keys; run/monitor `OPTIMIZE` according to platform policy | C, R | Liquid clustering replaces partitioning/ZORDER and is not a drop-in change for all runtimes [21]; maintenance consumes compute | Low to medium |
| Databricks ZORDER candidate on legacy layout | Legacy Delta table, repeated selective predicates, data-skipping stats show poor locality | ZORDER on a small set of high-value columns, or migrate to liquid clustering | C, R | ZORDER can be inferior to liquid clustering on supported runtimes; avoid piling both without evidence | Medium |
| Databricks partition explosion | Too many tiny partitions, small files, high task overhead, low rows per file | Remove or coarsen partitions; use liquid clustering or compaction | C, R | File layout and streaming latency can change | Medium |
| Redshift sort key missing or misordered | Poor sort order, high unsorted region, scans on a recurring time/join predicate, EXPLAIN shows broad scan | Add/reorder sort key; choose compound/interleaved/automatic design appropriate to workload | C, R | Sort maintenance, vacuum, load order, and workload mix matter; use EXPLAIN and history | Medium |
| Redshift distribution key causes redistribution | Query plans show broadcast or redistribution on large joins; skewed node row counts | Choose a common join key, `AUTO`, or a safer distribution style; validate skew | C, R | A key that helps one join can hurt another; skew is worse than a missing key | Low to medium |
| Redshift compression/statistics maintenance gap | Large table footprint, stale statistics, high scan, vacuum/analyze debt | Apply encoding/compression and schedule `ANALYZE`/vacuum or automatic maintenance | C, R, S | Maintenance itself consumes capacity; preserve sort and load behavior | Medium |
| PostgreSQL index/materialized-view gap | `EXPLAIN ANALYZE` and `pg_stat_statements` show repeated selective scans or sort/join cost on persistent relations | Add a targeted index, partial index, covering index, or materialized view; refresh deliberately | C, R | Index write/storage cost and planner regressions; require workload-wide evidence | Low to medium |
| DuckDB file/layout gap | Profiling shows repeated full Parquet scans, poor predicate pushdown, or excessive local spill | Partition/order Parquet by common filters, project columns, use persistent local intermediate tables, and profile again | C, R, S | DuckDB is workload-local; file layout may be owned by another pipeline | Medium |

The agent should produce a physical-design proposal only when it can show a before/after hypothesis: current bytes or partitions scanned, predicate frequency, expected pruning dimension, maintenance cost, and rollback. “Add a clustering key to every large table” is not an optimization policy.

## 4 SQL Anti-Patterns the Agent Should Detect

The SQL lane needs both an AST detector and a query-plan detector. Static lint can find `SELECT *`, ambiguous joins, missing qualifications, and some set-operation hazards. It cannot decide whether a `DISTINCT` is semantically required or whether a join is intentionally many-to-many. SQLFluff's rule catalog explicitly warns that wildcard projection can cause slow performance, hide schema changes, or break production code [28]. Snowflake query insights also calls out exploding joins, where a join output returns many more rows than its inputs [15].

| Anti-pattern | Detection signal | Fix pattern | Impact | Safe automation boundary |
|---|---|---|---|---|
| Late filtering | Large upstream rows/bytes, filter appears after joins/windows; plan shows high intermediate cardinality | Push selective predicates to source/staging scans; retain null/time semantics | C, R | Auto only when predicate references one relation and equivalence is proven; otherwise propose |
| `SELECT *` propagation | Wildcards in staging/intermediate models; downstream selects most columns repeatedly | Explicit column list; use a controlled star macro only where schema evolution is intentional | C, R, M, Q | Generate diff, but do not silently remove new columns |
| Unnecessary `DISTINCT` | Dedup operator consumes high bytes; upstream join or key test shows uniqueness | Remove it, deduplicate at the correct grain, or fix the join | C, R, Q | Propose-only unless uniqueness is proven by constraints and sampled/full checks |
| `DISTINCT` as join repair | Row multiplication before distinct; output rows equal expected grain after expensive dedup | Fix join cardinality, pre-aggregate, or select one deterministic record | C, R, Q | Propose-only |
| Exploding/many-to-many join | Join output/input row ratio, Cartesian join, missing predicate, duplicate keys, spill/shuffle | Add complete join predicate; deduplicate or aggregate each side to intended grain before joining | C, R, Q | Never auto-rewrite a business join without a grain contract |
| Repeated dimension join | Same dimension joined repeatedly in a chain; identical scan fingerprints | Centralize a conformed intermediate or join once at the correct grain | C, R, M | Propose-only because join placement changes semantics |
| Window used for simple aggregate | `row_number`, `rank`, or window sum over a partition where only grouped result is consumed | Replace with `GROUP BY` or pre-aggregate, or use `QUALIFY` where supported | C, R | Propose-only; window ordering and tie handling matter |
| Group by used when row-level window is required | Aggregation loses detail then downstream rejoins; repeated fan-in | Keep window or build a reusable aggregate at the correct grain | R, M, Q | Propose-only |
| `UNION` used without duplicate requirement | Set distinct operation is expensive; source branches are disjoint or have proven unique keys | Use `UNION ALL`; add an explicit dedup model only if required | C, R | Auto only with disjoint predicates or key proof; otherwise propose |
| `UNION ALL` used with duplicate risk | Duplicate keys across branches; downstream distinct or duplicate test failures | Deduplicate using deterministic precedence or use `UNION` deliberately | Q, C | Propose-only |
| `ORDER BY` in a model | Top-level order without `LIMIT`, window dependency, or consumer contract; sort spill | Remove it; order at presentation/query boundary | C, R | High confidence if no limit/window and relation contract has no order guarantee |
| Non-sargable partition/date predicate | Cast/function around partition key; implicit type conversion; string date comparison | Cast parameters, not columns; use half-open typed ranges | C, R, Q | Medium; timezone and null behavior must be tested |
| Correlated scalar subquery repeated per row | Plan shows repeated lookup or nested loop on large input | Pre-aggregate/join, use `EXISTS`, or materialize reusable lookup | C, R | Propose-only |
| `NOT IN` with nullable subquery | Null-sensitive anti-join; unexpected row loss or extra scans | Use `NOT EXISTS` with explicit null semantics | Q, R | Propose-only |
| Repeated expression/subquery | Same expensive expression or source scan appears multiple times in compiled SQL | Compute once in a CTE or intermediate relation; verify engine does not re-evaluate it | C, R, M | CTE behavior differs by engine; propose with plan evidence |
| CTE materialization mismatch | PostgreSQL plan materializes a large CTE unnecessarily, or another engine inlines a costly reused CTE; repeated scan in profile | Use `MATERIALIZED`/`NOT MATERIALIZED` where supported, or persist a relation | C, R | Propose-only and engine-specific |
| Wide JSON/array/object extraction early | Large semi-structured columns parsed before selective filters; high CPU | Project and filter first; extract only needed paths | C, R | Medium |
| Implicit casts and mixed types in joins | Plan shows casts on join columns or poor distribution/pruning | Normalize types upstream or cast the smaller side deliberately | C, R, Q | Propose-only if key values may change |
| UDF or Python row-by-row computation | High CPU, low scan, serialized execution, poor vectorization | Replace with native SQL/vectorized function or precompute | C, R | Propose-only |
| Repeated full-source scans in sibling models | Same source fingerprint and time window across many models | Build one appropriately materialized staging/intermediate relation and reuse it | C, R, M | Propose-only; shared relation can create a new bottleneck |

A query rewrite should be accepted only after result equivalence at the declared grain. The validation harness should compare schema, row count, key uniqueness, null rates, aggregate checksums, and sampled or full data diffs. Recce's row-count, profile, value, top-K, histogram, and schema diffs are useful for this validation layer [54].

## 5 DAG and Model-Structure Taxonomy

The graph is an economic model. Every node has build cost, storage cost, and downstream reuse; every edge has a freshness and scheduling consequence. The agent should compute fan-in, fan-out, descendants, ancestors, path depth, longest weighted path, shared upstream scans, materialization boundaries, and consumer query frequency.

| Graph use-case | Detection signal | Fix pattern | Impact | Risk/precondition | Confidence |
|---|---|---|---|---|---|
| High fan-out staging view | One expensive staging view has many descendants and is re-executed in each consumer query | Materialize once as table/incremental or consolidate consumers | C, R | Storage/freshness trade-off; verify downstream concurrency | Medium |
| High fan-in mart | Many branches converge into one large join with repeated grain changes | Pre-aggregate branches, establish a declared grain, or split the mart | C, R, Q | Business semantics are central; propose-only | Low |
| Duplicate upstream scans | Multiple siblings independently scan the same raw source/window | Shared staging/intermediate relation with explicit projection and partitioning | C, R, M | Shared relation can increase scheduled build work if consumers are sparse | Medium |
| Staging-layer bloat | Deep chain of one-line pass-through models, low reuse, no tests/contracts | Collapse safe pass-through layers or use a reusable staging model | M, R | Preserve lineage, access, contracts, and ownership | Medium |
| Over-materialized intermediates | Many one-consumer tables; build and storage time dominate | Convert small one-consumer nodes to ephemeral/view | C, R, S | Do not inline expensive or reused computations | Medium |
| Under-materialized reusable logic | Same compiled CTE or macro expands in many models | Persist the computation once; refactor macro/model boundary | C, R, M | Output grain and ownership must be explicit | Medium |
| Dead model | No downstream model, exposure, metric, seed, test, external consumer, or scheduled selector references it | Quarantine, deprecate, then delete after owner confirmation | C, M, S | External BI and ad hoc consumers may not appear in manifest | High for report, low for delete |
| Dead source/exposure metadata | Sources or exposures have no reachable lineage or stale owners | Remove or repair metadata; use exposures to drive selection and impact | M, R | Metadata deletion can hide operational dependencies | Medium |
| Critical-path root cause | Longest weighted path has one slow node or serial bottleneck; high p95 and downstream SLA impact | Optimize that node or parallelize independent branches; do not optimize low-impact leaves first | R, C | Critical path changes after graph edits; recompute after each change | High |
| Excessive DAG depth | Long chain of low-cost nodes adds scheduling overhead and serial barriers | Collapse safe transformations or combine compatible stages | R, M | Debuggability and ownership may suffer | Medium |
| Branch imbalance | One branch dominates runtime while threads idle on other branches | Move work earlier/later, materialize shared result, or split large node | R, C | Concurrency can increase warehouse contention | Medium |
| Cross-domain fan-in | Large fact tables from separate domains joined at incompatible grains | Create conformed dimensions/aggregates and join at declared grain | C, R, Q | High semantic risk | Low |
| Unused column propagation | Columns travel through many models but are never selected downstream | Remove from model projections after dependency analysis | C, R, S, M | External consumers and `SELECT *` contracts can break | Medium |
| Model selector overbuild | Scheduled job runs all models despite isolated domains or changed subset | Use selectors, tags, state selection, and downstream-specific jobs | C, R | Must preserve required downstream order and freshness | High |
| Duplicate snapshots/derived history | Multiple models independently implement SCD history | Centralize snapshot/history and expose derived views | C, S, M | Historical semantics and retention are sensitive | Low to medium |

The graph lane should produce two scores: “cost saved if this node is cheaper” and “runtime saved if this node leaves the critical path.” They are not the same. A low-frequency root model can dominate the critical path, while a frequently queried view may dominate warehouse spend outside dbt runs.

## 6 Run-Level, dbt Configuration, Tests, and Storage

| Use-case | Detection signal/evidence | Proposed fix | Impact | Risk/preconditions | Confidence |
|---|---|---|---|---|---|
| Over-frequent full refresh | Job history, arguments, or CI scripts contain `--full-refresh` on routine runs | Separate rebuild/backfill jobs; remove routine flag; set explicit model policy | C, R | Keep an approved rebuild path and validation | High |
| Peak-hour scheduling | dbt executions overlap BI or ingestion peaks; queue time and warehouse utilization rise | Move batch, stagger domains, or use workload-specific warehouses | C, R | SLA, source arrival time, and downstream freshness constrain moves | Medium |
| One warehouse size for all models | Small models run on oversized warehouse; large critical model queues on undersized one | Route by cost/runtime class; resize or use per-job warehouses; compare credits per runtime | C, R | Warehouse startup, cache, concurrency, and workload isolation matter | Medium |
| Threads too low | Warehouse idle while independent dbt nodes wait; low concurrency and long critical path | Increase threads until marginal runtime benefit flattens | R | More threads increase load and can hurt BI/other jobs [13] | Medium |
| Threads too high | Queue time, spill, throttling, warehouse saturation, or higher credits without runtime gain | Reduce threads; isolate workloads; scale warehouse only when justified | C, R | Need workload-wide not job-only measurement | High |
| Full project build in CI | Every PR builds all models; unchanged dependencies rebuild | Use `state:modified`, `--defer`, Slim CI, affected-node selection, and targeted tests | C, R | State artifacts must be current; defer can mask missing production changes | High |
| Broad backfill for local correction | A date correction rebuilds all history and all descendants | Select affected models and event-time partitions; rebuild impacted descendants only | C, R | Must identify all downstream historical dependencies | Medium |
| Stale or missing state artifact | State selection produces too many or too few nodes | Version and validate state manifest/run artifacts; alert on stale state | R, Q | Incorrect state selection can omit required changes | High |
| Expensive pre/post-hooks | Hooks scan tables, create indexes, grant repeatedly, or run external SQL on every model | Move to deployment step, narrow scope, make idempotent, or remove redundant hook | C, R, M | Hooks may enforce security or operational contracts | Medium |
| `persist_docs` on every relation without need | DDL/comment operations are visible in run history at high node count | Scope documentation persistence to governed schemas or release jobs | R, C | Documentation discoverability and governance can be lost; recommend selectively | Low to medium |
| Freshness scans entire source | Source freshness query reads a huge table without bounded predicate | Add freshness `where`, use ingestion/update column, or run freshness on a representative recent slice | C, R | A predicate can miss a stale partition or late source; dbt supports a freshness `where` filter [20] | Medium |
| Exposures are stale or absent | BI dashboards do not appear as downstream consumers; owners/URLs are missing | Maintain exposures and owners; use them in impact and selector logic | M, Q, R | Metadata is not proof that a dashboard queries a model | Medium |
| Generic tests scan full history | `unique`, `not_null`, relationships, or custom tests repeatedly scan large tables | Add `where`, partition-aware test models, incremental test tables, or schedule full tests less often | C, R | Recent-only testing can miss historical regressions; keep periodic full audits | Medium |
| Redundant tests | Same assertion repeated at source, staging, intermediate, and mart with no additional coverage | Keep tests at contract boundaries; remove duplicates | C, R, M | Different grains may make apparently duplicate tests meaningful | Medium |
| Primary-key test is absent | Incremental/merge key lacks not-null and uniqueness evidence | Add key tests at the model grain; use composite/surrogate key test | Q, C | Full uniqueness test is expensive; partition-aware sampling is not equivalent | High |
| Primary-key test is inefficient | Concatenated expression, null-sensitive composite, or repeated full-table hash | Use native composite tests, null normalization, or a reusable key column | C, R, Q | Hash collisions and null semantics need explicit policy | Medium |
| Relationship test joins huge tables | Relationship test scans both full relations repeatedly | Test bounded recent partitions, precomputed key sets, or run full relationship audits periodically | C, R | Recent-only test cannot prove historical referential integrity | Medium |
| Snapshot bloat | Snapshot grows faster than source; unchanged rows are copied; hard deletes are mishandled | Use `check` or `timestamp` strategy correctly, narrow columns, separate history, control hard deletes, and archive old history | S, C, R, Q | History is often the product; never delete without retention policy | Low to medium |
| Snapshot runs too frequently | Snapshot executes more often than source changes or SLA requires | Align schedule with source update cadence; use event/update timestamp | C, R, S | May miss intermediate states if source changes multiple times between runs | Medium |
| Permanent staging tables retain unnecessary recovery data | Snowflake disposable layers use permanent tables and long Time Travel | Use transient/temporary staging and shorter permitted retention | S, C | Transient has no Fail-safe; unsuitable for irreplaceable data [11] | Medium |
| Storage churn from rebuilds | Frequent `CREATE OR REPLACE`, dropped tables, or snapshot copies create retained historical storage | Reduce rebuilds, use incremental/partition replacement, and tune retention | S, C | Compliance and recovery policies override optimization | Medium |
| Schema-change behavior causes rebuilds or failures | Source columns added/removed; `on_schema_change` mismatch; unexpected DDL time | Set explicit policy, contract columns, migration tests, and targeted rebuild | R, Q | Configuration does not backfill old rows; engine behavior varies | Medium |

Test optimization must preserve a two-speed quality model: cheap bounded checks on every build, plus periodic full-history audits. Removing tests because they are expensive is not optimization; changing their scope while preserving a stated detection SLA is.

## 7 Existing Tool Coverage Checklist

The following is a coverage map, not an endorsement and not a claim that each vendor publishes a complete optimizer rule catalog. Version and edition differences matter.

| Tool | Published or observable coverage relevant to this agent | What it does not replace |
|---|---|---|
| `dbt_project_evaluator` | Project-level rule families for modeling, testing, documentation, and performance; performance rules highlight possible materialization improvements in a model chain [70]. Use it for DAG hygiene, model/source conventions, tests, docs, and materialization smells. | Warehouse query plans, actual spend, physical layout, semantic SQL equivalence, and complete ROI ranking. |
| SQLFluff | Large static rule catalog for layout, aliases, references, ambiguous joins/set operations, wildcard projection, structure, and dbt templating. Its `SELECT *` guidance explicitly includes performance/schema-change risk [28]. | It is primarily a linter/formatter; it does not know actual bytes, credits, fan-out cost, or whether a `DISTINCT` is semantically required. |
| Recce | Lineage diff, row-count diff, profile diff, value diff, top-K diff, histogram diff, and schema diff for reviewing dbt changes [54]. | It validates proposed changes; it is not a warehouse cost optimizer or static SQL performance catalog in the evidence gathered. |
| Datafold | Data diff, column-level lineage, impact analysis, and CI-oriented validation of dbt changes. | It validates data impact; it does not by itself choose a materialization, clustering key, or thread count. |
| SELECT.dev | dbt resource attribution, historical model/test cost and performance, query-level observability, and tailored savings recommendations for Snowflake, Databricks, and BigQuery [71] [34]. | It does not provide a universal semantic rewrite engine or cover all six engines in the requested scope. |
| Montara | The evidence gathered confirms a Montara product page but did not expose a citable public rule catalog. Treat it as an unverified candidate until a current product/API inventory is available. | Do not invent Montara rules from marketing descriptions. |
| dbt Cloud Catalog/Model Performance/Cost Insights | Historical model performance and estimated cost views; model query history is gathered from production warehouse logs [17] [68]. | Public evidence gathered here did not expose a complete, versioned “advisor rule” catalog; use it as telemetry and compare recommendations with local evidence. |
| Paradime | Public pages describe scheduler/orchestration and broad metrics, but the evidence gathered did not expose a complete optimization rule catalog. | Do not treat broad platform or “60+ metrics” language as 60 optimization rules. |
| Tobiko SQLMesh | SQLMesh documents audits, unit tests, environments, planning, and incremental/interval-oriented execution concepts. It is useful as a semantic validation and planning comparison. | SQLMesh is a separate transformation system, not a drop-in dbt optimizer; its audits are not proof that a dbt model can be rewritten safely. |

Coverage checklist for the agent should therefore include both “already covered elsewhere” and “gap to build.” Existing tools cover naming, lint, docs, tests, lineage, data diffs, and some cost observability. The missing layer is the join between query-history evidence, dbt graph economics, engine physical design, and a semantic equivalence gate.

### Practitioner Cases That Should Shape Prioritization

**Incrementality.** The dbt Discourse case reporting 20 seconds versus 1,500 seconds shows why the agent should inspect full-refresh versus incremental execution for the same model and not infer value from SQL size alone [66]. The failure lesson is that incrementality moves complexity into cursor, update, delete, and backfill semantics; a fast run that silently misses late records is not a successful optimization.

**Slim CI.** The reported 10x CI speedup from state/defer selection is a strong example of an orchestration optimization that changes what runs rather than changing production outputs [67]. The failure lesson is stale or incorrect state: the agent must show the selected set, deferred relations, and reasons for inclusion/exclusion.

**Materialization schedules.** dbt Labs describes a case where changing the materialization schedule reduced query time and saved Snowflake credits [72]. The mechanism is workload separation: expensive transformations can be paid once at a suitable cadence rather than repeatedly through a user-facing view. The counter-risk is freshness lag and storage cost, so the proposal must include consumer SLA and refresh schedule.

## 8 Ranked Top 20 by Expected Real-World ROI Frequency

This is a practical prior for triage, not a universal benchmark. It combines frequency of the anti-pattern, size of the potential avoided work, availability of evidence, and the number of practitioners who can act without changing the warehouse platform.

| Rank | Use-case | Why it ranks here | Minimum evidence gate | Default action |
|---:|---|---|---|---|
| 1 | Table to incremental | Repeated full scans are common and often high impact | Changed-row ratio, cursor, grain, update/delete policy | Propose |
| 2 | Push incremental/source filters earlier | Reduces work before joins and windows | Plan plus bytes/rows before and after filter | Propose |
| 3 | Fix broad merge destination scans | Merge can process a small source but scan a large target | Destination scan and safe lookback bound | Propose |
| 4 | Remove accidental routine full refresh | Avoids rebuilding history | Job arguments and run frequency | Auto-config change only with approval |
| 5 | BigQuery partition and pruning fix | Bytes billed makes benefit directly measurable | Partition filter and bytes processed | Propose |
| 6 | Snowflake clustering/pruning fix | Repeated selective scans on large tables are expensive | Query profile, pruning/overlap, maintenance estimate | Propose |
| 7 | Fix exploding or many-to-many joins | Row multiplication can dominate all downstream work | Join cardinality, key uniqueness, plan spill/shuffle | Propose-only |
| 8 | Materialize an expensive reused view | Prevents repeated recomputation by many consumers | Downstream query frequency and repeated scan cost | Propose |
| 9 | Remove `SELECT *` propagation | Lowers width and protects schema contracts | Column usage and external-consumer inventory | Generate diff/propose |
| 10 | Slim CI/state/defer | Large CI savings with low production semantic risk | State manifest age and selected-node simulation | Auto-enable in CI after simulation |
| 11 | Remove unnecessary `DISTINCT` | Expensive sort/hash often masks a join defect | Key/grain proof and plan operator cost | Propose-only |
| 12 | `UNION ALL` where disjointness is proven | Removes duplicate-elimination work | Branch predicates or unique-key proof | Auto only with proof |
| 13 | Pre-aggregate before joins/windows | Controls row multiplication and shuffle | Grain declarations and plan cardinality | Propose-only |
| 14 | Tune threads and warehouse routing | Improves critical path or removes queueing | Queue time, utilization, marginal runtime/credits | Propose |
| 15 | Remove duplicate upstream scans | Converts repeated view/CTE work into one reusable relation | Query fingerprints plus lineage fan-out | Propose |
| 16 | Bound expensive tests and freshness | Tests can repeatedly scan full history | Test SQL, partition column, required detection SLA | Propose |
| 17 | Remove or quarantine dead models | Eliminates scheduled work and maintenance | No manifest consumers plus owner/exposure confirmation | Report, then propose deletion |
| 18 | Redshift sort/dist or Databricks layout | High value where platform evidence shows skew or poor skipping | EXPLAIN/profile, skew, unsorted/data-skipping metrics | Propose |
| 19 | Snapshot and retention cleanup | Storage and recurring snapshot work compound over time | Growth curve, retention policy, historical-use inventory | Propose-only |
| 20 | Microbatch/materialized-view/dynamic-table migration | Very high impact for qualifying workloads but lower frequency and higher risk | Time-series grain, adapter support, freshness and maintenance cost | Propose-only |

The ranking should be recalculated per project using measured cost and blast radius. A BigQuery table with 99 percent partition pruning failure may jump to first place; a small Postgres project may get more value from indexes and `pg_stat_statements`-guided query rewrites than from dbt incrementalization.

## 9 Safe Auto-Fixes Versus Propose-Only Changes

### Safe or nearly safe to auto-apply after a dry run

1. SQL formatting, consistent qualification, and lint fixes that do not change the parse tree.
2. A dead-model report, unused-column report, and unused-source report. Deletion should still require owner approval.
3. Removal of a top-level `ORDER BY` when there is no `LIMIT`, window dependency, model contract requiring order, or downstream SQL relying on it. Generate a diff and compile first.
4. CI selector changes for `state:modified` and `--defer` after printing the exact selected set and comparing it with a full build on a sample or protected branch.
5. Scheduling or thread changes in a sandbox job when the agent can compare queue time, runtime, warehouse utilization, and spend.
6. Adding query tags, structured comments, or artifact collection. These improve future attribution and do not alter result semantics.
7. `UNION` to `UNION ALL` only when branch predicates are provably disjoint or a complete unique-key proof exists.
8. Explicit projection generation only when the output schema is contractually fixed, all downstream references are known, and the diff includes schema-impact warnings.

### Propose-only by default

1. Table/view/incremental/ephemeral/materialized-view/dynamic-table changes.
2. Unique keys, merge predicates, late-arrival windows, deletes, snapshots, and `on_schema_change` policies.
3. Join rewrites, `DISTINCT` removal, window-to-group rewrites, anti-join rewrites, and CTE materialization hints.
4. Partitioning, clustering, liquid clustering, ZORDER, Redshift sort/distribution changes, indexes, and warehouse routing.
5. Test `where` clauses, reduced freshness windows, snapshot retention, Time Travel, transient tables, and hook removal.
6. Deleting dead models, collapsing staging layers, or replacing shared models with macros.

Every propose-only change should include: exact files/configs, baseline queries, predicted bytes/rows/runtime/cost, correctness assumptions, affected descendants and exposures, validation SQL, rollback, and whether a targeted or full refresh is required. The agent should refuse to auto-apply if it cannot establish the declared grain or cannot identify all downstream consumers.

A useful confidence scale is:

| Confidence | Meaning | Example |
|---|---|---|
| High | Static or telemetry evidence is decisive and semantics are unchanged | Unused model report; routine full-refresh flag; top-level order removal with no limit |
| Medium | Evidence is strong but requires a contract or bounded experiment | Incremental candidate with reliable cursor; partition/clustering proposal; shared intermediate |
| Low | The change alters grain, history, ownership, or warehouse behavior | Join rewrite; snapshot strategy; unique-key invention; deletion of a model with external consumers |

## 10 Synthesis: Five Different Optimization Mechanisms, Not One

**Mechanism.** Materialization and physical design avoid repeated work by storing or organizing data. SQL rewrites reduce work per execution. DAG changes reduce duplicated work and serial barriers. Orchestration changes reduce the set and timing of executions. Quality and storage changes control secondary work and retained data. They should be scored separately because a faster model can still raise total spend if it runs more often or uses a larger warehouse.

**Scope.** A SQL rewrite is local but can affect every downstream model. A clustering key is local to a relation but benefits many consumers. Slim CI changes only development execution and is often safer. Snapshot and retention changes affect historical correctness and recovery. The agent should expose scope explicitly instead of presenting all savings as equivalent.

**Trade-off.** Views minimize storage but transfer compute to each consumer. Tables pay once per build but can become stale. Incrementals reduce steady-state work but require a correct cursor and recovery policy. Microbatch adds independent retries and parallelism [31], but only fits bounded time-series logic. Clustering and compaction improve reads but consume maintenance compute. Tests improve correctness but can be expensive; bounded tests preserve fast feedback only when paired with periodic full audits.

**Evidence.** Query history is strongest for runtime, bytes, queueing, and spend. The manifest is strongest for identity and graph structure. Compiled SQL and query plans are strongest for anti-patterns. Data diffs are strongest for semantic validation. No single evidence source can justify a high-risk recommendation.

**Time horizon.** State selection and thread tuning can produce immediate operational wins. Incrementalization, physical design, and materialization schedules produce recurring savings after deployment. DAG cleanup and DRY refactoring compound maintainability benefits. Retention and snapshot policy affect storage over months. Rank immediate savings separately from compounding savings.

The recommended product architecture is therefore a four-stage loop: detect, estimate, validate, and apply. Detect with artifacts, AST, lineage, and warehouse telemetry. Estimate with measured execution frequency and avoidable work. Validate with query plans and data diffs. Apply only changes whose semantic and operational risk matches the confidence level. This design turns the optimizer from a generic linter into an evidence-backed change planner.

## References

1. *persist_docs | dbt Developer Hub*. https://docs.getdbt.com/reference/resource-configs/persist_docs
2. *Data test configurations | dbt Developer Hub*. https://docs.getdbt.com/reference/data-test-configs
3. *tobikodata.com*. https://www.tobikodata.com/sqlmesh
4. *Datafold | Automate Data Engineering — AI-Powered Migrations, Optimization & Development*. https://www.datafold.com/
5. *Materializations | dbt Developer Hub*. https://docs.getdbt.com/docs/build/materializations
6. *full_refresh | dbt Developer Hub*. https://docs.getdbt.com/reference/resource-configs/full_refresh
7. *Use dynamic tables in dbt*. https://docs.snowflake.com/en/user-guide/dynamic-tables/dbt
8. *Snapshot configurations | dbt Developer Hub*. https://docs.getdbt.com/reference/snapshot-configs
9. *dbt_project_evaluator*. https://dbt-labs.github.io/dbt-project-evaluator/
10. *Optimize and troubleshoot dbt models on Databricks | dbt Developer Hub*. https://docs.getdbt.com/guides/optimize-dbt-models-on-databricks
11. *Working with Temporary and Transient Tables*. https://docs.snowflake.com/en/user-guide/tables-temp-transient
12. *Choose the best sort key*. https://docs.aws.amazon.com/redshift/latest/dg/c_best-practices-sort-key.html
13. *Using threads | dbt Developer Hub*. https://docs.getdbt.com/docs/running-a-dbt-project/using-threads
14. *Redshift configurations | dbt Developer Hub*. https://docs.getdbt.com/reference/resource-configs/redshift-configs
15. *How to use the Snowflake Query Profile*. https://select.dev/posts/snowflake-query-profile
16. *Defer | dbt Developer Hub*. https://docs.getdbt.com/reference/node-selection/defer
17. *Model performance | dbt Developer Hub*. https://docs.getdbt.com/docs/explore/model-performance
18. *Run results JSON file | dbt Developer Hub*. https://docs.getdbt.com/reference/artifacts/run-results-json
19. *Manifest JSON file | dbt Developer Hub*. https://docs.getdbt.com/reference/artifacts/manifest-json
20. *freshness | dbt Developer Hub*. https://docs.getdbt.com/reference/resource-properties/freshness
21. *Use liquid clustering for tables | Databricks on AWS*. https://docs.databricks.com/aws/en/tables/clustering
22. *Configure incremental models | dbt Developer Hub*. https://docs.getdbt.com/docs/build/incremental-models
23. *Optimize query computation  |  BigQuery  |  Google Cloud Documentation*. https://cloud.google.com/bigquery/docs/best-practices-performance-compute
24. *About incremental strategy | dbt Developer Hub*. https://docs.getdbt.com/docs/build/incremental-strategy
25. *Using query insights to improve performance*. https://docs.snowflake.com/en/user-guide/query-insights
26. *Clustering Keys & Clustered Tables*. https://docs.snowflake.com/en/user-guide/tables-clustering-keys
27. *About data tests property | dbt Developer Hub*. https://docs.getdbt.com/reference/resource-properties/data-tests
28. *Rules Reference¶*. https://docs.sqlfluff.com/en/stable/reference/rules.html
29. *Sort keys*. https://docs.aws.amazon.com/redshift/latest/dg/t_Sorting_data.html
30. *Introduction to clustered tables  |  BigQuery  |  Google Cloud Documentation*. https://cloud.google.com/bigquery/docs/clustered-tables
31. *About microbatch incremental models | dbt Developer Hub*. https://docs.getdbt.com/docs/build/incremental-microbatch
32. *Introduction to partitioned tables  |  BigQuery  |  Google Cloud Documentation*. https://cloud.google.com/bigquery/docs/partitioned-tables
33. *Micro-partitions & Data Clustering*. https://docs.snowflake.com/en/user-guide/tables-clustering-micropartitions
34. *dbt | SELECT Documentation*. https://select.dev/docs/dbt
35. *pre-hook & post-hook | dbt Developer Hub*. https://docs.getdbt.com/reference/resource-configs/pre-hook-post-hook
36. *Redirecting…*. https://duckdb.org/docs/stable/dev/profiling
37. *Cost Insights in the dbt platform | dbt Developer Hub*. https://docs.getdbt.com/docs/explore/cost-insights
38. *dbt for Data Products: Cost Savings, Experience, & Monetisation | Part 3*. https://moderndata101.substack.com/p/dbt-for-data-products-cost-monetisation-xp
39. *Performance Optimization in Data Pipelines with dbt | by Xavier Raju | Towards Dev*. https://medium.com/towardsdev/performance-optimization-in-data-pipelines-with-dbt-e2ea0a7510a0
40. *Evaluating dbt Cloud features vs dbt Core*. https://www.datafold.com/blog/dbt-cloud/
41. *Datafold + dbt: The Perfect Stack for Reliable Data Pipelines*. https://www.datafold.com/blog/datafold-dbt-the-perfect-stack-for-reliable-data-pipelines/
42. *dbt - Automated Testing for Analytics Engineers*. https://www.datafold.com/dbt/
43. *GitHub - DataRecce/recce: The data-validation toolkit for enhanced dbt (data build tool) PR review · GitHub*. https://github.com/DataRecce/recce
44. *dbt Labs Visionary Consulting Partner | dbt Consulting Services - Analytics8*. https://www.analytics8.com/technologies/dbt-partners/
45. *Recce - Your AI Data Review Agent*. http://reccehq.com/
46. *Paradime or dbt Cloud™ | Get ahead or stay behind*. https://www.paradime.io/paradime-vs-dbt-cloud
47. *How dbt Labs tunes model performance and optimizes cloud data platform costs - Coalesce 2023 - YouTube*. https://www.youtube.com/watch?v=c8a6PExx9qw
48. *Docs + Testing: Are We Optimizing for the Wrong Thing?*. https://tobikodata.com/blog/optimizing-for-what
49. *Montara | Give your analysts superpowers*. https://www.montara.io/
50. *sqlmesh.readthedocs.io*. https://sqlmesh.readthedocs.io/
51. *Data Reviewer Workflow - Recce Docs*. https://docs.reccehq.com/using-recce/data-reviewer/
52. *SQLMesh for dbt Users - Part 1*. https://www.tobikodata.com/blog/sqlmesh-for-dbt-1
53. *Introduction to Amazon Redshift - Amazon Redshift*. https://docs.aws.amazon.com/redshift/latest/dg/STL_QUERY.html
54. *Lineage Diff - Recce Docs*. https://docs.reccehq.com/what-you-can-explore/lineage-diff/
55. *Best practices for data diffing with a shift-left approach*. https://www.datafold.com/blog/best-practices-for-data-diffing/
56. *Expert paradime dbt cloud cost optimization*. https://dynamicdata.com/feeds/service/dbt-cloud-cost-optimization-services
57. *PostgreSQL: Documentation: 18: F.32. pg_stat_statements — track statistics of SQL planning and execution*. https://www.postgresql.org/docs/current/pgstatstatements.html
58. *Paradime Pricing | Predictable pricing for companies of any scale*. https://www.paradime.io/pricing
59. *QUERY_HISTORY view*. https://docs.snowflake.com/en/sql-reference/account-usage/query_history
60. *dbt - SQLMesh*. https://sqlmesh.readthedocs.io/en/stable/integrations/dbt
61. *GitHub - SQLMesh/sqlmesh: Scalable and efficient data transformation framework - backwards compatible with dbt. · GitHub*. https://github.com/SQLMesh/sqlmesh
62. *Data Validation Toolkit for dbt Data Projects*. https://blog.reccehq.com/data-validation-toolkit-for-dbt-data-projects
63. *JOBS view  |  BigQuery  |  Google Cloud*. https://cloud.google.com/bigquery/docs/information-schema-jobs
64. *SYS_QUERY_HISTORY*. https://docs.aws.amazon.com/redshift/latest/dg/SYS_QUERY_HISTORY.html
65. *Query history system table reference | Databricks on AWS*. https://docs.databricks.com/aws/en/admin/system-tables/query-history
66. *On the limits of incrementality - In-Depth Discussions*. https://discourse.getdbt.com/t/on-the-limits-of-incrementality/303
67. *How we sped up our CI runs by 10x using Slim CI*. https://discourse.getdbt.com/t/how-we-sped-up-our-ci-runs-by-10x-using-slim-ci/2603
68. *Model query history | dbt Developer Hub*. https://docs.getdbt.com/docs/explore/model-query-history
69. *QUERY_HISTORY , QUERY_HISTORY_BY_**. https://docs.snowflake.com/en/sql-reference/functions/query_history
70. *Performance - dbt_project_evaluator*. https://dbt-labs.github.io/dbt-project-evaluator/latest/rules/performance/
71. *SELECT: Data cloud cost observability and optimization*. https://select.dev/
72. *Optimizing query run time with materialization schedules*. https://www.getdbt.com/blog/optimizing-query-run-time-with-materialization-schedules
