---
title: "Agent Modes — Builder, Analyst, Reviewer, dbt-Optimizer, and Plan"
description: "Altimate Code offers five agent modes: Builder (full tool access), Analyst (read-only), Reviewer (signed dbt PR verdicts), dbt-Optimizer (dbt project optimization), and Plan (planning only)."
---

# Agent Modes

altimate runs in one of five specialized modes. Each mode has different permissions, tool access, and behavioral guardrails.

| Mode | Access | Purpose |
|---|---|---|
| **Builder** | Read/Write | Create and modify data pipelines |
| **Analyst** | Read-only | Safe exploration and cost analysis |
| **Reviewer** | Read-only | dbt PR review with a signed, engine-backed verdict — see [dbt PR Review](../usage/dbt-pr-review.md) |
| **dbt-Optimizer** | Read + approval-gated writes | Scan a dbt project for fixable issues, propose fixes with cost/impact evidence |
| **Plan** | Minimal | Planning only, no edits or execution |

## Builder

**Full read/write access. For creating and modifying data pipelines.**

```bash
altimate --agent builder
```

> Tip: `--yolo` auto-approves permission prompts for faster iteration (`altimate --yolo --agent builder`). Not recommended with live warehouse connections. Use on local/dev environments only. See [Permissions: Yolo Mode](../configure/permissions.md#yolo-mode).

Builder mode classifies every SQL query before execution. Read queries run freely. Write queries (`INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`) prompt for approval. Destructive SQL (`DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE`) is hard-blocked and cannot be overridden.

### Example: Create a staging model

```
You: Create a staging model for the raw_orders table

Builder: Let me inspect the source table first.

> schema_inspect raw_orders
  Columns: order_id (NUMBER), customer_id (NUMBER), order_date (TIMESTAMP),
           amount (FLOAT), status (VARCHAR), _loaded_at (TIMESTAMP)

> lineage_check "SELECT * FROM raw.raw_orders"
  Lineage: raw.raw_orders → all columns flow through

I'll create a staging model with proper typing, deduplication, and column naming:

> write models/staging/stg_orders.sql
  WITH source AS (
      SELECT * FROM {{ source('raw', 'raw_orders') }}
  ),
  deduplicated AS (
      SELECT *,
          ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY _loaded_at DESC) AS rn
      FROM source
  )
  SELECT
      order_id,
      customer_id,
      order_date,
      amount::DECIMAL(12,2) AS order_amount,
      LOWER(status) AS order_status
  FROM deduplicated
  WHERE rn = 1

> sql_analyze [the above SQL]
  ✓ No anti-patterns detected (confidence: high)

> dbt_run --select stg_orders
  ✓ Compiled and ran successfully
```

### What builder can do

- Create and edit SQL files, dbt models, YAML configs
- Execute SQL (DDL/DML/DQL) with write approval prompts
- Run dbt commands
- Generate tests and documentation
- Scaffold new models from templates

---

## Analyst

**Read-only access. Safe for production environments.**

```bash
altimate --agent analyst
```

Analyst mode enforces strict guardrails:

- **SELECT only.** INSERT, UPDATE, DELETE, DROP are denied (not prompted, blocked entirely)
- **No file writes.** Cannot modify your codebase
- **Safe bash only.** `ls`, `grep`, `cat`, `head`, `tail`, `find`, `wc` auto-allowed. dbt read commands allowed (`dbt list`, `dbt ls`, `dbt debug`, `dbt deps`). Everything else denied.
- **Full web access.** Fetch and search allowed without prompts
- **All inspection tools.** Schema, warehouse, finops, lineage, and core analysis tools available

### Example: Investigate expensive queries

```
You: What's driving our Snowflake costs this week?

Analyst: Let me pull the query history and credit analysis.

> finops_analyze_credits prod-snowflake --days 7
  Total credits: 847.2
  Top warehouse: TRANSFORM_WH (523.1 credits, 62%)
  Daily trend: ↑ 15% vs last week

> finops_expensive_queries prod-snowflake --days 7 --limit 5
  1. SELECT * FROM events JOIN users... (89.3 credits, 47 runs)
  2. CREATE TABLE AS SELECT...         (45.1 credits, 1 run)
  3. SELECT COUNT(DISTINCT...)         (23.7 credits, 312 runs)

The #1 cost driver is a query running 47 times that scans the full
events table with a SELECT *. Let me analyze it:

> sql_analyze "SELECT * FROM events JOIN users ON events.user_id = users.id"
  ⚠ SELECT_STAR: Use explicit column list (severity: warning)
  ⚠ MISSING_LIMIT: Add LIMIT for exploratory queries (severity: info)

Recommendations:
1. Replace SELECT * with only the 6 columns actually used downstream
2. Add a date filter, since the events table has 2.1B rows but most queries
   only need the last 7 days
3. Consider materializing this as a view with the filter baked in

Estimated savings: ~60 credits/week (71% reduction on this query alone)
```

### What analyst can do

- Run SELECT queries (enforced)
- Inspect schemas and metadata
- Check column-level lineage
- Analyze costs and credit consumption
- Search warehouse metadata
- Detect PII columns
- Save training entries

---

## Plan

**Minimal permissions. For planning before acting.**

```bash
altimate --agent plan
```

Plan mode restricts the agent to reading files and editing plan files only. No SQL, no bash, no file modifications. Use this to outline an approach before switching to builder to execute it.

The plan agent investigates the repo before drafting: it makes at least one read-only call (`read`/`grep`/`glob`/`explore`) to ground the plan in your actual code, rather than guessing from the prompt alone. For a genuinely trivial, fully-specified change it will say so and skip straight to the plan.

### Two-step workflow

Plan mode uses a two-step approach to keep you in control:

1. **Outline** — The agent produces a short outline (3-5 bullet points) summarizing what it intends to do.
2. **Expand** — After you confirm, the agent expands the outline into a full, detailed plan.

This prevents wasted effort on plans that are heading in the wrong direction.

### Refinement loop

You don't have to start over if the plan isn't quite right. After the agent presents its outline or full plan, you can:

- **Approve** — Accept the plan as-is (e.g., "looks good", "approved", "let's go").
- **Refine** — Edit specific parts and ask the agent to revise (e.g., "change step 3 to use incremental instead of table").
- **Reject** — Discard the plan entirely (e.g., "scrap this", "start over", "reject").

Refinements are capped at **5 revisions per session** to avoid endless loops. After the cap is reached, the agent asks you to approve or reject the current version.

### Example conversation

```text
You: Plan a migration of our raw_events table from a view to an incremental model

Plan: Here's my proposed approach:
  • Inspect the current raw_events view and its downstream dependencies
  • Design an incremental model with a timestamp-based strategy
  • Add schema tests for the new model
  • Create a cutover checklist for swapping the view to the model
  • Update the dbt DAG documentation

You: Change the second bullet — use insert_overwrite instead of timestamp-based

Plan: Updated outline:
  • Inspect the current raw_events view and its downstream dependencies
  • Design an incremental model with an insert_overwrite strategy
  • Add schema tests for the new model
  • Create a cutover checklist for swapping the view to the model
  • Update the dbt DAG documentation

You: Approved

Plan: [expands into a full detailed plan]
```

---

## dbt-Optimizer

**Scans a dbt project for concrete, fixable issues and proposes targeted fixes with cost and impact reporting.**

```bash
altimate --agent dbt-optimizer
```

The optimizer works in four explicit phases and never skips ahead:

1. **Scan (read-only)** — detects issues across six lanes: materialization & incremental processing (with a named strategy — `merge`, `delete+insert`, `insert_overwrite`, `microbatch` — and verified preconditions), warehouse physical design (clustering/partitioning/sort keys, proposed only with query-history evidence), SQL anti-patterns, DAG economics (fan-out views, duplicate scans, dead models), run-level orchestration (Slim CI, threads, full-refresh overuse), and tests/docs/storage. The scan produces a numbered **candidate list** — every candidate carries evidence, an impact estimate, and a confidence level, ranked by expected ROI. It then stops and asks which candidates to fix.
2. **Fix** — applies only the candidates you select, one focused change each. Every SQL rewrite is verified with the equivalence engine; an undecidable result is reported as *unproven* with a data-diff recommendation, never as safe.
3. **Impact report** — the combined effect of the batch, with cost estimates only where query-history evidence supports them ("not estimable" is a valid answer).
4. **Pull request** — on request, a branch + PR whose body is the impact report.

### Example: Scan a project

```text
You: Scan this dbt project for optimization candidates

dbt-Optimizer: Building the evidence base (manifest + query history)...

Candidates, ranked by expected ROI:

1. [materialization] fct_events — full-rebuild table over append-only data
   Evidence: rebuilt 24×/day scanning 2.1B rows; event_id key + loaded_at cursor present
   Impact: compute cost (est. from last 30 days of query history)
   Fix: incremental with merge strategy on event_id, 3-day lookback
   Confidence: medium (validate first run against a full-refresh baseline)

2. [dag] legacy_events_backup — dead model, no downstream consumers
   Evidence: no model, exposure, or selector references it; rebuilt daily
   Impact: compute + storage    Fix: quarantine, confirm with owner, then remove
   Confidence: high (report), deletion is propose-only

3. [testing] dim_customers — primary key untested
   Evidence: no tests in schema.yml; customer_id is a merge key downstream
   Impact: correctness    Fix: add not_null + unique tests
   Confidence: high

Which candidates should I fix?
```

### Permissions

- File edits and shell commands **prompt for approval** by default.
- The direct SQL write tool (`sql_execute_write`) is **denied non-overridably** — no global or per-agent config can enable it.
- dbt builds mutate the warehouse, so they run only as user-approved shell commands, model-by-model (`altimate-dbt compile --model` / `build --model`); a full project build requires explicit approval. The agent is instructed to confirm the active target is a dev/CI target before building, but the runtime does not validate the target — review the command's target before approving, and keep production credentials out of your default target.
- Destructive DDL (`DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE`) stays hard-blocked like every agent.

### Coming from builder

Builder's self-review points you here: when it notices optimizer-shaped issues during dbt work (wrong materialization, duplicated logic), it flags them and suggests switching to dbt-Optimizer for the project-wide, cost-evidenced scan instead of fixing them silently out of scope.

---

## SQL Write Access Control

All SQL queries are classified before execution using AST-based parsing:

| Query Type | Builder | Analyst | Reviewer | dbt-Optimizer |
|-----------|---------|---------|----------|---------------|
| `SELECT` | Allowed | Allowed | — | Allowed |
| `SHOW`, `DESCRIBE`, `EXPLAIN` (classified ambiguous) | Prompts for approval | Denied | — | Denied — use `schema_inspect` / `sql_explain` instead |
| `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER` | Prompts for approval | Denied | — | Denied (non-overridable) |
| `DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE` | Blocked (cannot override) | Blocked | — | Blocked |

The classifier treats only plain `SELECT` as a proven read; `SHOW`/`DESCRIBE`/`EXPLAIN` fall into the ambiguous category and follow the write column. Use the dedicated read tools (`schema_inspect` for structure, `sql_explain` for plans) instead.

The Reviewer has no direct SQL execution tools at all — it works through the `dbt_pr_review` verdict engine and read-only analysis tools; see [dbt PR Review](../usage/dbt-pr-review.md).

The classifier detects write operations including: `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `DROP`, `ALTER`, `TRUNCATE`, `GRANT`, `REVOKE`, `COPY INTO`, `CALL`, `EXEC`, `EXECUTE IMMEDIATE`, `BEGIN`, `DECLARE`, `REPLACE`, `UPSERT`, `RENAME`.

Multi-statement queries (`SELECT 1; INSERT INTO ...`) are classified as write if any statement is a write.

---

## Custom Agent Modes

You can create custom agents with tailored permissions for specialized workflows like validation, migration, research, or executive reporting. See [Agent Configuration](../configure/agents.md#custom-agents) for details.

For training your AI teammate, see [Training](training/index.md).
