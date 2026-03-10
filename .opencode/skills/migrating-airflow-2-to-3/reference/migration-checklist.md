# Migration Checklist

After running Ruff's AIR rules, use this manual search checklist to find remaining issues.

## 1. Direct metadata DB access

**Search for:**
- `provide_session`
- `create_session`
- `@provide_session`
- `Session(`
- `engine`
- `with Session()`
- `engine.connect(`
- `Session(bind=engine)`
- `from airflow.settings import Session`
- `from airflow.settings import engine`
- `from sqlalchemy.orm.session import Session`

**Fix:** Refactor to use Airflow Python client or REST API

---

## 2. Legacy imports

**Search for:**
- `from airflow.contrib`
- `from airflow.operators.`
- `from airflow.hooks.`

**Fix:** Map to provider imports (see [migration-patterns.md](migration-patterns.md))

---

## 3. Removed/renamed DAG arguments

**Search for:**
- `schedule_interval=`
- `timetable=`
- `days_ago(`
- `fail_stop=`
- `sla=`
- `sla_miss_callback`

**Fix:**
- `schedule_interval` and `timetable` → use `schedule=`
- `days_ago` → use `pendulum.today("UTC").add(days=-N)`
- `fail_stop` → renamed to `fail_fast`
- `sla` and `sla_miss_callback` → removed; use **Astro Alerts** or OSS **Deadline Alerts** (Airflow 3.1+ experimental)

---

## 4. Deprecated context keys

**Search for:**
- `execution_date`
- `prev_ds`
- `next_ds`
- `yesterday_ds`
- `tomorrow_ds`
- `templates_dict`

**Fix:**
- `execution_date` → use `context["dag_run"].logical_date`
- `tomorrow_ds` / `yesterday_ds` → use `ds` with date math: `macros.ds_add(ds, 1)` / `macros.ds_add(ds, -1)`
- `prev_ds` / `next_ds` → use `prev_start_date_success` or timetable API
- `templates_dict` → use `params` via `context["params"]`

---

## 5. XCom pickling

**Search for:**
- `ENABLE_XCOM_PICKLING`
- `.xcom_pull(` without `task_ids=`

**Fix:** Use JSON-serializable data or custom backend

---

## 6. Datasets to Assets

**Search for:**
- `airflow.datasets`
- `triggering_dataset_events`
- `DatasetOrTimeSchedule`
- `on_dataset_created`
- `on_dataset_changed`
- `outlet_events["`
- `inlet_events["`

**Fix:** Switch to `airflow.sdk.Asset`, `AssetOrTimeSchedule`, `on_asset_created`/`on_asset_changed`. Use `Asset(name=...)` objects as keys in `outlet_events`/`inlet_events` (not strings)

---

## 7. Removed operators

**Search for:**
- `SubDagOperator`
- `SimpleHttpOperator`
- `DagParam`
- `DummyOperator`

**Fix:** Use TaskGroups, HttpOperator, Param, EmptyOperator

---

## 8. Email changes

**Search for:**
- `airflow.operators.email.EmailOperator`
- `airflow.utils.email`
- `email=` (task parameter for email on failure/retry)

**Fix:** Use SMTP provider (`apache-airflow-providers-smtp`). Replace legacy email behavior with SMTP-provider callbacks such as `send_smtp_notification(...)` or `SmtpNotifier`.

---

## 9. REST API v1

**Search for:**
- `/api/v1`
- `auth=(`
- `execution_date` (in API params)

**Fix:** Update to `/api/v2` with Bearer tokens. Replace `execution_date` params with `logical_date`. Dataset endpoints now under `asset` resources

---

## 10. File paths and shared utility imports

**Search for:**
- `open("include/`
- `open("data/`
- `template_searchpath=`
- relative paths
- `import common` or `from common` (bare imports from `dags/common/` or similar)
- `import utils` or `from utils` (bare imports from `dags/utils/` or similar)
- `sys.path.append` or `sys.path.insert` (custom path manipulation)

**Fix:**
- Use `__file__` or `AIRFLOW_HOME` anchoring for file paths
- Note: triggers cannot be in DAG bundle; must be elsewhere on `sys.path`
- **Shared utility imports**: Bare imports like `import common` no longer work. Use fully qualified imports: `import dags.common` or `from dags.common.utils import helper_function`

---

## 11. FAB-based plugins

**Search for:**
- `appbuilder_views`
- `appbuilder_menu_items`
- `flask_blueprints`
- `AirflowPlugin`

**Fix:** Flask-AppBuilder removed from core. FAB plugins need manual migration to new system (React apps, FastAPI, listeners). Do not auto-migrate; recommend separate PR

---

## 12. Callback and behavior changes

**Search for:**
- `on_success_callback`
- `@teardown`
- `templates_dict`
- `expanded_ti_count`
- `external_trigger`
- `test_mode`
- `trigger_rule="dummy"` or `TriggerRule.DUMMY`
- `trigger_rule="none_failed_or_skipped"` or `NONE_FAILED_OR_SKIPPED`

**Fix:**
- `on_success_callback` no longer runs on skip; use `on_skipped_callback` if needed
- `@teardown` with trigger rule `always` not allowed; teardowns now execute even if DAG run terminated early
- `templates_dict` removed → use `params` via `context["params"]`
- `expanded_ti_count` removed → use REST API "Get Mapped Task Instances"
- `dag_run.external_trigger` removed → infer from `dag_run.run_type`
- `test_mode` removed; avoid relying on this flag
- `dummy` trigger rule removed → use `always` (or `TriggerRule.ALWAYS`)
- `none_failed_or_skipped` trigger rule removed → use `none_failed_min_one_success` (or `TriggerRule.NONE_FAILED_MIN_ONE_SUCCESS`)
