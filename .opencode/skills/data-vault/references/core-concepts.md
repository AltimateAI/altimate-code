# Data Vault 2.0 — Core Concepts

The vocabulary. Read this once, refer back when a term in another
reference feels ambiguous.

## The Three Structures

Data Vault 2.0 raw vault contains exactly three kinds of table. Nothing
else. If you have a fourth, it belongs in the business vault, an
information mart, or a staging layer — not the raw vault.

### Hub

A **hub** stores the unique list of business keys for a single business
concept, plus its hash key and load metadata. Nothing else.

Columns:
| Column | Purpose |
|--------|---------|
| `<entity>_hk` | Hash key (MD5 / SHA-1 of the normalized business key). Primary key of the hub. |
| `<entity>_bk` | Business key(s) — one column per key part. |
| `load_dts` | When *we* first inserted this business key. |
| `record_source` | Which system / feed the key was first seen in. |

Constraints:
- Insert-only. Once a business key is in the hub, its row is immutable.
- One row per business key (enforced by the hash key uniqueness).

### Link

A **link** stores the unique combinations of business keys that
participate in a relationship, plus a hash key and load metadata.

Columns:
| Column | Purpose |
|--------|---------|
| `<relationship>_hk` | Hash key of the concatenated normalized business keys. Primary key of the link. |
| `<hub_a>_hk` | Hash key referencing hub A. |
| `<hub_b>_hk` | Hash key referencing hub B. |
| ... | One `_hk` column per hub the link connects, plus any driver-key columns. |
| `load_dts` | When *we* first inserted this combination. |
| `record_source` | Which system the relationship was first seen in. |

Constraints:
- Insert-only. Once a combination is in the link, its row is immutable.
- One row per unique combination of participating keys.
- Links carry no descriptive attributes. Descriptive attributes belong
  in a satellite hanging off the link.

**Sub-types:**
- **Standard link** — connects two or more hubs. The most common shape.
- **Transactional (non-historized) link** — records events that don't
  repeat (a purchase, a login). Has no satellite because there's
  nothing to historize.
- **Hierarchical link** — self-referencing (employee ↔ manager, part ↔
  parent-part). Two hash keys point to the same hub.
- **Same-as link** — records that two business keys refer to the same
  real-world entity (deduplication link). Two hash keys point to the
  same hub, plus a match-confidence attribute in an accompanying
  satellite.

### Satellite

A **satellite** stores the descriptive attributes for a hub or link,
historized by hashdiff.

Columns:
| Column | Purpose |
|--------|---------|
| `<parent>_hk` | Hash key referencing the parent hub or link. |
| `load_dts` | When *we* inserted this version. |
| `hashdiff` | Hash of the descriptive attributes. Detects change. |
| `record_source` | Which system this version came from. |
| `<attr_1>`, `<attr_2>`, ... | Descriptive attributes. |

Constraints:
- Insert-only. A new row appears when the hashdiff changes; old rows
  are never updated or deleted.
- Primary key is `(parent_hk, load_dts)`.
- Two adjacent rows for the same parent (by `load_dts`) must have
  different hashdiffs. If they don't, the load was buggy.

**Sub-types:**
- **Standard satellite** — one row per parent per change. The default.
- **Multi-active satellite (MAS)** — parent hash key has multiple
  *concurrent* descriptive rows (a customer's multiple phone numbers,
  a product's multiple tags). Primary key is `(parent_hk, load_dts,
  sub_sequence)`.
- **Effectivity satellite (EFS)** — tracks when a link relationship
  is effective vs. ended. Two dates: `effective_from` and
  `effective_to`. Enables "which driver drove which car on 2024-06-01?"
  queries.
- **Status-tracking satellite (STS)** — records whether a business key
  exists in the current source snapshot (`'PRESENT'` / `'DELETED'`).
  Used to detect deletions in the source without violating raw-vault
  insert-only.
- **Record-tracking satellite (RTS)** — records every load in which
  the parent hash key was seen (no payload). Distinct from STS:
  RTS tracks *presence over time*, STS tracks *current state*. Often
  paired with STS as the substrate for snapshot-based CDC.
- **Bi-temporal satellite** — historizes on both technical time
  (`load_dts`) and business time (`applied_dts` / `valid_from`).
  Handles sources that back-date or correct historical events.
- **Computed satellite** (business vault only) — payload is derived
  from other vault tables, not from source. Same insert-only + hashdiff
  discipline.

## Reference Table

A **reference table** stores lookup / code data (country codes,
currency codes, calendar, taxonomies) that doesn't fit the hub/link/sat
pattern cleanly. Distinct from hubs because:

- The business key *is* the display value (e.g., `'US'`, `'USD'`).
- Values are stable over long periods.
- Referenced from marts for enrichment, not from other vault objects
  for relationships.

Two variants:
- **No-history reference table** — a simple lookup table, rebuilt on
  refresh. `ref_country`, `ref_calendar`. Materialized as `table`.
- **Historized reference table** — same shape as a small hub+sat,
  used when the reference data itself changes over time and history
  matters (e.g., `ref_currency_rate` with daily exchange rates).

See [reference-tables.md](reference-tables.md).

## Ghost, Zero, and Error Keys

Special hash-key sentinels loaded once per hub at project setup:

- **Ghost / zero key** — hash of `'^^'` (or `'-1'`). Stand-in for
  "unknown" business key. Ensures downstream `LEFT JOIN` from links
  or marts always resolves.
- **Error key** — hash of `'##'` (or `'-2'`). Stand-in for "given but
  invalid" — the source provided a value but it failed a hard-rule
  check. Rare; adopt only when downstream needs to distinguish
  "unknown" from "known-bad".
- **Sentinel keys** — hashes of `'ALL'`, `'N/A'`, etc. for business
  concepts that have those as valid semantic values.

See [zero-keys-and-ghost.md](zero-keys-and-ghost.md).

## Metrics Vault

A **metrics vault** is a set of hubs / links / satellites *about the
loads themselves* — batch IDs, feed IDs, per-batch statistics (rows
read, rows loaded, rows rejected, duration). Follows standard DV
discipline; enables load-observability queries and SLA reporting.

Typical hubs: `hub_load_batch`, `hub_data_feed`.
Typical link: `lnk_load_batch_feed`.
Typical satellite: `sat_lnk_load_batch_feed_metrics`.

See [metrics-and-error-vault.md](metrics-and-error-vault.md).

## Error Mart

A **flat, timestamped log** of rows rejected by hard rules during a
load. Not a full vault structure (no hashes, no historization) — a
straightforward `INSERT` per rejection with:

- `rejection_id`, `load_batch_id`, `rejected_at`, `record_source`
- `rejection_reason` (controlled vocabulary code)
- `rejected_row` (JSON of the failed row)

Enables downstream investigation of "why is data missing", schema-drift
alerting, and audit reconciliation (rows_read = rows_loaded + rows_rejected).

See [metrics-and-error-vault.md](metrics-and-error-vault.md).

## Load Metadata (Required on Every Vault Row)

Every hub, link, and satellite row carries three or four columns of
load metadata that are computed **at load time**, not sourced.

| Column | Semantics | How to compute |
|--------|-----------|----------------|
| `load_dts` | The exact instant *we* loaded this row into the vault. | `run_started_at` (dbt) or `CURRENT_TIMESTAMP()`. Never source `updated_at`. |
| `record_source` | Which system / feed / batch produced the row. | Constant string per model (e.g., `'salesforce.accounts'`). Include enough granularity to trace any row back to its origin. |
| `<entity>_hk` (hubs, links) | Hash of the normalized business key. | MD5 / SHA-1 of the normalized business key. See [hashing-and-keys.md](hashing-and-keys.md). |
| `hashdiff` (satellites) | Hash of the descriptive attributes. Detects change. | MD5 / SHA-1 of the sorted, normalized descriptive columns. |

`load_dts` is often stored with high precision (microsecond) so that
concurrent loads to the same hub don't collide on the satellite PK.

## Business Keys

A **business key** is the identifier the business actually uses to
refer to a real-world entity. Not the source system's surrogate ID
(unless the business happens to use that too).

Rules of thumb:
- If the business could reasonably re-issue the ID in a new source
  system and expect it to still identify the same entity, it's a
  business key. Surrogate IDs (auto-incrementing PKs) usually are not.
- Business keys are stable across source systems. `email` may be the
  business key for a customer even if Salesforce calls their PK
  `sf_contact_id`.
- A business key may be composite: `(store_id, sku)` for an
  inventory item. Every part is required to hash.

**Normalize before hashing.** See
[hashing-and-keys.md](hashing-and-keys.md) for the exact recipe.
Without a shared normalization, two loads of the same business key
produce different hash keys and the vault silently fragments.

## Hash Key

The **hash key** (`_hk`) is the primary key of a hub or link. It's the
MD5 / SHA-1 of the normalized business key(s), stored as a fixed-width
binary or hex string.

Why hash instead of using the business key directly?
1. **Fixed width, fast join.** Hash joins are cheaper than variable-
   length string joins across every satellite lookup.
2. **Composite key collapse.** A composite business key becomes a
   single column, so joins across the vault are uniform.
3. **Parallel loading.** Because the hash is deterministic from the
   business key, hub / link / satellite loads can run in parallel
   without needing to look up a surrogate ID.

Hash collisions are astronomically rare with MD5 (128 bits) at
warehouse scale. Do not use CRC32 or shorter hashes.

## Hashdiff

The **hashdiff** is the MD5 / SHA-1 of a satellite's descriptive
attributes. It's the change-detection primitive: a new satellite row is
inserted only if the current hashdiff differs from the latest row for
that parent hash key.

Rules:
- Hash the same columns, in the same order, with the same
  normalization, every time. Any drift produces false-positive
  changes (looks changed but isn't) or false-negative changes (looks
  unchanged but was).
- Alphabetize the columns before concatenating. Do not rely on
  `SELECT` column order.
- Cast every column to a consistent string type before concatenating.
- Coalesce NULLs to a sentinel (`'^^'` is the AutomateDV default).
- Use a delimiter (`'||'` is the AutomateDV default) between columns
  so `('a', 'bc')` doesn't collide with `('ab', 'c')`.

## Raw Vault vs. Business Vault vs. Information Mart

Data Vault 2.0 has three logical layers on top of the source /
staging area:

| Layer | Purpose | Insert-only? | Business rules? |
|-------|---------|--------------|-----------------|
| **Raw vault** | Historized, source-shaped store. Byte-for-byte re-buildable from source. | Yes | No |
| **Business vault** | Computed hubs / links / satellites that apply business rules on top of the raw vault. Optional. | Yes | Yes |
| **Information mart** | Dimensional / OBT / flat consumption layer for BI, ML, or apps. Usually a `table` or `view` built from PIT + bridge + satellites. | No (rebuildable) | Yes |

A vault project can have zero business vault entities and go straight
from raw vault → information mart, or can have a heavy business vault
that pre-computes cross-source derivations. The information mart is
where reporting joins live; users never query the raw vault directly.

## Point-in-Time (PIT) Tables

A **PIT table** is a snapshot index that answers "as of `date_x`, which
satellite row was current for each parent hash key?" It's the
performance workhorse for information marts — without one, every mart
query has to run a `MAX(load_dts) WHERE load_dts <= snapshot_dts`
correlated sub-query per satellite.

PIT tables are:
- Regenerated on a cadence (daily, hourly).
- One row per parent hash key per snapshot date.
- Columns: parent hash key, snapshot date, and one `(sat_hk, load_dts)`
  pointer per satellite you want to snapshot.

See [pit-and-bridge.md](pit-and-bridge.md) for construction.

## Bridge Tables

A **bridge table** pre-computes multi-hop joins across the vault
(hub → link → hub → link → hub) so information mart queries don't
have to. It's another performance shortcut — pure computation over
the vault, no new information.

Bridge tables are:
- Regenerated on a cadence.
- Optionally combined with PIT semantics (a "point-in-time bridge").
- Columns: the participating hub hash keys, plus any dimensional
  attributes commonly filtered on.

See [pit-and-bridge.md](pit-and-bridge.md) for construction.

## Ghost Records

A **ghost record** is a special row inserted into every hub and
satellite with a known-invalid business key (typically all zeros
hashed, or a sentinel like `'-1'` / `'^^'`). Purpose:

- Guarantees that every `LEFT JOIN` from a link or fact resolves,
  even when the parent key is unknown. Downstream reporting never
  has to handle NULLs on lookup.
- Gives satellites a "no data yet" baseline row so PIT tables have
  something to point at before real data arrives.

Load exactly one ghost per hub and one baseline row per satellite,
at project setup, and never delete them.

## Terminology Cheat Sheet

| Term | Meaning |
|------|---------|
| BK | Business Key |
| HK | Hash Key |
| LDTS / LDT | Load Date/Timestamp (`load_dts`) |
| RSRC | Record Source (`record_source`) |
| ADT / ADTS | Applied Date/Timestamp (business time, for bi-temporal sats) |
| BATCH_ID | Load batch ID (ties rows to a specific ingestion event) |
| HUB / H_ / HUB_ | Hub table (naming convention varies by shop) |
| LNK / L_ / LINK_ | Link table |
| SAT / S_ / SAT_ | Satellite table |
| REF / R_ | Reference table |
| MAS | Multi-Active Satellite |
| EFS / ES | Effectivity Satellite |
| STS | Status-Tracking Satellite |
| RTS | Record-Tracking Satellite |
| PIT | Point-in-Time table |
| BRIDGE | Bridge table |
| BHUB / BH_ / BLNK / BL_ / BSAT / BS_ | Business-vault hub / link / satellite |
| RV | Raw Vault |
| BV | Business Vault |
| MV | Metrics Vault |
| IM | Information Mart |
| EM | Error Mart |
| HR / SR | Hard Rule / Soft Rule |

Match the naming convention the project already uses. Both `hub_customer`
and `H_CUSTOMER` are correct — mixing them in the same project is not.
