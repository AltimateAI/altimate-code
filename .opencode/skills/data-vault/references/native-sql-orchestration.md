# Native SQL Orchestration (Without dbt)

Not every DV 2.0 project runs on dbt. Some teams orchestrate with
Airflow + hand-written SQL, some use Dagster + SQLMesh, some rely on
Snowflake Tasks or Azure Data Factory or plain cron + shell scripts.
DV 2.0's patterns are engine-agnostic and orchestrator-agnostic —
this reference captures the adjustments needed when you're not
using dbt.

## What Changes Without dbt

dbt provides three things the DV load patterns lean on:

1. **`{{ ref('...') }}` / `{{ source('...') }}`** — turns model
   names into fully-qualified table references.
2. **`{{ is_incremental() }}` and `{{ this }}`** — the anti-join
   filter that makes loads idempotent.
3. **`{{ run_started_at }}` / `{{ invocation_id }}`** — atomic
   per-run values for `load_dts` and `load_batch_id`.

Without dbt, you replace each with your own mechanism:

| dbt feature | Native replacement |
|-------------|--------------------|
| `{{ ref('...') }}` | Explicit `schema.table` names (config-driven or hardcoded) |
| `{{ is_incremental() }}` | Always run the anti-join; no branching needed |
| `{{ this }}` | The literal table name on the LHS of the load |
| `{{ run_started_at }}` | An orchestrator-set variable, or `SELECT ... FROM (SELECT NOW() AS load_dts) t` computed once per run |
| `{{ invocation_id }}` | An orchestrator-generated UUID per run |
| dbt DAG (hub → link → sat) | Orchestrator-managed dependencies (Airflow / Dagster / Snowflake Task graph) |
| dbt tests | Hand-written assertion queries + fail-if-nonzero check |

## The Universal Load Template

Every hub / link / satellite load, in native SQL, follows this shape:

```
BEGIN;
-- 1. Fix load_dts + load_batch_id for the entire batch, once.
INSERT INTO _load_context (batch_id, load_dts)
    VALUES (gen_random_uuid(), NOW());

-- 2. Do the actual load, referring to _load_context for consistent metadata.
INSERT INTO raw_vault.hub_customer
    (customer_hk, customer_bk, load_dts, record_source, load_batch_id)
SELECT DISTINCT
    <hash_function>(<normalized_bk>)         AS customer_hk,
    <customer_bk>                            AS customer_bk,
    (SELECT load_dts  FROM _load_context ORDER BY 1 DESC LIMIT 1),
    'crm.customers'                          AS record_source,
    (SELECT batch_id  FROM _load_context ORDER BY 1 DESC LIMIT 1)
FROM staging.stg_crm__customers s
LEFT JOIN raw_vault.hub_customer t
    ON <hash_function>(<normalized_bk>) = t.customer_hk
WHERE s.customer_id IS NOT NULL
  AND t.customer_hk IS NULL;

COMMIT;
```

The `_load_context` table gives you `run_started_at` + `invocation_id`
equivalents without dbt. Structure:

```sql
CREATE TABLE _load_context (
    batch_id UUID PRIMARY KEY,
    load_dts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    orchestrator VARCHAR   -- 'airflow', 'snowflake-task', etc.
);
```

Or pass `batch_id` and `load_dts` as orchestrator parameters —
Airflow's `xcom` or Snowflake Task's `SYSTEM$CURRENT_USER_TASK_NAME`
+ `RUN_START_TIME`.

## Airflow-Orchestrated DV Loads

```python
# dags/dv_daily_load.py
from airflow import DAG
from airflow.providers.snowflake.operators.snowflake import SnowflakeOperator
from datetime import datetime
import uuid

with DAG('dv_daily_load',
         start_date=datetime(2024, 1, 1),
         schedule='@daily',
         catchup=False) as dag:

    batch_id = str(uuid.uuid4())
    load_dts = "{{ ts }}"      # Airflow logical timestamp; passed to every task

    # 1. Staging → Stage 1 (source mirror)
    stage_1 = SnowflakeOperator(
        task_id='stage_1_crm_customers',
        sql=f"""
        INSERT INTO staging.stg_crm__customers
        SELECT
            CAST(customer_id AS VARCHAR),
            ...
        FROM raw.crm.customers
        WHERE customer_id IS NOT NULL;
        """,
        snowflake_conn_id='snowflake_dv'
    )

    # 2. Stage 1 → Stage 2 (hashed)
    stage_2 = SnowflakeOperator(
        task_id='stage_2_crm_customers_hashed',
        sql=f"""
        INSERT INTO staging.stg_crm__customers__hashed
        SELECT
            customer_id AS customer_bk,
            MD5_BINARY(COALESCE(NULLIF(UPPER(TRIM(customer_id::VARCHAR)), ''), '^^'))
                AS customer_hk,
            '{load_dts}'::TIMESTAMP  AS load_dts,
            'crm.customers'          AS record_source,
            '{batch_id}'             AS load_batch_id,
            ...
        FROM staging.stg_crm__customers;
        """,
        snowflake_conn_id='snowflake_dv'
    )

    # 3. Hub load
    hub_customer = SnowflakeOperator(
        task_id='load_hub_customer',
        sql=f"""
        INSERT INTO raw_vault.hub_customer (customer_hk, customer_bk, load_dts, record_source, load_batch_id)
        SELECT DISTINCT s.customer_hk, s.customer_bk, s.load_dts, s.record_source, s.load_batch_id
        FROM staging.stg_crm__customers__hashed s
        LEFT JOIN raw_vault.hub_customer t USING (customer_hk)
        WHERE t.customer_hk IS NULL;
        """,
        snowflake_conn_id='snowflake_dv'
    )

    # 4. Link, sat, PIT, etc. — each is its own SnowflakeOperator

    stage_1 >> stage_2 >> hub_customer >> [lnk_customer_x, sat_customer_details]
```

The Airflow DAG replaces dbt's ref-based DAG. Every hub / link /
sat is a separate task; Airflow enforces the dependency order.

## Snowflake Tasks — DAG in the Warehouse

Native Snowflake orchestration without external tools:

```sql
-- Root task: pick a batch_id + load_dts once per run
CREATE OR REPLACE TASK dv_load_root
    WAREHOUSE = wh_dv_load
    SCHEDULE = 'USING CRON 0 2 * * * UTC'
AS
    INSERT INTO _load_context (batch_id, load_dts)
        VALUES (UUID_STRING(), CURRENT_TIMESTAMP());

-- Downstream tasks reference the root
CREATE OR REPLACE TASK dv_load_hub_customer
    WAREHOUSE = wh_dv_load
    AFTER dv_load_root
AS
    INSERT INTO raw_vault.hub_customer
        (customer_hk, customer_bk, load_dts, record_source, load_batch_id)
    SELECT DISTINCT
        s.customer_hk,
        s.customer_bk,
        (SELECT load_dts FROM _load_context ORDER BY load_dts DESC LIMIT 1),
        'crm.customers',
        (SELECT batch_id FROM _load_context ORDER BY load_dts DESC LIMIT 1)
    FROM staging.stg_crm__customers__hashed s
    LEFT JOIN raw_vault.hub_customer t USING (customer_hk)
    WHERE t.customer_hk IS NULL;

CREATE OR REPLACE TASK dv_load_sat_customer_details
    WAREHOUSE = wh_dv_load
    AFTER dv_load_hub_customer
AS
    -- similar pattern, with the satellite's hashdiff comparison
    ...;

-- Resume the root; downstream tasks auto-inherit its schedule
ALTER TASK dv_load_sat_customer_details  RESUME;
ALTER TASK dv_load_hub_customer          RESUME;
ALTER TASK dv_load_root                  RESUME;
```

`AFTER` builds a DAG. Every task inherits the root's schedule via
the chain; no external cron needed.

## Dagster-Orchestrated DV Loads

Dagster's asset-based model maps naturally onto the vault DAG:

```python
from dagster import asset, MaterializeResult

@asset
def stg_crm__customers__hashed():
    execute_sql("""
        INSERT INTO staging.stg_crm__customers__hashed
        SELECT customer_id AS customer_bk,
               MD5_BINARY(...) AS customer_hk,
               ...
    """)

@asset(deps=[stg_crm__customers__hashed])
def hub_customer():
    execute_sql("""
        INSERT INTO raw_vault.hub_customer ...
    """)

@asset(deps=[hub_customer, stg_crm__customers__hashed])
def sat_customer_details():
    execute_sql("""
        INSERT INTO raw_vault.sat_customer_details ...
    """)
```

Dagster tracks lineage between assets; the mart layer can subscribe
to the raw-vault assets it depends on.

## Testing Without dbt

Every load pattern needs assertions. Replace `dbt test` with a
runner that executes a SQL suite and fails on any row returned:

```sql
-- tests/hub_customer_unique_bk.sql
-- Fails if any duplicate business key exists
SELECT customer_bk, COUNT(*)
FROM raw_vault.hub_customer
GROUP BY customer_bk
HAVING COUNT(*) > 1;

-- tests/hub_customer_no_null_hk.sql
SELECT customer_hk
FROM raw_vault.hub_customer
WHERE customer_hk IS NULL;

-- tests/sat_customer_details_no_consecutive_matching_hashdiffs.sql
WITH ordered AS (
    SELECT parent_hk = customer_hk, load_dts, hashdiff,
           LAG(hashdiff) OVER (PARTITION BY customer_hk ORDER BY load_dts) AS prev_hashdiff
    FROM raw_vault.sat_customer_details
)
SELECT *
FROM ordered
WHERE prev_hashdiff IS NOT NULL AND prev_hashdiff = hashdiff;
```

Runner:
- **Airflow**: `SnowflakeCheckOperator` — passes if the query returns
  0 rows.
- **Snowflake Tasks**: run each test as a task; on failure, alert
  via `SYSTEM$SEND_EMAIL()`.
- **Dagster**: `AssetCheck` decorator.
- **Cron + shell**: `psql -c "..." | grep -q "0 rows"` in a bash
  script.

## Load-Batch Metadata Without dbt

The `_load_context` table pattern above gives you consistent
`batch_id` and `load_dts` across every table loaded in one logical
run. Alternative: pass both as CLI parameters and template into
every SQL file:

```bash
# scripts/dv_load.sh
BATCH_ID=$(uuidgen)
LOAD_DTS=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)

envsubst < sql/hub_customer.sql | snowsql -f -
envsubst < sql/lnk_order_customer.sql | snowsql -f -
envsubst < sql/sat_customer_details.sql | snowsql -f -
```

Each SQL file uses `$BATCH_ID` and `$LOAD_DTS` placeholders:
```sql
-- sql/hub_customer.sql
INSERT INTO raw_vault.hub_customer ...
VALUES (..., '$LOAD_DTS'::TIMESTAMP, ..., '$BATCH_ID');
```

Less powerful than dbt's Jinja but sufficient for smaller projects.

## When to Use dbt vs. Native SQL

**Use dbt** when:
- Team has multiple developers who need consistent SQL patterns.
- Testing / docs / lineage are meaningful investments.
- The project has > 20 models.
- You want to leverage AutomateDV / datavault4dbt macros.

**Use native SQL orchestration** when:
- Team is small (1–2) and comfortable with SQL + orchestration.
- Warehouse-native features (Snowflake Tasks, BigQuery scheduled
  queries) already handle scheduling / DAG semantics.
- Vault is < 20 tables and unlikely to grow.
- Compliance requires exactly-known SQL for every load (dbt's Jinja
  templating is a compliance friction point at some orgs).

**Use both** when:
- Batch loads run on dbt; near-real-time loads run as native
  streaming jobs. Common pattern for hybrid feeds.

## Common Native-SQL Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| `NOW()` / `CURRENT_TIMESTAMP()` computed per-row instead of per-batch | Rows in one logical run get different `load_dts` values | Compute once per batch; store in `_load_context` or pass as parameter |
| No `load_batch_id` | Can't correlate rows to specific runs | Generate UUID per batch; include on every row |
| Missing anti-join in native SQL | Duplicate hub rows on re-runs | Always `LEFT JOIN target WHERE target._hk IS NULL` |
| Assertions run once at project setup, never after loads | Regressions silent until user notices | Every load ends with the assertion suite |
| No transaction boundary per batch | Partial load on failure; inconsistent state | `BEGIN` / `COMMIT` per logical batch |
| DAG dependencies not enforced by orchestrator | Sat loads before its hub → FK integrity broken | Explicit orchestrator dependencies; `AFTER` in Snowflake tasks, `deps=` in Dagster |
| Hardcoded schema names across many SQL files | Environment promotion (dev → prod) is manual find-and-replace | Templating layer (`envsubst`, Jinja2 externally, sqlfluff templater) |
| No linting / formatting on the SQL corpus | Team drift on style; hard to spot real bugs | `sqlfluff lint` in CI |
| Tests written but not run in CI | Assertions rot | Run test suite on every deploy |
| dbt's `run_started_at` "replicated" as `SELECT CURRENT_TIMESTAMP()` inline in every INSERT | Different rows get different timestamps | Compute once; reference the stored value everywhere |
| Skipping metrics vault "because we don't have dbt" | No load observability | Metrics vault has nothing to do with dbt; use INSERT-based instrumentation as in [metrics-and-error-vault.md](metrics-and-error-vault.md) |
