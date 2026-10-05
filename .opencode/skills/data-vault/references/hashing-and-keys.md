# Hashing and Business-Key Normalization

**Read this first, before writing any hub / link / satellite SQL.**
Every DV 2.0 correctness property depends on hashes being computed
identically everywhere they're computed. A single inconsistency —
one hub trims, another doesn't; one satellite uppercases, another
lowercases — silently fragments the vault.

## Ask the User First — Normalization Conventions

Every one of these is a project-wide decision that cannot be
retroactively changed without rehashing every row in every hub,
link, and satellite (see the rehashing playbook in
[scale-and-ops.md](scale-and-ops.md)). Confirm all six *before*
writing a single hash macro:

| Convention | Options | Ask user |
|------------|---------|----------|
| Hash algorithm | MD5 / SHA-1 / SHA-256 | Does compliance require SHA-family, or is MD5 acceptable? |
| Hash storage | Binary (BINARY(16), BYTES, VARBINARY) / Hex (VARCHAR(32)) | Storage engine supports binary? Downstream consumers accept binary? |
| Case | UPPER / LOWER / preserve | Any source case-sensitive by contract? Otherwise UPPER by convention. |
| NULL sentinel | `'^^'` / `'-1'` / `'#NULL#'` | Any conflict with real business-key values (unlikely for `'^^'`)? |
| Delimiter | `'\|\|'` / `'~'` / `'\|~\|'` | Any character forbidden in business keys? |
| Whitespace | TRIM edges / no trim / normalize interior | Sources ever produce meaningful trailing spaces? |
| Empty-string handling | Treat `''` as NULL / treat as literal `''` | Sources emit meaningful empty strings? |

**Do not proceed with defaults.** The defaults in AutomateDV
(UPPER, `'^^'`, `'||'`, MD5, binary storage) are sensible but
still deserve confirmation — some sources genuinely have
lowercase-meaningful keys or contain `||` in the raw value.

## The Normalization Recipe

Applied to *every* business key input to a hash, in this order:

1. **Cast to string.** `CAST(bk AS VARCHAR)` — every part of a composite
   key becomes a string before any other step.
2. **Trim whitespace.** `TRIM(...)` — leading and trailing spaces are
   invisible and produce different hashes.
3. **Case-normalize.** `UPPER(...)`. Pick UPPER or LOWER project-wide
   and never mix. AutomateDV defaults to UPPER; datavault4dbt also
   defaults to UPPER.
4. **NULL-coalesce to sentinel.** `COALESCE(..., '^^')`. A NULL business
   key becomes the literal `'^^'` (AutomateDV convention) or `'-1'`.
   Pick one project-wide.
5. **Concatenate with delimiter.** `... || '||' || ...`. Use `'||'`
   between parts. Without a delimiter, `('a','bc')` and `('ab','c')`
   collide.
6. **Hash.** Apply MD5 or SHA-1 (see dialect table below).

Every step is required. Skipping trim is the most common bug — the
source will helpfully insert a trailing space in exactly one system,
and joins will silently miss.

## The Normalization Macro

Put the recipe in one macro and call it everywhere. Do not inline the
CAST / TRIM / UPPER / COALESCE chain — someone will forget a step.

```jinja
{# macros/dv_hash_bk.sql #}
{% macro dv_hash_bk(columns) %}
  {# columns: list of column expressions (in canonical order) #}
  {%- set parts = [] -%}
  {%- for col in columns -%}
    {%- do parts.append("COALESCE(NULLIF(UPPER(TRIM(CAST(" ~ col ~ " AS VARCHAR))), ''), '^^')") -%}
  {%- endfor -%}
  {{ dv_hash_function() }}(
    {{ parts | join(" || '||' || ") }}
  )
{% endmacro %}

{# macros/dv_hash_function.sql — one place to pick the hash #}
{% macro dv_hash_function() %}
  {%- if target.type in ('snowflake', 'bigquery') -%}
    MD5_BINARY
  {%- elif target.type == 'redshift' -%}
    MD5
  {%- elif target.type == 'postgres' -%}
    MD5
  {%- elif target.type == 'databricks' -%}
    MD5
  {%- else -%}
    MD5
  {%- endif -%}
{% endmacro %}
```

Call sites:

```sql
-- In hub_customer:
{{ dv_hash_bk(['customer_id']) }} AS customer_hk

-- In lnk_order_customer:
{{ dv_hash_bk(['order_id', 'customer_id']) }} AS lnk_order_customer_hk

-- Also compute each participating hub's hash:
{{ dv_hash_bk(['order_id']) }}    AS order_hk,
{{ dv_hash_bk(['customer_id']) }} AS customer_hk
```

**The order of `columns` must be the canonical order for that link**,
and it must match everywhere the same link is referenced. Document
the canonical order in the link's `_models.yml`.

## The Hashdiff Recipe

For satellites, hash the *descriptive* columns (never the parent
hash key, never the load metadata). Same normalization, but the
column list must be:

1. **Alphabetized.** Do not depend on SELECT order — someone will
   reorder it during a "cleanup" refactor and silently break history.
2. **Complete.** Every descriptive column that belongs in the
   satellite. Adding a column later requires a schema-evolution plan
   (see "Adding a column to a satellite" below).

```jinja
{# macros/dv_hashdiff.sql #}
{% macro dv_hashdiff(columns) %}
  {%- set sorted_cols = columns | sort -%}
  {%- set parts = [] -%}
  {%- for col in sorted_cols -%}
    {%- do parts.append("COALESCE(NULLIF(UPPER(TRIM(CAST(" ~ col ~ " AS VARCHAR))), ''), '^^')") -%}
  {%- endfor -%}
  {{ dv_hash_function() }}(
    {{ parts | join(" || '||' || ") }}
  )
{% endmacro %}
```

Call site inside a satellite:

```sql
{{ dv_hashdiff(['first_name', 'last_name', 'email', 'phone', 'address_line_1']) }} AS hashdiff
```

## Dialect-Specific Hash Functions

| Warehouse | Function | Storage type | Notes |
|-----------|----------|--------------|-------|
| Snowflake | `MD5_BINARY(x)` | `BINARY(16)` | Half the storage of hex; fastest joins. `MD5(x)` also works but returns hex. |
| BigQuery | `MD5(x)` returns BYTES | `BYTES` | Cast to `STRING` via `TO_HEX(MD5(x))` if joins need hex. |
| Redshift | `MD5(x)` | `VARCHAR(32)` | No binary type; hex only. |
| PostgreSQL | `MD5(x)` | `TEXT` (32 chars) | Use `decode(md5(x), 'hex')` for `bytea` if you want binary. |
| Databricks | `MD5(x)` | `STRING` (32 hex chars) | `sha1(x)` also available (40 hex chars). |
| SQL Server | `HASHBYTES('MD5', x)` | `VARBINARY(16)` | Legacy: requires explicit `VARBINARY` cast. |
| DuckDB | `MD5(x)` | `VARCHAR` (32 hex) | Also `hash(x)` for 64-bit int — do *not* use for DV. |

**Pick binary types when the warehouse supports them.** Snowflake's
`BINARY(16)` join is roughly 2× faster than `VARCHAR(32)` at scale
and halves storage. Downstream consumers who need to see the hash
can `TO_VARCHAR(hk, 'HEX')` on demand.

## Never Use These As Hashes

- **CRC32 / xxhash / hash() / farm_fingerprint** — too short. Even a
  billion-row hub has a real collision risk with 32-bit hashes.
- **The source system's surrogate PK** — that's a source ID, not a
  cryptographic hash of a business key. It changes if the source is
  ever reloaded and it can't be recomputed from business context.
- **A concatenated business-key string, unhashed** — variable width,
  slow to join, and NULL / delimiter / case issues bite you at the
  join site instead of the hash site.

## Business Key Normalization Choices — Pick Once

For each of these, decide the project convention *once* and record it
in the project's `README` or `CLAUDE.md`. Every hub / link / satellite
must follow the same choice.

| Choice | Options | Default (AutomateDV) |
|--------|---------|----------------------|
| Case | UPPER / LOWER / preserve | UPPER |
| NULL sentinel | `'^^'` / `'-1'` / `'#NULL#'` | `'^^'` |
| Delimiter | `'||'` / `'~'` / `'\|~\|'` | `'||'` |
| Hash algorithm | MD5 / SHA-1 / SHA-256 | MD5 |
| Hash storage | Binary / Hex | Binary (where supported) |
| Whitespace | TRIM (leading + trailing) / no trim | TRIM |
| Empty string handling | Treat `''` as NULL / treat as `''` | Treat `''` as NULL (via `NULLIF(..., '')`) |

Changing any of these later requires **re-hashing every row of every
hub / link / satellite in the vault**. Pick correctly the first time.

## Adding a Column to a Satellite — Hashdiff Evolution

Adding a new column to an existing satellite changes every future
hashdiff. Two acceptable approaches:

**Approach A — new satellite.** Create `sat_customer_v2` with the
extended column list. Old satellite keeps its history frozen; new
one starts fresh. Downstream marts choose which to read.

**Approach B — retire and rebuild.** If you have permission to reload
history (the source is fully re-readable): drop the old satellite,
create the new one, reload from source. Uses more compute but keeps
one satellite per attribute cadence.

**Never** just add the column and re-run. The very next load will
insert a new row for every parent hash key (because the hashdiff
changed for all of them), producing a huge "phantom change" event
downstream marts have to explain.

## Verifying Hash Consistency

Before declaring a vault load correct, spot-check:

```sql
-- Same business key → same hash key, everywhere it's computed
SELECT customer_hk FROM {{ ref('hub_customer') }}    WHERE customer_id = '<known-id>'
UNION ALL
SELECT customer_hk FROM {{ ref('lnk_order_customer') }} WHERE ...;
-- The two rows must have the same customer_hk.

-- Hashdiff stability: reloading the same source row must not create a new satellite row
{{ dv_hashdiff(['first_name', 'last_name', 'email']) }} AS test_hashdiff
FROM {{ source('crm', 'customers') }}
WHERE customer_id = '<known-id>';
-- Compare against the latest hashdiff for that customer_hk in sat_customer.
-- If they differ but the source row didn't change, normalization is drifting.
```

Codify the first check as a dbt test:

```yaml
# _models.yml
models:
  - name: lnk_order_customer
    tests:
      - dbt_utils.relationships_where:
          to: ref('hub_customer')
          field: customer_hk
          column_name: customer_hk
```

## Ghost Record Hash

The ghost record is a hub row with a known-invalid business key whose
hash is deterministic and reserved. Insert it once at vault setup:

```sql
-- Ghost row in every hub
INSERT INTO hub_customer (customer_hk, customer_bk, load_dts, record_source)
SELECT
    {{ dv_hash_function() }}('^^')      AS customer_hk,   -- literal sentinel, hashed
    '^^'                                AS customer_bk,
    '1900-01-01'::TIMESTAMP             AS load_dts,
    'SYSTEM'                            AS record_source;
```

Every satellite gets a corresponding baseline row with the same
`customer_hk` and NULLed-out (or `'^^'`-filled) descriptive columns.
Never delete these.
