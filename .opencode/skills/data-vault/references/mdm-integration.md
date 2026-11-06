# MDM Integration

If the enterprise already runs a Master Data Management platform
(Informatica MDM, Reltio, Profisee, IBM InfoSphere, Semarchy, Ataccama,
Riversand), the vault must consume MDM's golden records rather than
duplicate MDM's work with a from-scratch same-as-link approach.
Getting this integration wrong either (a) reinvents MDM inside the
vault or (b) treats MDM output as raw source and re-links it, which
destroys MDM's carefully-computed identity resolution.

**When to load this reference:** the org has a live MDM system whose
output the vault should honor. Skip when MDM doesn't exist or when
you're deliberately building identity resolution inside the vault
(rare; usually only appropriate for pure-analytics teams without
enterprise MDM).

---

## Ask the User First — MDM Landscape

Before wiring MDM to the vault, get answers to:

1. **Which MDM tool?** Each has different output shapes and refresh
   patterns. Informatica MDM emits IDs from the "hub" (their term);
   Reltio has "entities" with universal IDs; Profisee emits ELM
   entities.
2. **What's the mastered entity list?** Customer only? Customer +
   product? Customer + supplier + employee? Each mastered entity
   should map to an existing DV hub — not to a new one.
3. **What are the source IDs feeding MDM?** MDM consolidates
   `crm.customer_id`, `erp.cust_no`, `billing.customer_number` into
   a single golden ID. The vault likely already ingests all three.
4. **What's the golden-ID stability guarantee?** Some MDM tools
   guarantee stable golden IDs forever; others may re-issue on
   re-master. Stability directly affects hash-key strategy.
5. **What's the refresh cadence?** Real-time push, hourly batch,
   nightly? Determines whether MDM output is a stream or a table.
6. **What's the trust model?** Does the business trust MDM's
   consolidations blindly, or does the vault need to record the
   provenance (which source rows MDM merged, at what time)?
7. **What happens on MDM merges/splits?** MDM tools handle both;
   the vault's same-as pattern must accommodate. Merges are usually
   easy; splits (reversing a merge) are painful.
8. **Are there MDM-mastered entities the vault does NOT ingest?**
   E.g., MDM handles supplier mastering but the vault only cares
   about customers.

**Do not proceed without answers.** MDM-vault integration is where
enterprise data programs commonly stall for weeks because these
answers weren't nailed down.

---

## The Two MDM Integration Patterns

### Pattern A — MDM as Source of Identity (preferred)

MDM emits a `golden_customer_id` per real-world customer. The vault:

1. Treats `golden_customer_id` as the business key for `hub_customer`.
2. Records the source-system IDs (`crm.customer_id`, `erp.cust_no`)
   as descriptive attributes on a satellite off `hub_customer`, plus
   as *interface links* (see [exploration-and-computed-links.md](exploration-and-computed-links.md))
   `lnk_customer_crm_id`, `lnk_customer_erp_id`.
3. Consumes MDM's merge/split events via a satellite off `hub_customer`
   or a status-tracking satellite.

**Advantages:** the vault's identity is stable, business-blessed,
and downstream marts see clean customer entities without doing their
own reconciliation.

**Disadvantages:** the vault is now downstream of MDM's SLA. If MDM
is slow/broken, the vault can't onboard new customers.

### Pattern B — MDM as Advisor (compatibility mode)

The vault keeps its native source-based hubs (`hub_customer` keyed
on the original `customer_id`). MDM output feeds a business-vault
same-as link that records MDM's consolidation decisions:

```
blnk_mdm_same_as_customer
├── mdm_golden_id_hk
├── source_customer_hk       ← the vault's original hub_customer key
├── mdm_confidence
├── mdm_match_rule
```

Downstream marts choose whether to consume the raw hub (source
view) or the MDM-consolidated view (business view via the same-as
link).

**Advantages:** vault stays independent of MDM; MDM changes don't
require vault re-hashing.

**Disadvantages:** every downstream consumer decides which view to
use → inconsistent semantics.

**Default: Pattern A** when MDM is authoritative for the org. Use
Pattern B when MDM is a new project not fully trusted, when the
vault is under a different governance, or when MDM refresh cadence
would introduce unacceptable vault latency.

**Ask the user:** *"Is MDM the authoritative identity source for
this business, or an advisor whose decisions marts can override?"*

---

## Pattern A — Detailed Implementation

Assume Informatica-style MDM emits a golden-record feed:

```
mdm.customer_golden(
    golden_customer_id VARCHAR PRIMARY KEY,   -- stable universal ID
    active_since       TIMESTAMP,
    last_updated       TIMESTAMP,
    merge_state        VARCHAR                 -- 'ACTIVE', 'MERGED', 'SUPERSEDED'
)
mdm.customer_source_map(
    golden_customer_id VARCHAR NOT NULL,
    source_system      VARCHAR NOT NULL,       -- 'CRM', 'ERP', 'BILLING'
    source_id          VARCHAR NOT NULL,       -- the source-system-specific ID
    match_confidence   NUMERIC(3,2),
    match_rule         VARCHAR,
    mapped_at          TIMESTAMP,
    active             BOOLEAN
    PRIMARY KEY (source_system, source_id)
)
```

### hub_customer keyed on golden ID

```sql
{{ config(materialized='incremental', incremental_strategy='append',
          unique_key='customer_hk') }}

WITH mdm_source AS (
    SELECT
        golden_customer_id AS customer_bk,
        '{{ run_started_at }}'::TIMESTAMP AS load_dts,
        'mdm.customer_golden' AS record_source
    FROM {{ ref('stg_mdm__customer_golden') }}
    WHERE golden_customer_id IS NOT NULL
      AND merge_state <> 'SUPERSEDED'  -- see below on merge handling
),
hashed AS (
    SELECT
        {{ dv_hash_bk(['customer_bk']) }} AS customer_hk,
        customer_bk,
        load_dts,
        record_source
    FROM mdm_source
),
deduped AS (
    SELECT * FROM hashed
    QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_hk ORDER BY load_dts) = 1
)
SELECT * FROM deduped
{% if is_incremental() %}
WHERE customer_hk NOT IN (SELECT customer_hk FROM {{ this }})
{% endif %}
```

### Source-ID interface links

Each `(golden_customer_id, source_system, source_id)` combination
becomes a row in an interface link — you can trace any source row to
the golden customer it belongs to:

```sql
-- blnk_customer_source_id.sql
SELECT
    {{ dv_hash_bk(['golden_customer_id', 'source_system', 'source_id']) }} AS blnk_hk,
    {{ dv_hash_bk(['golden_customer_id']) }}                             AS customer_hk,
    source_system,
    source_id,
    load_dts,
    record_source
FROM {{ ref('stg_mdm__customer_source_map') }}
WHERE active = TRUE
```

Add a satellite `bsat_customer_source_id_details` off this link for
match confidence, rule, and timestamp.

### MDM merge events → same-as link

When MDM merges two golden IDs (previously separate, now known to
be the same person), it emits `merge_state='MERGED'` on the losing
side and updates `customer_source_map` to point every source ID at
the winning golden ID.

```sql
-- lnk_customer_mdm_merge.sql (business vault, not raw)
SELECT
    {{ dv_hash_bk(['winning_golden_id', 'losing_golden_id']) }} AS lnk_merge_hk,
    {{ dv_hash_bk(['winning_golden_id']) }}                     AS winning_customer_hk,
    {{ dv_hash_bk(['losing_golden_id']) }}                      AS losing_customer_hk,
    merge_at,
    merge_reason,
    load_dts,
    'mdm.merge_events'                                          AS record_source
FROM {{ ref('stg_mdm__merge_events') }}
```

Downstream marts respect this link — a fact-table query on
`losing_customer_hk` joins through the merge link to attribute the
row to `winning_customer_hk`.

### MDM split events → same as above, reversed

Splits are rarer but happen (MDM was wrong; two people got merged
who shouldn't have been). Same link shape but a `split_at` event.
The winning-golden-id → source-id mapping updates in
`customer_source_map`; the vault's same-as link records the split
timestamp.

---

## Trusting MDM — Verification Patterns

Even in Pattern A, the vault should not silently trust every MDM
decision. Two verification layers:

**Layer 1 — provenance preservation.** Every hub row's satellite
records which sources contributed which values. When MDM merges A
and B, the resulting golden customer's PII satellite has rows from
both original satellites, with `record_source` distinguishing them.
A regulator asking "where did this email come from" can trace back.

**Layer 2 — MDM confidence threshold gate.** MDM confidence scores
below a threshold (usually < 0.9) get flagged for manual review:

```sql
-- tests/mdm_low_confidence_review.sql
{% test mdm_low_confidence_review() %}
    SELECT source_system, source_id, golden_customer_id, match_confidence
    FROM {{ ref('stg_mdm__customer_source_map') }}
    WHERE active = TRUE
      AND match_confidence < 0.9
{% endtest %}
```

Route failures to a `governance.mdm_review_queue` for a data
steward. Low-confidence matches don't block ingestion but trigger
review.

---

## When MDM Refresh Cadence Is Slower Than Vault

If MDM refreshes hourly but vault ingests source in near-real-time,
there's a window where source rows arrive before MDM has assigned
a golden ID. Two options:

**Option A — buffer at staging.** Source rows land but wait for the
next MDM refresh before flowing to the vault. Simple; adds latency.

**Option B — provisional golden ID.** Vault issues a provisional ID
(hash of the source ID) and swaps to the MDM golden ID after MDM
refreshes. Complex — every downstream reference needs to handle
the ID switch — but no latency.

Default to **Option A** unless real-time is required.

---

## Pattern B — Detailed Implementation

Pattern B keeps the vault's original hubs (source-keyed) and adds
MDM as a business-vault same-as link:

```sql
-- blnk_computed_same_as_customer_mdm.sql (business vault)
SELECT
    {{ dv_hash_function() }}(source_customer_hk || '||' || golden_customer_hk) AS blnk_hk,
    source_customer_hk,                              -- original hub_customer key
    {{ dv_hash_bk(['golden_customer_id']) }} AS golden_customer_hk,
    match_confidence,
    match_rule,
    load_dts,
    'business_vault.mdm_same_as' AS record_source
FROM {{ ref('stg_mdm__customer_source_map') }}
JOIN {{ ref('stg_crm__customers__hashed') }} src
    ON stg_mdm__customer_source_map.source_system = 'CRM'
   AND stg_mdm__customer_source_map.source_id = src.customer_id
```

Downstream marts join via the same-as link to consolidate views.
Pattern B is essentially the [same-as-link pattern](link-patterns.md)
with MDM as the origination.

---

## Special MDM Scenarios

### Reference Data From MDM

Some MDM tools also master reference data (currency, country, org
hierarchy). Treat as reference-data ingestion (see
[reference-tables.md](reference-tables.md)); MDM is just the
upstream source of the ref feed.

### Employee / User Mastering

If MDM masters employees or users (Workday integration common),
these become their own hub — `hub_employee` — following the same
pattern as `hub_customer`. Same considerations for tenancy: is the
employee tenant-scoped?

### Cross-Domain Mastering

MDM sometimes masters relationships (e.g., "this customer belongs
to this account belongs to this parent org"). Those become links in
the vault. MDM's hierarchy → `lnk_customer_account` +
`lnk_account_parent_org` in the raw vault, driven by MDM's output.

### Reversing an Incorrect Merge (Split)

If MDM incorrectly merged customer A + B into golden ID G, and later
splits them:

1. MDM emits a split event.
2. Vault's `hub_customer` gets a new row for the newly-split golden
   ID (A now has its own golden ID; B stays on G).
3. `customer_source_map` refresh reroutes A's source IDs.
4. `lnk_customer_mdm_merge` gains a "split" event (with a matching
   `record_source = 'mdm.split_events'`).
5. Historical mart snapshots pre-split still reference G — this is
   correct; the mart's snapshot reflects reality at that time.

**Never mutate previously-loaded hub rows or satellites on a
split.** The insert-only rule still holds — the split is a new
event.

---

## Metrics-Vault Integration

MDM feeds add specific metrics:

- MDM refresh lag (time between MDM update and vault ingestion).
- Match-confidence distribution per feed.
- Merge/split event count per week.
- Low-confidence review queue depth.
- Source-ID coverage (percentage of source rows with matching MDM
  entry).

Every one of these is a `sat_lnk_load_batch_feed_metrics` row (see
[metrics-and-error-vault.md](metrics-and-error-vault.md)) with
`record_source = 'mdm.<metric>'`.

---

## Governance — MDM as a Contract Source

The MDM feed itself is subject to a data contract (see
[data-contracts-and-change-mgmt.md](data-contracts-and-change-mgmt.md)).
The contract's owner is the MDM team; freshness SLA, volume SLA,
schema stability all apply. Treating MDM as "just another source"
(with contract enforcement) rather than a special magic pipeline
is essential.

---

## Common MDM Integration Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Ignore MDM; build same-as links from scratch inside the vault | Duplicates MDM's work; results diverge; enterprise-wide identity confusion | Consume MDM as source of identity (Pattern A) or as advisor (Pattern B) |
| Treat MDM output as raw source and hash source-system IDs | Vault hub keyed on source ID; MDM merges silently produce two hub rows | Pattern A hashes on `golden_customer_id`; source IDs live on interface links |
| Skip MDM confidence threshold | Low-confidence matches merge as if certain; data steward has no visibility | Low-confidence-review queue + weekly steward workflow |
| Not preserving provenance after MDM merge | Regulator asks "which source produced this email" and there's no answer | `record_source` on every satellite row preserves origin even post-merge |
| Ignore MDM merges/splits | Vault gets stale identity views | `lnk_customer_mdm_merge` records every event; downstream marts respect it |
| MDM as authoritative but refresh is slower than vault | Vault issues provisional IDs and downstream ID references break on swap | Buffer at staging (Option A) unless real-time is required |
| MDM contract missing | MDM team changes schema silently → vault breaks | Contract with MDM team as owner; scheduled schema-diff scan |
| Blindly trust MDM's split events | Splits are dangerous; incorrect splits fragment history | Splits require higher approval (data-steward sign-off) before applied |
| Vault ingests MDM but not the underlying sources | Vault has *only* golden IDs; can't audit MDM's decisions | Continue ingesting source systems; MDM output is a *supplement* |
| Assuming golden IDs are stable forever | Some MDM tools re-issue on re-master; hash keys change | Verify stability guarantee; if not guaranteed, add a stable-key layer |
| MDM tenant model doesn't match vault tenant model | Cross-tenant identity leaks via MDM | MDM output must include `tenant_id`; vault enforces tenant-scoped hash |
| Building marts on top of raw hub AND MDM-consolidated hub in parallel | Two competing "truth" views; user confusion | Pick one authoritative view for BI; the other is engineering-only |
