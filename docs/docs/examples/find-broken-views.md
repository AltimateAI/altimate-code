# Find Broken Views in Snowflake

Create a "Sprint Work Agent" that integrates Snowflake, dbt, and Jira to find empty views, trace root causes, and file tickets — all through your IDE.

## Overview

Data warehouse views can silently break when upstream logic changes. This example shows how to build an agent that automatically discovers empty views in Snowflake, investigates the corresponding dbt models to find the root cause, and creates Jira tickets for the team.

## Workflow

### 1. List Snowflake connections

The agent starts by listing available Snowflake connections and selecting the target environment.

### 2. Query mart layer views

The agent queries a specified schema to find all views and checks which ones return zero rows.

### 3. Identify empty tables

Empty views are flagged for investigation. For example, the agent might discover that `MART_STORE_LIFETIME_VALUE` returns no data.

### 4. Review corresponding dbt models

The agent traces the empty view back to its dbt model and inspects the SQL. In this example, the root cause was a `WHERE store_id IS NULL` condition in a CTE that filtered out all records.

### 5. Create Jira tickets

For each broken view, the agent creates a Jira ticket with:

- The view name and schema
- Root cause analysis
- The specific code location causing the issue
- Suggested fix

## Example finding

```
View: MART_STORE_LIFETIME_VALUE
Status: Empty (0 rows)
Root cause: WHERE store_id IS NULL in CTE "store_orders" filters all records
Location: models/marts/mart_store_lifetime_value.sql, line 14
Fix: Change condition to WHERE store_id IS NOT NULL
```

## Key features

| Feature | Description |
|---|---|
| **Automated monitoring** | Scans all views in a schema to find empty or broken ones |
| **Root cause analysis** | Traces issues through dbt models to the specific SQL causing the problem |
| **Jira integration** | Creates well-structured tickets with root cause and suggested fixes |
| **IDE-native** | Runs directly in your development environment — no context switching |

## Try it

See the full interactive walkthrough on the [Datamates documentation site](https://datamates-docs.myaltimate.com/examples/find-broken-views-snowflake/).
