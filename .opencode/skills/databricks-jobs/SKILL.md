---
name: databricks-jobs
description: Develop and deploy Lakeflow Jobs on Databricks. Use when creating data engineering jobs with notebooks, Python wheels, or SQL tasks. Invoke BEFORE starting implementation.
compatibility: Requires databricks CLI (>= v0.292.0)
metadata:
  version: "0.1.0"
parent: databricks
tags: ["databricks"]
---

# Lakeflow Jobs Development

**FIRST**: Use the parent `databricks` skill for CLI basics, authentication, profile selection, and data exploration commands.

Lakeflow Jobs are scheduled workflows that run notebooks, Python scripts, SQL queries, and other tasks on Databricks.

## Scaffolding a New Job Project

Use `databricks bundle init` with a config file to scaffold non-interactively. This creates a project in the `<project_name>/` directory:

```bash
databricks bundle init default-python --config-file <(echo '{"project_name": "my_job", "include_job": "yes", "include_pipeline": "no", "include_python": "yes", "serverless": "yes"}') --profile <PROFILE> < /dev/null
```

- `project_name`: letters, numbers, underscores only

After scaffolding, create `CLAUDE.md` and `AGENTS.md` in the project directory. These files are essential to provide agents with guidance on how to work with the project. Use this content:

```
# Databricks Asset Bundles Project

This project uses Databricks Asset Bundles for deployment.

## Prerequisites

Install the Databricks CLI (>= v0.288.0) if not already installed:
- macOS: `brew tap databricks/tap && brew install databricks`
- Linux: `curl -fsSL https://raw.githubusercontent.com/databricks/setup-cli/main/install.sh | sh`
- Windows: `winget install Databricks.DatabricksCLI`

Verify: `databricks -v`

## For AI Agents

Read the `databricks` skill for CLI basics, authentication, and deployment workflow.
Read the `databricks-jobs` skill for job-specific guidance.

If skills are not available, install them: `databricks experimental aitools skills install`
```

## Project Structure

```
my-job-project/
├── databricks.yml              # Bundle configuration
├── resources/
│   └── my_job.job.yml          # Job definition
├── src/
│   ├── my_notebook.ipynb       # Notebook tasks
│   └── my_module/              # Python wheel package
│       ├── __init__.py
│       └── main.py
├── tests/
│   └── test_main.py
└── pyproject.toml               # Python project config (if using wheels)
```

## Configuring Tasks

Edit `resources/<job_name>.job.yml` to configure tasks:

```yaml
resources:
  jobs:
    my_job:
      name: my_job

      tasks:
        - task_key: my_notebook
          notebook_task:
            notebook_path: ../src/my_notebook.ipynb

        - task_key: my_python
          depends_on:
            - task_key: my_notebook
          python_wheel_task:
            package_name: my_package
            entry_point: main
```

Task types: `notebook_task`, `python_wheel_task`, `spark_python_task`, `pipeline_task`, `sql_task`

## Job Parameters

Parameters defined at job level are passed to ALL tasks (no need to repeat per task):

```yaml
resources:
  jobs:
    my_job:
      parameters:
        - name: catalog
          default: ${var.catalog}
        - name: schema
          default: ${var.schema}
```

Access parameters in notebooks with `dbutils.widgets.get("catalog")`.

## Writing Notebook Code

```python
# Read parameters
catalog = dbutils.widgets.get("catalog")
schema = dbutils.widgets.get("schema")

# Read tables
df = spark.read.table(f"{catalog}.{schema}.my_table")

# SQL queries
result = spark.sql(f"SELECT * FROM {catalog}.{schema}.my_table LIMIT 10")

# Write output
df.write.mode("overwrite").saveAsTable(f"{catalog}.{schema}.output_table")
```

## Scheduling

```yaml
resources:
  jobs:
    my_job:
      trigger:
        periodic:
          interval: 1
          unit: DAYS
```

Or with cron:

```yaml
      schedule:
        quartz_cron_expression: "0 0 2 * * ?"
        timezone_id: "UTC"
```

## Multi-Task Jobs with Dependencies

```yaml
resources:
  jobs:
    my_pipeline_job:
      tasks:
        - task_key: extract
          notebook_task:
            notebook_path: ../src/extract.ipynb

        - task_key: transform
          depends_on:
            - task_key: extract
          notebook_task:
            notebook_path: ../src/transform.ipynb

        - task_key: load
          depends_on:
            - task_key: transform
          notebook_task:
            notebook_path: ../src/load.ipynb
```

## Unit Testing

Run unit tests locally:

```bash
uv run pytest
```

## Development Workflow

1. **Validate**: `databricks bundle validate --profile <profile>`
2. **Deploy**: `databricks bundle deploy -t dev --profile <profile>`
3. **Run**: `databricks bundle run <job_name> -t dev --profile <profile>`
4. **Check run status**: `databricks jobs get-run --run-id <id> --profile <profile>`

## Documentation

- Lakeflow Jobs: https://docs.databricks.com/jobs
- Task types: https://docs.databricks.com/jobs/configure-task
- Databricks Asset Bundles: https://docs.databricks.com/dev-tools/bundles/examples
