---
title: "FinOps Tools — Cost Optimization — Altimate Code"
description: "Monitor warehouse costs, query history, and credits with Altimate Code's FinOps tools including finops_query_history."
---

# FinOps Tools

Cost optimization and warehouse governance. These tools help you find where money is being wasted and fix it.

!!! note "v0.7.3+ — warehouse parameter is now optional"
    Every `finops_*` tool used to require an explicit `warehouse=<connection-name>` argument. As of v0.7.3, the parameter is optional — if omitted, the tool auto-picks the first configured warehouse whose driver type supports the operation. Pass `warehouse=` explicitly when you have multiple compatible connections and want a specific one. The bare form (`finops_query_history --days 7`) works.

## finops_query_history

Fetch recent query execution history from your warehouse.

```
> finops_query_history prod-snowflake --days 7

Recent Queries (top 10 by cost):
┌───┬──────────────────────────────────┬──────────┬────────┬───────────┬─────────┐
│ # │ Query (truncated)                │ Credits  │ Rows   │ Duration  │ Runs    │
├───┼──────────────────────────────────┼──────────┼────────┼───────────┼─────────┤
│ 1 │ SELECT * FROM events JOIN use... │ 89.3     │ 2.1B   │ 4m 12s    │ 47      │
│ 2 │ CREATE TABLE AS SELECT DISTIN... │ 45.1     │ 340M   │ 12m 33s   │ 1       │
│ 3 │ SELECT COUNT(DISTINCT user_id... │ 23.7     │ 890M   │ 1m 45s    │ 312     │
│ 4 │ INSERT INTO daily_agg SELECT... │ 18.2     │ 45M    │ 3m 21s    │ 7       │
│ 5 │ SELECT * FROM raw_clickstream...│ 12.8     │ 1.5B   │ 2m 08s    │ 3       │
└───┴──────────────────────────────────┴──────────┴────────┴───────────┴─────────┘

Summary:
  Total queries: 4,231
  Total credits: 847.2
  Avg credits/query: 0.20
```

**Parameters:**
- `warehouse` (optional, since v0.7.3): Connection name. If omitted, the first configured Snowflake / BigQuery / Databricks / PostgreSQL warehouse is auto-picked.
- `days` (optional, default: 7): Lookback period
- `limit` (optional, default: 100): Max queries returned
- `user` (optional): Filter by username
- `warehouse_filter` (optional, Snowflake-only): Filter the result rows by the in-warehouse compute name (different from the `warehouse` connection parameter). Use `warehouse` to pick which connection to query; use `warehouse_filter` to narrow which Snowflake virtual warehouse's queries appear in the output.

**Data sources by warehouse:**
- Snowflake: `QUERY_HISTORY` function
- BigQuery: region-qualified `` `region-<location>.INFORMATION_SCHEMA.JOBS` `` — the region is auto-resolved from the BigQuery connection's `location` (e.g. `us`, `eu`, `us-central1`, `asia-northeast1`). If `location` is unset the tool defaults to `us`. Set `location` explicitly for non-US projects or you will query the wrong region.
- Databricks: `system.query.history`
- PostgreSQL: `pg_stat_statements`

---

## finops_analyze_credits

Break down credit consumption by warehouse, time, and user.

```
> finops_analyze_credits --days 30
# equivalent: finops_analyze_credits prod-snowflake --days 30

Credit Analysis (last 30 days):

Daily Usage Trend:
  Feb 1:  ████████████░░░░░░░░  28.4 credits
  Feb 2:  ███████████████░░░░░  35.1 credits
  ...
  Feb 26: ██████████████████░░  42.7 credits

By Warehouse:
  TRANSFORM_WH (XL):    523.1 credits (62%) ← largest cost driver
  ANALYTICS_WH (M):     187.3 credits (22%)
  LOADING_WH (S):        89.4 credits (11%)
  DEV_WH (XS):           47.4 credits (6%)

Recommendations:
  1. TRANSFORM_WH runs at 23% utilization, consider downsizing to L
  2. 340 queries on ANALYTICS_WH scan >1GB but return <100 rows, add filters
  3. DEV_WH has 0 queries between 2am-8am, enable auto-suspend
```

---

## finops_expensive_queries

Find your most expensive queries ranked by cost.

```
> finops_expensive_queries prod-snowflake --days 7 --limit 5

Top 5 Expensive Queries:

1. 89.3 credits | 47 executions | TRANSFORM_WH
   SELECT * FROM events e JOIN users u ON e.user_id = u.id
   Anti-patterns: SELECT_STAR, MISSING_LIMIT
   Fix: Add column list + date filter → estimated 71% savings

2. 45.1 credits | 1 execution | TRANSFORM_WH
   CREATE TABLE daily_snapshot AS SELECT DISTINCT ...
   Anti-patterns: None (legitimate full-table operation)
   Suggestion: Use incremental logic instead of full refresh

3. 23.7 credits | 312 executions | ANALYTICS_WH
   SELECT COUNT(DISTINCT user_id) FROM events WHERE ...
   Anti-patterns: None
   Suggestion: Pre-aggregate in a materialized view, which saves ~23 credits/week

4. 18.2 credits | 7 executions | TRANSFORM_WH
   INSERT INTO daily_agg SELECT ... FROM raw_events
   Anti-patterns: SELECT_STAR_IN_SUBQUERY
   Fix: Explicit columns → estimated 40% savings

5. 12.8 credits | 3 executions | ANALYTICS_WH
   SELECT * FROM raw_clickstream WHERE event_type = 'page_view'
   Anti-patterns: SELECT_STAR
   Fix: Add column list + LIMIT → estimated 80% savings
```

---

## finops_warehouse_advice

Get warehouse sizing recommendations based on actual usage patterns.

```
> finops_warehouse_advice prod-snowflake --days 14

Warehouse Analysis:

TRANSFORM_WH (currently: X-Large)
  Avg utilization: 23%
  Peak utilization: 67% (Wed 2-4am during batch jobs)
  Avg queue time: 0.3s
  Recommendation: ↓ Downsize to LARGE
  Estimated savings: 210 credits/month ($630/month)

ANALYTICS_WH (currently: Medium)
  Avg utilization: 71%
  Peak utilization: 95% (Mon-Fri 9am-12pm)
  Avg queue time: 4.2s during peak
  Recommendation: → Keep current size, enable auto-scaling (max 2 clusters)
  Estimated impact: Queue time drops to <1s during peak

LOADING_WH (currently: Small)
  Avg utilization: 45%
  Peak utilization: 89% (daily at 6am)
  Recommendation: → Keep current size
  Auto-suspend: Currently 5min, recommend 1min (saves 12 credits/month)

DEV_WH (currently: X-Small)
  Avg utilization: 8%
  Active hours: 9am-6pm weekdays only
  Recommendation: → Keep size, set auto-suspend to 1min
  Estimated savings: 15 credits/month
```

---

## finops_unused_resources

Find tables and warehouses that are costing money but not being used.

```
> finops_unused_resources prod-snowflake --days 30

Unused Tables (no reads in 30 days):
  1. RAW.LEGACY_EVENTS (450GB, last accessed 2025-11-03)
  2. STAGING.STG_OLD_USERS (12GB, last accessed 2025-12-15)
  3. ANALYTICS.TMP_MIGRATION_2024 (89GB, last accessed 2025-08-22)
  Total storage: 551GB → ~$23/month in storage costs

Idle Warehouses (no queries in 7+ days):
  1. MIGRATION_WH (Medium), last query 2026-02-10
  2. TEST_WH (Small), last query 2026-01-28

Recommendations:
  1. Archive or drop the 3 unused tables → save $23/month
  2. Suspend MIGRATION_WH and TEST_WH → save credits on auto-resume
```

---

## finops_databricks_savings

Check a Databricks workspace for savings with Altimate's rules, on a Databricks connection whose `http_path` is a SQL warehouse (`/sql/1.0/warehouses/<id>`). It reads seven days of system tables (`system.billing`, `system.compute`, `system.query`, `system.lakeflow`) on that warehouse, which Databricks starts if it is stopped. System tables cover every workspace of the account they can see, so one connection checks all of them; each finding names its workspace. Nothing is written. Four checks:

- **Migrate Classic/Pro to Serverless:** a Classic or Pro warehouse that bills for time it sits idle.
- **Over-Sized Warehouse:** a warehouse whose queries never use the cores it pays for.
- **Idle Cluster Detection:** an all-purpose cluster with idle workers and auto-termination off or an hour or more.
- **Job Running on All-Purpose Compute:** a job with at least one scheduled run in the seven days, or at least 24 hours of continuous running in one task, on an all-purpose cluster. Its DBUs would bill at the jobs-compute rate on a job cluster.

The tool measures each resource's usage; altimate-core decides what qualifies and what it saves. Prices are list prices. Each resource is counted once in the total, and each flagged warehouse also gets what it would cost at every smaller size and as serverless. If the connection cannot read the cluster or job tables, that check is named as not checked and the warehouse checks still report; the warehouse tables themselves are required.

**What it does not assess.** Databricks Apps spend is not covered, and a serverless SQL warehouse gets only the Over-Sized Warehouse check. A SQL warehouse's cost is its billed usage for the six full days before the window's last day, counting only records Databricks had ingested before that day, spread over the seven-day window as Altimate's pipeline does, so it reads lower than seven days of billing (on one measured workspace, about 7% lower). A cluster's cost is its billed usage for the seven full days before the window's last day. A job's cost is estimated, because Databricks billing does not name the job on all-purpose compute: its task hours from the job timeline times the DBUs per hour its cluster billed. When the jobs on one cluster would add up to more DBUs than it billed, their estimates are scaled down to fit. The connection needs the `@databricks/sql` driver installed.

**Asks first, and stops long queries.** A run can start a stopped warehouse that then bills, so in a session you are asked before the first query (permission `finops_databricks_savings`, which you can set to `allow` in your config). `altimate-code tool run` cannot prompt, so running it is your go-ahead; the Claude Code `/savings` command runs it that way when you type it. `altimate run` cannot prompt either and rejects the request, so there the check runs only with the permission set to `allow` or with `--yolo`. Over MCP (`altimate-code mcp serve`) the model makes the call and nothing can ask you, so the check runs only when the server was started with both `--all-tools` (it is not in the default set) and `--allow-write`. It runs three queries and stops after 9 minutes, connecting included, cancelling any query still running on the warehouse (or sooner, at an `altimate run --time-budget` cutoff); stopping the session cancels the running query too.

**Assessment mode.** Set `ALTIMATE_ASSESSMENT_MODE=true` to keep a savings check from contacting anything but your warehouse. It sends no telemetry (not even the one-time opt-out event), treats you as signed out of Altimate (no workspace or project-binding lookups; workspace skills already on disk stay as they are, and pulled team rules are not applied while it is on), fetches no remote config and installs no plugin dependencies, and downloads neither the model catalog (models.dev) nor ripgrep (github.com). Any value but empty, `0` or `false` turns it on, and a tool daemon started without it is not reused. It is measured for `tool run` of the two savings tools. Other tools and commands are not covered: a signed-in user's other Altimate tools can still reach Altimate, and so can the update check and language-server downloads. Core's compiled analysis is not audited for network use. Without it, `ALTIMATE_TELEMETRY_DISABLED=true` alone still lets the CLI send that opt-out event and fetch those. The Claude Code `/savings` command sets it for you. Tool results shown in a Claude Code conversation reach its model provider; assessment mode does not change that.

```
> finops_databricks_savings --warehouse prod_dbx

Databricks savings: 7 SQL warehouses, 3 all-purpose clusters, 12 jobs checked, the 7 days to 2026-11-17, at list price.
Total: $85.17–$106 a month on 1 resource, each counted once at its largest saving.

Classic (sql warehouse, workspace 525779153077873) · Migrate Classic/Pro to Serverless · $85.17–$106 a month (critical)
  CLASSIC SMALL warehouse, 95% idle over 10.8 running hours (2,988 queries)
  $29.29 in DBUs over the window; serverless would bill $4.44 for the busy time alone

What Classic (now SMALL (CLASSIC), $125 a month) would cost instead:
  SERVERLESS: $19.03 a month, saving $106
  X-SMALL: $62.60 a month, saving $62.60
  2X-SMALL: $41.73 a month, saving $83.47
```


---

## finops_snowflake_savings

Check a Snowflake account for savings with Altimate's rules. It lists warehouses with `SHOW WAREHOUSES` and, to report on seven days, reads up to eleven days of usage from `SNOWFLAKE.ACCOUNT_USAGE` (`WAREHOUSE_METERING_HISTORY`, `WAREHOUSE_EVENTS_HISTORY`, `QUERY_HISTORY`), read-only, on the connection's warehouse. The role needs `IMPORTED PRIVILEGES` on the `SNOWFLAKE` database, and sees only the warehouses it has access to; warehouses that billed credits but cannot be listed are named as not checked, and so is usage an earlier warehouse billed under a name a newer one now has.

**Warehouses that shared a name.** `SHOW WAREHOUSES` gives names, not ids, so the check also reads warehouse creations (`CREATE_WAREHOUSE`) and drops (`DROP_WAREHOUSE`) from `WAREHOUSE_EVENTS_HISTORY`, which keeps a year. A dropped warehouse's usage never counts for a warehouse listed now, and a warehouse created within that year gets the usage of its own id, under any name it had: the view records no renames, but a renamed warehouse keeps its id. A warehouse the events cannot name (created more than a year ago, or in the same second as another) is matched by name and creation time, so it can still get the usage of a warehouse that used its name before: one renamed away that has not run under its new name, or one dropped in the last few hours, which the view (up to three hours behind) does not show yet. If the events cannot be read in full, every warehouse is matched by name and creation time, and the result says so.

- **High Idle Time:** on days a warehouse sat idle for more than 40% of its active time, the idle share of that day's cost.
- **Downsize Warehouse:** nearly all queries finish within 5 seconds, or nearly all active periods last 80 seconds or less, so one size smaller would do.
- **Underutilized Cluster:** the highest cluster of a multi-cluster warehouse is barely needed. It is reported without a dollar estimate.
- **Frequent Restart Overcharge:** a warehouse that suspends and resumes within one billed minute pays the overlap twice.

The tool measures each warehouse's usage; altimate-core decides what qualifies and what it saves. Credits are priced from `ORGANIZATION_USAGE.RATE_SHEET_DAILY` when the role can read it in dollars, otherwise at $3.00 (also for an account billed in another currency), and the output says which. Each warehouse is counted once in the total.

**What it does not assess.** These are four of Altimate's warehouse checks. Storage, serverless features and individual query tuning are not covered. As in Altimate's hosted product, idle time is measured within active periods (resume to the next suspend or resume) that ran at least one query, and a period counts on the day it started: a warehouse that never suspended in the window has no completed active period, and one resumed and left running with no query at all adds no idle time, so neither gets an idle finding for that time. Days are UTC, and the window ends at 00:00 UTC on the latest day at least six hours past, because `ACCOUNT_USAGE` lags by up to that long.

**Asks first, and stops long queries.** A run can resume a suspended warehouse that then bills, so in a session you are asked before the first query (permission `finops_snowflake_savings`, which you can set to `allow` in your config); `altimate-code tool run` cannot prompt, so running it is your go-ahead. `altimate run` cannot prompt either and rejects the request, so there the check runs only with the permission set to `allow` or with `--yolo`. Over MCP (`altimate-code mcp serve`) the model makes the call and nothing can ask you, so the check runs only when the server was started with both `--all-tools` (it is not in the default set) and `--allow-write`. It runs seven queries and stops after 9 minutes, connecting included, cancelling any query still running on Snowflake (or sooner, at an `altimate run --time-budget` cutoff); stopping the session cancels the running query too.

**Assessment mode.** `ALTIMATE_ASSESSMENT_MODE=true` works as it does for `finops_databricks_savings`: the run contacts your Snowflake account, and turns off the Snowflake driver's cloud-platform detection. If a result is large enough for Snowflake to deliver it from its own cloud storage, the driver fetches it from there too.

```
> finops_snowflake_savings --warehouse prod_sf

Snowflake savings: 12 warehouses checked, the 7 days to 2026-11-18, at $3.00 a credit from the account's rate sheet.
Total: $54.00–$90.00 a month on 1 warehouse, each counted once at its largest saving.

BI_WH (warehouse) · Downsize Warehouse · $54.00–$90.00 a month (medium)
  Large could be Medium: 95.0% of its active periods lasted 80 seconds or less
  The saving is a share of $42.00 over the window
```

---

## finops_role_grants

Analyze role permissions and access patterns (RBAC).

```
> finops_role_grants prod-snowflake --role ANALYST_ROLE

Grants for ANALYST_ROLE:
┌──────────────┬───────────┬──────────────────────────┐
│ Privilege    │ Type      │ Object                   │
├──────────────┼───────────┼──────────────────────────┤
│ USAGE        │ WAREHOUSE │ ANALYTICS_WH             │
│ USAGE        │ DATABASE  │ ANALYTICS                │
│ USAGE        │ SCHEMA    │ ANALYTICS.MARTS          │
│ SELECT       │ TABLE     │ ANALYTICS.MARTS.*        │
│ SELECT       │ TABLE     │ ANALYTICS.STAGING.*      │
│ USAGE        │ SCHEMA    │ ANALYTICS.RAW            │
│ SELECT       │ TABLE     │ ANALYTICS.RAW.*          │
└──────────────┴───────────┴──────────────────────────┘

Privilege Summary:
  SELECT on 847 tables across 3 schemas
  No INSERT/UPDATE/DELETE privileges ✓
  No DDL privileges ✓
```

---

## finops_role_hierarchy

Visualize role inheritance.

```
> finops_role_hierarchy prod-snowflake

Role Hierarchy:
  ACCOUNTADMIN
  ├── SYSADMIN
  │   ├── TRANSFORM_ROLE
  │   │   └── DBT_ROLE
  │   ├── LOADING_ROLE
  │   └── ADMIN_ROLE
  ├── SECURITYADMIN
  │   └── USERADMIN
  └── PUBLIC
      ├── ANALYST_ROLE
      └── VIEWER_ROLE

8 roles total
```

---

## finops_user_roles

List user-to-role assignments.

```
> finops_user_roles prod-snowflake

┌──────────────────┬────────────────┬───────────────┐
│ User             │ Role           │ Default Role  │
├──────────────────┼────────────────┼───────────────┤
│ alice@company.com│ ANALYST_ROLE   │ YES           │
│ alice@company.com│ VIEWER_ROLE    │ NO            │
│ bob@company.com  │ TRANSFORM_ROLE │ YES           │
│ bob@company.com  │ DBT_ROLE       │ NO            │
│ svc_dbt          │ DBT_ROLE       │ YES           │
│ svc_fivetran     │ LOADING_ROLE   │ YES           │
└──────────────────┴────────────────┴───────────────┘
```
