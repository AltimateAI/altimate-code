---
name: testing-dags
description: Complex DAG testing workflows with debugging and fixing cycles. Use for multi-step testing requests like "test this dag and fix it if it fails", "test and debug", "run the pipeline and troubleshoot issues". For simple test requests ("test dag", "run dag"), the airflow entrypoint skill handles it directly. This skill is for iterative test-debug-fix cycles.
tags: ["airflow"]
---

# DAG Testing Skill

Use `af` commands to test, debug, and fix DAGs in iterative cycles.

## Running the CLI

Run all `af` commands using uvx (no installation required):

```bash
uvx --from astro-airflow-mcp af <command>
```

Throughout this document, `af` is shorthand for `uvx --from astro-airflow-mcp af`.

---

## Quick Validation with Astro CLI

If the user has the Astro CLI available, these commands provide fast feedback without needing a running Airflow instance:

```bash
# Parse DAGs to catch import errors, syntax issues, and DAG-level problems
astro dev parse

# Run pytest against DAGs (runs tests in tests/ directory)
astro dev pytest
```

Use these for quick validation during development. For full end-to-end testing against a live Airflow instance, continue to the trigger-and-wait workflow below.

---

## FIRST ACTION: Just Trigger the DAG

When the user asks to test a DAG, your **FIRST AND ONLY action** should be:

```bash
af runs trigger-wait <dag_id>
```

**DO NOT:**
- Call `af dags list` first
- Call `af dags get` first
- Call `af dags errors` first
- Use `grep` or `ls` or any other bash command
- Do any "pre-flight checks"

**Just trigger the DAG.** If it fails, THEN debug.

---

## Testing Workflow Overview

```
┌─────────────────────────────────────┐
│ 1. TRIGGER AND WAIT                 │
│    Run DAG, wait for completion     │
└─────────────────────────────────────┘
                 ↓
        ┌───────┴───────┐
        ↓               ↓
   ┌─────────┐    ┌──────────┐
   │ SUCCESS │    │ FAILED   │
   │ Done!   │    │ Debug... │
   └─────────┘    └──────────┘
                       ↓
        ┌─────────────────────────────────────┐
        │ 2. DEBUG (only if failed)           │
        │    Get logs, identify root cause    │
        └─────────────────────────────────────┘
                       ↓
        ┌─────────────────────────────────────┐
        │ 3. FIX AND RETEST                   │
        │    Apply fix, restart from step 1   │
        └─────────────────────────────────────┘
```

**Philosophy: Try first, debug on failure.** Don't waste time on pre-flight checks — just run the DAG and diagnose if something goes wrong.

---

## Phase 1: Trigger and Wait

Use `af runs trigger-wait` to test the DAG:

### Primary Method: Trigger and Wait

```bash
af runs trigger-wait <dag_id> --timeout 300
```

**Example:**

```bash
af runs trigger-wait my_dag --timeout 300
```

**Why this is the preferred method:**
- Single command handles trigger + monitoring
- Returns immediately when DAG completes (success or failure)
- Includes failed task details if run fails
- No manual polling required

### Response Interpretation

**Success:**
```json
{
  "dag_run": {
    "dag_id": "my_dag",
    "dag_run_id": "manual__2025-01-14T...",
    "state": "success",
    "start_date": "...",
    "end_date": "..."
  },
  "timed_out": false,
  "elapsed_seconds": 45.2
}
```

**Failure:**
```json
{
  "dag_run": {
    "state": "failed"
  },
  "timed_out": false,
  "elapsed_seconds": 30.1,
  "failed_tasks": [
    {
      "task_id": "extract_data",
      "state": "failed",
      "try_number": 2
    }
  ]
}
```

**Timeout:**
```json
{
  "dag_id": "my_dag",
  "dag_run_id": "manual__...",
  "state": "running",
  "timed_out": true,
  "elapsed_seconds": 300.0,
  "message": "Timed out after 300 seconds. DAG run is still running."
}
```

### Alternative: Trigger and Monitor Separately

Use this only when you need more control:

```bash
# Step 1: Trigger
af runs trigger my_dag
# Returns: {"dag_run_id": "manual__...", "state": "queued"}

# Step 2: Check status
af runs get my_dag manual__2025-01-14T...
# Returns current state
```

---

## Handling Results

### If Success

The DAG ran successfully. Summarize for the user:
- Total elapsed time
- Number of tasks completed
- Any notable outputs (if visible in logs)

**You're done!**

### If Timed Out

The DAG is still running. Options:
1. Check current status: `af runs get <dag_id> <dag_run_id>`
2. Ask user if they want to continue waiting
3. Increase timeout and try again

### If Failed

Move to Phase 2 (Debug) to identify the root cause.

---

## Phase 2: Debug Failures (Only If Needed)

When a DAG run fails, use these commands to diagnose:

### Get Comprehensive Diagnosis

```bash
af runs diagnose <dag_id> <dag_run_id>
```

Returns in one call:
- Run metadata (state, timing)
- All task instances with states
- Summary of failed tasks
- State counts (success, failed, skipped, etc.)

### Get Task Logs

```bash
af tasks logs <dag_id> <dag_run_id> <task_id>
```

**Example:**

```bash
af tasks logs my_dag manual__2025-01-14T... extract_data
```

**For specific retry attempt:**

```bash
af tasks logs my_dag manual__2025-01-14T... extract_data --try 2
```

**Look for:**
- Exception messages and stack traces
- Connection errors (database, API, S3)
- Permission errors
- Timeout errors
- Missing dependencies

### Check Upstream Tasks

If a task shows `upstream_failed`, the root cause is in an upstream task. Use `af runs diagnose` to find which task actually failed.

### Check Import Errors (If DAG Didn't Run)

If the trigger failed because the DAG doesn't exist:

```bash
af dags errors
```

This reveals syntax errors or missing dependencies that prevented the DAG from loading.

---

## Phase 3: Fix and Retest

Once you identify the issue:

### Common Fixes

| Issue | Fix |
|-------|-----|
| Missing import | Add to DAG file |
| Missing package | Add to `requirements.txt` |
| Connection error | Check `af config connections`, verify credentials |
| Variable missing | Check `af config variables`, create if needed |
| Timeout | Increase task timeout or optimize query |
| Permission error | Check credentials in connection |

### After Fixing

1. Save the file
2. **Retest:** `af runs trigger-wait <dag_id>`

**Repeat the test → debug → fix loop until the DAG succeeds.**

---

## CLI Quick Reference

| Phase | Command | Purpose |
|-------|---------|---------|
| Test | `af runs trigger-wait <dag_id>` | **Primary test method — start here** |
| Test | `af runs trigger <dag_id>` | Start run (alternative) |
| Test | `af runs get <dag_id> <run_id>` | Check run status |
| Debug | `af runs diagnose <dag_id> <run_id>` | Comprehensive failure diagnosis |
| Debug | `af tasks logs <dag_id> <run_id> <task_id>` | Get task output/errors |
| Debug | `af dags errors` | Check for parse errors (if DAG won't load) |
| Debug | `af dags get <dag_id>` | Verify DAG config |
| Debug | `af dags explore <dag_id>` | Full DAG inspection |
| Config | `af config connections` | List connections |
| Config | `af config variables` | List variables |

---

## Testing Scenarios

### Scenario 1: Test a DAG (Happy Path)

```bash
af runs trigger-wait my_dag
# Success! Done.
```

### Scenario 2: Test a DAG (With Failure)

```bash
# 1. Run and wait
af runs trigger-wait my_dag
# Failed...

# 2. Find failed tasks
af runs diagnose my_dag manual__2025-01-14T...

# 3. Get error details
af tasks logs my_dag manual__2025-01-14T... extract_data

# 4. [Fix the issue in DAG code]

# 5. Retest
af runs trigger-wait my_dag
```

### Scenario 3: DAG Doesn't Exist / Won't Load

```bash
# 1. Trigger fails - DAG not found
af runs trigger-wait my_dag
# Error: DAG not found

# 2. Find parse error
af dags errors

# 3. [Fix the issue in DAG code]

# 4. Retest
af runs trigger-wait my_dag
```

### Scenario 4: Debug a Failed Scheduled Run

```bash
# 1. Get failure summary
af runs diagnose my_dag scheduled__2025-01-14T...

# 2. Get error from failed task
af tasks logs my_dag scheduled__2025-01-14T... failed_task_id

# 3. [Fix the issue]

# 4. Retest
af runs trigger-wait my_dag
```

### Scenario 5: Test with Custom Configuration

```bash
af runs trigger-wait my_dag --conf '{"env": "staging", "batch_size": 100}' --timeout 600
```

### Scenario 6: Long-Running DAG

```bash
# Wait up to 1 hour
af runs trigger-wait my_dag --timeout 3600

# If timed out, check current state
af runs get my_dag manual__2025-01-14T...
```

---

## Debugging Tips

### Common Error Patterns

**Connection Refused / Timeout:**
- Check `af config connections` for correct host/port
- Verify network connectivity to external system
- Check if connection credentials are correct

**ModuleNotFoundError:**
- Package missing from `requirements.txt`
- After adding, may need environment restart

**PermissionError:**
- Check IAM roles, database grants, API keys
- Verify connection has correct credentials

**Task Timeout:**
- Query or operation taking too long
- Consider adding timeout parameter to task
- Optimize underlying query/operation

### Reading Task Logs

Task logs typically show:
1. Task start timestamp
2. Any print/log statements from task code
3. Return value (for @task decorated functions)
4. Exception + full stack trace (if failed)
5. Task end timestamp and duration

**Focus on the exception at the bottom of failed task logs.**

### On Astro

Astro deployments support environment promotion, which helps structure your testing workflow:

- **Dev deployment**: Test DAGs freely with `astro deploy --dags` for fast iteration
- **Staging deployment**: Run integration tests against production-like data
- **Production deployment**: Deploy only after validation in lower environments
- Use separate Astro deployments for each environment and promote code through them

---

## Related Skills

- **authoring-dags**: For creating new DAGs (includes validation before testing)
- **debugging-dags**: For general Airflow troubleshooting
- **deploying-airflow**: For deploying DAGs to production after testing
