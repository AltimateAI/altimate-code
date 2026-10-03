# arms2 review

Verifier-safety basis (demo/verifier/check.py): C1 path+name, C2 pk rename (`as <pk>`) + unique/not_null in `_<source>__models.yml`,
C3 `cents_to_dollars('x_cents')` + no `*_cents` + sum==cents/100, C4 `to_utc('x')` + `_at` name + timestamp type,
C5 row count == non-deleted rows and no `_is_deleted` column, C6 `dbt build --select <model>` passes. SQL comments are stripped
before regexes. Column order, whitespace, YAML descriptions and extra YAML columns are never inspected. K1-K4 controls only touch
`stg_shop__customers` (is_vip) and an analysis; the applicable rules are written for new staging models and do not require changing
existing models or analyses.

## applicable40 (36 added rules)

| # | id | rule | why it applies | why it cannot fail a check |
|---|---|---|---|---|
| 1 | L-a302 | Start every staging model with a one-line header comment `-- source: raw_<entity> (<source> source)`; keep Jinja out of SQL comments because dbt renders it. | Documents provenance of the model. | Comments are stripped by strip_comments before regex checks; no Jinja means no render issue. |
| 2 | L-26a3 | Write SQL keywords and function names in lowercase (`select`, `from`, `where`, `as`, `cast`). | House SQL style. | Regexes use re.I only on `as pk`; lowercase `as` is what the gold uses. |
| 3 | L-107c | Indent with four spaces inside a CTE and never use tab characters. | Formatting. | Whitespace-insensitive regexes (\s*, \s+). |
| 4 | L-36f2 | Leave exactly one blank line between CTEs, and a blank line after each `as (` and before the closing `)`. | Layout matches existing stg_shop__* models. | Pure whitespace. |
| 5 | L-9385 | Put commas at the end of the line, never at the start of the next one. | Comma placement convention (not trailing commas before `from`, which would be a syntax error). | Does not change parsed SQL. |
| 6 | L-a405 | Put each selected column on its own line. | Diff-friendly formatting. | Whitespace only; regexes tolerate \s*. |
| 7 | L-e422 | Order output columns keys first: the primary key, then foreign keys in source order. | Column-order convention, part 1. | Order not checked (inspected by name, sums by name). |
| 8 | L-bb35 | After the keys, list descriptive attributes and amounts in their source order. | Column-order convention, part 2. | Same as above. |
| 9 | L-9920 | List date and timestamp columns last, in source order. | Column-order convention, part 3. | Same as above. |
| 10 | L-52f2 | Select explicit column names in the `renamed` CTE; `select * from source` in the `source` CTE and `select * from renamed` at the end are fine. | Explicit contracts in renamed; matches gold shape. | Gold already does this; adds/drops nothing. |
| 11 | L-4a50 | Always spell out `as` when aliasing a column, for example `id as refund_id`, never a bare alias. | Alias style. | C2 regex needs `as <pk>`; this reinforces it. |
| 12 | L-c83c | Name the two CTEs `source` and `renamed`, in that order, with nothing between them. | Shape convention from gold item 2. | Matches gold; no check on names. |
| 13 | L-52d0 | Do not qualify column names with the CTE name (`source.id`); the `renamed` CTE reads from a single relation. | Style. | cents/to_utc regexes match the call, not the column prefix; C3/C4 take the bare name inside the call (a qualified name would break them, so this avoids that). |
| 14 | L-3b6a | Staging models do no joins, aggregations or `distinct`; one source table in, one row per source row out. | Staging layer contract. | Gold has none. |
| 15 | L-82e4 | Staging models contain no `order by` and no `limit`. | Ordering and limiting belong downstream. | Gold has none; row counts are checked and `limit` would break them, so this protects. |
| 16 | L-a997 | Reference raw data only through `{{ source('<source>', '<entity>') }}`; never hardcode schema or table names such as `raw.raw_refunds`. | Lineage convention (gold item 1). | Gold uses source(). |
| 17 | L-cb34 | Staging models do not `ref()` other models; they sit directly on sources. | Layering rule. | Gold has no refs. |
| 18 | L-bce9 | Keep text and categorical columns exactly as the source delivers them: no `lower()`, `trim()` or casts. | Staging stays a rename layer. | Not checked; no columns are asked to change. |
| 19 | L-2d20 | Use unquoted lowercase snake_case for every output column name. | Naming hygiene. | Source names are already snake_case; pk/money/ts names are lowercase. |
| 20 | L-d164 | Put the `where not _is_deleted` filter on its own line directly after `from source` when a filter is needed. | Filter placement; reinforces the real soft-delete lesson. | Same predicate as gold; only layout. |
| 21 | L-3f2f | Put the `{{ cents_to_dollars('x_cents') }}` and `{{ to_utc('x_ts') }}` calls on the same line as their `as` alias. | Keeps the transform and its output name together. | Regexes already tolerate this form and gold has it. |
| 22 | L-43cf | Open the model with `{{ config(tags=['staging']) }}` below the header comment. | Tagging convention for selecting layers. | Does not change materialization or build; not parsed by checks. |
| 23 | L-71e2 | End each SQL and YAML file with a single newline and no trailing whitespace. | Editor hygiene. | Whitespace. |
| 24 | L-29d6 | Keep every line under 100 characters. | Readability. | Whitespace/layout only. |
| 25 | L-978f | Document the new model in `_<source>__models.yml` with a one-sentence description in the form `<Plural entity>, one row per <singular entity>.` | Matches existing yml descriptions. | Model description untested; tests on pk unchanged. |
| 26 | L-5edb | Give every output column a `description` in the models YAML, as a short sentence starting with a capital and ending with a period. | Column docs. | Descriptions are not tests; unlisted/extra columns do not fail dbt build. |
| 27 | L-9094 | List columns in the models YAML in the same order as the final select. | Keeps yml and SQL aligned. | Order is irrelevant to dbt. |
| 28 | L-f5bd | Describe converted money columns in YAML with their unit, for example `Amount in dollars.` | Column docs. | Text only. |
| 29 | L-7d96 | Describe timestamp columns in YAML as UTC, for example `Time the refund was issued, in UTC.` | Column docs. | Text only. |
| 30 | L-99d5 | Quote YAML descriptions that contain a colon, and keep Jinja braces out of them. | Avoids yaml/Jinja parse errors. | Prevents a build break rather than causing one. |
| 31 | L-ca34 | Keep the models YAML at two-space indentation with `version: 2` first and a blank line between model entries. | Matches `_shop__models.yml`. | Whitespace; same structure the gold uses. |
| 32 | L-b7ab | List models in `_<source>__models.yml` in alphabetical order by name. | Predictable yml. | Order irrelevant to dbt; C2 reads patch_path. |
| 33 | L-4c9b | Do not edit `dbt_project.yml`, seeds or macros when adding a staging model; the existing project config already covers it. | Scope discipline. | Verifier restores these files anyway; changing them could only confuse. |
| 34 | L-19d4 | Do not create extra files for a staging model beyond its `.sql` and the models YAML (no docs blocks, no per-model yml). | Layout convention. | C2 requires the one `_<source>__models.yml`; this reinforces it. |
| 35 | L-4773 | Before building, run `dbt compile --select <model>` and read the compiled SQL to confirm every macro expanded. | Process. | Process only; leaves no artifacts the checks read. |
| 36 | L-64b6 | In the final summary list the columns you renamed or converted, as `old -> new`. | Handoff convention. | Chat output only. |

Real bullets sit at positions 6, 16, 26, 36 (1-indexed) via `make_arms.spread`.

## overgeneral (4 reworded bullets)

Same 4 lessons with the `staging models` / `new source` scope removed so they read as universal. Intended failure mode:
the model over-applies them to the control tasks (K4 on `control-payments-by-month` needs `total_cents` in cents; K3 on
`control-customers-vip` must keep existing columns/row counts and not restructure).

## conflict (4 real + 4 stale)

Order: stale-money, REAL-money, stale-timestamps, REAL-timestamps, REAL-soft-delete, stale-soft-delete, REAL-yml, stale-naming.
Stale-before-real for money and timestamps; stale-after-real for soft deletes and naming/yml.

Note: the 4 real bullets contain no naming rule (L-8aba is YAML registration), so stale (d) contradicts the verifier/gold
convention `stg_<source>__<entity>` (C1) and is paired with L-8aba, adding a YAML-entry name clause that touches registration.

- L-5c1d (money, h:1 x:0): Convert integer `*_cents` columns by dividing inline (`amount_cents / 100.0 as amount`); do not call macros in staging models, keep them plain SQL.
- L-a37e (ts, h:1 x:0): Normalize timestamp columns with `convert_timezone('UTC', col)` and keep the original column name; do not rename them with an `_at` suffix.
- L-9e42 (sd, h:2 x:1): Keep `_is_deleted` in staging output and do not filter it there; filter soft-deleted rows in the marts so history is preserved.
- L-7b60 (name, h:1 x:0): Staging models are named `stg_<entity>.sql` without the source prefix, and their YAML entry uses the same name.
