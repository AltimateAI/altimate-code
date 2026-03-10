# af api Reference

Direct REST API access for Airflow endpoints not covered by high-level commands.

## Endpoint Discovery

```bash
# List all available endpoints
af api ls

# Filter endpoints by pattern
af api ls --filter variable
af api ls --filter xcom

# Get full OpenAPI spec (for detailed method/parameter info)
af api spec

# Get details for specific endpoint
af api spec | jq '.paths["/api/v2/variables"]'
```

## HTTP Methods

```bash
# GET (default) - retrieve resources
af api dags
af api dags/my_dag
af api dags -F limit=10 -F only_active=true

# POST - create resources
af api variables -X POST -F key=my_var -f value="my value"

# PATCH - update resources
af api dags/my_dag -X PATCH -F is_paused=false

# DELETE - remove resources
af api variables/old_var -X DELETE
```

## Field Syntax

| Flag | Behavior | Use When |
|------|----------|----------|
| `-F key=value` | Auto-converts: `true`/`false` → bool, numbers → int/float, `null` → null | Most cases |
| `-f key=value` | Keeps value as raw string | Values that look like numbers but should be strings |
| `--body '{}'` | Raw JSON body | Complex nested objects |
| `-F key=@file` | Read value from file | Large values, configs |

```bash
# Type conversion examples
af api dags -F limit=10 -F only_active=true
# Sends: params limit=10 (int), only_active=true (bool)

# Raw string (no conversion)
af api variables -X POST -F key=port -f value=8080
# Sends: {"key": "port", "value": "8080"} (string, not int)
```

## Common Endpoints

### XCom Values
```bash
af api xcom-entries -F dag_id=my_dag -F dag_run_id=manual__2024-01-15 -F task_id=my_task
```

### Event Logs / Audit Trail
```bash
af api event-logs -F dag_id=my_dag -F limit=50
af api event-logs -F event=trigger
```

### Backfills (Airflow 2.10+)
```bash
# Create backfill
af api backfills -X POST --body '{
  "dag_id": "my_dag",
  "from_date": "2024-01-01T00:00:00Z",
  "to_date": "2024-01-31T00:00:00Z"
}'

# List backfills
af api backfills -F dag_id=my_dag
```

### Task Instances for a Run
```bash
af api dags/my_dag/dagRuns/manual__2024-01-15/taskInstances
```

### Connections (passwords exposed)
```bash
# Warning: Use 'af config connections' for filtered output
af api connections
af api connections/my_conn
```

## Debugging

```bash
# Include HTTP status and headers
af api dags -i

# Access non-versioned endpoints
af api health --raw
```

## When to Use af api

| Task | Use |
|------|-----|
| List/get DAGs, runs, tasks | `af dags`, `af runs`, `af tasks` |
| Trigger and monitor runs | `af runs trigger-wait` |
| Delete or clear runs | `af runs delete`, `af runs clear` |
| Diagnose failures | `af runs diagnose` |
| XCom, event logs, backfills | `af api` |
| Create/update variables, connections | `af api` |
| Any endpoint not in high-level CLI | `af api` |
