---
name: cosmos-dbt-core
description: Use when turning a dbt Core project into an Airflow DAG/TaskGroup using Astronomer Cosmos. Does not cover dbt Fusion. Before implementing, verify dbt engine, warehouse, Airflow version, execution environment, DAG vs TaskGroup, and manifest availability.
tags: ["airflow", "dbt"]
---

# Cosmos + dbt Core: Implementation Checklist

Execute steps in order. Prefer the simplest configuration that meets the user's constraints.

> **Version note**: This skill targets Cosmos 1.11+ and Airflow 3.x. If the user is on Airflow 2.x, adjust imports accordingly (see Appendix A).
>
> **Reference**: Latest stable: https://pypi.org/project/astronomer-cosmos/

> **Before starting**, confirm: (1) dbt engine = Core (not Fusion → use **cosmos-dbt-fusion**), (2) warehouse type, (3) Airflow version, (4) execution environment (Airflow env / venv / container), (5) DbtDag vs DbtTaskGroup vs individual operators, (6) manifest availability.

---

## 1. Configure Project (ProjectConfig)

| Approach | When to use | Required param |
|----------|-------------|----------------|
| Project path | Files available locally | `dbt_project_path` |
| Manifest only | `dbt_manifest` load | `manifest_path` + `project_name` |

```python
from cosmos import ProjectConfig

_project_config = ProjectConfig(
    dbt_project_path="/path/to/dbt/project",
    # manifest_path="/path/to/manifest.json",  # for dbt_manifest load mode
    # project_name="my_project",  # if using manifest_path without dbt_project_path
    # install_dbt_deps=False,  # if deps precomputed in CI
)
```

## 2. Choose Parsing Strategy (RenderConfig)

Pick ONE load mode based on constraints:

| Load mode | When to use | Required inputs | Constraints |
|-----------|-------------|-----------------|-------------|
| `dbt_manifest` | Large projects; containerized execution; fastest | `ProjectConfig.manifest_path` | Remote manifest needs `manifest_conn_id` |
| `dbt_ls` | Complex selectors; need dbt-native selection | dbt installed OR `dbt_executable_path` | Can also be used with containerized execution |
| `dbt_ls_file` | dbt_ls selection without running dbt_ls every parse | `RenderConfig.dbt_ls_path` | `select`/`exclude` won't work |
| `automatic` (default) | Simple setups; let Cosmos pick | (none) | Falls back: manifest → dbt_ls → custom |

> **CRITICAL**: Containerized execution (`DOCKER`/`KUBERNETES`/etc.)

```python
from cosmos import RenderConfig, LoadMode

_render_config = RenderConfig(
    load_method=LoadMode.DBT_MANIFEST,  # or DBT_LS, DBT_LS_FILE, AUTOMATIC
)
```

---

## 3. Choose Execution Mode (ExecutionConfig)

> **Reference**: See **[reference/cosmos-config.md](reference/cosmos-config.md#execution-modes-executionconfig)** for detailed configuration examples per mode.

Pick ONE execution mode:

| Execution mode | When to use | Speed | Required setup |
|----------------|-------------|-------|----------------|
| `WATCHER` | Fastest; single `dbt build` visibility | Fastest | dbt adapter in env OR `dbt_executable_path` or dbt Fusion |
| `WATCHER_KUBERNETES` | Fastest isolated method; single `dbt build` visibility | Fast | dbt installed in container |
| `LOCAL` + `DBT_RUNNER` | dbt + adapter in the same Python installation as Airflow | Fast | dbt 1.5+ in `requirements.txt` |
| `LOCAL` + `SUBPROCESS` | dbt + adapter available in the Airflow deployment, in an isolated Python installation | Medium | `dbt_executable_path` |
| `AIRFLOW_ASYNC` | BigQuery + long-running transforms | Fast | Airflow ≥2.8; provider deps |
| `KUBERNETES` | Isolation between Airflow and dbt | Medium | Airflow ≥2.8; provider deps |
| `VIRTUALENV` | Can't modify image; runtime venv | Slower | `py_requirements` in operator_args |
| Other containerized approaches | Support Airflow and dbt isolation | Medium | container config |

```python
from cosmos import ExecutionConfig, ExecutionMode

_execution_config = ExecutionConfig(
    execution_mode=ExecutionMode.WATCHER,  # or LOCAL, VIRTUALENV, AIRFLOW_ASYNC, KUBERNETES, etc.
)
```

---

## 4. Configure Warehouse Connection (ProfileConfig)

> **Reference**: See **[reference/cosmos-config.md](reference/cosmos-config.md#profileconfig-warehouse-connection)** for detailed ProfileConfig options and all ProfileMapping classes.

### Option A: Airflow Connection + ProfileMapping (Recommended)

```python
from cosmos import ProfileConfig
from cosmos.profiles import SnowflakeUserPasswordProfileMapping

_profile_config = ProfileConfig(
    profile_name="default",
    target_name="dev",
    profile_mapping=SnowflakeUserPasswordProfileMapping(
        conn_id="snowflake_default",
        profile_args={"schema": "my_schema"},
    ),
)
```

### Option B: Existing profiles.yml

> **CRITICAL**: Do not hardcode secrets; use environment variables.

```python
from cosmos import ProfileConfig

_profile_config = ProfileConfig(
    profile_name="my_profile",
    target_name="dev",
    profiles_yml_filepath="/path/to/profiles.yml",
)
```

---

## 5. Configure Testing Behavior (RenderConfig)

> **Reference**: See **[reference/cosmos-config.md](reference/cosmos-config.md#testing-behavior-renderconfig)** for detailed testing options.

| TestBehavior | Behavior |
|--------------|----------|
| `AFTER_EACH` (default) | Tests run immediately after each model (default) |
| `BUILD` | Combine run + test into single `dbt build` |
| `AFTER_ALL` | All tests after all models complete |
| `NONE` | Skip tests |

```python
from cosmos import RenderConfig, TestBehavior

_render_config = RenderConfig(
    test_behavior=TestBehavior.AFTER_EACH,
)
```

---

## 6. Configure operator_args

> **Reference**: See **[reference/cosmos-config.md](reference/cosmos-config.md#operator_args-configuration)** for detailed operator_args options.

```python
_operator_args = {
    # BaseOperator params
    "retries": 3,

    # Cosmos-specific params
    "install_deps": False,
    "full_refresh": False,
    "quiet": True,

    # Runtime dbt vars (XCom / params)
    "vars": '{"my_var": "{{ ti.xcom_pull(task_ids=\'pre_dbt\') }}"}',
}
```

---

## 7. Assemble DAG / TaskGroup

### Option A: DbtDag (Standalone)

```python
from cosmos import DbtDag, ProjectConfig, ProfileConfig, ExecutionConfig, RenderConfig
from cosmos.profiles import SnowflakeUserPasswordProfileMapping
from pendulum import datetime

_project_config = ProjectConfig(
    dbt_project_path="/usr/local/airflow/dbt/my_project",
)

_profile_config = ProfileConfig(
    profile_name="default",
    target_name="dev",
    profile_mapping=SnowflakeUserPasswordProfileMapping(
        conn_id="snowflake_default",
    ),
)

_execution_config = ExecutionConfig()
_render_config = RenderConfig()

my_cosmos_dag = DbtDag(
    dag_id="my_cosmos_dag",
    project_config=_project_config,
    profile_config=_profile_config,
    execution_config=_execution_config,
    render_config=_render_config,
    operator_args={},
    start_date=datetime(2025, 1, 1),
    schedule="@daily",
)
```

### Option B: DbtTaskGroup (Inside Existing DAG)

```python
from airflow.sdk import dag, task  # Airflow 3.x
# from airflow.decorators import dag, task  # Airflow 2.x
from airflow.models.baseoperator import chain
from cosmos import DbtTaskGroup, ProjectConfig, ProfileConfig, ExecutionConfig, RenderConfig
from pendulum import datetime

_project_config = ProjectConfig(dbt_project_path="/usr/local/airflow/dbt/my_project")
_profile_config = ProfileConfig(profile_name="default", target_name="dev")
_execution_config = ExecutionConfig()
_render_config = RenderConfig()

@dag(start_date=datetime(2025, 1, 1), schedule="@daily")
def my_dag():
    @task
    def pre_dbt():
        return "some_value"

    dbt = DbtTaskGroup(
        group_id="dbt_project",
        project_config=_project_config,
        profile_config=_profile_config,
        execution_config=_execution_config,
        render_config=_render_config,
    )

    @task
    def post_dbt():
        pass

    chain(pre_dbt(), dbt, post_dbt())

my_dag()
```

### Option C: Use Cosmos operators directly

```python
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from airflow import DAG

try:
    from airflow.providers.standard.operators.python import PythonOperator
except ImportError:
    from airflow.operators.python import PythonOperator

from cosmos import DbtCloneLocalOperator, DbtRunLocalOperator, DbtSeedLocalOperator, ProfileConfig
from cosmos.io import upload_to_aws_s3

DEFAULT_DBT_ROOT_PATH = Path(__file__).parent / "dbt"
DBT_ROOT_PATH = Path(os.getenv("DBT_ROOT_PATH", DEFAULT_DBT_ROOT_PATH))
DBT_PROJ_DIR = DBT_ROOT_PATH / "jaffle_shop"
DBT_PROFILE_PATH = DBT_PROJ_DIR / "profiles.yml"
DBT_ARTIFACT = DBT_PROJ_DIR / "target"

profile_config = ProfileConfig(
    profile_name="default",
    target_name="dev",
    profiles_yml_filepath=DBT_PROFILE_PATH,
)


def check_s3_file(bucket_name: str, file_key: str, aws_conn_id: str = "aws_default", **context: Any) -> bool:
    """Check if a file exists in the given S3 bucket."""
    from airflow.providers.amazon.aws.hooks.s3 import S3Hook

    s3_key = f"{context['dag'].dag_id}/{context['run_id']}/seed/0/{file_key}"
    print(f"Checking if file {s3_key} exists in S3 bucket...")
    hook = S3Hook(aws_conn_id=aws_conn_id)
    return hook.check_for_key(key=s3_key, bucket_name=bucket_name)


with DAG("example_operators", start_date=datetime(2024, 1, 1), catchup=False) as dag:
    seed_operator = DbtSeedLocalOperator(
        profile_config=profile_config,
        project_dir=DBT_PROJ_DIR,
        task_id="seed",
        dbt_cmd_flags=["--select", "raw_customers"],
        install_deps=True,
        append_env=True,
    )

    check_file_uploaded_task = PythonOperator(
        task_id="check_file_uploaded_task",
        python_callable=check_s3_file,
        op_kwargs={
            "aws_conn_id": "aws_s3_conn",
            "bucket_name": "cosmos-artifacts-upload",
            "file_key": "target/run_results.json",
        },
    )

    run_operator = DbtRunLocalOperator(
        profile_config=profile_config,
        project_dir=DBT_PROJ_DIR,
        task_id="run",
        dbt_cmd_flags=["--models", "stg_customers"],
        install_deps=True,
        append_env=True,
    )

    clone_operator = DbtCloneLocalOperator(
        profile_config=profile_config,
        project_dir=DBT_PROJ_DIR,
        task_id="clone",
        dbt_cmd_flags=["--models", "stg_customers", "--state", DBT_ARTIFACT],
        install_deps=True,
        append_env=True,
    )

    seed_operator >> run_operator >> clone_operator
    seed_operator >> check_file_uploaded_task
```

### Setting Dependencies on Individual Cosmos Tasks

```python
from cosmos import DbtDag, DbtResourceType
from airflow.sdk import task, chain

with DbtDag(...) as dag:
    @task
    def upstream_task():
        pass

    _upstream = upstream_task()

    for unique_id, dbt_node in dag.dbt_graph.filtered_nodes.items():
        if dbt_node.resource_type == DbtResourceType.SEED:
            my_dbt_task = dag.tasks_map[unique_id]
            chain(_upstream, my_dbt_task)
```

---

## 8. Safety Checks

Before finalizing, verify:

- [ ] Execution mode matches constraints (AIRFLOW_ASYNC → BigQuery only)
- [ ] Warehouse adapter installed for chosen execution mode
- [ ] Secrets via Airflow connections or env vars, NOT plaintext
- [ ] Load mode matches execution (complex selectors → dbt_ls)
- [ ] Airflow 3 asset URIs if downstream DAGs scheduled on Cosmos assets (see Appendix A)

---

## Appendix A: Airflow 3 Compatibility

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

> **CRITICAL**: Update asset URIs when upgrading to Airflow 3.

---

## Appendix B: Operational Extras

### Caching

Cosmos caches artifacts to speed up parsing. Enabled by default.

Reference: https://astronomer.github.io/astronomer-cosmos/configuration/caching.html

### Memory-Optimized Imports

```bash
AIRFLOW__COSMOS__ENABLE_MEMORY_OPTIMISED_IMPORTS=True
```

When enabled:
```python
from cosmos.airflow.dag import DbtDag  # instead of: from cosmos import DbtDag
```

### Artifact Upload to Object Storage

```bash
AIRFLOW__COSMOS__REMOTE_TARGET_PATH=s3://bucket/target_dir/
AIRFLOW__COSMOS__REMOTE_TARGET_PATH_CONN_ID=aws_default
```

```python
from cosmos.io import upload_to_cloud_storage

my_dag = DbtDag(
    # ...
    operator_args={"callback": upload_to_cloud_storage},
)
```

### dbt Docs Hosting (Airflow 3.1+ / Cosmos 1.11+)

```bash
AIRFLOW__COSMOS__DBT_DOCS_PROJECTS='{
    "my_project": {
        "dir": "s3://bucket/docs/",
        "index": "index.html",
        "conn_id": "aws_default",
        "name": "My Project"
    }
}'
```

Reference: https://astronomer.github.io/astronomer-cosmos/configuration/hosting-docs.html

---

## Related Skills

- **cosmos-dbt-fusion**: For dbt Fusion projects (not dbt Core)
- **authoring-dags**: General DAG authoring patterns
- **testing-dags**: Testing DAGs after creation
