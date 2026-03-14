# Optimize Cost & Performance

Automate discovery and implementation of cost and performance optimizations across Snowflake, Databricks, and BigQuery.

## Overview

Cloud data platform costs can grow quickly without active optimization. This example shows how to use altimate to automatically discover optimization opportunities, execute improvements, measure impact, and document successful patterns for reuse.

## Capabilities

### Databricks optimization

- **Cluster right-sizing** — List underutilized clusters, retrieve configurations, and create right-sized replacements
- **Job optimization** — Monitor job runs, optimize scheduling, and reduce notebook workload costs
- **Idle resource cleanup** — Identify and terminate idle clusters automatically

### Multi-platform SQL analysis

The agent works across Snowflake, BigQuery, and Databricks to:

- Run analysis queries identifying resource-intensive operations
- Rewrite queries for improved performance
- Query system tables for consumption metrics
- Test optimizations with comparative before/after analysis

## Workflow

### 1. Discover opportunities

The agent scans your warehouse for:

- Expensive queries (by credit consumption, scan volume, or execution time)
- Underutilized or over-provisioned warehouses/clusters
- Unused tables, views, and materialized views
- Inefficient SQL patterns (SELECT *, missing filters, cartesian joins)

### 2. Execute improvements

For each opportunity, the agent can:

- Rewrite SQL to reduce scan volume
- Suggest warehouse right-sizing configurations
- Flag unused resources for cleanup
- Add partition and clustering recommendations

### 3. Measure impact

After applying optimizations, the agent compares before and after metrics:

- Credit/cost reduction
- Query execution time improvement
- Data scan volume reduction

### 4. Document patterns

Successful optimization patterns are stored for reuse, building institutional knowledge that improves future optimization runs.

## Key features

| Feature | Description |
|---|---|
| **Multi-platform** | Works across Snowflake, Databricks, and BigQuery |
| **Automated discovery** | Finds optimization opportunities without manual investigation |
| **Impact measurement** | Quantifies savings from each optimization |
| **Pattern learning** | Documents successful patterns for consistent future application |

## Try it

See the full interactive walkthrough on the [Datamates documentation site](https://datamates-docs.myaltimate.com/examples/optimize-costs-and-performance/).
