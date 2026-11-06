# CDC and Streaming Source Ingestion

Real enterprise sources rarely arrive as clean, current-state row
dumps. They arrive as Debezium/GoldenGate/Fivetran change streams,
SaaS REST APIs with pagination, event-sourced JSON payloads with
nested arrays, or hybrid batch+stream feeds. The DV 2.0 modeling
patterns are engine-agnostic — this reference is what to do
*upstream* of them so the vault sees clean, correctly-typed,
insert-only-friendly rows.

**When to load this reference:** whenever ingestion is CDC-based
(Debezium, GoldenGate, Oracle LogMiner, SQL Server CDC/CT, Fivetran
CDC connectors), event-streaming (Kafka, Kinesis, Pub/Sub, Event
Hubs), or paginated REST APIs. Skip for simple daily bulk-dump
sources — the existing [staging-layer.md](staging-layer.md) covers
those.

---

## Ask the User First — CDC Design Decisions

Before choosing patterns from this reference, get answers to:

1. **What's the CDC mechanism?** Debezium/Kafka Connect / GoldenGate
   / Fivetran / Airbyte / native (Snowpipe Streaming, BigQuery
   Datastream) / homebrew. Each emits a different event shape and
   handles order/duplicates differently.
2. **What's the delivery guarantee?** At-least-once (default; you
   need dedup), exactly-once (rare; still verify), at-most-once
   (usually unacceptable).
3. **Are deletes captured?** Some CDC pipelines drop DELETE
   operations (Fivetran default). Others emit tombstones. Others
   emit soft-delete flags. Modeling depends on this.
4. **What's the ordering guarantee?** Per-key ordered (Kafka with
   key partitioning) / globally ordered / not ordered. Not-ordered
   CDC needs different reconciliation.
5. **Are schemas evolving?** Debezium emits schema changes as
   events; Fivetran syncs them silently. Auto-evolution vs. manual
   sign-off is a governance choice.
6. **What's the volume + latency target?** 100 events/day →
   micro-batch is fine. 100k events/second → dedicated streaming
   loader per feed.
7. **Semi-structured payloads?** JSON columns with nested objects
   and arrays need explicit hashing decisions (see below). Ask
   whether the business queries the nested structure or treats it
   as opaque.
8. **API pagination?** Which cursor mechanism (page number,
   timestamp, ID watermark, opaque token)? Rate limits? Retry
   semantics on partial-page failure?

**Do not assume defaults.** The wrong assumption on delivery
guarantee turns into duplicate hub rows; the wrong assumption on
delete handling turns into "our vault says these customers still
exist but the source deleted them 6 months ago."

---

## CDC Event Shape (Debezium-Style)

Most modern CDC systems emit events that look roughly like:

```json
{
  "op":       "c" | "u" | "d" | "r",   // create / update / delete / read (snapshot)
  "ts_ms":    1700000000000,           // source txn timestamp
  "source":   { "db": "prod", "table": "customers", "lsn": 42, ... },
  "before":   { "customer_id": "C-100", "email": "old@x", ... }, // null on 'c'
  "after":    { "customer_id": "C-100", "email": "new@x", ... }  // null on 'd'
}
```

The DV loader has to answer:

| Question | Answer |
|----------|--------|
| Where does this land? | A "landing" CDC event table (append-only, insert-only in its own right) |
| How does `after` map to a satellite row? | `after` fields → hashed staging → satellite |
| What does `d` mean for the hub? | Nothing — hub stays. Deletion is recorded in a status-tracking sat |
| What does `d` mean for the satellite? | Insert a final "as-deleted" row, or leave the satellite alone (depending on business semantics) |
| Ordering guarantee? | Depends on the CDC pipeline (see above) |

### The Landing → Staging → Vault Split

```
Kafka topic / Kinesis stream / Fivetran log
             │
             ▼
    landing.cdc_events               ← every event, insert-only, with op + ts + payload
             │
             ▼
    staging.stg_<src>__cdc_view      ← projects op = 'c'/'u'/'r' rows; extracts columns
             │
             ▼
    staging.stg_<src>__<table>__hashed  ← adds hash + hashdiff + load metadata
             │
             ▼
    raw_vault.{hub,link,sat,sts}
```

The landing table is the ultimate replay source. Never drop it. Archive
old partitions after N days per retention policy.

### CDC Landing Table

```sql
CREATE TABLE landing.cdc_events (
    event_id          VARCHAR         NOT NULL PRIMARY KEY,   -- from CDC producer
    source_db         VARCHAR         NOT NULL,
    source_table      VARCHAR         NOT NULL,
    operation         CHAR(1)         NOT NULL,               -- c/u/d/r
    source_ts         TIMESTAMP       NOT NULL,               -- from CDC payload
    ingested_at       TIMESTAMP       NOT NULL,               -- when WE received it
    lsn               VARCHAR,                                -- log sequence for ordering
    before_payload    VARIANT,                                -- JSON blob
    after_payload     VARIANT,                                -- JSON blob
    schema_version    VARCHAR                                 -- from CDC producer
);
```

Cluster / partition on `(source_table, ingested_at)`. Retention:
90-180 days typical.

---

## Operation-Type Handling

Each CDC operation type maps differently to vault objects.

### `c` (create) and `u` (update) → hub + link + sat

Standard load path. The `after` payload is what you hash.

```sql
-- staging: filter to c/u/r operations, project after_payload as source columns
CREATE VIEW staging.stg_crm__customers AS
SELECT
    after_payload:customer_id::VARCHAR         AS customer_id,
    after_payload:email::VARCHAR               AS email,
    after_payload:first_name::VARCHAR          AS first_name,
    after_payload:updated_at::TIMESTAMP        AS updated_at,
    source_ts,                                  -- keep for optional bi-temporal use
    ingested_at,
    operation
FROM landing.cdc_events
WHERE source_table = 'customers'
  AND operation IN ('c', 'u', 'r');
```

Downstream `stg_crm__customers__hashed` and vault loads are unchanged
from the batch case.

### `r` (snapshot read) → same as `c`

Debezium's initial-snapshot events are `r` (read). Treat identically
to `c` for loading. Distinguish only for observability (metrics
vault records the batch as "initial snapshot" vs. "ongoing CDC").

### `d` (delete) → status-tracking satellite

Deletion in the source is a business event. The hub row *stays*
(vault is insert-only). Route the delete to a status-tracking
satellite:

```sql
-- sat_customer_status (STS)
CREATE VIEW staging.stg_crm__customers_deletes AS
SELECT
    before_payload:customer_id::VARCHAR       AS customer_id,
    'DELETED'                                 AS status,
    source_ts,
    ingested_at,
    operation
FROM landing.cdc_events
WHERE source_table = 'customers'
  AND operation = 'd';

-- sat_customer_status loader unions the DELETED rows with regular
-- status observations from c/u/r events (status = 'ACTIVE').
```

See [record-tracking-satellites.md](record-tracking-satellites.md)
for the STS pattern.

### Tombstone-Only Deletes (Kafka log-compaction)

Some CDC pipelines emit a tombstone (null value) to signal deletion
rather than a `d` operation. In Kafka log-compacted topics, that
tombstone eventually removes the key from the topic entirely.

**Rule:** always land the tombstone in `landing.cdc_events` with
`operation = 'd'` and `before_payload` populated (the compactor
preserves the key), even if the topic itself later evicts the row.

---

## Delivery Guarantees and Deduplication

CDC delivery is almost always at-least-once. The same event can
arrive twice. The vault's insert-only anti-join filters duplicates
at hub/link level automatically, but the landing table also needs
dedup or its metrics get skewed.

### Landing-Level Dedup by event_id

```sql
-- Insert into landing with idempotency
INSERT INTO landing.cdc_events (event_id, ...)
SELECT event_id, ...
FROM (raw stream)
ON CONFLICT (event_id) DO NOTHING;
```

If the CDC pipeline doesn't emit a stable `event_id`, construct one
from `(source_ts, lsn, before_hash, after_hash)`. Do NOT skip this;
metrics based on landing counts become useless without stable IDs.

### Vault-Level Dedup

The standard anti-join / hashdiff patterns already handle duplicates
at hub, link, and sat. No CDC-specific changes needed here.

---

## Out-of-Order Events

If CDC delivery is not ordered (parallel consumers, cross-partition
reads), events for the same key may arrive out of order. Example:

- Event 1 at t=10s: customer email = A
- Event 2 at t=20s: customer email = B
- Delivered in reverse order at ingest.

**Correctness impact on the vault:**
- Hub: unaffected (first-seen wins on any order).
- Link: unaffected.
- Satellite: `load_dts` reflects ingestion order, not source order.
  If downstream needs "the *latest* value in source order," they need
  to also read `source_ts` and sort by it.

**Two mitigation strategies:**

**Strategy A — bi-temporal satellite.** Store `source_ts` as
`applied_dts` alongside `load_dts` on every satellite row. Downstream
picks either. See [multi-temporal.md](multi-temporal.md).

**Strategy B — per-key reorder buffer in staging.** Delay events N
seconds and emit only after the buffer says "no earlier events
possible for this key." Requires an ordered upstream (Kafka + key
partitioning). Adds latency; use only when downstream can't cope
with source-order sorting itself.

**Ask the user:** *"Do downstream marts care about source-event
order, or is ingestion order sufficient? If yes, is a small latency
tradeoff (Strategy B) acceptable, or do we absorb source_ts as a
descriptive column (Strategy A)?"*

---

## Nested / Array Payload Hashing

Source payloads with JSON objects or arrays need explicit hashing
decisions. The vault can't naively hash the JSON string because:

- Serialization order isn't deterministic (`{"a":1,"b":2}` vs.
  `{"b":2,"a":1}` → different hashes for same data).
- Nested field additions cause phantom changes.
- Array element order may or may not be semantically meaningful.

### Rule 1 — canonicalize before hashing

For an object payload, extract fields in a documented canonical
order, cast each to string, apply the normalization recipe, then
hash:

```sql
{{ dv_hashdiff([
    "after_payload:address:city",
    "after_payload:address:country_code",
    "after_payload:address:postal_code",
    "after_payload:address:street"
]) }} AS address_hashdiff
```

Same alphabetization rule as regular hashdiff. The whole nested
object becomes N fields to hash.

### Rule 2 — arrays: pick semantics deliberately

For an array field, decide: is order meaningful?

- **Order-sensitive** (event sequence): hash the array as-is,
  concatenated with a delimiter.
- **Order-insensitive** (set semantics — tags, phone numbers):
  sort the array before hashing.

```sql
-- Order-insensitive: sort first
{{ dv_hash_function() }}(
    LISTAGG(tag, '||') WITHIN GROUP (ORDER BY tag)
) AS tags_hashdiff
```

**Ask the user:** *"For the `tags` array on customer, does order
matter? (i.e. is `[a, b]` semantically the same as `[b, a]`?)"*
Get an explicit answer per array field.

### Rule 3 — schema-evolving payloads

If the source adds new fields to the JSON payload, the hashdiff
column list must decide whether to include them. Two approaches:

- **Whitelist** (strict): hashdiff over the exact columns you
  agreed to; new fields ignored until manually added. Safer;
  requires ongoing coordination.
- **Whole-payload hash** (lax): hash a canonicalized version of
  the entire JSON. Auto-tracks new fields but breaks on every
  benign source addition.

Prefer whitelist for enterprise use. Combine with data contracts
(see [data-contracts-and-change-mgmt.md](data-contracts-and-change-mgmt.md))
so new fields go through a review.

---

## API / Paginated Sources

For SaaS REST APIs (Salesforce, HubSpot, Zendesk, Stripe, Shopify),
the ingestion pattern differs:

- No CDC event stream; you poll.
- Pagination via cursor (page number, offset, timestamp, opaque
  token).
- Rate limits and partial-page failures are your problem.

### Standard Pattern

1. **Landing = the raw API response payload** (JSON, one row per
   API record) with `fetched_at`, `cursor_at_fetch`, `page_token`.
2. **Incremental cursor** stored in a persistent state table
   (`ingestion.cursors`), read at run start, updated at run end.
3. **Failure = don't advance the cursor**. Next run re-fetches from
   the last known-good cursor.
4. **Landing dedup** by (source_id, updated_at) or (source_id,
   version) — SaaS APIs typically expose one of these.
5. **After landing** the flow is identical to CDC — `after`-shaped
   rows flow into staging → hashed staging → vault.

```sql
CREATE TABLE ingestion.cursors (
    source_name       VARCHAR    NOT NULL,
    cursor_field      VARCHAR    NOT NULL,   -- 'updated_at' etc.
    last_value        VARCHAR    NOT NULL,   -- serialized cursor
    last_run_at       TIMESTAMP  NOT NULL,
    last_run_status   VARCHAR    NOT NULL,   -- 'success', 'partial', 'failed'
    PRIMARY KEY (source_name, cursor_field)
);
```

### Handling Pagination Failures Mid-Fetch

If page 5 of 10 fails, options:

**Option A — all-or-nothing.** Discard the partial fetch, don't
advance the cursor, retry from page 1 next run. Safe; may re-process
some records (idempotent via anti-join, so fine).

**Option B — page-level checkpointing.** Persist the page-level
cursor after each successful page. Partial-fetch state is
recoverable but adds complexity and per-page state.

Default to option A. Move to B only when API rate limits or fetch
duration make full-restart prohibitive.

### Rate-Limit and Retry Semantics

- Read the API's rate-limit headers (`X-RateLimit-Remaining`,
  `Retry-After`) and pause between pages.
- Retry with exponential backoff on 429 / 5xx.
- Log every failed fetch to the error mart (see
  [metrics-and-error-vault.md](metrics-and-error-vault.md)) so
  operators can see partial-day gaps.

**Ask the user:** *"For source X, what's the rate limit? Is there
a soft-delete or a versioning column so we can distinguish deletion
from 'not returned in this page'? Do you want failure to block or
skip the vault load?"*

---

## Semi-Structured Types at Rest

For sources whose native shape is nested JSON (Firestore, MongoDB,
event streams), the vault has a choice:

**Option A — flatten in staging.** Explode nested fields into
columns; vault sees flat rows. Simple downstream; brittle to schema
changes.

**Option B — preserve JSON in satellite.** Store payload as VARIANT/JSON
column; downstream marts explode on read. Robust to schema changes;
harder to query.

**Option C — hybrid.** Extract known-important fields to columns;
preserve full JSON as a "raw" column for future queries.

Enterprise default: **Option C.** Extract the fields the business
queries today; keep the full JSON so tomorrow's questions can be
answered without re-loading source history.

The hashdiff decision: hash the *extracted fields* only. Do not
hash the raw JSON blob — it will change hashes on benign source
formatting shifts.

---

## Kafka-Specific Patterns

If Kafka is the transport, some additional decisions:

- **Topic-to-source mapping:** typically one topic per source table.
  Landing table `source_table` column derived from topic name.
- **Consumer group per loader:** each hub/link/sat loader can be
  its own consumer group *only if* it can independently handle
  duplicates. Practically: one consumer group per landing pipeline;
  DV loaders run downstream in batch.
- **Kafka Connect / Debezium connector metadata:** Debezium emits
  `source.snapshot`, `source.lsn`, `source.file`, `source.pos` —
  preserve all of these in the landing table for lineage.
- **Compaction:** if the topic is compacted, the tombstone rule
  above applies. Otherwise the topic is append-only and the
  landing table simply mirrors.

---

## When to Use Snowpipe Streaming / BigQuery Storage Write / Databricks Auto Loader

Warehouse-native streaming ingestion is usually simpler than
DIY Kafka Connect. Prefer:

- **Snowpipe Streaming API** (Snowflake) — SDK inserts rows
  directly, exactly-once semantics per channel. See
  [snowflake-specific.md](snowflake-specific.md).
- **BigQuery Storage Write API** — Google's exactly-once
  streaming ingest. See [bigquery-specific.md](bigquery-specific.md).
- **Databricks Auto Loader** — schema-inferring streaming reader
  for cloud storage. See [databricks-specific.md](databricks-specific.md).

Each replaces "manage your own Kafka consumer + upsert into
landing" with warehouse-native primitives. The vault-side DV
patterns downstream of landing are unchanged.

---

## Common CDC / Streaming Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Hashing raw CDC payload JSON string | Serialization order → phantom changes | Extract fields, canonicalize, then hash |
| Ignoring `d` operations | Deletions in source invisible in vault | Route to status-tracking satellite |
| Assuming Fivetran captures deletes | Fivetran default drops them | Explicitly enable delete capture; or use vendor's separate deleted-rows API |
| Using source_ts as load_dts | Non-monotonic history when out-of-order arrives | load_dts = ingested_at; source_ts = descriptive `applied_dts` |
| No landing table (staging reads Kafka directly) | Can't replay; loss of raw payload on schema drift | Land raw events; then staging over landing |
| Missing dedup on event_id at landing | Metrics vault counts wrong; storage bloats | ON CONFLICT DO NOTHING on event_id |
| Whole-JSON hashdiff | Benign source formatting = false-positive changes | Whitelist-based hashdiff on extracted fields |
| Assuming exactly-once delivery | Duplicates in vault when producer retries | Assume at-least-once; anti-join filters, dedup landing |
| No error mart for API fetch failures | Silent daily gaps in vault | Every failed fetch logs a rejection event |
| Not persisting cursor state | Every run does a full fetch → cost + latency | ingestion.cursors table; commit after successful fetch |
| Hashing arrays without agreeing on order | Same set of tags produces different hashdiffs across runs | Sort order-insensitive arrays; document the choice |
| Dropping the CDC landing table after N days | Can't replay history for a regulatory audit | Retain 90-180 days; archive to cheap storage, not delete |
| Bi-temporal by default | Every source doesn't need it; adds cost | Only when source can back-date; ask user first |
