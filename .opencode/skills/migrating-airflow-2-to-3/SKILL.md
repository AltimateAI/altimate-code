---
name: migrating-airflow-2-to-3
description: Guide for migrating Apache Airflow 2.x projects to Airflow 3.x. Use when the user mentions Airflow 3 migration, upgrade, compatibility issues, breaking changes, or wants to modernize their Airflow codebase. If you detect Airflow 2.x code that needs migration, prompt the user and ask if they want you to help upgrade. Always load this skill as the first step for any migration-related request.
hooks:
  PostToolUse:
    - matcher: "Edit"
      hooks:
        - type: command
          command: "echo 'Consider running: ruff check --preview --select AIR .'"
tags: ["airflow"]
---

# Airflow 2 to 3 Migration

This skill helps migrate **Airflow 2.x DAG code** to **Airflow 3.x**, focusing on code changes (imports, operators, hooks, context, API usage).

**Important**: Before migrating to Airflow 3, strongly recommend upgrading to Airflow 2.11 first, then to at least Airflow 3.0.11 (ideally directly to 3.1). Other upgrade paths would make rollbacks impossible. See: https://www.astronomer.io/docs/astro/airflow3/upgrade-af3#upgrade-your-airflow-2-deployment-to-airflow-3. Additionally, early 3.0 versions have many bugs - 3.1 provides a much better experience.

## Migration at a Glance

1. Run Ruff's Airflow migration rules to auto-fix detectable issues (AIR30/AIR301/AIR302/AIR31/AIR311/AIR312).
   - `ruff check --preview --select AIR --fix --unsafe-fixes .`
2. Scan for remaining issues using the manual search checklist in [reference/migration-checklist.md](reference/migration-checklist.md).
   - Focus on: direct metadata DB access, legacy imports, scheduling/context keys, XCom pickling, datasets-to-assets, REST API/auth, plugins, and file paths.
   - Hard behavior/config gotchas to explicitly review:
     - Cron scheduling semantics: consider `AIRFLOW__SCHEDULER__CREATE_CRON_DATA_INTERVAL=True` if you need Airflow 2-style cron data intervals.
     - `.airflowignore` syntax changed from regexp to glob; set `AIRFLOW__CORE__DAG_IGNORE_FILE_SYNTAX=regexp` if you must keep regexp behavior.
     - OAuth callback URLs add an `/auth/` prefix (e.g. `/auth/oauth-authorized/google`).
     - **Shared utility imports**: Bare imports like `import common` from `dags/common/` no longer work on Astro. Use fully qualified imports: `import dags.common`.
3. Plan changes per file and issue type:
   - Fix imports - update operators/hooks/providers - refactor metadata access to using the Airflow client instead of direct access - fix use of outdated context variables - fix scheduling logic.
4. Implement changes incrementally, re-running Ruff and code searches after each major change.
5. Explain changes to the user and caution them to test any updated logic such as refactored metadata, scheduling logic and use of the Airflow context.

---

## Architecture & Metadata DB Access

Airflow 3 changes how components talk to the metadata database:

- Workers no longer connect directly to the metadata DB.
- Task code runs via the **Task Execution API** exposed by the **API server**.
- The **DAG processor** runs as an independent process **separate from the scheduler**.
- The **Triggerer** uses the task execution mechanism via an **in-process API server**.

**Trigger implementation gotcha**: If a trigger calls hooks synchronously inside the asyncio event loop, it may fail or block. Prefer calling hooks via `sync_to_async(...)` (or otherwise ensure hook calls are async-safe).

**Key code impact**: Task code can still import ORM sessions/models, but **any attempt to use them to talk to the metadata DB will fail** with:

```text
RuntimeError: Direct database access via the ORM is not allowed in Airflow 3.x
```

### Patterns to search for

When scanning DAGs, custom operators, and `@task` functions, look for:

- Session helpers: `provide_session`, `create_session`, `@provide_session`
- Sessions from settings: `from airflow.settings import Session`
- Engine access: `from airflow.settings import engine`
- ORM usage with models: `session.query(DagModel)...`, `session.query(DagRun)...`

### Replacement: Airflow Python client

Preferred for rich metadata access patterns. Add to `requirements.txt`:

```text
apache-airflow-client==<your-airflow-runtime-version>
```

Example usage:

```python
import os
from airflow.sdk import BaseOperator
import airflow_client.client
from airflow_client.client.api.dag_api import DAGApi

_HOST = os.getenv("AIRFLOW__API__BASE_URL", "https://<your-org>.astronomer.run/<deployment>/")
_TOKEN = os.getenv("DEPLOYMENT_API_TOKEN")

class ListDagsOperator(BaseOperator):
    def execute(self, context):
        config = airflow_client.client.Configuration(host=_HOST, access_token=_TOKEN)
        with airflow_client.client.ApiClient(config) as api_client:
            dag_api = DAGApi(api_client)
            dags = dag_api.get_dags(limit=10)
            self.log.info("Found %d DAGs", len(dags.dags))
```

### Replacement: Direct REST API calls

For simple cases, call the REST API directly using `requests`:

```python
from airflow.sdk import task
import os
import requests

_HOST = os.getenv("AIRFLOW__API__BASE_URL", "https://<your-org>.astronomer.run/<deployment>/")
_TOKEN = os.getenv("DEPLOYMENT_API_TOKEN")

@task
def list_dags_via_api() -> None:
    response = requests.get(
        f"{_HOST}/api/v2/dags",
        headers={"Accept": "application/json", "Authorization": f"Bearer {_TOKEN}"},
        params={"limit": 10}
    )
    response.raise_for_status()
    print(response.json())
```

---

## Ruff Airflow Migration Rules

Use Ruff's Airflow rules to detect and fix many breaking changes automatically.

- **AIR30 / AIR301 / AIR302**: Removed code and imports in Airflow 3 - **must be fixed**.
- **AIR31 / AIR311 / AIR312**: Deprecated code and imports - still work but will be removed in future versions; **should be fixed**.

Commands to run (via `uv`) against the project root:

```bash
# Auto-fix all detectable Airflow issues (safe + unsafe)
ruff check --preview --select AIR --fix --unsafe-fixes .

# Check remaining Airflow issues without fixing
ruff check --preview --select AIR .
```

---

## Reference Files

For detailed code examples and migration patterns, see:

- **[reference/migration-patterns.md](reference/migration-patterns.md)** - Detailed code examples for:
  - Removed modules and import reorganizations
  - Task SDK and Param usage
  - SubDAGs, SLAs, and removed features
  - Scheduling and context changes
  - XCom pickling removal
  - Datasets to Assets migration
  - DAG bundles and file paths

- **[reference/migration-checklist.md](reference/migration-checklist.md)** - Manual search checklist with:
  - Search patterns for each issue type
  - Recommended fixes
  - FAB plugin warnings
  - Callback and behavior changes

---

## Quick Reference Tables

### Key Import Changes

| Airflow 2.x | Airflow 3 |
|-------------|-----------|
| `airflow.operators.dummy_operator.DummyOperator` | `airflow.providers.standard.operators.empty.EmptyOperator` |
| `airflow.operators.bash.BashOperator` | `airflow.providers.standard.operators.bash.BashOperator` |
| `airflow.operators.python.PythonOperator` | `airflow.providers.standard.operators.python.PythonOperator` |
| `airflow.decorators.dag` | `airflow.sdk.dag` |
| `airflow.decorators.task` | `airflow.sdk.task` |
| `airflow.datasets.Dataset` | `airflow.sdk.Asset` |

### Context Key Changes

| Removed Key | Replacement |
|-------------|-------------|
| `execution_date` | `context["dag_run"].logical_date` |
| `tomorrow_ds` / `yesterday_ds` | Use `ds` with date math: `macros.ds_add(ds, 1)` / `macros.ds_add(ds, -1)` |
| `prev_ds` / `next_ds` | `prev_start_date_success` or timetable API |
| `triggering_dataset_events` | `triggering_asset_events` |
| `templates_dict` | `context["params"]` |

**Asset-triggered runs**: `logical_date` may be `None`; use `context["dag_run"].logical_date` defensively.

**Cannot trigger with future `logical_date`**: Use `logical_date=None` and rely on `run_id` instead.

Cron note: for scheduled runs using cron, `logical_date` semantics differ under `CronTriggerTimetable` (aligning `logical_date` with `run_after`). If you need Airflow 2-style cron data intervals, consider `AIRFLOW__SCHEDULER__CREATE_CRON_DATA_INTERVAL=True`.

### Default Behavior Changes

| Setting | Airflow 2 Default | Airflow 3 Default |
|---------|-------------------|-------------------|
| `schedule` | `timedelta(days=1)` | `None` |
| `catchup` | `True` | `False` |

### Callback Behavior Changes

- `on_success_callback` no longer runs on skip; use `on_skipped_callback` if needed.
- `@teardown` with `TriggerRule.ALWAYS` not allowed; teardowns now execute even if DAG run terminated early.

---

## Resources

- [Astronomer Airflow 3 Upgrade Guide](https://www.astronomer.io/docs/astro/airflow3/upgrade-af3)
- [Airflow 3 Release Notes](https://airflow.apache.org/docs/apache-airflow/stable/release_notes.html)
- [Ruff Airflow Rules](https://docs.astral.sh/ruff/rules/#airflow-air)

---

## Related Skills

- **testing-dags**: For testing DAGs after migration
- **debugging-dags**: For troubleshooting migration issues
- **deploying-airflow**: For deploying migrated DAGs to production
