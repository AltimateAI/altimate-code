# Optimizer agent eval fixture — answer key

A small DuckDB dbt project with PLANTED optimization issues. Used by
`test/altimate/optimizer-prompt-contract.test.ts` (evidence-chain checks) and
`test/altimate/optimizer-agent-eval.test.ts` (opt-in live-agent eval).

This file MUST stay outside `optimizer-project/` — the live eval copies that
directory into a tmpdir the agent scans, and the answers must not leak.

Planted issues (the eval grades the agent on finding these):

| # | Category         | Model(s)                        | Issue |
|---|------------------|---------------------------------|-------|
| 1 | materialization  | `fct_events_daily`              | Full-rebuild `table` model over an append-style event stream with `event_id` grain + `loaded_at` cursor. The fixture has NO query history, so a correct agent proposes incremental as a cost-blind, precondition-gated candidate (statically evident: full rebuild + cursor column), not as a verified cost win. |
| 2 | dag (dead model) | `legacy_events_backup`          | No downstream model, exposure, or selector references it — dead model, report-only per the prompt (deletion needs owner confirmation). |
| 3 | performance      | `stg_events` -> downstream      | `SELECT *` propagation from staging into marts. (`stg_events` staying a table is defensible — it has 4+ consumers — so materialization of this model is deliberately NOT graded.) |
| 4 | performance      | `fct_events_daily`              | `ORDER BY` in a model with no LIMIT (pointless sort cost at build time) |
| 5 | DRY              | `rpt_us.sql`, `rpt_eu.sql`, `rpt_apac.sql` | The same 16-line `revenue_base` CTE duplicated verbatim in 3 models |
| 6 | testing/docs     | `dim_customers`                 | No tests, no description; primary key `customer_id` untested |

Do not "fix" these models — the defects are the fixture.
