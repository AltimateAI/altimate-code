# Scale and Operations

Everything the standard DV skill teaches — insert-only, hashdiff,
PIT — assumes a comfortably-sized vault. At enterprise scale
(billions of satellite rows, hundreds of feeds, dozens of teams),
new problems appear: rehashing when normalization must change,
archiving old satellite partitions under retention policy, CI cost
control against a multi-billion-row vault, backfill/replay for
hundreds of feeds, DR/backup semantics for an insert-only store,
and SLA/freshness dashboards for non-technical stakeholders.

This reference is the ops layer that turns "it works" into "it
works reliably in year 3 with 40 teams."

**When to load this reference:** vault expected to grow past ~1
billion satellite rows total, more than ~50 feeds, or more than
one warehouse. Skip for smaller projects — most of this is
premature optimization otherwise.

---

## Ask the User First — Ops Context

Before applying scale/ops patterns, get answers to:

1. **What's the current + projected size?** Rows and bytes, per
   layer (staging / raw vault / business vault / mart). "About 500M
   customer events per day" is a very different design from "40M
   total customers, growing 10%/year."
2. **What's the retention policy per layer?** Raw vault might be
   forever; staging might be 90 days; error mart 1 year; metrics
   vault 2 years. Retention drives archiving strategy.
3. **What's the DR expectation?** RPO (recovery point) and RTO
   (recovery time) — 4-hour RPO and 24-hour RTO is common;
   near-zero RPO requires cross-region replication.
4. **What's the CI budget?** Full build of the vault on every PR
   costs $X. Is there a monthly cap on CI compute? Are ephemeral
   test copies acceptable?
5. **Who consumes vault freshness SLAs?** Engineers only (
   metrics-vault dashboards)? Business users (freshness alerts in
   BI tool)? External partners (contractual SLA)?
6. **Is a normalization rule ever expected to change?** If a hash-
   normalization rule (e.g., UPPER vs. LOWER, delimiter, sentinel)
   needs to change post-launch, the vault must be rehashed. That's
   a project, not a task.
7. **What are the failure modes tolerated?** Full-feed outage
   accepted for hours? Partial rows OK if the majority load? Or is
   correctness paramount?

**Do not skip these.** The wrong RPO assumption produces an ops
model that costs 10× correct.

---

## Satellite Archiving and Tiering

At scale, hot storage of a 10-billion-row satellite is expensive.
Tiering keeps recent rows hot and older rows on cold storage.

### Rule — Never Delete Raw Vault Data

Archiving ≠ deletion. Old satellite rows move to cheap storage
(Snowflake external table + S3, BigQuery long-term storage,
Databricks Delta with `optimize` + cheaper tier, Redshift Spectrum
+ S3). They remain queryable but cost less per row.

### Warehouse-Specific Tiering

- **Snowflake:** partition satellites by `load_dts` month.
  Materialize old months to external tables on S3/GCS/Azure
  Blob. Use a view that unions hot + cold. Query cost of cold
  reads is higher but per-byte storage is 5-10× cheaper.
- **BigQuery:** long-term storage kicks in automatically after 90
  days of no writes. Design partitions to enable this.
- **Databricks:** partition by month + `OPTIMIZE ... ZORDER`; use
  a cheaper storage tier for the cold Delta files.
- **Redshift:** unload old months to S3 as Parquet + expose as
  Spectrum external table. Union with current-month RA3 table.
- **PostgreSQL:** partition by month + detach old partitions;
  archive to S3/cheap storage.

### The Cold-Tier Discipline

Cold partitions:
- Are **read-only** — no new inserts. If the source ever back-dates
  data to an old month, you have a decision: refuse the row, load
  to hot (breaking the partition boundary), or reload the cold
  partition.
- Are **not covered by mart freshness SLAs** — mart queries against
  cold data announce degraded latency.
- Are **still queryable for audit** — retention rules apply.

**Ask the user:** *"Do you need to query 5-year-old data with
mart-level performance, or is 'we can retrieve it, but slowly' OK?"*

---

## Rehashing at Scale — When You Must Change Normalization

The skill's core rule is "pick normalization correctly the first
time." In practice, at year 3, someone will discover a bug: an
Oracle source stores customer IDs zero-padded (`00123`) but a
Postgres source doesn't (`123`), and both hit the same normalized
key by accident. Fixing this means rehashing every hub, link, and
satellite.

### The Migration Playbook

1. **Freeze**: no new work on the affected hub until migration is
   scheduled.
2. **Parallel build**: create `hub_customer_v2` with the new
   normalization. Load it from source in parallel.
3. **Data comparison**: for known-stable business keys, verify
   `hub_customer_v2` matches `hub_customer` in row count and
   value. Divergences investigate case-by-case.
4. **Downstream migration**: satellite, link, PIT, and mart
   models update to reference `hub_customer_v2`. Version them
   too (`sat_customer_details_v2`, etc.).
5. **Cutover**: mart consumers migrate; monitoring in metrics
   vault ensures no downstream is left behind.
6. **Retire**: `hub_customer` and its descendants frozen (no new
   loads) but retained per retention policy.

### Cost Estimation

For a 10B-row satellite, rehashing takes:
- Snowflake M-size warehouse: ~4-8 hours.
- BigQuery on-demand: ~10-40 TB scanned (bill accordingly).
- Databricks Photon i3.4xlarge cluster: ~2-6 hours.
- Redshift ra3.4xlarge (8-node): ~4-10 hours.
- Postgres single-node: prohibitive; migrate to a cloud warehouse
  first.

**Budget the migration explicitly.** It's a project, not a
run-of-the-mill deploy.

---

## Backfill and Replay Orchestration

At scale, a single feed's initial load is a project (billions of
rows); N feeds each needing a backfill is coordinated chaos. The
answer is a **replay-capable landing table** + **an orchestrator
that respects dependencies**.

### Landing Table = Replay Source

Every source feed lands into a persistent, insert-only landing
table (see [staging-layer.md](staging-layer.md) and
[cdc-and-streaming-sources.md](cdc-and-streaming-sources.md)).
The vault is built as a *view* over landing + downstream loads:

- To replay a feed, re-run the loads from landing.
- To backfill a new feed, insert historical rows into landing
  (marked with `ingested_at = now()`, `source_ts = original`)
  and run the loads.

**Do not backfill by inserting directly into the vault.** That
defeats every audit and traceability guarantee.

### Dependency-Aware Orchestration

Backfill order matters:

1. Reference tables first (they may depend on nothing).
2. Hubs in dependency order (hub_customer before lnk_order_customer).
3. Links after their hubs.
4. Satellites after their parents.
5. Business vault objects after all raw vault.
6. PITs and marts last.

Orchestrators (Airflow, Dagster, dbt Cloud, native Snowflake tasks)
express this graph. See [native-sql-orchestration.md](native-sql-orchestration.md).

### Parallelism Limits

Vault loads parallelize naturally because hash keys are
deterministic — hub_customer and hub_order can load simultaneously
from the same batch. But at extreme scale:

- **Warehouse concurrency limits** may cap parallelism (Snowflake
  X-Small has 8 concurrent queries).
- **Anti-join queries** against 10B-row hubs get expensive when
  many run at once.
- **Landing-table lock contention** if multiple loaders read the
  same landing simultaneously — solve by having each loader read a
  different partition or watermark.

Right-size warehouse and concurrency; measure before scaling out.

---

## CI Cost Control

Running full `dbt build` on every PR against a multi-billion-row
vault is prohibitively expensive. The solution is a three-tier CI
strategy:

### Tier 1 — PR CI (fast, cheap, per-PR)

- **Compile only**, no execution.
- **Lint** (SQLFluff / dbt lint).
- **Static tests**: schema-yml validation, contract check
  (see [data-contracts-and-change-mgmt.md](data-contracts-and-change-mgmt.md)).
- **Column-lineage diff** (via companion `lineage-diff` skill) —
  show reviewers the blast radius.
- **Unit tests** (via companion `dbt-unit-tests` skill) — small
  synthetic inputs, run in seconds.

Budget: < $1 per PR.

### Tier 2 — Pre-merge CI (ephemeral copy, sampled data)

Run against a **sampled or synthetic mirror** of production:

- Snowflake: `CREATE SCHEMA dv_pr123 CLONE dv_prod;` — zero-copy;
  bounded to the PR's scope.
- BigQuery: sampled tables (1% of rows) in a scratch dataset.
- Databricks: shallow clone of Delta tables.

Run `dbt build --select state:modified+ --defer` against the
sampled schema. Actual row counts diverge from prod but structural
correctness verified.

Budget: < $5 per pre-merge run.

### Tier 3 — Nightly full CI (real data)

Run `dbt build` against production every night with:

- Full data volume.
- All tests.
- Metrics recorded to the metrics vault.

Failures alert oncall for morning review; not blocking on individual
PRs.

Budget: monthly, capped and measured.

### Cost Guardrails

- **Warehouse auto-suspend** at 30 seconds idle.
- **Query timeout** on tests (10 minutes max).
- **PR CI fails fast** — compile errors stop before any warehouse
  spend.
- **Test data caching** — synthetic seeds reused across PRs.

---

## DR / Backup Semantics for Insert-Only

Raw vault is insert-only, so traditional "restore to prior state"
is under-specified. Define these precisely:

### RPO — Recovery Point Objective

How much data can you afford to lose? For an insert-only vault:
- Every batch is atomically loaded → RPO = one batch interval
  (5 min, hourly, daily).
- **In-flight loads at time of failure:** are those "in progress"
  or "lost"? Depends on whether the orchestrator persisted the
  batch_id before failure.

### RTO — Recovery Time Objective

How fast must the vault be back? For a fully-backed-up warehouse:
- Snowflake: within-region Time Travel restore is minutes; cross-
  region is hours (must copy data).
- BigQuery: multi-region storage is default in some tiers; single-
  region requires cross-region backup.
- Databricks: Delta clone to a DR region.
- Redshift: automated cross-region snapshots + restore.

### Backup Strategy

Because raw vault is insert-only:

1. **Continuous replication** to a secondary region is the primary
   defense.
2. **Point-in-time restore** is complementary — Snowflake Time
   Travel (up to 90 days on Enterprise), BigQuery time travel (7
   days), Databricks Delta VACUUM retention (30 days default).
3. **Cross-region snapshot** at least daily; retain 30-90 days.

**Insert-only advantage:** a "wrong data" incident affects only the
rows loaded during that batch. Recovery = re-run from landing, not
restore from backup.

**Insert-only pitfall:** a "wrong normalization" incident affects
every row ever loaded. See rehashing playbook above.

### Documented DR Runbook

Every enterprise vault has a written runbook covering:

- Primary region failure → failover to secondary.
- Corruption of the raw vault → identify affected batches from
  metrics vault → re-run from landing.
- Loss of a hub → rebuild from source (all sources landed in
  landing tables are still available).
- Loss of the metrics vault → rebuild from log archives; historical
  metrics may not be recoverable but ongoing operations resume.
- KMS key loss (if using crypto-shredding) → per-subject data
  becomes irrecoverable (which is the design intent — but flag
  this in DR planning).

**Ask the user:** *"Do you have an existing DR runbook this vault
should plug into, or is this a greenfield?"*

---

## SLA Registry and Freshness Dashboards

The metrics vault (see [metrics-and-error-vault.md](metrics-and-error-vault.md))
captures raw operational data. The SLA layer turns it into
business-visible commitments.

### SLA Registry Table

```sql
CREATE TABLE governance.sla_registry (
    sla_id                  UUID       NOT NULL PRIMARY KEY,
    consumer_name           VARCHAR    NOT NULL,   -- 'finance-dashboard', 'ml-features'
    upstream_object         VARCHAR    NOT NULL,   -- 'raw_vault.hub_customer'
    freshness_max_minutes   INTEGER    NOT NULL,
    completeness_min_pct    NUMERIC(5,2),
    correctness_min_pct     NUMERIC(5,2),
    contact_channel         VARCHAR    NOT NULL,   -- Slack, PagerDuty
    escalation_ticket_url   VARCHAR    NOT NULL,
    contracted_at           DATE       NOT NULL,
    review_due              DATE       NOT NULL,
    tier                    VARCHAR    NOT NULL    -- 'gold', 'silver', 'bronze'
);
```

Every downstream consumer has a row. Every hub / satellite / mart
in the vault knows its downstream SLA commitments.

### Freshness Dashboard

Public-to-the-business view over the metrics vault:

```sql
CREATE VIEW ops.freshness_dashboard AS
SELECT
    sla.consumer_name,
    sla.upstream_object,
    latest.completed_at                        AS last_updated,
    DATEDIFF('minute', latest.completed_at, CURRENT_TIMESTAMP()) AS minutes_since_last_update,
    sla.freshness_max_minutes,
    CASE
        WHEN DATEDIFF('minute', latest.completed_at, CURRENT_TIMESTAMP()) > sla.freshness_max_minutes
        THEN 'BREACHED'
        WHEN DATEDIFF('minute', latest.completed_at, CURRENT_TIMESTAMP()) > sla.freshness_max_minutes * 0.8
        THEN 'AT_RISK'
        ELSE 'HEALTHY'
    END                                        AS sla_status,
    sla.contact_channel
FROM governance.sla_registry sla
LEFT JOIN metrics_vault.latest_load_per_object latest
    ON sla.upstream_object = latest.object_name
```

Expose in Grafana / DataDog / Looker / Superset for the business.

### Alerting Ladder

- Freshness warning (80% of SLA elapsed): Slack.
- Freshness breach (100% elapsed): PagerDuty + auto-ticket.
- Completeness breach: separate alert; tests already caught this.
- Correctness breach: high-severity; ticket + rollback consideration.

---

## Cost Attribution

At enterprise scale, "which team's dbt build is costing $50K/month"
is a real conversation. Attribute cost per team:

- Snowflake: warehouse tags per team; query attribution via account
  usage views.
- BigQuery: labels on jobs; billing exports.
- Databricks: cluster tags; account usage system tables.
- Redshift: RA3 concurrency scaling attribution.

Load into a cost-attribution mart (see the `cost-report` companion
skill) so team leaders can see their spend.

---

## Common Scale/Ops Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| No archiving; hot storage forever | Cost explodes past year 3 | Partition + tier at year 2 planning |
| Rehash-normalization becomes silent | Every downstream hash mismatches; unfixable retroactively | Rehashing is a versioned migration project |
| Every PR triggers full build | CI cost > engineering payroll | Three-tier CI: compile → sampled → nightly full |
| No landing table; source read directly | Can't replay; can't backfill without re-reading source | Landing = persistent + insert-only |
| DR planning assumes traditional restore | Insert-only invalidates traditional backups | Replay from landing + cross-region replication |
| Freshness SLA implicit | Business asks "is the data fresh?" — no answer | SLA registry + public dashboard |
| Cost untagged | Team leader asks "why is my team's spend high?" — no answer | Warehouse tagging + attribution mart |
| Backfill by direct insert | Vault has rows with unknown provenance | Backfill via landing → replay |
| No dependency-aware orchestrator | Hub loaded after link; broken FK | Orchestrator respects DV DAG order |
| Nightly build never runs; only PR CI | Real prod bugs discovered by users | Tier 3 nightly full CI + alerts |
| Ignoring KMS in DR planning | Region loss = permanent data loss (via key loss) | Cross-region KMS replication |
| Time Travel treated as backup | 90-day window doesn't cover corruption discovered later | Cross-region snapshot + landing replay |
| Cold-tier data used for freshness-critical queries | Slow mart; SLA breach | Freshness SLA only covers hot tier; document explicitly |
| Rehashing scheduled during work hours | 8-hour compute burst impacts production | Rehash during scheduled maintenance windows |
| No cost cap on PR CI | Single runaway PR costs $1000 | Query timeout + warehouse auto-suspend enforced |
