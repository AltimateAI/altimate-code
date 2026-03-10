---
name: troubleshooting-astro-deployments
description: Troubleshoot Astronomer production deployments with Astro CLI. Use when investigating deployment issues, viewing production logs, analyzing failures, or managing deployment environment variables.
tags: ["airflow", "astronomer"]
---

# Astro Deployment Troubleshooting

This skill helps you diagnose and troubleshoot production Astronomer deployments using the Astro CLI.

> **For deployment management**, see the **managing-astro-deployments** skill.
> **For local development**, see the **managing-astro-local-env** skill.

---

## Quick Health Check

Start with these commands to get an overview:

```bash
# 1. List deployments to find target
astro deployment list

# 2. Get deployment overview
astro deployment inspect <DEPLOYMENT_ID>

# 3. Check for errors
astro deployment logs <DEPLOYMENT_ID> --error -c 50
```

---

## Viewing Deployment Logs

Use `-c` to control log count (default: 500). Log flags cannot be combined — use one component or level flag per command.

### Component-Specific Logs

View logs from specific Airflow components:

```bash
# Scheduler logs (DAG processing, task scheduling)
astro deployment logs <DEPLOYMENT_ID> --scheduler -c 50

# Worker logs (task execution)
astro deployment logs <DEPLOYMENT_ID> --workers -c 30

# Webserver logs (UI access, health checks)
astro deployment logs <DEPLOYMENT_ID> --webserver -c 30

# Triggerer logs (deferrable operators)
astro deployment logs <DEPLOYMENT_ID> --triggerer -c 30
```

### Log Level Filtering

Filter by severity:

```bash
# Error logs only (most useful for troubleshooting)
astro deployment logs <DEPLOYMENT_ID> --error -c 30

# Warning logs
astro deployment logs <DEPLOYMENT_ID> --warn -c 50

# Info-level logs
astro deployment logs <DEPLOYMENT_ID> --info -c 50
```

### Search Logs

Search for specific keywords:

```bash
# Search for specific error
astro deployment logs <DEPLOYMENT_ID> --keyword "ConnectionError"

# Search for specific DAG
astro deployment logs <DEPLOYMENT_ID> --keyword "my_dag_name" -c 100

# Find import errors
astro deployment logs <DEPLOYMENT_ID> --error --keyword "ImportError"

# Find task failures
astro deployment logs <DEPLOYMENT_ID> --error --keyword "Task failed"
```

---

## Complete Investigation Workflow

### Step 1: Identify the Problem

```bash
# List deployments with status
astro deployment list

# Get deployment details
astro deployment inspect <DEPLOYMENT_ID>
```

Look for:
- Status: HEALTHY vs UNHEALTHY
- Runtime version compatibility
- Resource limits (CPU, memory)
- Recent deployment timestamp

### Step 2: Check Error Logs

```bash
# Start with errors
astro deployment logs <DEPLOYMENT_ID> --error -c 50
```

Look for:
- Recurring error patterns
- Specific DAGs failing repeatedly
- Import errors or syntax errors
- Connection or credential errors

### Step 3: Review Scheduler Logs

```bash
# Check DAG processing
astro deployment logs <DEPLOYMENT_ID> --scheduler -c 30
```

Look for:
- DAG parse errors
- Scheduling delays
- Task queueing issues

### Step 4: Check Worker Logs

```bash
# Check task execution
astro deployment logs <DEPLOYMENT_ID> --workers -c 30
```

Look for:
- Task execution failures
- Resource exhaustion
- Timeout errors

### Step 5: Verify Configuration

```bash
# Check environment variables
astro deployment variable list --deployment-id <DEPLOYMENT_ID>

# Verify deployment settings
astro deployment inspect <DEPLOYMENT_ID>
```

Look for:
- Missing or incorrect environment variables
- Secrets configuration (AIRFLOW__SECRETS__BACKEND)
- Connection configuration

---

## Common Investigation Patterns

### Recurring DAG Failures

Follow the complete investigation workflow above, then narrow to the specific DAG:

```bash
astro deployment logs <DEPLOYMENT_ID> --keyword "my_dag_name" -c 100
```

### Resource Issues

```bash
# 1. Check deployment resource allocation
astro deployment inspect <DEPLOYMENT_ID>
# Look for: resource_quota_cpu, resource_quota_memory
# Worker queue: max_worker_count, worker_type

# 2. Check for worker scaling issues
astro deployment logs <DEPLOYMENT_ID> --workers -c 50

# 3. Look for out-of-memory errors
astro deployment logs <DEPLOYMENT_ID> --error --keyword "memory"
```

### Configuration Problems

```bash
# 1. Review environment variables
astro deployment variable list --deployment-id <DEPLOYMENT_ID>

# 2. Check for secrets backend configuration
# Look for: AIRFLOW__SECRETS__BACKEND, AIRFLOW__SECRETS__BACKEND_KWARGS

# 3. Verify deployment settings
astro deployment inspect <DEPLOYMENT_ID>

# 4. Check webserver logs for auth issues
astro deployment logs <DEPLOYMENT_ID> --webserver -c 30
```

### Import Errors

```bash
# 1. Find import errors
astro deployment logs <DEPLOYMENT_ID> --error --keyword "ImportError"

# 2. Check scheduler for parse failures
astro deployment logs <DEPLOYMENT_ID> --scheduler --keyword "Failed to import" -c 50

# 3. Verify dependencies were deployed
astro deployment inspect <DEPLOYMENT_ID>
# Check: current_tag, last deployment timestamp
```

---

## Environment Variables Management

### List Variables

```bash
# List all variables for deployment
astro deployment variable list --deployment-id <DEPLOYMENT_ID>

# Find specific variable
astro deployment variable list --deployment-id <DEPLOYMENT_ID> --key AWS_REGION

# Export variables to file
astro deployment variable list --deployment-id <DEPLOYMENT_ID> --save --env .env.backup
```

### Create Variables

```bash
# Create regular variable
astro deployment variable create --deployment-id <DEPLOYMENT_ID> \
  --key API_ENDPOINT \
  --value https://api.example.com

# Create secret (masked in UI and logs)
astro deployment variable create --deployment-id <DEPLOYMENT_ID> \
  --key API_KEY \
  --value secret123 \
  --secret
```

### Update Variables

```bash
# Update existing variable
astro deployment variable update --deployment-id <DEPLOYMENT_ID> \
  --key API_KEY \
  --value newsecret
```

### Delete Variables

```bash
# Delete variable
astro deployment variable delete --deployment-id <DEPLOYMENT_ID> --key OLD_KEY
```

**Note**: Variables are available to DAGs as environment variables. Changes require no redeployment.

---

## Key Metrics from `deployment inspect`

Focus on these fields when troubleshooting:

- **status**: HEALTHY vs UNHEALTHY
- **runtime_version**: Airflow version compatibility
- **scheduler_size/scheduler_count**: Scheduler capacity
- **executor**: CELERY, KUBERNETES, or LOCAL
- **worker_queues**: Worker scaling limits and types
  - `min_worker_count`, `max_worker_count`
  - `worker_concurrency`
  - `worker_type` (resource class)
- **resource_quota_cpu/memory**: Overall resource limits
- **dag_deploy_enabled**: Whether DAG-only deploys work
- **current_tag**: Last deployment version
- **is_high_availability**: Redundancy enabled

---

## Investigation Best Practices

1. **Always start with error logs** - Most obvious failures appear here
2. **Check error logs for patterns** - Same DAG failing repeatedly? Timing patterns?
3. **Component-specific troubleshooting**:
   - Worker logs → task execution details
   - Scheduler logs → DAG processing and scheduling
   - Webserver logs → UI issues and health checks
   - Triggerer logs → deferrable operator issues
4. **Use `--keyword` for targeted searches** - More efficient than reading all logs
5. **The `inspect` command is your health dashboard** - Check it first
6. **Environment variables in `inspect` output** - May reveal configuration issues
7. **Log count default is 500** - Adjust with `-c` based on needs
8. **Don't forget to check deployment time** - Recent deploy might have introduced issue

---

## Troubleshooting Quick Reference

| Symptom | Command |
|---------|---------|
| Deployment shows UNHEALTHY | `astro deployment inspect <ID>` + `--error` logs |
| DAG not appearing | `--error` logs for import errors, check `--scheduler` logs |
| Tasks failing | `--workers` logs + search for DAG with `--keyword` |
| Slow scheduling | `--scheduler` logs + check `inspect` for scheduler resources |
| UI not responding | `--webserver` logs |
| Connection issues | Check variables, search logs for connection name |
| Import errors | `--error --keyword "ImportError"` + `--scheduler` logs |
| Out of memory | `inspect` for resources + `--workers --keyword "memory"` |

---

## Related Skills

- **managing-astro-deployments**: Create, update, delete deployments, deploy code
- **managing-astro-local-env**: Manage local Airflow development environment
- **setting-up-astro-project**: Initialize and configure Astro projects
