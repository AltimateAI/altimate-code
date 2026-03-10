---
name: airflow-plugins
description: Build Airflow 3.1+ plugins that embed FastAPI apps, custom UI pages, React components, middleware, macros, and operator links directly into the Airflow UI. Use this skill whenever the user wants to create an Airflow plugin, add a custom UI page or nav entry to Airflow, build FastAPI-backed endpoints inside Airflow, serve static assets from a plugin, embed a React app in the Airflow UI, add middleware to the Airflow API server, create custom operator extra links, or call the Airflow REST API from inside a plugin. Also trigger when the user mentions AirflowPlugin, fastapi_apps, external_views, react_apps, plugin registration, or embedding a web app in Airflow 3.1+. If someone is building anything custom inside Airflow 3.1+ that involves Python and a browser-facing interface, this skill almost certainly applies.
tags: ["airflow"]
---

# Airflow 3 Plugins

Airflow 3 plugins let you embed FastAPI apps, React UIs, middleware, macros, operator buttons, and custom timetables directly into the Airflow process. No sidecar, no extra server.

> **CRITICAL**: Plugin components (fastapi_apps, react_apps, external_views) require **Airflow 3.1+**. **NEVER import `flask`, `flask_appbuilder`, or use `appbuilder_views` / `flask_blueprints`** — these are Airflow 2 patterns and will not work in Airflow 3. If existing code uses them, rewrite the entire registration block using FastAPI.
>
> **Security**: FastAPI plugin endpoints are **not automatically protected** by Airflow auth. If your endpoints need to be private, implement authentication explicitly using FastAPI's security utilities.
>
> **Restart required**: Changes to Python plugin files require restarting the API server. Static file changes (HTML, JS, CSS) are picked up immediately. Set `AIRFLOW__CORE__LAZY_LOAD_PLUGINS=False` during development to load plugins at startup rather than lazily.
>
> **Relative paths always**: In `external_views`, `href` must have no leading slash. In HTML and JavaScript, use relative paths for all assets and `fetch()` calls. Absolute paths break behind reverse proxies.

### Before writing any code, verify

1. Am I using `fastapi_apps` / FastAPI — not `appbuilder_views` / Flask?
2. Are all HTML/JS asset paths and `fetch()` calls relative (no leading slash)?
3. Are all synchronous SDK or SQLAlchemy calls wrapped in `asyncio.to_thread()`?
4. Do the `static/` and `assets/` directories exist before the FastAPI app mounts them?
5. If the endpoint must be private, did I add explicit FastAPI authentication?

---

## Step 1: Choose plugin components

A single plugin class can register multiple component types at once.

| Component | What it does | Field |
|-----------|-------------|-------|
| Custom API endpoints | FastAPI app mounted in Airflow process | `fastapi_apps` |
| Nav / page link | Embeds a URL as an iframe or links out | `external_views` |
| React component | Custom React app embedded in Airflow UI | `react_apps` |
| API middleware | Intercepts all Airflow API requests/responses | `fastapi_root_middlewares` |
| Jinja macros | Reusable Python functions in DAG templates | `macros` |
| Task instance button | Extra link button in task Detail view | `operator_extra_links` / `global_operator_extra_links` |
| Custom timetable | Custom scheduling logic | `timetables` |
| Event hooks | Listener callbacks for Airflow events | `listeners` |

---

## Step 2: Plugin registration skeleton

### Project file structure

Give each plugin its own subdirectory under `plugins/` — this keeps the Python file, static assets, and templates together and makes multi-plugin projects manageable:

```
plugins/
  my-plugin/
    plugin.py       # AirflowPlugin subclass — auto-discovered by Airflow
    static/
      index.html
      app.js
    assets/
      icon.svg
```

`BASE_DIR = Path(__file__).parent` in `plugin.py` resolves to `plugins/my-plugin/` — static and asset paths will be correct relative to that. Create the subdirectory and any static/assets folders before starting Airflow, or `StaticFiles` will raise on import.

```python
from pathlib import Path
from airflow.plugins_manager import AirflowPlugin
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

BASE_DIR = Path(__file__).parent

app = FastAPI(title="My Plugin")

# Both directories must exist before Airflow starts or FastAPI raises on import
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
app.mount("/assets", StaticFiles(directory=BASE_DIR / "assets"), name="assets")


class MyPlugin(AirflowPlugin):
    name = "my_plugin"

    fastapi_apps = [
        {
            "app": app,
            "url_prefix": "/my-plugin",   # plugin available at {AIRFLOW_HOST}/my-plugin/
            "name": "My Plugin",
        }
    ]

    external_views = [
        {
            "name": "My Plugin",
            "href": "my-plugin/ui",              # NO leading slash — breaks on Astro and reverse proxies
            "destination": "nav",                # see locations table below
            "category": "browse",                # nav bar category (nav destination only)
            "url_route": "my-plugin",            # unique route name (required for React apps)
            "icon": "/my-plugin/static/icon.svg" # DOES use a leading slash — served by FastAPI
        }
    ]
```

### External view locations

| `destination` | Where it appears |
|--------------|-----------------|
| `"nav"` | Left navigation bar (also set `category`) |
| `"dag"` | Extra tab on every Dag page |
| `"dag_run"` | Extra tab on every Dag run page |
| `"task"` | Extra tab on every task page |
| `"task_instance"` | Extra tab on every task instance page |

### Nav bar categories (`destination: "nav"`)

Set `"category"` to place the link under a specific nav group: `"browse"`, `"admin"`, or omit for top-level.

### External URLs and minimal plugins

`href` can be a relative path to an internal endpoint (`"my-plugin/ui"`) or a full external URL. A plugin with only `external_views` and no `fastapi_apps` is valid — no backend needed for a simple link or tab:

```python
from airflow.plugins_manager import AirflowPlugin

class LearnViewPlugin(AirflowPlugin):
    name = "learn_view_plugin"

    external_views = [
        {
            "name": "Learn Airflow 3",
            "href": "https://www.astronomer.io/docs/learn",
            "destination": "dag",   # adds a tab to every Dag page
            "url_route": "learn"
        }
    ]
```

The no-leading-slash rule applies to internal paths only — full `https://` URLs are fine.

---

## Step 3: Serve the UI entry point

```python
@app.get("/ui", response_class=FileResponse)
async def serve_ui():
    return FileResponse(BASE_DIR / "static" / "index.html")
```

In HTML, always use **relative paths**. Absolute paths break when Airflow is mounted at a sub-path:

```html
<!-- correct -->
<link rel="stylesheet" href="static/app.css" />
<script src="static/app.js?v=20240315"></script>

<!-- breaks behind a reverse proxy -->
<script src="/my-plugin/static/app.js"></script>
```

Same rule in JavaScript:

```javascript
fetch('api/dags')           // correct — relative to current page
fetch('/my-plugin/api/dags') // breaks on Astro and sub-path deploys
```

---

## Step 4: Call the Airflow API from your plugin

> **Only needed if your plugin calls the Airflow REST API.** Plugins that only serve static files, register `external_views`, or use direct DB access do not need this step — skip to Step 5 or Step 6.

### Add the dependency

Only if REST API communication is being implemented: add `apache-airflow-client` to the project's dependencies. Check which file exists and act accordingly:

| File found | Action |
|------------|--------|
| `requirements.txt` | Append `apache-airflow-client` |
| `pyproject.toml` (uv / poetry) | `uv add apache-airflow-client` or `poetry add apache-airflow-client` |
| None of the above | Tell the user: "Add `apache-airflow-client` to your dependencies before running the plugin." |

Use `apache-airflow-client` to talk to Airflow's own REST API. The SDK is **synchronous** but FastAPI routes are async — never call blocking SDK methods directly inside `async def` or you will stall the event loop and freeze all concurrent requests.

### JWT token management

Cache one token per process. Refresh 5 minutes before the 1-hour expiry. Use double-checked locking so multiple concurrent requests don't all race to refresh simultaneously:

> Replace `MYPLUGIN_` with a short uppercase prefix derived from the plugin name (e.g. if the plugin is called "Trip Analyzer", use `TRIP_ANALYZER_`). If no plugin name has been given yet, ask the user before writing env var names.

```python
import asyncio
import os
import threading
import time
import airflow_client.client as airflow_sdk
import requests

AIRFLOW_HOST  = os.environ.get("MYPLUGIN_HOST",     "http://localhost:8080")
AIRFLOW_USER  = os.environ.get("MYPLUGIN_USERNAME", "admin")
AIRFLOW_PASS  = os.environ.get("MYPLUGIN_PASSWORD", "admin")
AIRFLOW_TOKEN = os.environ.get("MYPLUGIN_TOKEN")    # Astronomer Astro: Deployment API token

_cached_token: str | None = None
_token_expires_at: float  = 0.0
_token_lock = threading.Lock()


def _fetch_fresh_token() -> str:
    """Exchange username/password for a JWT via Airflow's auth endpoint."""
    response = requests.post(
        f"{AIRFLOW_HOST}/auth/token",
        json={"username": AIRFLOW_USER, "password": AIRFLOW_PASS},
        timeout=10,
    )
    response.raise_for_status()
    return response.json()["access_token"]


def _get_token() -> str:
    # Astronomer Astro production: use static Deployment API token directly
    if AIRFLOW_TOKEN:
        return AIRFLOW_TOKEN
    global _cached_token, _token_expires_at
    now = time.monotonic()
    # Fast path — no lock if still valid
    if _cached_token and now < _token_expires_at:
        return _cached_token
    # Slow path — one thread refreshes, others wait
    with _token_lock:
        if _cached_token and now < _token_expires_at:
            return _cached_token
        _cached_token = _fetch_fresh_token()
        _token_expires_at = now + 55 * 60  # refresh 5 min before 1-hour expiry
    return _cached_token


def _make_config() -> airflow_sdk.Configuration:
    config = airflow_sdk.Configuration(host=AIRFLOW_HOST)
    config.access_token = _get_token()
    return config
```

After implementing auth, tell the user:

- **Local development**: set `MYPLUGIN_USERNAME` and `MYPLUGIN_PASSWORD` in `.env` — JWT exchange happens automatically.
- **Astronomer Astro (production)**: create a Deployment API token and set it as `MYPLUGIN_TOKEN` — the JWT exchange is skipped entirely:
  1. Astro UI → open the Deployment → **Access** → **API Tokens** → **+ Deployment API Token**
  2. Copy the token value (shown only once)
  3. `astro deployment variable create MYPLUGIN_TOKEN=<token>`

  `MYPLUGIN_USERNAME` and `MYPLUGIN_PASSWORD` are not needed on Astro.

### Wrapping SDK calls with asyncio.to_thread

```python
from fastapi import HTTPException
from airflow_client.client.api import DAGApi

@app.get("/api/dags")
async def list_dags():
    try:
        def _fetch():
            with airflow_sdk.ApiClient(_make_config()) as client:
                return DAGApi(client).get_dags(limit=100).dags
        dags = await asyncio.to_thread(_fetch)
        return [{"dag_id": d.dag_id, "is_paused": d.is_paused, "timetable_summary": d.timetable_summary} for d in dags]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
```

> **API field names**: Never guess response field names — verify against the [REST API reference](https://airflow.apache.org/docs/apache-airflow/stable/stable-rest-api-ref.html). Key `DAGResponse` fields: `dag_id`, `dag_display_name`, `description`, `is_paused`, `timetable_summary`, `timetable_description`, `fileloc`, `owners`, `tags`.

The pattern is always: define a plain inner `def _fetch()` with all SDK logic, then `await asyncio.to_thread(_fetch)`.

### Alternative: Direct database access

> **Warning — use with caution and tell the user.** The Airflow metadb is not a public interface. Direct writes or poorly-formed queries can corrupt scheduler state. Whenever you use this pattern, explicitly tell the user: "This accesses Airflow's internal database directly. The internal models are not part of the public API, can change between Airflow versions, and incorrect queries can cause issues in the metadb. Prefer `apache-airflow-client` unless the operation is not exposed via the REST API."

Since FastAPI plugin endpoints run inside the **API server process** (not in a task worker), they have direct access to Airflow's internal SQLAlchemy models — no HTTP round-trip or JWT needed. Use only for read operations not exposed via the REST API, or when the extra HTTP overhead genuinely matters. Always wrap DB calls in `asyncio.to_thread()` — SQLAlchemy queries are blocking.

```python
from airflow.models import DagBag, DagModel
from airflow.utils.db import provide_session

@app.get("/api/dags/status")
async def dag_status():
    def _fetch():
        @provide_session
        def _query(session=None):
            dagbag = DagBag()
            paused = sum(
                1 for dag_id in dagbag.dags
                if (m := session.query(DagModel).filter(DagModel.dag_id == dag_id).first())
                and m.is_paused
            )
            return {"total": len(dagbag.dags), "paused": paused}
        return _query()
    return await asyncio.to_thread(_fetch)
```

---

## Step 5: Common API endpoint patterns

> **If you need an SDK method or field not shown in the examples below**, verify it before generating code — do not guess. Either run `python3 -c "from airflow_client.client.api import <Class>; print([m for m in dir(<Class>) if not m.startswith('_')])"` in any environment where the SDK is installed, or search the [`apache/airflow-client-python`](https://github.com/apache/airflow-client-python) repo for the class definition.

```python
from airflow_client.client.api import DAGApi, DagRunApi
from airflow_client.client.models import TriggerDAGRunPostBody, DAGPatchBody


@app.post("/api/dags/{dag_id}/trigger")
async def trigger_dag(dag_id: str):
    def _run():
        with airflow_sdk.ApiClient(_make_config()) as client:
            return DagRunApi(client).trigger_dag_run(dag_id, TriggerDAGRunPostBody())
    result = await asyncio.to_thread(_run)
    return {"run_id": result.dag_run_id, "state": normalize_state(result.state)}


@app.patch("/api/dags/{dag_id}/pause")
async def toggle_pause(dag_id: str, is_paused: bool):
    def _run():
        with airflow_sdk.ApiClient(_make_config()) as client:
            DAGApi(client).patch_dag(dag_id, DAGPatchBody(is_paused=is_paused))
    await asyncio.to_thread(_run)
    return {"dag_id": dag_id, "is_paused": is_paused}


@app.delete("/api/dags/{dag_id}")
async def delete_dag(dag_id: str):
    def _run():
        with airflow_sdk.ApiClient(_make_config()) as client:
            DAGApi(client).delete_dag(dag_id)
    await asyncio.to_thread(_run)
    return {"deleted": dag_id}


def normalize_state(raw) -> str:
    """Convert SDK enum objects to plain strings before sending to the frontend."""
    if raw is None:
        return "never_run"
    return str(raw).lower()
```

### DAG runs, task instances, and logs

These are the most common calls beyond basic DAG CRUD. For anything not shown here, consult the [REST API reference](https://airflow.apache.org/docs/apache-airflow/stable/stable-rest-api-ref.html) for available endpoints and the matching Python SDK class/method names.

```python
from airflow_client.client.api import DagRunApi, TaskInstanceApi

# Latest run for a DAG
@app.get("/api/dags/{dag_id}/runs/latest")
async def latest_run(dag_id: str):
    def _fetch():
        with airflow_sdk.ApiClient(_make_config()) as client:
            runs = DagRunApi(client).get_dag_runs(dag_id, limit=1, order_by="-start_date").dag_runs
            return runs[0] if runs else None
    run = await asyncio.to_thread(_fetch)
    if not run:
        return {"state": "never_run"}
    return {"run_id": run.dag_run_id, "state": normalize_state(run.state)}


# Task instances for a specific run
@app.get("/api/dags/{dag_id}/runs/{run_id}/tasks")
async def task_instances(dag_id: str, run_id: str):
    def _fetch():
        with airflow_sdk.ApiClient(_make_config()) as client:
            return TaskInstanceApi(client).get_task_instances(dag_id, run_id).task_instances
    tasks = await asyncio.to_thread(_fetch)
    return [{"task_id": t.task_id, "state": normalize_state(t.state)} for t in tasks]


# Task log (try_number starts at 1)
@app.get("/api/dags/{dag_id}/runs/{run_id}/tasks/{task_id}/logs/{try_number}")
async def task_log(dag_id: str, run_id: str, task_id: str, try_number: int):
    def _fetch():
        with airflow_sdk.ApiClient(_make_config()) as client:
            return TaskInstanceApi(client).get_log(
                dag_id, run_id, task_id, try_number, map_index=-1
            )
    result = await asyncio.to_thread(_fetch)
    return {"log": result.content if hasattr(result, "content") else str(result)}
```

### Streaming proxy

Use `StreamingResponse` to proxy binary content from an external URL through the plugin — useful when the browser can't fetch the resource directly (CORS, auth, etc.):

```python
import requests
from starlette.responses import StreamingResponse

@app.get("/api/files/{filename}")
async def proxy_file(filename: str):
    def _stream():
        r = requests.get(f"https://files.example.com/{filename}", stream=True)
        r.raise_for_status()
        return r
    response = await asyncio.to_thread(_stream)
    return StreamingResponse(
        response.iter_content(chunk_size=8192),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
```

Note that `requests.get()` is blocking — fetch in `asyncio.to_thread` so the event loop isn't stalled while waiting for the remote server.

---

## Step 6: Other plugin component types

### Macros

Macros are loaded by the **scheduler** (and DAG processor), not the API server. Restart the scheduler after changes.

```python
from airflow.plugins_manager import AirflowPlugin

def format_confidence(confidence: float) -> str:
    return f"{confidence * 100:.2f}%"

class MyPlugin(AirflowPlugin):
    name = "my_plugin"
    macros = [format_confidence]
```

Use in any templated field — including with XCom:

```
{{ macros.my_plugin.format_confidence(0.95) }}

{{ macros.my_plugin.format_confidence(ti.xcom_pull(task_ids='score_task')['confidence']) }}
```

The naming pattern is always `macros.{plugin_name}.{function_name}`.

### Middleware

Middleware applies to **all** Airflow API requests, including the built-in REST API and any FastAPI plugins. Use sparingly and filter requests explicitly if needed:

```python
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi import Request, Response

class AuditMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        # runs before every request to the Airflow API server
        response = await call_next(request)
        return response

class MyPlugin(AirflowPlugin):
    name = "my_plugin"
    fastapi_root_middlewares = [
        {"middleware": AuditMiddleware, "args": [], "kwargs": {}, "name": "Audit"}
    ]
```

### Operator extra links

```python
from airflow.sdk.bases.operatorlink import BaseOperatorLink

class MyDashboardLink(BaseOperatorLink):
    name = "Open in Dashboard"

    def get_link(self, operator, *, ti_key, **context) -> str:
        return f"https://my-dashboard.example.com/tasks/{ti_key.task_id}"

class MyPlugin(AirflowPlugin):
    name = "my_plugin"
    global_operator_extra_links = [MyDashboardLink()]  # appears on every task
    # operator_extra_links = [MyDashboardLink()]       # attach to specific operator instead
```

### React apps

React apps are embedded as JavaScript bundles served via FastAPI. The bundle must expose itself as a global variable matching the plugin name:

```javascript
// In your bundle (e.g. my-app.js)
globalThis['My Plugin'] = MyComponent;   // matches plugin name
globalThis.AirflowPlugin = MyComponent;  // fallback Airflow looks for
```

```python
class MyPlugin(AirflowPlugin):
    name = "my_plugin"
    fastapi_apps = [{"app": app, "url_prefix": "/my-plugin", "name": "My Plugin"}]
    react_apps = [
        {
            "name": "My Plugin",
            "bundle_url": "/my-plugin/my-app.js",
            "destination": "nav",
            "category": "browse",
            "url_route": "my-plugin",
        }
    ]
```

The same bundle can be registered to multiple destinations by adding multiple entries — each needs a unique `url_route`:

```python
react_apps = [
    {"name": "My Widget", "bundle_url": "/my-plugin/widget.js", "destination": "nav",  "url_route": "my-widget-nav"},
    {"name": "My Widget", "bundle_url": "/my-plugin/widget.js", "destination": "dag",  "url_route": "my-widget-dag"},
]
```

> React app integration is experimental in Airflow 3.1. Interfaces may change in future releases.

---

## Step 7: Environment variables and deployment

Never hardcode credentials:

```python
AIRFLOW_HOST = os.environ.get("MYPLUGIN_HOST",     "http://localhost:8080")
AIRFLOW_USER = os.environ.get("MYPLUGIN_USERNAME", "admin")
AIRFLOW_PASS = os.environ.get("MYPLUGIN_PASSWORD", "admin")
```

**Local Astro CLI:**
```
# .env
MYPLUGIN_HOST=http://localhost:8080
MYPLUGIN_USERNAME=admin
MYPLUGIN_PASSWORD=admin
```

```bash
astro dev restart              # required after any Python plugin change

# Check logs by component (Astro CLI):
astro dev logs --api-server    # FastAPI apps, external_views — plugin import errors show here
astro dev logs --scheduler     # macros, timetables, listeners, operator links
astro dev logs --dag-processor # DAG parsing errors

# Non-Astro:
airflow plugins                # CLI — lists all loaded plugins
```

**Production Astronomer:**
```bash
astro deployment variable create --deployment-id <id> MYPLUGIN_HOST=https://airflow.example.com
```

**Auto-reload during development** (skips lazy loading):
```
AIRFLOW__CORE__LAZY_LOAD_PLUGINS=False
```

**Cache busting for static files** after deploy:
```html
<script src="static/app.js?v=20240315-1"></script>
```

**Verify the plugin loaded**: open **Admin > Plugins** in the Airflow UI.

**OpenAPI docs** are auto-generated for FastAPI plugins:
- Swagger UI: `{AIRFLOW_HOST}/{url_prefix}/docs`
- OpenAPI JSON: `{AIRFLOW_HOST}/{url_prefix}/openapi.json`

---

## Common pitfalls

| Problem | Cause | Fix |
|---------|-------|-----|
| Nav link goes to 404 | Leading `/` in `href` | `"my-plugin/ui"` not `"/my-plugin/ui"` |
| Nav icon not showing | Missing `/` in `icon` | `icon` takes an absolute path: `"/my-plugin/static/icon.svg"` |
| Event loop freezes under load | Sync SDK called directly in `async def` | Wrap with `asyncio.to_thread()` |
| 401 errors after 1 hour | JWT expires with no refresh | Use the 5-minute pre-expiry refresh pattern |
| `StaticFiles` raises on startup | Directory missing | Create `assets/` and `static/` before starting |
| Plugin not showing up | Python file changed without restart | `astro dev restart` |
| Endpoints accessible without login | FastAPI apps are not auto-authenticated | Add FastAPI security (e.g. OAuth2, API key) if endpoints must be private |
| Middleware affecting wrong routes | Middleware applies to all API traffic | Filter by `request.url.path` inside `dispatch()` |
| JS `fetch()` breaks on Astro | Absolute path in `fetch()` | Always use relative paths: `fetch('api/dags')` |

---

## References

- [Airflow plugins documentation](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/plugins.html)
- [Airflow REST API reference](https://airflow.apache.org/docs/apache-airflow/stable/stable-rest-api-ref.html) — full endpoint list with SDK class/method names
- [Astronomer: Using Airflow plugins](https://www.astronomer.io/docs/learn/using-airflow-plugins)
