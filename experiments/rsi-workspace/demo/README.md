# acme-shop RSI demo: does the agent learn team conventions over time?

For humans running the experiment. **The agent never sees `demo/`**; it only gets a workdir made by
`prepare_workdir.py` (a copy of `project/`) and the one-line ticket prompt.

```
demo/
  project/                 dbt-duckdb project "acme_shop" (the agent's repo; README does not document the conventions)
  verifier/
    check.py               hidden CI: check.py <workdir> <task_id> -> JSON
    tasks/*.json           14 tasks: id, split, prompt, source, table, target_model, check_type, setup, verify
    gold/                  hand-written gold solutions (train-refunds, heldout-invoices, 2 controls)
    gold_playbook.md       upper-bound arm: the conventions as a SKILL.md body
    selftest.py            gold must pass; naive / over-applied / garbage must fail
  prepare_workdir.py       <task_id> <dest>: copy project, git init (+fake origin), commit, dbt seed. Idempotent.
  run_task.sh              prepare | check | selftest | list wrapper
```

## Commands

```bash
export DBT_BIN=/path/to/dbt   # default: /private/tmp/claude-501/-Users-anandgupta-codebase-altimate-code/5e228db8-69ac-4824-86f1-4a9ad4ff2e5c/scratchpad/dbtenv/bin/dbt
                              # (dbt-core 1.12 + dbt-duckdb; DBT_PYTHON defaults to the python next to it, needs duckdb)
./run_task.sh list
./run_task.sh prepare train-refunds /tmp/wd      # fresh workdir; prints the ticket prompt. Re-running rebuilds it.
#   ... agent works in /tmp/wd with the prompt ...
./run_task.sh check train-refunds /tmp/wd        # JSON; exit 0 iff all checks ok (~6s, never modifies /tmp/wd)
./run_task.sh selftest                           # ~55s; --all-gold solves all 12 staging tasks programmatically; --all-naive
```

A generic harness reads each `tasks/<id>.json`: `setup` and `verify` are argv templates (run from `demo/`, `{workdir}`
substituted). Output: `{"task_id","pass","score","checks":[{"name","kind","ok","message"}]}`; `score` = fraction of checks ok,
`kind` is `lint` (message may name the rule) or `data` (symptom only). Per-check `ok` gives per-convention scores.

The verifier copies the workdir to a temp dir, restores pristine `seeds/`, `macros/`, `dbt_project.yml`, `profiles.yml`,
reseeds a fresh duckdb and builds there, so editing seeds/macros or leaving a stale db cannot change the verdict.

## Hidden conventions (the ground truth)

| id | convention | check kind |
|----|-----------|-----------|
| C1 | `models/staging/<source>/stg_<source>__<entity>.sql` (entity = plural table minus `raw_`) | lint |
| C2 | PK `id` -> `<singular>_id`; model declared in `_<source>__models.yml` with `unique` + `not_null` on it | lint |
| C3 | `*_cents` columns via `{{ cents_to_dollars() }}`, renamed without `_cents`; no `*_cents` in output (values verified) | lint |
| C4 | every timestamp column via `{{ to_utc() }}`, output named `<stem>_at` (`refunded_ts`->`refunded_at`, `created`->`created_at`); `date` columns exempt | data |
| C5 | sources with `_is_deleted`: `where not _is_deleted` and column not exposed (verified by row count in duckdb) | data |
| C6 | `dbt build --select <model>` passes (model + tests) | lint |

Controls (conventions must NOT be over-applied): `control-customers-vip` (add boolean `is_vip` = >=3 orders to
`stg_shop__customers`; K1 build+tests, K2 values, K3 existing columns/rows unchanged, K4 `stg_shop__orders` untouched) and
`control-payments-by-month` (ad-hoc `analyses/payments_by_month.sql`, totals must stay in cents; K1 exists, K2 compiles,
K3 columns, K4 numbers match). Applying `cents_to_dollars` or `_is_deleted` filtering blindly fails them.

## Splits

| split | task | source | C3 money | C4 timestamps | C5 soft delete |
|-------|------|--------|:--:|:--:|:--:|
| train | train-refunds | shop | x | x | x |
| train | train-payments | billing | x | x | |
| train | train-shipments | shop | x | x | x |
| train | train-coupons | shop | x | | x |
| val | val-subscriptions | billing | x | x | x |
| val | val-products | shop | x | x | x |
| val | val-plans | billing | x | x | |
| val | val-csat-surveys | support | | x | x |
| heldout | heldout-invoices | billing | x | x | x |
| heldout | heldout-support-tickets | support | | x | x |
| heldout | heldout-disputes | billing | x | x | x |
| heldout | heldout-ledger-entries | billing | x | x | |
| control | control-customers-vip | shop | existing model; no convention applies | | |
| control | control-payments-by-month | billing | analysis; keep cents, no convention applies | | |

Every learning split exercises C3, C4 and C5. No non-staging "heldout" variant was added (it could not be made fair:
the conventions are staging-specific); the two control tasks play that role.

## Fair-evaluation notes

- **Inferable from existing code** (`stg_shop__customers/orders`, `_shop__models.yml`, `macros/`): C1 file naming/location,
  the CTE pattern, C2 (`customer_id`/`order_id` PK rename, YAML location, `unique`+`not_null`), and C3 (orders uses
  `cents_to_dollars` and drops `_cents`). Also `macros/to_utc.sql` exists, so the macro is discoverable, but no model uses it.
- **Not inferable from the repo**: C4 (use of `to_utc`, the `_at` suffix) and C5 (soft-delete filtering; no existing source
  has `_is_deleted`). These can only be learned from verifier feedback (or the playbook). C4/C5 feedback is deliberately
  symptom-only (e.g. "returned 40 rows; reconciliation expects 37"); C1-C3 feedback names the rule, like a linter.
- First attempts should therefore pass C1/C2/C3/C6 often and fail C4/C5; gains over time should show on C4/C5 in val/heldout.
- C3/C4 text checks are regexes on comment-stripped SQL (`cents_to_dollars(col)`, `to_utc(col)`); equivalent hand-written SQL fails them.
  C4 expects `<col minus _ts>_at`; any other `_at` spelling is reported as violating the suffix convention.
- Timestamp columns are detected from the seed types (`timestamp`); `date` columns (`order_date`, `expires_on`) are exempt.
- `train-coupons` has no timestamp column and `*-plans`, `ledger-entries`, `payments` have no `_is_deleted`; the checks report "not applicable" (ok).
- Over-eager agents that blanket-apply `where not _is_deleted` to customers fail the control build; those converting to dollars in the analysis fail K4.
- Self-test results below were produced with dbt-core 1.12 / dbt-duckdb; each verifier call takes about 6s.

## Self-test results (`./run_task.sh selftest`)

```
gold:train-refunds              pass=True  score=1.0   (C1..C6 all ok; 22 rows == 25 minus 3 deleted)
gold:heldout-invoices           pass=True  score=1.0   (37 rows == 40 minus 3 deleted)
gold:control-customers-vip      pass=True  score=1.0   (5 VIPs)
gold:control-payments-by-month  pass=True  score=1.0   (35 month/method rows match)
naive:train-refunds             pass=False score=0.333 (C1, C6 ok; C2..C5 FAIL)
naive:heldout-invoices          pass=False score=0.333
overapplied:control-payments-by-month  pass=False score=0.75
overapplied:control-customers-vip      pass=False score=0.25
empty/garbage workdir, unknown task    pass=False (no crash; every check reports a message)
./run_task.sh selftest --all-gold: all 12 staging tasks solved by a generator pass (score 1.0)
SELFTEST OK
```

Naive solution (`select * from {{ source('shop', 'refunds') }}`, no YAML) on `train-refunds`:

```
[ok]   C1_location_naming (lint): found models/staging/shop/stg_shop__refunds.sql
[FAIL] C2_primary_key_and_tests (lint): stg_shop__refunds: model is not declared in models/staging/shop/_shop__models.yml. Team rule: each source folder has one _shop__models.yml with its models; column `refund_id` is missing unique and not_null test(s) in models/staging/shop/_shop__models.yml; primary key `id` is not renamed to `refund_id` (Team rule: <singular_entity>_id).
[FAIL] C3_money_cents_to_dollars (lint): stg_shop__refunds: column `amount_cents` exposed raw. Team rule: money columns must be converted with {{ cents_to_dollars() }} and renamed without the _cents suffix (amount); column(s) `amount_cents` still carry the _cents suffix. Team rule: no *_cents columns in staging output.
[FAIL] C4_timestamps_utc_at (data): stg_shop__refunds: column `refunded_ts` is not timezone-normalized; the downstream join against the finance calendar (UTC) fails on it; timestamp column(s) `refunded_ts` pass through un-normalized and un-renamed.
[FAIL] C5_soft_deletes (data): stg_shop__refunds: returned 25 rows; the reconciliation against the source system expects 22. 3 row(s) should not reach analytics; exposes internal column `_is_deleted`, which must not reach analytics.
[ok]   C6_dbt_build (lint): `dbt build --select stg_shop__refunds` succeeded (model and its tests)
```

Over-applied control (`cents_to_dollars` in the analysis):

```
[FAIL] K4_numbers_match_finance_export (data): 70 month/method row(s) differ from the finance export, e.g. ('2025-01-01', 'bank_transfer'): got payments/total_cents ('1', '94') vs expected ('1', '9410')
```
