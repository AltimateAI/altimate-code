---
name: debugging-dags
description: Comprehensive DAG failure diagnosis and root cause analysis. Use for complex debugging requests requiring deep investigation like "diagnose and fix the pipeline", "full root cause analysis", "why is this failing and how to prevent it". For simple debugging ("why did dag fail", "show logs"), the airflow entrypoint skill handles it directly. This skill provides structured investigation and prevention recommendations.
tags: ["airflow"]
---

# DAG Diagnosis

You are a data engineer debugging a failed Airflow DAG. Follow this systematic approach to identify the root cause and provide actionable remediation.

## Running the CLI

Run all `af` commands using uvx (no installation required):

```bash
uvx --from astro-airflow-mcp af <command>
```

Throughout this document, `af` is shorthand for `uvx --from astro-airflow-mcp af`.

---

## Step 1: Identify the Failure

If a specific DAG was mentioned:
- Run `af runs diagnose <dag_id> <dag_run_id>` (if run_id is provided)
- If no run_id specified, run `af dags stats` to find recent failures

If no DAG was specified:
- Run `af health` to find recent failures across all DAGs
- Check for import errors with `af dags errors`
- Show DAGs with recent failures
- Ask which DAG to investigate further

## Step 2: Get the Error Details

Once you have identified a failed task:

1. **Get task logs** using `af tasks logs <dag_id> <dag_run_id> <task_id>`
2. **Look for the actual exception** - scroll past the Airflow boilerplate to find the real error
3. **Categorize the failure type**:
   - **Data issue**: Missing data, schema change, null values, constraint violation
   - **Code issue**: Bug, syntax error, import failure, type error
   - **Infrastructure issue**: Connection timeout, resource exhaustion, permission denied
   - **Dependency issue**: Upstream failure, external API down, rate limiting

## Step 3: Check Context

Gather additional context to understand WHY this happened:

1. **Recent changes**: Was there a code deploy? Check git history if available
2. **Data volume**: Did data volume spike? Run a quick count on source tables
3. **Upstream health**: Did upstream tasks succeed but produce unexpected data?
4. **Historical pattern**: Is this a recurring failure? Check if same task failed before
5. **Timing**: Did this fail at an unusual time? (resource contention, maintenance windows)

Use `af runs get <dag_id> <dag_run_id>` to compare the failed run against recent successful runs.

### On Astro

If you're running on Astro, these additional tools can help with diagnosis:

- **Deployment activity log**: Check the Astro UI for recent deploys — a failed deploy or recent code change is often the cause of sudden failures
- **Astro alerts**: Configure alerts in the Astro UI for proactive failure monitoring (DAG failure, task duration, SLA miss)
- **Observability**: Use the Astro [observability dashboard](https://www.astronomer.io/docs/astro/airflow-alerts) to track DAG health trends and spot recurring issues

### On OSS Airflow

- **Airflow UI**: Use the DAGs page, Graph view, and task logs to inspect recent runs and failures

## Step 4: Provide Actionable Output

Structure your diagnosis as:

### Root Cause
What actually broke? Be specific - not "the task failed" but "the task failed because column X was null in 15% of rows when the code expected 0%".

### Impact Assessment
- What data is affected? Which tables didn't get updated?
- What downstream processes are blocked?
- Is this blocking production dashboards or reports?

### Immediate Fix
Specific steps to resolve RIGHT NOW:
1. If it's a data issue: SQL to fix or skip bad records
2. If it's a code issue: The exact code change needed
3. If it's infra: Who to contact or what to restart

### Prevention
How to prevent this from happening again:
- Add data quality checks?
- Add better error handling?
- Add alerting for edge cases?
- Update documentation?

### Quick Commands
Provide ready-to-use commands:
- To clear and rerun the entire DAG run: `af runs clear <dag_id> <run_id>`
- To clear and rerun specific failed tasks: `af tasks clear <dag_id> <run_id> <task_ids> -D`
- To delete a stuck or unwanted run: `af runs delete <dag_id> <run_id>`
