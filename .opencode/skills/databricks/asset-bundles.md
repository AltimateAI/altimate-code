# Databricks Asset Bundles (DABs)

Databricks Asset Bundles provide Infrastructure-as-Code for Databricks resources, enabling version control, automated deployments, and environment management.

## What are Asset Bundles?

Asset Bundles let you define your Databricks projects as code, including:
- Jobs
- Pipelines (Lakeflow Declarative Pipelines)
- Apps
- Models
- Dashboards
- Notebooks
- Python files
- Configuration files

## Bundle Commands

```bash
# Initialize a new bundle from template
databricks bundle init --profile my-workspace

# Validate bundle configuration
databricks bundle validate --profile my-workspace

# Deploy bundle to workspace
databricks bundle deploy --profile my-workspace

# Deploy to specific target (dev/staging/prod)
databricks bundle deploy -t dev --profile my-workspace
databricks bundle deploy -t staging --profile my-workspace
databricks bundle deploy -t prod --profile my-workspace

# Run a resource from the bundle
databricks bundle run <resource-name> --profile my-workspace

# Generate configuration for existing resources
databricks bundle generate job <job-id> --profile my-workspace
databricks bundle generate pipeline <pipeline-id> --profile my-workspace
databricks bundle generate dashboard <dashboard-id> --profile my-workspace
databricks bundle generate app <app-name> --profile my-workspace

# Destroy bundle resources (use with caution!)
databricks bundle destroy --profile my-workspace
databricks bundle destroy -t dev --profile my-workspace
```

## Bundle Structure

A typical bundle has this structure:

```
my-project/
├── databricks.yml                        # Main bundle configuration
├── resources/
│   ├── sample_job.job.yml                # Job definition
│   └── my_project_etl.pipeline.yml       # Pipeline definition
├── src/
│   ├── sample_notebook.ipynb             # Notebook tasks
│   └── my_project_etl/                   # Pipeline source
│       └── transformations/
│           ├── transform.py
│           └── transform.sql
├── tests/
│   └── test_main.py
└── README.md
```

Resource files use the naming convention `<resource_key>.<resource_type>.yml` (e.g. `sample_job.job.yml`, `my_project_etl.pipeline.yml`).

## Main Configuration (databricks.yml)

### Basic Example

```yaml
bundle:
  name: my-project

include:
  - resources/*.yml
  - resources/*/*.yml

variables:
  catalog:
    description: The catalog to use
  schema:
    description: The schema to use

targets:
  dev:
    mode: development
    default: true
    workspace:
      host: https://company-workspace.cloud.databricks.com
    variables:
      catalog: dev_catalog
      schema: ${workspace.current_user.short_name}

  prod:
    mode: production
    workspace:
      host: https://company-workspace.cloud.databricks.com
      root_path: /Workspace/Users/${workspace.current_user.userName}/.bundle/${bundle.name}/${bundle.target}
    variables:
      catalog: prod_catalog
      schema: prod
    permissions:
      - user_name: my-user@example.com
        level: CAN_MANAGE
```

## Initializing a Bundle

### Using Templates

```bash
# Start initialization (interactive)
databricks bundle init --profile my-workspace
```

Available templates:
- **default-python** - Python project with jobs and pipeline
- **default-sql** - SQL project with jobs
- **default-scala** - Scala/Java project
- **lakeflow-pipelines** - Lakeflow Declarative Pipelines (Python or SQL)
- **dbt-sql** - dbt integration
- **default-minimal** - Minimal structure

## Defining Resources

### Job Resource (Serverless)

```yaml
# resources/sample_job.job.yml
resources:
  jobs:
    sample_job:
      name: sample_job

      trigger:
        periodic:
          interval: 1
          unit: DAYS

      parameters:
        - name: catalog
          default: ${var.catalog}
        - name: schema
          default: ${var.schema}

      tasks:
        - task_key: notebook_task
          notebook_task:
            notebook_path: ../src/sample_notebook.ipynb

        - task_key: main_task
          depends_on:
            - task_key: notebook_task
          python_wheel_task:
            package_name: my_project
            entry_point: main
          environment_key: default

        - task_key: refresh_pipeline
          depends_on:
            - task_key: notebook_task
          pipeline_task:
            pipeline_id: ${resources.pipelines.my_project_etl.id}

      environments:
        - environment_key: default
          spec:
            environment_version: "4"
            dependencies:
              - ../dist/*.whl
```

### Job Resource (Classic Clusters)

```yaml
# resources/sample_job.job.yml
resources:
  jobs:
    sample_job:
      name: sample_job

      tasks:
        - task_key: notebook_task
          notebook_task:
            notebook_path: ../src/sample_notebook.ipynb
          job_cluster_key: job_cluster
          libraries:
            - whl: ../dist/*.whl

        - task_key: main_task
          depends_on:
            - task_key: notebook_task
          python_wheel_task:
            package_name: my_project
            entry_point: main
          job_cluster_key: job_cluster
          libraries:
            - whl: ../dist/*.whl

      job_clusters:
        - job_cluster_key: job_cluster
          new_cluster:
            spark_version: 16.4.x-scala2.12
            node_type_id: i3.xlarge
            data_security_mode: SINGLE_USER
            autoscale:
              min_workers: 1
              max_workers: 4
```

### Pipeline Resource

```yaml
# resources/my_project_etl.pipeline.yml
resources:
  pipelines:
    my_project_etl:
      name: my_project_etl
      catalog: ${var.catalog}
      schema: ${var.schema}
      serverless: true
      root_path: "../src/my_project_etl"

      libraries:
        - glob:
            include: ../src/my_project_etl/transformations/**
```

### App Resource

```yaml
# resources/my_app.app.yml
resources:
  apps:
    dashboard_app:
      name: "analytics-dashboard"
      description: "Customer analytics dashboard"
      source_code_path: ./src/app
```

### Model Resource

```yaml
# resources/my_model.yml
resources:
  registered_models:
    customer_churn:
      name: "${var.catalog}.${var.schema}.customer_churn_model"
      description: "Customer churn prediction model"
```

## Working with Targets

Targets allow you to deploy the same code to different workspaces with different configurations.

```yaml
targets:
  dev:
    mode: development
    default: true
    variables:
      catalog: dev_catalog
      schema: ${workspace.current_user.short_name}
    workspace:
      host: https://company-workspace.cloud.databricks.com

  staging:
    mode: production
    variables:
      catalog: staging_catalog
      schema: staging
    workspace:
      host: https://staging-workspace.cloud.databricks.com
      root_path: /Workspace/Users/deployer@example.com/.bundle/${bundle.name}/${bundle.target}
    permissions:
      - user_name: deployer@example.com
        level: CAN_MANAGE

  prod:
    mode: production
    variables:
      catalog: prod_catalog
      schema: prod
    workspace:
      host: https://prod-workspace.cloud.databricks.com
      root_path: /Workspace/Users/deployer@example.com/.bundle/${bundle.name}/${bundle.target}
    permissions:
      - user_name: deployer@example.com
        level: CAN_MANAGE
```

### Deploying to Different Targets

```bash
# Deploy to dev (default)
databricks bundle deploy --profile my-workspace

# Deploy to staging
databricks bundle deploy -t staging --profile my-workspace

# Deploy to production
databricks bundle deploy -t prod --profile my-workspace
```

## Bundle Workflow

### Complete Development Workflow

1. **Initialize bundle**:
   ```bash
   databricks bundle init --profile my-workspace
   ```

2. **Develop locally**:
   - Edit `databricks.yml` and resource files
   - Write notebooks, Python scripts, SQL queries
   - Configure jobs, pipelines, apps

3. **Validate configuration**:
   ```bash
   databricks bundle validate --profile my-workspace
   ```

4. **Deploy to development**:
   ```bash
   databricks bundle deploy -t dev --profile my-workspace
   ```

5. **Test your deployment**:
   ```bash
   # Run a job
   databricks bundle run sample_job -t dev --profile my-workspace

   # Start a pipeline
   databricks bundle run my_project_etl -t dev --profile my-workspace
   ```

6. **Deploy to production**:
   ```bash
   databricks bundle deploy -t prod --profile my-workspace
   ```

## Generating Bundle from Existing Resources

If you have existing resources in your workspace, you can generate bundle configuration:

```bash
# Get job ID from list
databricks jobs list --profile my-workspace

# Generate configuration
databricks bundle generate job 12345 --profile my-workspace
databricks bundle generate pipeline <pipeline-id> --profile my-workspace
databricks bundle generate app my-app --profile my-workspace
databricks bundle generate dashboard <dashboard-id> --profile my-workspace
```

## Variables and Templating

### Defining Variables

```yaml
# databricks.yml
variables:
  catalog:
    description: The catalog to use
    default: dev_catalog
  schema:
    description: The schema to use
  warehouse_id:
    description: SQL Warehouse ID
```

### Using Variables

```yaml
# In resource files
resources:
  jobs:
    my_job:
      name: "Job in ${var.catalog}"
      parameters:
        - name: catalog
          default: ${var.catalog}
```

### Target-Specific Variables

```yaml
targets:
  dev:
    variables:
      catalog: dev_catalog
      schema: ${workspace.current_user.short_name}
  prod:
    variables:
      catalog: prod_catalog
      schema: prod
```

### Available Substitutions

```yaml
${var.my_variable}                          # User-defined variable
${bundle.name}                              # Bundle name
${bundle.target}                            # Current target name (dev, prod, etc.)
${workspace.current_user.userName}          # Current user email
${workspace.current_user.short_name}        # Current user short name
${workspace.file_path}                      # Workspace file path
${resources.pipelines.my_pipeline.id}       # Reference another resource's ID
${resources.jobs.my_job.id}                 # Reference a job's ID
```

## Best Practices

### 1. Use Version Control

Always commit your bundle to Git:

```bash
git init
git add databricks.yml resources/ src/
git commit -m "Initial bundle setup"
```

### 2. Use Typed Resource File Names

Name resource files with their type for clarity:

```
resources/
├── sample_job.job.yml
├── my_project_etl.pipeline.yml
└── my_app.app.yml
```

### 3. Use Target-Specific Configuration

```yaml
targets:
  dev:
    mode: development  # Prefixes resources with [dev user_name], pauses schedules

  prod:
    mode: production   # Requires permissions, runs schedules as configured
    permissions:
      - user_name: deployer@example.com
        level: CAN_MANAGE
```

### 4. Validate Before Deploy

Always validate:

```bash
databricks bundle validate --profile my-workspace
```

## Troubleshooting

### Bundle Validation Errors

**Symptom**: `databricks bundle validate` shows errors

**Solution**:
1. Check YAML syntax (proper indentation, no tabs)
2. Verify all required fields are present
3. Check that resource references are correct
4. Use `databricks bundle validate --debug` for detailed errors

### Deployment Fails

**Symptom**: `databricks bundle deploy` fails

**Solution**:
1. Run validation first: `databricks bundle validate`
2. Check workspace permissions
3. Verify target configuration
4. Check for resource name conflicts
5. Review error message for specific issues

### Variable Not Resolved

**Symptom**: Variable showing as `${var.name}` instead of actual value

**Solution**:
1. Check variable is defined in `databricks.yml`
2. Verify variable has value in target
3. Use correct syntax: `${var.variable_name}`
4. Check variable scope (bundle vs target)

## Related Topics

- [Data Exploration](data-exploration.md) - Validate data exposed by bundle deployments
- Apps - Define app resources (use `databricks-apps` skill for full app development)
