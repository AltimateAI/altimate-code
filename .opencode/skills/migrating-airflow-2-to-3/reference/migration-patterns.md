# Migration Patterns Reference

Detailed code examples for Airflow 2 to 3 migration.

## Table of Contents

- [Removed Modules & Import Reorganizations](#removed-modules--import-reorganizations)
- [Task SDK & Param Usage](#task-sdk--param-usage)
- [SubDAGs, SLAs, and Removed Features](#subdags-slas-and-removed-features)
- [Scheduling & Context Changes](#scheduling--context-changes)
- [XCom Pickling Removal](#xcom-pickling-removal)
- [Datasets to Assets](#datasets-to-assets)
- [DAG Bundles & File Paths](#dag-bundles--file-paths)

---

## Removed Modules & Import Reorganizations

### `airflow.contrib.*` removed

The entire `airflow.contrib.*` namespace is removed in Airflow 3.

**Before (Airflow 2.x, removed in Airflow 3):**

```python
from airflow.contrib.operators.dummy_operator import DummyOperator
```

**After (Airflow 3):**

```python
from airflow.providers.standard.operators.empty import EmptyOperator
```

Use `EmptyOperator` instead of the removed `DummyOperator`.

### Core operators moved to provider packages

Many commonly used core operators moved to the **standard provider**.

Example for `BashOperator` and `PythonOperator`:

```python
# Airflow 2 legacy imports (removed in Airflow 3, AIR30/AIR301)
from airflow.operators.bash_operator import BashOperator
from airflow.operators.python_operator import PythonOperator

# Airflow 2/3 deprecated imports (still work but deprecated, AIR31/AIR311)
from airflow.operators.bash import BashOperator
from airflow.operators.python import PythonOperator

# Recommended in Airflow 3: Standard provider
from airflow.providers.standard.operators.bash import BashOperator
from airflow.providers.standard.operators.python import PythonOperator
```

Operators moved to the `apache-airflow-providers-standard` package include (non-exhaustive):

- `BashOperator`
- `BranchDateTimeOperator`
- `BranchDayOfWeekOperator`
- `LatestOnlyOperator`
- `PythonOperator`
- `PythonVirtualenvOperator`
- `ExternalPythonOperator`
- `BranchPythonOperator`
- `BranchPythonVirtualenvOperator`
- `BranchExternalPythonOperator`
- `ShortCircuitOperator`
- `TriggerDagRunOperator`

This provider is installed on Astro Runtime by default.

### Hook and sensor imports moved to providers

Most hooks and sensors live in provider packages in Airflow 3. Look for very old imports:

```python
from airflow.hooks.http_hook import HttpHook
from airflow.hooks.base_hook import BaseHook
```

Replace with provider imports:

```python
from airflow.providers.http.hooks.http import HttpHook
from airflow.sdk import BaseHook  # base hook from task SDK where appropriate
```

### `EmailOperator` moved to SMTP provider

In Airflow 3, `EmailOperator` is provided by the **SMTP provider**, not the standard provider.

```python
from airflow.providers.smtp.operators.smtp import EmailOperator

EmailOperator(
    task_id="send_email",
    conn_id="smtp_default",
    to="receiver@example.com",
    subject="Test Email",
    html_content="This is a test email",
)
```

Ensure `apache-airflow-providers-smtp` is added to any project that uses email features or notifications so that email-related code is compatible with Airflow 3.2 and later.

**Replacing legacy email notifications**: Move towards SMTP-provider based callbacks (and eventually `SmtpNotifier`) instead of relying on legacy task-level email behavior:

```python
from airflow.providers.smtp.notifications.smtp import send_smtp_notification

BashOperator(
    task_id="my_task",
    bash_command="exit 1",
    on_failure_callback=[
        send_smtp_notification(
            from_email="airflow@my_domain.com",
            to="my_name@my_domain.ch",
            subject="[Error] The Task {{ ti.task_id }} failed",
            html_content="debug logs",
        )
    ],
)
```

**Astro users**: Consider [Astro Alerts](https://www.astronomer.io/docs/astro/alerts) for critical notifications (works independently of Airflow components).

---

## Task SDK & Param Usage

In Airflow 3, most classes and decorators used by DAG authors are available via the **Task SDK** (`airflow.sdk`). Using these imports makes it easier to evolve your code with future Airflow versions.

### Key Task SDK imports

Prefer these imports in new code:

```python
from airflow.sdk import (
    dag,
    task,
    setup,
    teardown,
    DAG,
    TaskGroup,
    BaseOperator,
    BaseSensorOperator,
    Param,
    ParamsDict,
    Variable,
    Connection,
    Context,
    Asset,
    AssetAlias,
    AssetAll,
    AssetAny,
    DagRunState,
    TaskInstanceState,
    TriggerRule,
    WeightRule,
    BaseHook,
    BaseNotifier,
    XComArg,
    chain,
    chain_linear,
    cross_downstream,
    get_current_context,
)
```

### Import mappings from legacy to Task SDK

| Legacy Import | Task SDK Import |
|---------------|-----------------|
| `airflow.decorators.dag` | `airflow.sdk.dag` |
| `airflow.decorators.task` | `airflow.sdk.task` |
| `airflow.utils.task_group.TaskGroup` | `airflow.sdk.TaskGroup` |
| `airflow.models.dag.DAG` | `airflow.sdk.DAG` |
| `airflow.models.baseoperator.BaseOperator` | `airflow.sdk.BaseOperator` |
| `airflow.models.param.Param` | `airflow.sdk.Param` |
| `airflow.datasets.Dataset` | `airflow.sdk.Asset` |
| `airflow.datasets.DatasetAlias` | `airflow.sdk.AssetAlias` |

---

## SubDAGs, SLAs, and Removed Features

### SubDAGs removed

Search for:

- `SubDagOperator(`
- `from airflow.operators.subdag_operator import SubDagOperator`
- `from airflow.operators.subdag import SubDagOperator`

Migration guidance:

- Use `TaskGroup` or `@task_group` for logical grouping **within a single DAG**.
- For workflows that were previously split via SubDAGs, consider:
  - Refactoring into **smaller DAGs**.
  - Using **Assets** (formerly Datasets) for cross-DAG dependencies.

### SLAs removed

Search for:

- `sla=`
- `sla_miss_callback`
- `SLAMiss`

Code changes:

- Remove SLA-related parameters from tasks and DAGs.
- Remove SLA-based callbacks from DAG definitions.
- On **Astro**, use **Astro Alerts** for DAG/task-level SLAs.

### Other removed or renamed code features

- `DagParam` removed - use `Param` from `airflow.sdk`.
- `SimpleHttpOperator` removed - use `HttpOperator` from the HTTP provider.
- Trigger rules:
  - `dummy` - use `TriggerRule.ALWAYS`.
  - `none_failed_or_skipped` - use `TriggerRule.NONE_FAILED_MIN_ONE_SUCCESS`.
- `.xcom_pull` behavior:
  - In Airflow 3, calling `xcom_pull(key="...")` **without** `task_ids` always returns `None`; always specify `task_ids` explicitly.
- `fail_stop` DAG parameter renamed to `fail_fast`.
- `max_active_tasks` now limits **active task instances per DAG run** instead of across all DAG runs.
- `on_success_callback` no longer runs on skip; use `on_skipped_callback` if needed.
- `@teardown` with `TriggerRule.ALWAYS` not allowed; teardowns now execute even if DAG run terminated early.
- `templates_dict` removed - use `params` via `context["params"]`.
- `expanded_ti_count` removed - use REST API "Get Mapped Task Instances" endpoint.
- `dag_run.external_trigger` removed - infer from `dag_run.run_type`.
- `test_mode` removed; avoid relying on this flag.
- Cannot trigger a DAG with a `logical_date` in the future; use `logical_date=None` and rely on `run_id` instead.

---

## Scheduling & Context Changes

### Default scheduling behavior

Airflow 3 changes default DAG scheduling:

- `schedule=None` instead of `timedelta(days=1)`.
- `catchup=False` instead of `True`.

Code impact:

- If a DAG relied on implicit daily scheduling, explicitly set `schedule`.
- If a DAG relied on catchup by default, explicitly set `catchup=True`.

### Removed context keys and replacements

| Removed Key | Replacement |
|-------------|-------------|
| `execution_date` | `context["dag_run"].logical_date` |
| `tomorrow_ds` / `yesterday_ds` | Use `ds` with date math: `macros.ds_add(ds, 1)` / `macros.ds_add(ds, -1)` |
| `prev_ds` / `next_ds` | Use `prev_start_date_success` or timetable API |
| `triggering_dataset_events` | `triggering_asset_events` with Asset objects |
| `conf` | In Airflow 3.2+, use `from airflow.sdk import conf`. In Airflow 3.0/3.1, temporarily use `from airflow.configuration import conf`. |

Note: These replacements are **not always drop-in**; logic changes may be required.

**Asset-triggered runs**: `logical_date` may be `None`. Use defensive access: `context["dag_run"].logical_date` or `context["run_id"]`.

### `days_ago` removed

The helper `days_ago` from `airflow.utils.dates` was removed. Replace with explicit datetimes:

```python
# WRONG - Removed in Airflow 3
from airflow.utils.dates import days_ago
start_date=days_ago(2)

# CORRECT - Use pendulum
import pendulum
start_date=pendulum.today("UTC").add(days=-2)
```

---

## XCom Pickling Removal

In Airflow 3:

- `AIRFLOW__CORE__ENABLE_XCOM_PICKLING` is removed.
- The default XCom backend requires values to be **serializable** (for most users this means JSON-serializable values).

If tasks need to pass complex objects (e.g. NumPy arrays), you must use a **custom XCom backend**.

Example custom backend for NumPy arrays:

```python
from airflow.sdk.bases.xcom import BaseXCom
import json
import numpy as np

class NumpyXComBackend(BaseXCom):
    @staticmethod
    def serialize_value(value, **kwargs):
        if isinstance(value, np.ndarray):
            return json.dumps({"type": "ndarray", "data": value.tolist(), "dtype": str(value.dtype)}).encode()
        return BaseXCom.serialize_value(value)

    @staticmethod
    def deserialize_value(result):
        if isinstance(result.value, bytes):
            d = json.loads(result.value.decode("utf-8"))
            if d.get("type") == "ndarray":
                return np.array(d["data"], dtype=d["dtype"])
        return BaseXCom.deserialize_value(result)
```

Reference: https://www.astronomer.io/docs/learn/custom-xcom-backend-strategies

---

## Datasets to Assets

Datasets were renamed to Assets in Airflow 3; the old APIs are deprecated.

Mappings:

| Airflow 2.x | Airflow 3 |
|-------------|-----------|
| `airflow.datasets.Dataset` | `airflow.sdk.Asset` |
| `airflow.datasets.DatasetAlias` | `airflow.sdk.AssetAlias` |
| `airflow.datasets.DatasetAll` | `airflow.sdk.AssetAll` |
| `airflow.datasets.DatasetAny` | `airflow.sdk.AssetAny` |
| `airflow.datasets.metadata.Metadata` | `airflow.sdk.Metadata` |
| `airflow.timetables.datasets.DatasetOrTimeSchedule` | `airflow.timetables.assets.AssetOrTimeSchedule` |
| `airflow.listeners.spec.dataset.on_dataset_created` | `airflow.listeners.spec.asset.on_asset_created` |
| `airflow.listeners.spec.dataset.on_dataset_changed` | `airflow.listeners.spec.asset.on_asset_changed` |

When working with asset events in the task context, **do not use plain strings as keys** in `outlet_events` or `inlet_events`:

```python
# WRONG
outlet_events["myasset"]

# CORRECT
from airflow.sdk import Asset
outlet_events[Asset(name="myasset")]
```

**Reading asset event data**:

```python
from airflow.sdk import task

@task
def read_triggering_assets(**context):
    events = context.get("triggering_asset_events") or {}
    for asset, asset_events in events.items():
        first_event = asset_events[0]
        print(asset, first_event.source_run_id)
```

**Cosmos/dbt note**: Asset URIs changed from dots to slashes (`schema.table` → `schema/table`). Upgrade `astronomer-cosmos` to **>= 1.10.0** for Airflow 3 compatibility (and **>= 1.11.0** if you need dbt Docs hosting in the Airflow UI).

---

## DAG Bundles & File Paths

On Astro Runtime, Airflow 3 uses a versioned DAG bundle, so file paths and imports behave differently.

### Shared utility imports

If you import shared utility code from `dags/common/` or similar directories, **bare imports no longer work** in Airflow 3 on Astro. This is because DAG bundles place the bundle root on `sys.path`, but not `<bundle_root>/dags`. Additionally, bare imports are unsafe with DAG bundles due to Python's global import cache conflicting with concurrent bundle versions.

Use fully qualified imports instead:

```python
# Airflow 2 (no longer works)
import common
from common.utils import helper_function

# Airflow 3
import dags.common
from dags.common.utils import helper_function
```

Each bundle has its own `dags` package rooted at its bundle directory, which keeps imports scoped to the correct bundle version.

### File path handling

On Astro Runtime, Airflow 3 uses a versioned DAG bundle, so file paths behave differently:

**For files inside `dags/` folder:**
```python
import os
dag_dir = os.path.dirname(__file__)
with open(os.path.join(dag_dir, "my_file.txt"), "r") as f:
    contents = f.read()
```

**For files in `include/` or other mounted folders:**
```python
import os
with open(f"{os.getenv('AIRFLOW_HOME')}/include/my_file.txt", 'r') as f:
    contents = f.read()
```

**For `template_searchpath`:**
```python
import os
from airflow.sdk import dag

@dag(template_searchpath=[f"{os.getenv('AIRFLOW_HOME')}/include/sql"])
def my_dag():
    ...
```

**Note**: Triggers cannot be in the DAG bundle; they must be elsewhere on `sys.path`.
