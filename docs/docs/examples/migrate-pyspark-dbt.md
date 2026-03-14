# Migrate PySpark to dbt

Convert a PySpark-based e-commerce reporting project in Databricks to dbt with automated code conversion, testing, and validation.

## Overview

Migrating from PySpark to dbt can unlock faster batch processing and improved data governance, but the manual effort is significant. This example shows how altimate automates the investigation, planning, code conversion, testing, and documentation of a PySpark-to-dbt migration.

## Workflow

### 1. Set up the Knowledge Hub

Select a datamate and load the Knowledge Hub with migration-specific guidance (e.g., a "PySpark dbt Migration" guide). The Knowledge Hub provides verified context that reduces AI hallucinations during code conversion.

### 2. Gather project context

The agent confirms its role and gathers information about the existing PySpark project:

- Transformation modules and business logic
- Spark session configuration
- Data sources and sinks
- Existing tests and validation

### 3. Analyze the PySpark codebase

The agent examines the project structure, including:

- Transformation functions and their dependencies
- DataFrame operations and their SQL equivalents
- Configuration files (e.g., `profiles.yml`)
- Business logic that needs to be preserved

### 4. Convert to dbt models

For each PySpark transformation, the agent creates an equivalent dbt model:

- DataFrame operations become SQL CTEs and transformations
- Spark UDFs become SQL functions or dbt macros
- Pipeline dependencies become `ref()` and `source()` calls
- Configuration becomes `dbt_project.yml` settings

### 5. Review and test

The agent presents changes for review. You can edit and accept each conversion before the agent:

- Runs `dbt build` to compile and execute the models
- Validates output data matches the original PySpark results
- Generates tests for the new models

## Key features

| Feature | Description |
|---|---|
| **Knowledge Hub** | Provides migration-specific guidance to improve conversion accuracy |
| **Codebase analysis** | Understands PySpark patterns and their dbt equivalents |
| **Interactive review** | Lets you review and edit each conversion before applying |
| **Validation** | Compares output data between PySpark and dbt to ensure correctness |

## Try it

See the full interactive walkthrough on the [Datamates documentation site](https://datamates-docs.myaltimate.com/examples/migrate-pyspark-dbt/).
