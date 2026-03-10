# Cosmos Configuration Reference (Core)

This reference covers detailed Cosmos configuration for **dbt Core** projects.

## Table of Contents

- [ProjectConfig Options](#projectconfig-options)
- [Execution Modes (ExecutionConfig)](#execution-modes-executionconfig)
- [ProfileConfig: Warehouse Connection](#profileconfig-warehouse-connection)
- [Testing Behavior (RenderConfig)](#testing-behavior-renderconfig)
- [operator_args Configuration](#operator_args-configuration)
- [Airflow 3 Compatibility](#airflow-3-compatibility)

--

## ProjectConfig Options

### Required Parameters

| Approach | When to use | Required param |
|----------|-------------|----------------|
| Project path | Project files available locally | `dbt_project_path` |
| Manifest only | Using `dbt_manifest` load mode; containerized execution | `manifest_path` + `project_name` |

### Optional Parameters

| Parameter | Purpose | Constraint |
|-----------|---------|------------|
| `dbt_project_path` | The path to the dbt project directory.  Defaults to `None` | Mandatory if using `LoadMode.DBT_LS` |
| `manifest_path` | Path to precomputed `manifest.json` (local or remote URI). Defaults to `None` |  Mandatory if using `LoadMode.DBT_MANIFEST`. Remote URIs require `manifest_conn_id` |
| `manifest_conn_id` | Airflow connection for remote manifest (S3/GCS/Azure) | — |
| `install_dbt_deps` | Run `dbt deps` during parsing/execution | Set `False` if deps are precomputed in CI |
| `copy_dbt_packages` | Copy `dbt_packages` directory, if it exists, instead of creating a symbolic link (`False` by default) | Use in case user pre-computes dependencies, but they may change after the deployment was made. |
| `env_vars` | Dict of env vars for parsing + execution | Requires `dbt_ls` load mode |
| `dbt_vars` | Dict of dbt vars (passed to `--vars`) | Requires `dbt_ls` or `custom` load mode |
| `partial_parse` | Enable dbt partial parsing | Requires `dbt_ls` load mode + `local` or `virtualenv` execution + `profiles_yml_filepath` |
| `models_relative_path` | The relative path to the dbt models directory within the project. Defaults to `models` | — |
| `seeds_relative_path` | The relative path to the dbt seeds directory within the project. Defaults to `seeds` | — |
| `snapshots_relative_path` | The relative path to the dbt snapshots directory within the project. Defaults to `snapshots` | - |

> **WARNING**: If using `dbt_vars` with Airflow templates like `ti`, `task_instance`, or `params` → use `operator_args["vars"]` instead. Those cannot be set via `ProjectConfig` because it is used during DAG parsing.

```python
from cosmos import ProjectConfig

_project_config = ProjectConfig(
    dbt_project_path="/path/to/dbt/project",
    # manifest_path="/path/to/manifest.json",
    # project_name="my_project",
    # manifest_conn_id="aws_default",
    # install_dbt_deps=False,
    # copy_dbt_packages=False,
    # dbt_vars={"my_var": "value"},  # static vars only
    # env_vars={"MY_ENV": "value"},
    # partial_parse=True,
    # models_relative_path="custom_models_path",
    # seeds_relative_path="custom_seeds_path",
    # snapshots_relative_path="custom_snapshots_path",
)
```

---

## Execution Modes (ExecutionConfig)

### WATCHER Mode (Experimental, Fastest)

Known limitations:
- Implements `DbtSeedWatcherOperator`, `DbtSnapshotWatcherOperator` and `DbtRunWatcherOperator` - not other operators
- Built on top of `ExecutionMode.LOCAL` and `ExecutionMode.KUBERNETES` - not available for other execution modes
- Tests with `TestBehavior.AFTER_EACH`, which is the default test behavior, are still being rendered as EmptyOperators.
- May not work as expected when using `RenderConfig.node_converters`
- Airflow assets or datasets are emitted by the `DbtProducerWatcherOperator` instead by the actual tasks related to the correspondent dbt models.

```python
from cosmos import ExecutionConfig, ExecutionMode

_execution_config = ExecutionConfig(
    execution_mode=ExecutionMode.WATCHER,
)
```

Reference: https://astronomer.github.io/astronomer-cosmos/getting_started/watcher-execution-mode.html

### LOCAL Mode (Default)

```python
from cosmos import ExecutionConfig, ExecutionMode, InvocationMode

# Option A: dbt in Airflow env
_execution_config = ExecutionConfig(
    execution_mode=ExecutionMode.LOCAL,
    invocation_mode=InvocationMode.DBT_RUNNER,
)

# Option B: dbt in separate venv baked into image
_execution_config = ExecutionConfig(
    execution_mode=ExecutionMode.LOCAL,
    invocation_mode=InvocationMode.SUBPROCESS,
    dbt_executable_path="/path/to/venv/bin/dbt",
)
```

### VIRTUALENV Mode

```python
from cosmos import ExecutionConfig, ExecutionMode

_execution_config = ExecutionConfig(
    execution_mode=ExecutionMode.VIRTUALENV,
    virtualenv_dir="/path/to/persistent/cache",
)

_operator_args = {
    "py_system_site_packages": False,
    "py_requirements": ["dbt-<adapter>==<version>"],
    "install_deps": True,
}
```

### AIRFLOW_ASYNC Mode (BigQuery Only)

> **CRITICAL**: BigQuery only, Airflow ≥2.8 required.

Required setup:
1. Install: `apache-airflow-providers-google`
2. Set env vars:
   - `AIRFLOW__COSMOS__REMOTE_TARGET_PATH` = `gs://bucket/target_dir/`
   - `AIRFLOW__COSMOS__REMOTE_TARGET_PATH_CONN_ID` = connection ID

```python
from cosmos import ExecutionConfig, ExecutionMode

_execution_config = ExecutionConfig(
    execution_mode=ExecutionMode.AIRFLOW_ASYNC,
    async_py_requirements=["dbt-bigquery==<version>"],
)

_operator_args = {
    "location": "US",
    "install_deps": True,
}
```

Reference: https://astronomer.github.io/astronomer-cosmos/getting_started/async-execution-mode.html

### Containerized Modes

Available: `DOCKER`, `KUBERNETES`, `AWS_EKS`, `AZURE_CONTAINER_INSTANCE`, `GCP_CLOUD_RUN_JOB`, `AWS_ECS`.

> **CRITICAL**: MUST use `dbt_manifest` load mode.

```python
from cosmos import ExecutionConfig, ExecutionMode, RenderConfig, LoadMode

_execution_config = ExecutionConfig(
    execution_mode=ExecutionMode.KUBERNETES,
    dbt_project_path="/path/to/dbt/project/in/image",
)

_render_config = RenderConfig(
    load_method=LoadMode.DBT_MANIFEST,
)

_operator_args = {
    "image": "dbt-jaffle-shop:1.0.0",
}
```

---

## ProfileConfig: Warehouse Connection

### ProfileMapping Classes by Warehouse

| Warehouse | dbt Adapter Package | ProfileMapping Class |
|-----------|---------------------|----------------------|
| Snowflake | `dbt-snowflake` | `SnowflakeUserPasswordProfileMapping` |
| BigQuery | `dbt-bigquery` | `GoogleCloudServiceAccountFileProfileMapping` |
| Databricks | `dbt-databricks` | `DatabricksTokenProfileMapping` |
| Postgres | `dbt-postgres` | `PostgresUserPasswordProfileMapping` |
| Redshift | `dbt-redshift` | `RedshiftUserPasswordProfileMapping` |
| DuckDB | `dbt-duckdb` | `DuckDBUserPasswordProfileMapping` |

Full list: https://astronomer.github.io/astronomer-cosmos/profiles/index.html

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

### Per-Node Profile Override

Override profile for individual nodes via `dbt_project.yml`:

```yaml
# In dbt_project.yml or models/*.yml
version: 2

models:
  - name: my_model
    meta:
      cosmos:
        profile_config:
          profile_name: other_profile
          target_name: prod
          profile_mapping:
            conn_id: other_connection
            profile_args:
              schema: prod
```

---

## Testing Behavior (RenderConfig)

### TestBehavior Options

| Option | Behavior | When to use |
|--------|----------|-------------|
| `AFTER_EACH` | Run tests on each model immediately after model runs | Default; maximum visibility |
| `BUILD` | Combine `dbt run` + `dbt test` into single `dbt build` per node | Faster parsing + execution |
| `AFTER_ALL` | Run all tests after all models complete | Matches dbt CLI default behavior |
| `NONE` | Skip tests entirely | When tests run separately |

> **NOTE**: Cosmos default (`AFTER_EACH`) differs from dbt CLI default (`AFTER_ALL`).

### Multi-Parent Test Handling

If a test depends on multiple models, `AFTER_EACH` may fail because not all parent models are materialized yet.

Solution: Set `should_detach_multiple_parents_tests=True` to run multi-parent tests only after all their parents complete.

```python
from cosmos import RenderConfig, TestBehavior

_render_config = RenderConfig(
    test_behavior=TestBehavior.AFTER_EACH,  # default
    # should_detach_multiple_parents_tests=True,  # for multi-parent tests
)
```

### test_indirect_selection (For Subset Runs)

When running only part of a project (`select`/`exclude`), control which tests run. Set in `ExecutionConfig`:

| Option | Behavior |
|--------|----------|
| `eager` | Run test if ANY parent is selected (may fail if other parents not built) |
| `buildable` | Run test only if selected node or its ancestors are selected |
| `cautious` | Only run tests for explicitly selected models |
| `empty` | Run no tests |

```python
from cosmos import ExecutionConfig, TestIndirectSelection

_execution_config = ExecutionConfig(
    test_indirect_selection=TestIndirectSelection.CAUTIOUS,
)
```

### on_warning_callback

Execute a function when dbt tests generate warnings (works with `local`, `virtualenv`, `kubernetes` execution modes):

```python
from airflow.utils.context import Context

def warning_callback(context: Context):
    tests = context.get("test_names")
    results = context.get("test_results")
    # Send to Slack, email, etc.

my_dag = DbtDag(
    # ...
    on_warning_callback=warning_callback,
)
```

---

## operator_args Configuration

The `operator_args` dict accepts four categories of parameters:

### Parameter Categories

| Category | Examples |
|----------|----------|
| BaseOperator params | `retries`, `retry_delay`, `on_failure_callback`, `pool` |
| Cosmos-specific params | `install_deps`, `full_refresh`, `quiet`, `fail_fast`, `cancel_query_on_kill`, `warn_error`, `dbt_cmd_flags`, `dbt_cmd_global_flags` |
| Runtime dbt vars | `vars` (string that renders as YAML) |
| Container operator params | `image`, `namespace`, `secrets` (for containerized execution) |

### Example Configuration

```python
_operator_args = {
    # BaseOperator params
    "retries": 3,
    "on_failure_callback": my_callback_function,

    # Cosmos-specific params
    "install_deps": False,  # if deps precomputed
    "full_refresh": False,  # for incremental models
    "quiet": True,  # only log errors
    "fail_fast": True,  # exit immediately on failure

    # Container params (for containerized execution)
    "image": "my-dbt-image:latest",
    "namespace": "airflow",
}
```

### Passing dbt vars at Runtime (XCom / Params)

Use `operator_args["vars"]` to pass values from upstream tasks or Airflow params:

> **WARNING**: `operator_args["vars"]` overrides ALL vars in `ProjectConfig.dbt_vars`.

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

### Per-Node Operator Overrides

Override task parameters for individual nodes via `dbt_project.yml`:

```yaml
# In dbt_project.yml or models/*.yml
version: 2

models:
  - name: my_model
    meta:
      cosmos:
        operator_kwargs:
          retries: 10
          pool: "high_priority_pool"
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

### DAG Versioning

DAG versioning in Airflow 3 does not yet track dbt project changes unless model names change. Improved support planned for Cosmos 1.11+.
