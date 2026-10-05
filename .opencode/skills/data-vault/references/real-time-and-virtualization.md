# Real-Time Loading and Virtualization

Data Vault 2.0's book explicitly treats real-time and near-real-time
loading as first-class. The vault's insert-only + hash-key
architecture is exceptionally well-suited to streaming — hubs, links,
and satellites can be loaded independently, in parallel, from stream
consumers, without needing to look up surrogate IDs.

This reference covers the patterns for continuous ingestion, and
its close cousin: **virtualization** — serving marts as views over
the vault so downstream sees "current" data with no additional
latency.

## Latency Tiers

DV 2.0 loading falls into three tiers:

| Tier | Latency target | Load pattern |
|------|----------------|--------------|
| **Batch** | Hours to daily | Scheduled dbt runs, full-refresh permitted |
| **Micro-batch** | 5–60 minutes | Frequent incremental dbt runs; streams+tasks |
| **Real-time** | < 1 minute (often sub-second) | Direct stream consumers writing to vault; dynamic tables |

Choose per-feed. Not every feed needs sub-second latency; not every
project can afford it. Reserve real-time for feeds that genuinely
drive real-time decisions.

## Real-Time Load Architecture

The book prescribes:

1. **Landing zone** — raw events stream into a staging table
   (Snowflake stream, BigQuery streaming buffer, Kafka topic,
   Databricks Delta Live Table). One record per source event.
2. **Real-time staging** — a stream consumer transforms landing
   into hashed staging (adds hash keys, hashdiffs, metadata).
3. **Real-time vault loaders** — one process per hub / link /
   satellite, each consuming from the real-time staging stream
   and appending to its target vault table.
4. **Virtualized information marts** — views over the vault so
   consumers see the newest data with no additional processing
   latency.

Each vault loader is independent — because hash keys are
deterministic from business keys, no cross-loader synchronization
is required. Hub loader for `hub_customer` doesn't wait for
`hub_order`; both compute the same hash key from the same source
input.

## Real-Time on Snowflake (Streams + Tasks)

Fully covered in [snowflake-specific.md](snowflake-specific.md).
Summary:

- Create a `STREAM` on each staging source.
- Create a `TASK` per vault loader that runs `WHEN
  SYSTEM$STREAM_HAS_DATA(...)` on a 1-5 minute schedule.
- Each task inserts into its target vault table with the same
  insert-only + anti-join discipline as batch loads.

Trade-offs: task warehouse cost while running; 1-minute task
minimum granularity.

## Real-Time on Snowflake (Dynamic Tables)

Newer alternative — declarative refresh with target lag:

```sql
CREATE OR REPLACE DYNAMIC TABLE hub_customer_rt
    TARGET_LAG = '2 minutes'
    WAREHOUSE = wh_dv_stream
    REFRESH_MODE = INCREMENTAL
AS
    SELECT
        MD5_BINARY(...) AS customer_hk,
        customer_id     AS customer_bk,
        MIN(ingestion_time) AS load_dts,     -- earliest source ingestion
        MIN(source_name)    AS record_source
    FROM staging_customer_stream
    WHERE customer_id IS NOT NULL
    GROUP BY MD5_BINARY(...), customer_id;
```

Snowflake handles the incremental refresh, choosing when to
recompute based on the target lag. Cost is metered against a
warehouse; auto-suspends between refreshes.

Best fit: hubs and standard links. Satellites are trickier because
`load_dts = CURRENT_TIMESTAMP()` in a dynamic-table definition
produces new hashdiffs on every refresh; the satellite churns.
Work-around: use `LEAST(existing_load_dts, current_load_dts)`
patterns, or stay with tasks for satellites.

## Real-Time on BigQuery

- **Streaming inserts** to a landing table (BigQuery Streaming API).
- **Scheduled queries** (5-minute minimum) as vault loaders.
- **Materialized views** for aggregation marts (with `refresh_intervals_minutes = 5`).
- **Data Transfer Service** for CDC from operational databases.

BigQuery's streaming buffer has a lag (~90 seconds) before data is
queryable via SQL, plus a per-partition-per-day insertion limit — a
constraint on very-high-volume feeds.

## Real-Time on Databricks

- **Delta Live Tables (DLT)** with continuous mode for streaming
  vault loaders.
- **Structured Streaming** jobs writing to Delta tables.
- **Autoloader** for CDC from cloud storage.

Databricks' `MERGE INTO` with `WHEN NOT MATCHED THEN INSERT` gives
insert-only semantics that respect DV 2.0 discipline (only inserts,
no updates).

## Real-Time Load Idempotency

Real-time loading introduces new failure modes:

1. **Duplicate events.** Stream sources often deliver at-least-once,
   so the same source event may appear twice.
2. **Late events.** An event's timestamp may be older than the
   current vault's `MAX(load_dts)`.
3. **Out-of-order events.** Event A ingested at 10:01:00 arrives
   after event B ingested at 10:01:05.

All three are handled correctly by the standard insert-only + hash
key + anti-join pattern:

1. **Duplicates** → anti-join filters. Same hash key, same load
   → same vault row; second insert is filtered by the anti-join.
2. **Late events** → hub sees the business key for the first time,
   inserts. Satellite compares hashdiff to whatever the latest is
   for that parent; if the late event's payload differs, inserts.
3. **Out-of-order** → satellite may end up with `load_dts` values
   that are non-monotonic relative to actual event time. That's
   fine — `load_dts` is ingestion time, not event time. If event
   time matters, use bi-temporal (see [multi-temporal.md](multi-temporal.md)).

## Virtualization — Views Over the Vault

If loads are real-time, so should be the consumer view. Instead of
materializing marts, **virtualize** — expose marts as `view` (or
Snowflake secure view, BigQuery authorized view, Databricks
materialized view with low refresh interval):

```sql
-- models/information_marts/virtualized/vdim_customer.sql
{{ config(materialized='view', tags=['information_mart', 'virtualized']) }}

WITH latest_pii AS (
    SELECT customer_hk, first_name, last_name, email
    FROM {{ ref('sat_customer_pii') }}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_hk ORDER BY load_dts DESC) = 1
),
latest_addr AS (
    SELECT customer_hk, address_line_1, city, postal_code
    FROM {{ ref('sat_customer_address') }}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_hk ORDER BY load_dts DESC) = 1
)

SELECT
    h.customer_hk           AS customer_key,
    h.customer_bk           AS customer_id,
    p.first_name,
    p.last_name,
    p.email,
    a.address_line_1,
    a.city,
    a.postal_code
FROM {{ ref('hub_customer') }} h
LEFT JOIN latest_pii p  USING (customer_hk)
LEFT JOIN latest_addr a USING (customer_hk)
WHERE h.customer_bk <> '^^'
```

Every query hits the vault directly and sees the newest data with
no additional load delay. Consumers get "real-time" without a
separate real-time pipeline for the mart.

### Virtualization Trade-Offs

**Pros:**
- Zero mart-load latency — every vault write is immediately visible.
- No PIT / bridge to maintain for freshness (though PITs may still
  help for as-of-history queries).
- Cheap to add / change / retire marts.

**Cons:**
- Every query re-executes the mart's join graph. On billion-row
  satellites with N-way joins, prohibitively expensive.
- Some BI tools cache view definitions and get stale.
- Query planner can't optimize as well as it can for pre-materialized
  tables.

**Rule of thumb:**
- Small vaults (< 100M satellite rows), infrequent BI queries →
  virtualize everything.
- Large vaults, high query volume → virtualize exploration / dev
  marts, materialize production marts.
- Hybrid — virtualize for the current view, materialize for
  historical PIT-based views.

### Snowflake Materialized Views for the Middle Ground

Snowflake's materialized views auto-refresh on source change and
serve reads from the cache — a compromise between full
materialization and full virtualization. Available on Enterprise
edition, with restrictions (no self-joins, no window functions).

## Real-Time PIT Refresh

PIT tables are, by definition, snapshot-based. In a real-time
world, PITs have two options:

1. **Skip the PIT for real-time consumers**; virtualize the mart
   with `MAX(load_dts)` per satellite inline. Simpler for
   current-state queries.
2. **PIT with continuous refresh** — Snowflake dynamic table or
   BigQuery scheduled query on a small interval. Retain PITs for
   as-of-history queries; virtualized marts serve current-state.

## Common Real-Time / Virtualization Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Streaming everything | Cost blows up; most feeds don't need it | Choose latency tier per feed based on downstream need |
| Dynamic table for satellites with `CURRENT_TIMESTAMP()` in the definition | Every refresh generates new hashdiff → satellite bloats | Use tasks for satellites, or design the satellite's `load_dts` to come from the source event |
| Stream consumer without anti-join | Duplicate events insert duplicate hub rows | Standard insert-only anti-join filter |
| Ignoring at-least-once semantics | Downstream sees duplicates | Deduplicate in the stream consumer via anti-join |
| Virtualized mart over billion-row satellites | Every mart query scans full satellites | Materialize; or add PIT + materialize the PIT |
| Marts stale despite real-time vault | Consumer sees old data because mart is `table` with daily rebuild | Virtualize the mart or reduce rebuild cadence |
| Mixing latency tiers within one mart | Some columns fresh, some stale; inconsistent snapshot | All satellites feeding a mart should share the same load cadence |
| Streaming source's `event_time` used as `load_dts` | Out-of-order events break the vault's monotonic history | `load_dts` is ingestion time; `event_time` is a descriptive column |
| Real-time load without metrics/error emission | Streaming pipeline failures invisible | Extend metrics vault to streaming loaders; alert on rejection spikes |
| Assuming "real-time = correct-time" | Business events may still need bi-temporal for retro corrections | Real-time doesn't remove the need for bi-temporal thinking |
