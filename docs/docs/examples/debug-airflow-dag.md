# Debug an Airflow DAG

Use AI to debug Airflow DAGs by combining platform integrations, best-practice templates, and automated fix suggestions.

## Overview

Debugging Airflow DAGs often requires switching between the Airflow UI, code editor, logs, and documentation. This example shows how to create an "Airflow tester" datamate that brings all of this context together in your IDE and automatically identifies and fixes DAG issues.

## Workflow

### 1. Create a datamate

Configure an "Airflow tester" datamate with integrations for:

- **Memory** — Persists learnings across sessions
- **Airflow** — Connects to your Airflow instance
- **GitHub** — Access to DAG source code
- **Databricks** — For data platform context
- **Jira** — For ticket creation and tracking

### 2. Add context from the Knowledge Hub

Load best-practice templates like an "Airflow Cookbook" into the Knowledge Hub. Customize these templates to match your company's specific patterns and conventions.

### 3. Identify the issue

Point the agent at a failing DAG. For example, an `asset1_producer` DAG with failed runs. The agent:

- Pulls recent run logs from Airflow
- Identifies the error (e.g., `ZeroDivisionError` from `error_count` being 0 in a success rate calculation)
- Traces the error to the specific task and code location

### 4. Apply fixes

The agent recommends and applies fixes including:

- Proper error handling for edge cases
- Input validation for numerical operations
- Structured logging for better observability
- Exception handling with meaningful error messages

### 5. Verify the fix

After applying fixes, the agent triggers a new DAG run and confirms it completes successfully.

### 6. Save learnings

The Memory Hub preserves the debugging pattern so the same type of issue is handled consistently across all datamates in your team.

## Example fix

**Before:**
```python
success_rate = successful_count / total_count * 100
```

**After:**
```python
if total_count > 0:
    success_rate = successful_count / total_count * 100
else:
    success_rate = 0.0
    logger.warning("Total count is zero, setting success rate to 0")
```

## Key features

| Feature | Description |
|---|---|
| **Multi-platform context** | Combines Airflow logs, source code, and data platform context |
| **Knowledge Hub** | Applies your team's best practices to fix suggestions |
| **Memory** | Remembers debugging patterns for consistent future troubleshooting |
| **IDE-native** | No context switching — debug directly in your editor |

## Try it

See the full interactive walkthrough on the [Datamates documentation site](https://datamates-docs.myaltimate.com/examples/debug-airflow-dag/).
