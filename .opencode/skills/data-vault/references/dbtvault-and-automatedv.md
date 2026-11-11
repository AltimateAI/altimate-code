# AutomateDV (formerly dbtvault) and datavault4dbt

Two dbt packages implement DV 2.0 with a macro-first approach:

- **AutomateDV** (formerly **dbtvault**) — the more mature package.
  Snowflake, BigQuery, Databricks, MS SQL, Postgres.
  https://automate-dv.readthedocs.io/
- **datavault4dbt** — newer, more actively developed 2024–2025.
  Snowflake, BigQuery, Databricks, Postgres, Exasol.
  https://datavault4dbt.com/

Both encode the insert-only + hashdiff + record-source contract in
macros. Prefer them over hand-rolled SQL when they support your
warehouse — the hand-rolled patterns in this skill's other reference
files are for when the package doesn't support your case or when
you're auditing/understanding what the package generates.

## When to Use a Package vs. Hand-Roll

**Use the package** when:
- Your warehouse is supported.
- The standard hub / link / satellite templates cover your case.
- You're building 10+ vault tables and consistency across them matters.
- Your team hasn't built vaults before — the package encodes correct
  defaults so beginners produce correct SQL.

**Hand-roll** when:
- Your warehouse isn't supported (e.g., Redshift + AutomateDV — check
  current support matrix).
- You need a non-standard structure the macro doesn't cover (weird
  effectivity semantics, custom audit columns, cross-tenant partitioning).
- You need to understand exactly what runs — audit / compliance
  demands review-ability of every line.

## AutomateDV Macro Reference

The five macros that cover 90% of raw vault:

| Macro | Purpose |
|-------|---------|
| `automate_dv.hub` | Standard hub |
| `automate_dv.link` | Standard link |
| `automate_dv.t_link` | Transactional (non-historized) link |
| `automate_dv.sat` | Standard satellite |
| `automate_dv.ma_sat` | Multi-active satellite |
| `automate_dv.eff_sat` | Effectivity satellite |
| `automate_dv.pit` | Point-in-time table |
| `automate_dv.bridge` | Bridge table |

### Hub via AutomateDV

```sql
-- models/raw_vault/hubs/hub_customer.sql
{{ config(materialized='incremental', tags=['raw_vault', 'hub']) }}

{%- set source_model = ['stg_crm__customers', 'stg_erp__customer_master'] -%}
{%- set src_pk = 'CUSTOMER_HK' -%}
{%- set src_nk = 'CUSTOMER_BK' -%}
{%- set src_ldts = 'LOAD_DTS' -%}
{%- set src_source = 'RECORD_SOURCE' -%}

{{ automate_dv.hub(
    src_pk=src_pk,
    src_nk=src_nk,
    src_ldts=src_ldts,
    src_source=src_source,
    source_model=source_model
) }}
```

The staging models `stg_crm__customers` etc. must expose
`CUSTOMER_HK`, `CUSTOMER_BK`, `LOAD_DTS`, `RECORD_SOURCE` — AutomateDV
provides a `stage` macro that computes these:

```sql
-- models/staging/stg_crm__customers.sql
{{ config(materialized='view') }}

{%- set source_model = source('crm', 'customers') -%}
{%- set hashed_columns = {
    'CUSTOMER_HK': 'CUSTOMER_ID'
} -%}
{%- set derived_columns = {
    'RECORD_SOURCE': "!crm.customers",
    'LOAD_DTS': "!' ~ run_started_at ~ '"
} -%}
{%- set columns_to_select = ['CUSTOMER_ID AS CUSTOMER_BK'] -%}

{{ automate_dv.stage(
    include_source_columns=false,
    source_model=source_model,
    derived_columns=derived_columns,
    hashed_columns=hashed_columns,
    ranked_columns=none
) }}
```

The `stage` macro applies the normalization (UPPER + TRIM + COALESCE
+ delimiter + MD5) automatically. Configure the defaults globally in
`dbt_project.yml`:

```yaml
vars:
  hash: 'MD5'                    # or SHA (SHA1) / SHA_256
  hash_content_casing: 'UPPER'
  null_placeholder_string: '^^'
  concat_string: '||'
```

### Satellite via AutomateDV

```sql
-- models/raw_vault/satellites/sat_customer_details.sql
{{ config(materialized='incremental', tags=['raw_vault', 'satellite']) }}

{%- set source_model = 'stg_crm__customers' -%}
{%- set src_pk = 'CUSTOMER_HK' -%}
{%- set src_hashdiff = 'HASHDIFF' -%}
{%- set src_payload = ['FIRST_NAME', 'LAST_NAME', 'EMAIL', 'PHONE',
                        'ADDRESS_LINE_1', 'ADDRESS_LINE_2', 'CITY',
                        'POSTAL_CODE', 'COUNTRY_CODE'] -%}
{%- set src_ldts = 'LOAD_DTS' -%}
{%- set src_source = 'RECORD_SOURCE' -%}

{{ automate_dv.sat(
    src_pk=src_pk,
    src_hashdiff=src_hashdiff,
    src_payload=src_payload,
    src_ldts=src_ldts,
    src_source=src_source,
    source_model=source_model
) }}
```

The staging model needs an added `HASHDIFF` hashed-columns entry:

```jinja
{%- set hashed_columns = {
    'CUSTOMER_HK': 'CUSTOMER_ID',
    'HASHDIFF': {
        'is_hashdiff': true,
        'columns': ['FIRST_NAME', 'LAST_NAME', 'EMAIL', 'PHONE',
                    'ADDRESS_LINE_1', 'ADDRESS_LINE_2', 'CITY',
                    'POSTAL_CODE', 'COUNTRY_CODE']
    }
} -%}
```

`is_hashdiff: true` triggers alphabetical sorting — AutomateDV handles
the "sort before hash" rule automatically.

### Link via AutomateDV

```sql
{{ config(materialized='incremental', tags=['raw_vault', 'link']) }}

{{ automate_dv.link(
    src_pk='LNK_ORDER_CUSTOMER_HK',
    src_fk=['ORDER_HK', 'CUSTOMER_HK'],
    src_ldts='LOAD_DTS',
    src_source='RECORD_SOURCE',
    source_model='stg_ecommerce__orders'
) }}
```

The staging model computes all three hashes (`LNK_ORDER_CUSTOMER_HK`,
`ORDER_HK`, `CUSTOMER_HK`) via `hashed_columns`.

### Effectivity Satellite via AutomateDV

```sql
{{ config(materialized='incremental', tags=['raw_vault', 'satellite', 'effectivity']) }}

{{ automate_dv.eff_sat(
    src_pk='LNK_CUSTOMER_ACCOUNT_MANAGER_HK',
    src_dfk=['CUSTOMER_HK'],                  -- driving foreign keys (stable)
    src_sfk=['ACCOUNT_MANAGER_HK'],           -- secondary foreign keys (can change)
    src_start_date='EFFECTIVE_FROM',
    src_end_date='EFFECTIVE_TO',
    src_eff='EFFECTIVE_FROM',
    src_ldts='LOAD_DTS',
    src_source='RECORD_SOURCE',
    source_model='stg_crm__assignments'
) }}
```

AutomateDV's `eff_sat` handles the two-pass logic (opens + closes).
Hand-rolling this is error-prone; use the macro.

### PIT via AutomateDV

```sql
{{ config(materialized='table', tags=['business_vault', 'pit']) }}

{{ automate_dv.pit(
    src_pk='CUSTOMER_HK',
    as_of_dates_table=ref('as_of_date'),
    satellites={
        'SAT_CUSTOMER_DETAILS': {
            'pk': 'CUSTOMER_HK',
            'ldts': 'LOAD_DTS'
        },
        'SAT_CUSTOMER_ADDRESS': {
            'pk': 'CUSTOMER_HK',
            'ldts': 'LOAD_DTS'
        }
    },
    src_ldts='LOAD_DTS',
    source_model='HUB_CUSTOMER'
) }}
```

`as_of_date` is a helper model containing one row per snapshot date —
build it once, reference from every PIT.

## datavault4dbt Highlights

Similar shape to AutomateDV; some notable differences:

- **Snowflake dynamic tables** — datavault4dbt has first-class
  support for Snowflake dynamic tables as a materialization for
  vault objects. See [snowflake-specific.md](snowflake-specific.md).
- **Ghost record** — auto-generates ghost rows for every hub and
  baseline rows for every satellite; no separate operation needed.
- **Business vault macros** — includes `bridge`, `pit`, and computed
  satellite templates out of the box.
- **Load-optimization macros** — `hub_incremental_lookback` and
  similar helpers that reduce full-table scans on very large hubs.

Choose based on your warehouse + team preference. Both are correct
DV 2.0 implementations.

## Package Installation

```yaml
# packages.yml — AutomateDV
packages:
  - package: Datavault-UK/automate_dv
    version: 0.11.1                    # check for latest

# OR datavault4dbt
packages:
  - package: ScalefreeCOM/datavault4dbt
    version: [">=1.4.0", "<2.0.0"]     # check for latest
```

Run `dbt deps` after adding.

## When to Prefer Hand-Rolled SQL

Even in a package-based project, hand-roll when:

- **You need a column the macro doesn't expose.** E.g., a
  data-classification tag that must appear on every satellite row.
  Hand-roll (or extend the macro via a shadowing pattern).
- **The macro's default hash function is wrong for your warehouse.**
  E.g., you need `SHA_256` in binary format on a warehouse whose
  package template defaults to MD5 hex.
- **You need to layer additional testing.** Some shops want an
  additional load-batch UUID on every row. Wrap the macro or
  hand-roll.
- **You're modeling a non-standard structure.** Same-as links,
  reference tables that hang off hubs but aren't strictly satellites,
  domain-specific extensions. Read the package's macro source and
  extend from there.

## Package Test Macros

Both packages include vault-specific tests. Use them.

AutomateDV:
- `automate_dv.unique_combination_of_columns` — for satellite PK
  uniqueness on `(parent_hk, load_dts)`.
- `automate_dv.relationships` — FK checks between hubs and links.

datavault4dbt:
- Similar tests plus `datavault4dbt.hub_ghost_record` to assert the
  ghost row is present.

Plus dbt-utils' `unique_combination_of_columns`,
`relationships_where`, and the custom `assert_no_consecutive_matching_hashdiffs`
test from [satellite-patterns.md](satellite-patterns.md).

## Common Package Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Configuring `hash: 'MD5'` in one project but the shared macros hardcode SHA1 | Hash keys don't line up between projects | Set the global config; don't override in individual macros |
| Skipping the `stage` macro and passing raw sources into `hub` | `hub` macro assumes hashes are pre-computed; it errors or produces garbage | Every raw source flows through `stage` first |
| Using AutomateDV's `sat` on a multi-active source | Loses the multi-active grain, silently deduplicates | Use `ma_sat` for multi-active |
| Mixing AutomateDV and datavault4dbt in one project | Two different hash conventions coexist; nothing joins | Pick one package per project |
| Using package `merge` mode when your warehouse defaults to it | Insert-only violated at the incremental strategy layer | Check `incremental_strategy` in `dbt_project.yml`; force `append` for vault tables |
| Building a PIT before satellites are stable | PIT points at satellite rows that get retracted → broken refs | Only build PIT after satellite has a stable history |
