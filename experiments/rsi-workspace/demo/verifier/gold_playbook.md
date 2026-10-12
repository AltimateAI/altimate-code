# acme-shop dbt staging conventions

Use this when adding or changing models in the acme-shop dbt project.

## New staging model (`models/staging/<source>/`)

1. **Location and name.** `models/staging/<source>/stg_<source>__<entity>.sql`, where `<source>` is the dbt
   source name (`shop`, `billing`, `support`) and `<entity>` is the plural table name without the `raw_` prefix
   (`raw_refunds` -> `stg_shop__refunds`). Read the table via `{{ source('<source>', '<entity>') }}`.
2. **Shape.** CTE pattern: `with source as (select * from {{ source(...) }}), renamed as (select ... from source) select * from renamed`.
3. **Primary key.** Rename `id` to `<singular_entity>_id` (`refunds` -> `refund_id`, `support_tickets` -> `support_ticket_id`,
   `ledger_entries` -> `ledger_entry_id`). Foreign keys keep their names.
4. **Tests.** Declare the model in `models/staging/<source>/_<source>__models.yml` (create it if the source has none)
   with `unique` and `not_null` on the primary key.
5. **Money.** Columns ending in `_cents` are integer cents. Convert with `{{ cents_to_dollars('x_cents') }}` and rename
   without the suffix (`amount_cents` -> `amount`). No `*_cents` column may remain in staging output.
6. **Timestamps.** Wrap every timestamp column in `{{ to_utc('col') }}` and name the output with an `_at` suffix
   (`refunded_ts` -> `refunded_at`, `created` -> `created_at`). Plain `date` columns are left alone.
7. **Soft deletes.** If the source has an `_is_deleted` column, filter with `where not _is_deleted` and do not expose
   the column.
8. Verify with `dbt seed` then `dbt build --select <model>` (run from the project root with `--profiles-dir .`).

## What these rules do NOT apply to

- Analyses (`analyses/`), ad-hoc queries and one-off scripts: use whatever units the ticket asks for (for example
  cents when finance reconciles in cents). Do not apply the staging conventions there.
- Existing models you are only extending (adding a column): do not restructure, rename or re-filter them; add what
  was asked and keep existing columns and row counts intact. Only apply `_is_deleted` filtering when the source
  actually has that column.
