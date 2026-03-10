---
name: cosmos-dbt-fusion
description: Use when running a dbt Fusion project with Astronomer Cosmos. Covers Cosmos 1.11+ configuration for Fusion on Snowflake/Databricks with ExecutionMode.LOCAL. Before implementing, verify dbt engine is Fusion (not Core), warehouse is supported, and local execution is acceptable. Does not cover dbt Core.
tags: ["airflow", "dbt"]
---

# Cosmos + dbt Fusion: Implementation Checklist

Execute steps in order. This skill covers Fusion-specific constraints only.

> **Version note**: dbt Fusion support was introduced in Cosmos 1.11.0. Requires Cosmos ≥1.11.
>
> **Reference**: See **[reference/cosmos-config.md](reference/cosmos-config.md)** for ProfileConfig, operator_args, and Airflow 3 compatibility details.

> **Before starting**, confirm: (1) dbt engine = Fusion (not Core → use **cosmos-dbt-core**), (2) warehouse = Snowflake, Databricks, Bigquery and Redshift only.

### Fusion-Specific Constraints

| Constraint | Details |
|------------|---------|
| No async | `AIRFLOW_ASYNC` not supported |
| No virtualenv | Fusion is a binary, not a Python package |
| Warehouse support | Snowflake, Databricks, Bigquery and Redshift support [while in preview](https://github.com/dbt-labs/dbt-fusion) |

---

## 1. Confirm Cosmos Version

> **CRITICAL**: Cosmos 1.11.0 introduced dbt Fusion compatibility.

```bash
# Check installed version
pip show astronomer-cosmos

# Install/upgrade if needed
pip install "astronomer-cosmos>=1.11.0"
```

**Validate**: `pip show astronomer-cosmos` reports version ≥ 1.11.0

---

## 2. Install the dbt Fusion Binary (REQUIRED)

dbt Fusion is NOT bundled with Cosmos or dbt Core. Install it into the Airflow runtime/image.

Determine where to install the Fusion binary (Dockerfile / base image / runtime).

### Example Dockerfile Install

```dockerfile
USER root
RUN apt-get update && apt-get install -y curl
ENV SHELL=/bin/bash
RUN curl -fsSL https://public.cdn.getdbt.com/fs/install/install.sh | sh -s -- --update
USER astro
```

### Common Install Paths

| Environment | Typical path |
|-------------|--------------|
| Astro Runtime | `/home/astro/.local/bin/dbt` |
| System-wide | `/usr/local/bin/dbt` |

**Validate**: The `dbt` binary exists at the chosen path and `dbt --version` succeeds.

---

## 3. Choose Parsing Strategy (RenderConfig)

Parsing strategy is the same as dbt Core. Pick ONE:

| Load mode | When to use | Required inputs |
|-----------|-------------|-----------------|
| `dbt_manifest` | Large projects; fastest parsing | `ProjectConfig.manifest_path` |
| `dbt_ls` | Complex selectors; need dbt-native selection | Fusion binary accessible to scheduler |
| `automatic` | Simple setups; let Cosmos pick | (none) |

```python
from cosmos import RenderConfig, LoadMode

_render_config = RenderConfig(
    load_method=LoadMode.AUTOMATIC,  # or DBT_MANIFEST, DBT_LS
)
```

---

## 4. Configure Warehouse Connection (ProfileConfig)

> **Reference**: See **[reference/cosmos-config.md](reference/cosmos-config.md#profileconfig-warehouse-connection)** for full ProfileConfig options and examples.


```python
from cosmos import ProfileConfig
from cosmos.profiles import SnowflakeUserPasswordProfileMapping

_profile_config = ProfileConfig(
    profile_name="default",
    target_name="dev",
    profile_mapping=SnowflakeUserPasswordProfileMapping(
        conn_id="snowflake_default",
    ),
)
```

---

## 5. Configure ExecutionConfig (LOCAL Only)

> **CRITICAL**: dbt Fusion with Cosmos requires `ExecutionMode.LOCAL` with `dbt_executable_path` pointing to the Fusion binary.

```python
from cosmos import ExecutionConfig
from cosmos.constants import InvocationMode

_execution_config = ExecutionConfig(
    invocation_mode=InvocationMode.SUBPROCESS,
    dbt_executable_path="/home/astro/.local/bin/dbt",  # REQUIRED: path to Fusion binary
    # execution_mode is LOCAL by default - do not change
)
```

---

## 6. Configure Project (ProjectConfig)

```python
from cosmos import ProjectConfig

_project_config = ProjectConfig(
    dbt_project_path="/path/to/dbt/project",
    # manifest_path="/path/to/manifest.json",  # for dbt_manifest load mode
    # install_dbt_deps=False,  # if deps precomputed in CI
)
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

_execution_config = ExecutionConfig(
    dbt_executable_path="/home/astro/.local/bin/dbt",  # Fusion binary
)

_render_config = RenderConfig()

my_fusion_dag = DbtDag(
    dag_id="my_fusion_cosmos_dag",
    project_config=_project_config,
    profile_config=_profile_config,
    execution_config=_execution_config,
    render_config=_render_config,
    start_date=datetime(2025, 1, 1),
    schedule="@daily",
)
```

### Option B: DbtTaskGroup (Inside Existing DAG)

```python
from airflow.sdk import dag, task  # Airflow 3.x
# from airflow.decorators import dag, task  # Airflow 2.x
from airflow.models.baseoperator import chain
from cosmos import DbtTaskGroup, ProjectConfig, ProfileConfig, ExecutionConfig
from pendulum import datetime

_project_config = ProjectConfig(dbt_project_path="/usr/local/airflow/dbt/my_project")
_profile_config = ProfileConfig(profile_name="default", target_name="dev")
_execution_config = ExecutionConfig(dbt_executable_path="/home/astro/.local/bin/dbt")

@dag(start_date=datetime(2025, 1, 1), schedule="@daily")
def my_dag():
    @task
    def pre_dbt():
        return "some_value"

    dbt = DbtTaskGroup(
        group_id="dbt_fusion_project",
        project_config=_project_config,
        profile_config=_profile_config,
        execution_config=_execution_config,
    )

    @task
    def post_dbt():
        pass

    chain(pre_dbt(), dbt, post_dbt())

my_dag()
```

---

## 8. Final Validation

Before finalizing, verify:

- [ ] **Cosmos version**: ≥1.11.0
- [ ] **Fusion binary installed**: Path exists and is executable
- [ ] **Warehouse supported**: Snowflake, Databricks, Bigquery or Redshift only
- [ ] **Secrets handling**: Airflow connections or env vars, NOT plaintext

### Troubleshooting

If user reports dbt Core regressions after enabling Fusion:

```bash
AIRFLOW__COSMOS__PRE_DBT_FUSION=1
```

### User Must Test

- [ ] The DAG parses in the Airflow UI (no import/parse-time errors)
- [ ] A manual run succeeds against the target warehouse (at least one model)

---

## Reference

- Cosmos dbt Fusion docs: https://astronomer.github.io/astronomer-cosmos/configuration/dbt-fusion.html
- dbt Fusion install: https://docs.getdbt.com/docs/core/pip-install#dbt-fusion

---

## Related Skills

- **cosmos-dbt-core**: For dbt Core projects (not Fusion)
- **authoring-dags**: General DAG authoring patterns
- **testing-dags**: Testing DAGs after creation
