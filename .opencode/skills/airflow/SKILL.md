---
name: airflow
description: Manages Apache Airflow operations including listing, testing, running, and debugging DAGs, viewing task logs, checking connections and variables, and monitoring system health. Use when working with Airflow DAGs, pipelines, workflows, or tasks, or when the user mentions testing dags, running pipelines, debugging workflows, dag failures, task errors, dag status, pipeline status, list dags, show connections, check variables, or airflow health.
tags: ["airflow"]
---

# Airflow Operations

Use `af` commands to query, manage, and troubleshoot Airflow workflows.

## Astro CLI

The [Astro CLI](https://www.astronomer.io/docs/astro/cli/overview) is the recommended way to run Airflow locally and deploy to production. It provides a containerized Airflow environment that works out of the box:

```bash
# Initialize a new project
astro dev init

# Start local Airflow (webserver at http://localhost:8080)
astro dev start

# Parse DAGs to catch errors quickly (no need to start Airflow)
astro dev parse

# Run pytest against your DAGs
astro dev pytest

# Deploy to production
astro deploy            # Full deploy (image + DAGs)
astro deploy --dags     # DAG-only deploy (fast, no image build)
```

For more details:
- **New project?** See the **setting-up-astro-project** skill
- **Local environment?** See the **managing-astro-local-env** skill
- **Deploying?** See the **deploying-airflow** skill

---

## Running the CLI

Run all `af` commands using uvx (no installation required):

```bash
uvx --from astro-airflow-mcp af <command>
```

Throughout this document, `af` is shorthand for `uvx --from astro-airflow-mcp af`.

## Instance Configuration

Manage multiple Airflow instances with persistent configuration:

```bash
# Add a new instance
af instance add prod --url https://airflow.example.com --token "$API_TOKEN"
af instance add staging --url https://staging.example.com --username admin --password admin

# List and switch instances
af instance list      # Shows all instances in a table
af instance use prod  # Switch to prod instance
af instance current   # Show current instance
af instance delete old-instance

# Auto-discover instances (use --dry-run to preview first)
af instance discover --dry-run        # Preview all discoverable instances
af instance discover                  # Discover from all backends (astro, local)
af instance discover astro            # Discover Astro deployments only
af instance discover astro --all-workspaces  # Include all accessible workspaces
af instance discover local            # Scan common local Airflow ports
af instance discover local --scan     # Deep scan all ports 1024-65535

# IMPORTANT: Always run with --dry-run first and ask for user consent before
# running discover without it. The non-dry-run mode creates API tokens in
# Astro Cloud, which is a sensitive action that requires explicit approval.

# Override instance for a single command
af --instance staging dags list
```

Config file: `~/.af/config.yaml` (override with `--config` or `AF_CONFIG` env var)

Tokens in config can reference environment variables using `${VAR}` syntax:
```yaml
instances:
- name: prod
  url: https://airflow.example.com
  auth:
    token: ${AIRFLOW_API_TOKEN}
```

Or use environment variables directly (no config file needed):

```bash
export AIRFLOW_API_URL=http://localhost:8080
export AIRFLOW_AUTH_TOKEN=your-token-here
# Or username/password:
export AIRFLOW_USERNAME=admin
export AIRFLOW_PASSWORD=admin
```

Or CLI flags: `af --airflow-url http://localhost:8080 --token "$TOKEN" <command>`

## Quick Reference

| Command | Description |
|---------|-------------|
| `af health` | System health check |
| `af dags list` | List all DAGs |
| `af dags get <dag_id>` | Get DAG details |
| `af dags explore <dag_id>` | Full DAG investigation |
| `af dags source <dag_id>` | Get DAG source code |
| `af dags pause <dag_id>` | Pause DAG scheduling |
| `af dags unpause <dag_id>` | Resume DAG scheduling |
| `af dags errors` | List import errors |
| `af dags warnings` | List DAG warnings |
| `af dags stats` | DAG run statistics |
| `af runs list` | List DAG runs |
| `af runs get <dag_id> <run_id>` | Get run details |
| `af runs trigger <dag_id>` | Trigger a DAG run |
| `af runs trigger-wait <dag_id>` | Trigger and wait for completion |
| `af runs delete <dag_id> <run_id>` | Permanently delete a DAG run |
| `af runs clear <dag_id> <run_id>` | Clear a run for re-execution |
| `af runs diagnose <dag_id> <run_id>` | Diagnose failed run |
| `af tasks list <dag_id>` | List tasks in DAG |
| `af tasks get <dag_id> <task_id>` | Get task definition |
| `af tasks instance <dag_id> <run_id> <task_id>` | Get task instance |
| `af tasks logs <dag_id> <run_id> <task_id>` | Get task logs |
| `af config version` | Airflow version |
| `af config show` | Full configuration |
| `af config connections` | List connections |
| `af config variables` | List variables |
| `af config variable <key>` | Get specific variable |
| `af config pools` | List pools |
| `af config pool <name>` | Get pool details |
| `af config plugins` | List plugins |
| `af config providers` | List providers |
| `af config assets` | List assets/datasets |
| `af api <endpoint>` | Direct REST API access |
| `af api ls` | List available API endpoints |
| `af api ls --filter X` | List endpoints matching pattern |

## User Intent Patterns

### Getting Started
- "How do I run Airflow locally?" / "Set up Airflow" -> use the **managing-astro-local-env** skill (uses Astro CLI)
- "Create a new Airflow project" / "Initialize project" -> use the **setting-up-astro-project** skill (uses Astro CLI)
- "How do I install Airflow?" / "Get started with Airflow" -> use the **setting-up-astro-project** skill

### DAG Operations
- "What DAGs exist?" / "List all DAGs" -> `af dags list`
- "Tell me about DAG X" / "What is DAG Y?" -> `af dags explore <dag_id>`
- "What's the schedule for DAG X?" -> `af dags get <dag_id>`
- "Show me the code for DAG X" -> `af dags source <dag_id>`
- "Stop DAG X" / "Pause this workflow" -> `af dags pause <dag_id>`
- "Resume DAG X" -> `af dags unpause <dag_id>`
- "Are there any DAG errors?" -> `af dags errors`
- "Create a new DAG" / "Write a pipeline" -> use the **authoring-dags** skill

### Run Operations
- "What runs have executed?" -> `af runs list`
- "Run DAG X" / "Trigger the pipeline" -> `af runs trigger <dag_id>`
- "Run DAG X and wait" -> `af runs trigger-wait <dag_id>`
- "Why did this run fail?" -> `af runs diagnose <dag_id> <run_id>`
- "Delete this run" / "Remove stuck run" -> `af runs delete <dag_id> <run_id>`
- "Clear this run" / "Retry this run" / "Re-run this" -> `af runs clear <dag_id> <run_id>`
- "Test this DAG and fix if it fails" -> use the **testing-dags** skill

### Task Operations
- "What tasks are in DAG X?" -> `af tasks list <dag_id>`
- "Get task logs" / "Why did task fail?" -> `af tasks logs <dag_id> <run_id> <task_id>`
- "Full root cause analysis" / "Diagnose and fix" -> use the **debugging-dags** skill

### Data Operations
- "Is the data fresh?" / "When was this table last updated?" -> use the **checking-freshness** skill
- "Where does this data come from?" -> use the **tracing-upstream-lineage** skill
- "What depends on this table?" / "What breaks if I change this?" -> use the **tracing-downstream-lineage** skill

### Deployment Operations
- "Deploy my DAGs" / "Push to production" -> use the **deploying-airflow** skill
- "Set up CI/CD" / "Automate deploys" -> use the **deploying-airflow** skill
- "Deploy to Kubernetes" / "Set up Helm" -> use the **deploying-airflow** skill
- "astro deploy" / "DAG-only deploy" -> use the **deploying-airflow** skill

### System Operations
- "What version of Airflow?" -> `af config version`
- "What connections exist?" -> `af config connections`
- "Are pools full?" -> `af config pools`
- "Is Airflow healthy?" -> `af health`

### API Exploration
- "What API endpoints are available?" -> `af api ls`
- "Find variable endpoints" -> `af api ls --filter variable`
- "Access XCom values" / "Get XCom" -> `af api xcom-entries -F dag_id=X -F task_id=Y`
- "Get event logs" / "Audit trail" -> `af api event-logs -F dag_id=X`
- "Create connection via API" -> `af api connections -X POST --body '{...}'`
- "Create variable via API" -> `af api variables -X POST -F key=name -f value=val`

## Common Workflows

### Validate DAGs Before Deploying

If you're using the Astro CLI, you can validate DAGs without a running Airflow instance:

```bash
# Parse DAGs to catch import errors and syntax issues
astro dev parse

# Run unit tests
astro dev pytest
```

Otherwise, validate against a running instance:

```bash
af dags errors     # Check for parse/import errors
af dags warnings   # Check for deprecation warnings
```

### Investigate a Failed Run

```bash
# 1. List recent runs to find failure
af runs list --dag-id my_dag

# 2. Diagnose the specific run
af runs diagnose my_dag manual__2024-01-15T10:00:00+00:00

# 3. Get logs for failed task (from diagnose output)
af tasks logs my_dag manual__2024-01-15T10:00:00+00:00 extract_data

# 4. After fixing, clear the run to retry all tasks
af runs clear my_dag manual__2024-01-15T10:00:00+00:00
```

### Morning Health Check

```bash
# 1. Overall system health
af health

# 2. Check for broken DAGs
af dags errors

# 3. Check pool utilization
af config pools
```

### Understand a DAG

```bash
# Get comprehensive overview (metadata + tasks + source)
af dags explore my_dag
```

### Check Why DAG Isn't Running

```bash
# Check if paused
af dags get my_dag

# Check for import errors
af dags errors

# Check recent runs
af runs list --dag-id my_dag
```

### Trigger and Monitor

```bash
# Option 1: Trigger and wait (blocking)
af runs trigger-wait my_dag --timeout 1800

# Option 2: Trigger and check later
af runs trigger my_dag
af runs get my_dag <run_id>
```

## Output Format

All commands output JSON (except `instance` commands which use human-readable tables):

```bash
af dags list
# {
#   "total_dags": 5,
#   "returned_count": 5,
#   "dags": [...]
# }
```

Use `jq` for filtering:

```bash
# Find failed runs
af runs list | jq '.dag_runs[] | select(.state == "failed")'

# Get DAG IDs only
af dags list | jq '.dags[].dag_id'

# Find paused DAGs
af dags list | jq '[.dags[] | select(.is_paused == true)]'
```

## Task Logs Options

```bash
# Get logs for specific retry attempt
af tasks logs my_dag run_id task_id --try 2

# Get logs for mapped task index
af tasks logs my_dag run_id task_id --map-index 5
```

## Direct API Access with `af api`

Use `af api` for endpoints not covered by high-level commands (XCom, event-logs, backfills, etc).

```bash
# Discover available endpoints
af api ls
af api ls --filter variable

# Basic usage
af api dags
af api dags -F limit=10 -F only_active=true
af api variables -X POST -F key=my_var -f value="my value"
af api variables/old_var -X DELETE
```

**Field syntax**: `-F key=value` auto-converts types, `-f key=value` keeps as string.

**Full reference**: See [api-reference.md](api-reference.md) for all options, common endpoints (XCom, event-logs, backfills), and examples.

## Related Skills

| Skill | Use when... |
|-------|-------------|
| **authoring-dags** | Creating or editing DAG files with best practices |
| **testing-dags** | Iterative test -> debug -> fix -> retest cycles |
| **debugging-dags** | Deep root cause analysis and failure diagnosis |
| **checking-freshness** | Checking if data is up to date or stale |
| **tracing-upstream-lineage** | Finding where data comes from |
| **tracing-downstream-lineage** | Impact analysis -- what breaks if something changes |
| **deploying-airflow** | Deploying DAGs to production (Astro, Docker Compose, Kubernetes) |
| **migrating-airflow-2-to-3** | Upgrading DAGs from Airflow 2.x to 3.x |
| **managing-astro-local-env** | Starting, stopping, or troubleshooting local Airflow |
| **setting-up-astro-project** | Initializing a new Astro/Airflow project |
