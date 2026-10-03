# Vague task variants (benchmark item 5, file hook)

Same project, same hidden verifier, same `setup`/`verify` argv as the heldout tasks (they still name the ORIGINAL
`heldout-*` id, because `demo/prepare_workdir.py` and `demo/verifier/check.py` read `demo/verifier/tasks/<id>.json`).
Only `id` (`vague-*`), `split` (`vague`), `prompt` change; `base_task` and `original_prompt` are kept for reference.
The prompts avoid: cents, timestamp, deleted, staging, macro, `stg_`, utc, `_at` (checked when generated).
Load them with `tasks_lib.install(tasks_lib.VAGUE_DIR)` then `C.select_tasks(["vague"])`, or pass the JSON to a driver.

| Task | Vague prompt | Lessons it needs (retrieval recall = shown / needed) |
|---|---|---|
| vague-disputes | Add a model for raw_disputes so risk can look at them. | L-2fe6 (`amount_cents`), L-8536 (`_is_deleted`), L-8201 (`opened_ts`, `resolved_ts`) |
| vague-invoices | Finance wants to query invoices; please bring raw_invoices into the project as a model. | L-2fe6 (`total_cents`, `tax_cents`), L-8536, L-8201 (`issued_ts`, `due_ts`) |
| vague-ledger-entries | Accounting needs to query the ledger entries. Set up a model for raw_ledger_entries. | L-2fe6 (`amount_cents`), L-8201 (`posted_ts`); no `_is_deleted` column |
| vague-support-tickets | CX needs the support tickets for their dashboard; make raw_support_tickets available as a model (the entity is support_tickets). | L-8536, L-8201 (`opened_ts`, `closed_ts`); no cents column |

`needs.json` has the same mapping keyed by the ORIGINAL task id (also for the two controls: none needed). L-8aba is never
required by any verifier check. "the entity is support_tickets" is kept from the original prompt (it disambiguates the
primary-key name, C2); it is not a convention word. C1 (location/naming) is still required, so the vague variants also
measure whether the agent infers `models/staging/<source>/stg_<source>__<entity>.sql` from the existing project, which
the `none` arm shows as the baseline.

## Why the lesson is reachable only through a file

Nothing in the prompt matches the lesson text (no keyword overlap with "cents", "timestamp", "deleted", "staging"), so
retrieval by request text should miss them; the files the agent touches carry the signal. Trigger paths on the real
lessons in the pool (`lessons-1000.jsonl` -> `trigger.paths`):

| Lesson | trigger.paths | Surfaces when the agent ... |
|---|---|---|
| L-2fe6 cents | `models/staging/**`, `seeds/raw_*.csv`, `macros/cents_to_dollars.sql` | creates/edits `models/staging/billing/stg_billing__*.sql`, or reads `seeds/raw_<t>.csv` whose header has `*_cents` (disputes, invoices, ledger_entries), or reads the macro |
| L-8536 soft delete | `models/staging/**`, `seeds/raw_*.csv` | same; the `_is_deleted` column is in the raw csv header (disputes, invoices, support_tickets) |
| L-8201 timestamps | `models/staging/**`, `seeds/_seeds.yml`, `macros/to_utc.sql` | same; `seeds/_seeds.yml` lists `column_types: {opened_ts: timestamp, ...}` for the raw tables |
| L-8aba sources yml | `models/staging/**/_*__sources.yml`, `models/staging/**/_*__models.yml` | opens the billing/support sources or models yml |

Typical agent path: `ls`/read `models/staging/shop/stg_shop__orders.sql` (already `models/staging/**`) -> read the
source yml -> read `seeds/raw_<t>.csv` header. Any of these reads, or the final Write of the new model file, should
attach the lessons for the rest of the turn. A hook that fires only on edit/write still works (the new model lives
under `models/staging/**`) but too late for the first draft; a read hook gets them in earlier.

## Caveats for the control tasks

`control-payments-by-month` reads `seeds/raw_payments.csv` (has `amount_cents`) and `analyses/`. The file hook would
surface L-2fe6 there. The lesson text says "staging", and the control's K4 requires cents to stay, so this arm also
measures over-application. Compare the control pass rate with and without the hook; a drop is a finding, not a bug in
the inputs. `control-customers-vip` edits `models/staging/shop/` (L-8201/L-2fe6 surface) and checks that the existing
model is not restructured.
