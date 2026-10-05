# Common Data Vault 2.0 Mistakes

Extended catalog of the mistakes that produce silently-wrong Data
Vault models. Grouped by which structure they apply to. Each entry
lists the symptom, the reason, and the fix.

## Hub Mistakes

### Selecting from a fact table
**Symptom:** `hub_customer` has N rows per customer, one per order.
**Reason:** `SELECT customer_id FROM stg_orders` inherits the order
grain instead of the customer grain.
**Fix:** Dedupe with `DISTINCT` or `QUALIFY ROW_NUMBER() = 1` on
`customer_hk`, and load from *every* source that mentions the key
(`UNION ALL`), not just one.

### One hub per source table
**Symptom:** `hub_customer_crm` and `hub_customer_erp` both exist,
holding the same customers.
**Reason:** Modeled the source, not the business concept.
**Fix:** One hub per business concept, `UNION ALL` all sources.
Cross-system deduplication (if the source PKs differ) lives in a
same-as link or business-vault hub.

### Using source `updated_at` as `load_dts`
**Symptom:** Reloading historical data inserts rows in the middle of
the satellite chain, breaking PIT lookups.
**Reason:** Vault history should reflect *when we ingested*, not
*when the source claimed the event happened*.
**Fix:** Always `{{ run_started_at }}` or `CURRENT_TIMESTAMP()`.

### Business key with trailing whitespace
**Symptom:** Two rows in the hub for the same logical customer,
different hash keys.
**Reason:** Skipped `TRIM` before hashing; the source inserted a
trailing space in one system.
**Fix:** Always apply the full normalization: `TRIM → UPPER → COALESCE
→ delimiter → hash`.

### Ghost row missing
**Symptom:** `LEFT JOIN` from a link to a hub returns NULL keys;
downstream marts break on missing dimensional attributes.
**Reason:** Ghost record wasn't loaded at project setup.
**Fix:** Insert one row per hub with the sentinel BK (`'^^'`) and
its deterministic hash. Never delete.

## Link Mistakes

### Missing driver key
**Symptom:** Two distinct relationships in the source collapse into
one row in the link. Downstream reporting can't distinguish them.
**Reason:** Not every key that participates in the relationship's
identity was included in the link's hash.
**Fix:** Apply the driver-key test to every candidate key. If
changing its value creates a new relationship (not a change to an
existing one), include it in the hash.

### Payload columns on a standard link
**Symptom:** The link's `quantity` column changes across loads, but
the link is insert-only — the changes are lost.
**Reason:** Payload attributes were added to the link instead of a
satellite.
**Fix:** Move payload to a satellite (`sat_lnk_order_line_details`).
Exception: transactional (non-historized) links whose attributes are
part of the immutable event.

### Different hash column order in link vs. hub
**Symptom:** `LEFT JOIN link ON hub.customer_hk = link.customer_hk`
matches zero rows.
**Reason:** One computed `dv_hash_bk(['customer_id'])`, the other
computed `dv_hash_bk(['customer_id', ''])` or a different casing.
**Fix:** Same canonical order and the same `dv_hash_bk` macro
everywhere.

### Loading a link before its hubs
**Symptom:** Link references a hash key that doesn't exist in the hub.
**Reason:** DAG ordering broken by `--select link_x --exclude hub_x`
or by parallel run without proper refs.
**Fix:** Never `--select` a link without its hubs during initial
build. Use `dbt run --select +link_x` (upstream) for safe reload.

### Filtering NULLs after hashing
**Symptom:** Link has one row with `MD5('^^')` for every NULL row in
source, corrupting the ghost row.
**Reason:** `WHERE customer_id IS NOT NULL` was applied after the
hash was already computed.
**Fix:** Filter NULLs first, hash second.

## Satellite Mistakes

### Using `MERGE` on the parent hash key
**Symptom:** Satellite has one row per parent — history is gone.
**Reason:** `incremental_strategy='merge'` with `unique_key='parent_hk'`
updates the existing row instead of appending.
**Fix:** `incremental_strategy='append'`, `unique_key=['parent_hk', 'load_dts']`,
filter by hashdiff difference.

### Missing hashdiff comparison
**Symptom:** Satellite doubles in size every run even when source
hasn't changed.
**Reason:** Load pattern inserts every parent's current source row
every time, without checking if the hashdiff differs from what's
already in the target.
**Fix:** `LEFT JOIN latest_in_target ... WHERE latest_hashdiff <>
current_hashdiff OR latest_hashdiff IS NULL`.

### Hashdiff over unsorted columns
**Symptom:** Every load inserts a "change" row even when nothing
changed.
**Reason:** `SELECT` column order shifted in a refactor; the
`MD5(a || b)` becomes `MD5(b || a)`.
**Fix:** Always alphabetize the column list inside `dv_hashdiff`. Do
not rely on `SELECT` order for hashdiff stability.

### Hashdiff includes load metadata
**Symptom:** Every load inserts a change row for every parent.
**Reason:** `load_dts` or `record_source` was in the hashdiff input
list.
**Fix:** Hashdiff includes *only* descriptive attributes. Load
metadata is never in it.

### Comparing hashdiff to any row instead of the latest
**Symptom:** Sometimes changes are missed, sometimes duplicate
inserts.
**Reason:** `WHERE hashdiff NOT IN (SELECT hashdiff FROM {{ this }} WHERE parent_hk = X)` —
compares to *any* historical value, not the current one.
**Fix:** `QUALIFY ROW_NUMBER() OVER (PARTITION BY parent_hk ORDER BY
load_dts DESC) = 1` to get the current row, then compare hashdiff.

### One giant satellite per hub
**Symptom:** Satellite grows to billions of rows in weeks; downstream
PIT queries are slow.
**Reason:** All descriptive attributes crammed into one satellite;
fast-changing columns (like `last_login_at`) force a new row for every
customer every load.
**Fix:** Split by change cadence. One satellite per cadence group.

### Multi-active satellite modeled as standard
**Symptom:** Customer's multiple phone numbers, only one appears in
the satellite; the others are silently lost.
**Reason:** Standard satellite has PK `(parent_hk, load_dts)`;
multiple rows for the same parent + load collide.
**Fix:** Use a multi-active satellite with PK `(parent_hk, load_dts,
sub_sequence)`.

### Effectivity satellite that never closes
**Symptom:** Historical "who was active on 2024-06-01?" returns
every assignment ever, not just the one that was active then.
**Reason:** Only the "open" pass runs; the "close previous interval"
pass was omitted.
**Fix:** Two-pass load — opens on new observations, closes on
disappearance. Prefer AutomateDV's `eff_sat` macro.

## Loading Mistakes

### `incremental_strategy='merge'` on raw vault
**Symptom:** Rows are being overwritten. History gone.
**Reason:** Some dbt adapters default to `merge`; the raw vault
inherits the default.
**Fix:** Explicit `incremental_strategy='append'` on every raw-vault
model.

### `CURRENT_TIMESTAMP()` instead of `{{ run_started_at }}`
**Symptom:** Two rows loaded in the same run get slightly different
timestamps; join between hub and satellite on `load_dts` sometimes
misses.
**Reason:** `CURRENT_TIMESTAMP()` evaluates per row.
**Fix:** `{{ run_started_at }}` is set once per run.

### Materialized as `table`
**Symptom:** Full reload every run; history is *the current source
snapshot only*.
**Reason:** Default materialization; missed the `incremental` flag.
**Fix:** `materialized='incremental'` on every vault table.

### Anti-join column name mismatch
**Symptom:** Vault grows without bound; every run appends every row.
**Reason:** `LEFT JOIN {{ this }} USING (customer_hk)` — but the
target's column is `customer_hash_key`, so the join always misses.
**Fix:** Match column names exactly, or specify explicit `ON`.

### Not verifying idempotency
**Symptom:** Duplicate rows show up months later; can't retrace
which load added them.
**Reason:** Second-run row count wasn't checked after any change to
the load pattern.
**Fix:** After every load pattern change, run twice and verify the
second run inserts zero rows.

## Business Vault / Information Mart Mistakes

### Business rules in the raw vault
**Symptom:** Vault can't be re-built byte-for-byte from source; audit
questions can't be answered without the current business-vault code.
**Reason:** "Convenience" filters (like `WHERE is_test = FALSE`)
added to raw-vault loads.
**Fix:** Move all business rules to business vault or information
mart. Raw vault stays source-faithful.

### Business vault without historization
**Symptom:** Downstream marts can't answer "what was the derived
value on date X".
**Reason:** BV computed satellite was materialized as `table` and
rebuilt every run, losing history.
**Fix:** BV computed satellites follow the same insert-only +
hashdiff discipline as raw-vault satellites.

### Info mart reads directly from source
**Symptom:** Vault → mart lineage broken; changes to source appear
in mart without going through vault.
**Reason:** Someone added a source ref directly in a mart to
"quickly add a column".
**Fix:** Marts only read from vault (raw or business). Sources → vault
first, always.

### Latest-row query instead of PIT
**Symptom:** Mart is slow when the vault grows.
**Reason:** Every mart query recomputes `QUALIFY ROW_NUMBER() ...
ORDER BY load_dts DESC` on billion-row satellites.
**Fix:** Build a PIT table and let marts join to it.

## Naming / Convention Mistakes

### Mixing case conventions
**Symptom:** `HUB_CUSTOMER` and `hub_customer` both appear in the
project; refs occasionally break on case-sensitive adapters.
**Reason:** Two developers used different conventions.
**Fix:** Pick one (`HUB_*` or `hub_*`) at project setup, enforce via
lint.

### Ambiguous satellite names
**Symptom:** `sat_customer_1`, `sat_customer_2` — no one knows what
they contain.
**Reason:** Split-by-cadence satellites weren't given semantic names.
**Fix:** `sat_customer_pii`, `sat_customer_address`,
`sat_customer_engagement` — the name says what changed together.

### Link named after the source table
**Symptom:** `lnk_order_lines` implies a source table; not obvious
what hubs it connects.
**Reason:** Named for source, not for the relationship.
**Fix:** `lnk_order_line_product` (or the hubs it connects).

## Silent-Correctness Bugs

The most dangerous class of DV bugs — models that build cleanly,
tests pass, but the answers are wrong.

### Ghost row polluted with real load metadata
**Symptom:** Every satellite has a "ghost's row" with a real
customer's `load_dts` and `record_source`.
**Reason:** Ghost was inserted via the same load path as real data,
picking up a real `record_source`.
**Fix:** Insert ghost via `run-operation`, once, with fixed
`record_source = 'SYSTEM'` and `load_dts = '1900-01-01'`.

### Normalization drift between hub and satellite
**Symptom:** Satellite loads a row, but joining hub to satellite on
`customer_hk` misses it.
**Reason:** Hub uses `UPPER`, satellite uses `LOWER` — different
hash keys for the same business key.
**Fix:** Shared `dv_hash_bk` macro. If you see inline `MD5(...)` in
a model, that's the bug.

### Silent hashdiff false-negative
**Symptom:** Real change to source's payload doesn't appear in the
satellite; downstream mart shows stale data.
**Reason:** A column was added to the source but not to the satellite's
hashdiff column list — the hash sees no change even when the added
column changes.
**Fix:** Whenever a source column is added, decide: is it descriptive
(add to hashdiff) or ignored (document why). Never leave source
columns unaccounted for.

### Ambiguous `record_source` mid-migration
**Symptom:** Some hub rows have `record_source = 'crm'`, some have
`record_source = 'crm.customers'` — both refer to the same feed.
**Reason:** Convention shifted mid-project.
**Fix:** Pick one convention per feed and stick with it. If you
must change, update all existing rows in a controlled migration
(actually, don't — leave old rows as they were and change new ones,
since raw vault is immutable).

### Wrong grain on link → hub joins never miss but always over-count
**Symptom:** Fact aggregates report 3× the correct total.
**Reason:** Link's grain is finer than the fact's expected grain
(e.g., link includes `warehouse_id` but the mart doesn't filter on
it), so each fact row matches multiple link rows.
**Fix:** Explicit link-grain in mart queries. Use PIT / bridge with
distinct grains for different mart use cases.
