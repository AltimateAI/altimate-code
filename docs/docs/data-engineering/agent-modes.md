# Agent Modes

altimate runs in one of three specialized modes. Each mode has different permissions, tool access, and behavioral guardrails.

| Mode | Access | Purpose |
|---|---|---|
| **Builder** | Read/Write | Create and modify data pipelines |
| **Analyst** | Read-only | Safe exploration and cost analysis |
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

---

## SQL Write Access Control

All SQL queries are classified before execution using AST-based parsing:

| Query Type | Builder | Analyst |
|-----------|---------|---------|
| `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN` | Allowed | Allowed |
| `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER` | Prompts for approval | Denied |
| `DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE` | Blocked (cannot override) | Blocked |

The classifier detects write operations including: `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `DROP`, `ALTER`, `TRUNCATE`, `GRANT`, `REVOKE`, `COPY INTO`, `CALL`, `EXEC`, `EXECUTE IMMEDIATE`, `BEGIN`, `DECLARE`, `REPLACE`, `UPSERT`, `RENAME`.

Multi-statement queries (`SELECT 1; INSERT INTO ...`) are classified as write if any statement is a write.

---

## Custom Agent Modes

You can create custom agents with tailored permissions for specialized workflows like validation, migration, research, or executive reporting. See [Agent Configuration](../configure/agents.md#custom-agents) for details.

For training your AI teammate, see [Training](training/index.md).
