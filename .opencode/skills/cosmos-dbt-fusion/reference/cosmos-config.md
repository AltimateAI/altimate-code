# Cosmos Configuration Reference (Fusion)

This reference covers Cosmos configuration for **dbt Fusion** projects. Fusion only supports `ExecutionMode.LOCAL` with Snowflake or Databricks warehouses.

## Table of Contents

- [ProfileConfig: Warehouse Connection](#profileconfig-warehouse-connection)
- [operator_args Configuration](#operator_args-configuration)
- [Airflow 3 Compatibility](#airflow-3-compatibility)

---

## ProfileConfig: Warehouse Connection

### Supported ProfileMapping Classes (Fusion)

| Warehouse | dbt Adapter Package | ProfileMapping Class |
|-----------|---------------------|----------------------|
| Snowflake | `dbt-snowflake` | `SnowflakeUserPasswordProfileMapping` |
| Databricks | `dbt-databricks` | `DatabricksTokenProfileMapping` |

> **Note**: Fusion currently only supports Snowflake and Databricks (public beta).

### Option A: Airflow Connection + ProfileMapping (Recommended)

```python
from cosmos import ProfileConfig
from cosmos.profiles import SnowflakeUserPasswordProfileMapping

_profile_config = ProfileConfig(
    profile_name="default",  # REQUIRED
    target_name="dev",  # REQUIRED
    profile_mapping=SnowflakeUserPasswordProfileMapping(
        conn_id="snowflake_default",  # REQUIRED
        profile_args={"schema": "my_schema"},  # OPTIONAL
    ),
)
```

**Databricks example:**

```python
from cosmos import ProfileConfig
from cosmos.profiles import DatabricksTokenProfileMapping

_profile_config = ProfileConfig(
    profile_name="default",
    target_name="dev",
    profile_mapping=DatabricksTokenProfileMapping(
        conn_id="databricks_default",
    ),
)
```

### Option B: Existing profiles.yml File

> **CRITICAL**: Do not hardcode secrets in `profiles.yml`; use environment variables.

```python
from cosmos import ProfileConfig

_profile_config = ProfileConfig(
    profile_name="my_profile",  # REQUIRED: must match profiles.yml
    target_name="dev",  # REQUIRED: must match profiles.yml
    profiles_yml_filepath="/path/to/profiles.yml",  # REQUIRED
)
```

---

## operator_args Configuration

The `operator_args` dict accepts parameters passed to Cosmos operators:

| Category | Examples |
|----------|----------|
| BaseOperator params | `retries`, `retry_delay`, `on_failure_callback`, `pool` |
| Cosmos-specific params | `install_deps`, `full_refresh`, `quiet`, `fail_fast` |
| Runtime dbt vars | `vars` (string that renders as YAML) |

### Example Configuration

```python
_operator_args = {
    # BaseOperator params
    "retries": 3,

    # Cosmos-specific params
    "install_deps": False,  # if deps precomputed
    "full_refresh": False,  # for incremental models
    "quiet": True,  # only log errors
}
```

### Passing dbt vars at Runtime (XCom / Params)

Use `operator_args["vars"]` to pass values from upstream tasks or Airflow params:

```python
# Pull from upstream task via XCom
_operator_args = {
    "vars": '{"my_department": "{{ ti.xcom_pull(task_ids=\'pre_dbt\', key=\'return_value\') }}"}',
}

# Pull from Airflow params (for manual runs)
@dag(params={"my_department": "Engineering"})
def my_dag():
    dbt = DbtTaskGroup(
        # ...
        operator_args={
            "vars": '{"my_department": "{{ params.my_department }}"}',
        },
    )
```

---

## Airflow 3 Compatibility

### Import Differences

| Airflow 3.x | Airflow 2.x |
|-------------|-------------|
| `from airflow.sdk import dag, task` | `from airflow.decorators import dag, task` |
| `from airflow.sdk import chain` | `from airflow.models.baseoperator import chain` |

### Asset/Dataset URI Format Change

Cosmos ≤1.9 (Airflow 2 Datasets):
```
postgres://0.0.0.0:5434/postgres.public.orders
```

Cosmos ≥1.10 (Airflow 3 Assets):
```
postgres://0.0.0.0:5434/postgres/public/orders
```

> **CRITICAL**: If you have downstream DAGs scheduled on Cosmos-generated datasets and are upgrading to Airflow 3, update the asset URIs to the new format.
