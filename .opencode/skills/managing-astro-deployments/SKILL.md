---
name: managing-astro-deployments
description: Manage Astronomer production deployments with Astro CLI. Use when the user wants to authenticate, switch workspaces, create/update/delete deployments, or deploy code to production.
tags: ["airflow", "astronomer"]
---

# Astro Deployment Management

This skill helps you manage production Astronomer deployments using the Astro CLI.

> **For local development**, see the **managing-astro-local-env** skill.
> **For production troubleshooting**, see the **troubleshooting-astro-deployments** skill.

---

## Authentication

All deployment operations require authentication:

```bash
# Login to Astronomer (opens browser for OAuth)
astro login
```

Authentication tokens are stored locally for subsequent commands. Run this before any deployment operations.

---

## Workspace Management

Deployments are organized into workspaces:

```bash
# List all accessible workspaces
astro workspace list

# Switch to a specific workspace
astro workspace switch <WORKSPACE_ID>
```

Workspace context is maintained between sessions. Most deployment commands operate within the current workspace context.

---

## List and Inspect Deployments

```bash
# List deployments in current workspace
astro deployment list

# List deployments across all workspaces
astro deployment list --all

# Inspect specific deployment (detailed info)
astro deployment inspect <DEPLOYMENT_ID>

# Inspect by name (alternative to ID)
astro deployment inspect --deployment-name data-service-stg
```

### What `inspect` Shows

- Deployment status (HEALTHY, UNHEALTHY)
- Runtime version and Airflow version
- Executor type (CELERY, KUBERNETES, LOCAL)
- Scheduler configuration (size, count)
- Worker queue settings (min/max workers, concurrency, worker type)
- Resource quotas (CPU, memory)
- Environment variables
- Last deployment timestamp and current tag
- Webserver and API URLs
- High availability status

---

## Create Deployments

```bash
# Create with default settings
astro deployment create

# Create with specific executor
astro deployment create --label production --executor celery
astro deployment create --label staging --executor kubernetes

# Executor options:
#   - celery: Best for most production workloads
#   - kubernetes: Best for dynamic scaling, isolated tasks
#   - local: Best for development only
```

---

## Update Deployments

```bash
# Enable DAG-only deploys (faster iteration)
astro deployment update <DEPLOYMENT_ID> --dag-deploy-enabled

# Update other settings (use --help for full options)
astro deployment update <DEPLOYMENT_ID> --help
```

---

## Delete Deployments

```bash
# Delete a deployment (requires confirmation)
astro deployment delete <DEPLOYMENT_ID>
```

**Destructive**: This cannot be undone. All DAGs, task history, and metadata will be lost.

---

## Deploy Code to Production

### Full Deploy

Deploy both DAGs and Docker image (required when dependencies change):

```bash
astro deploy <DEPLOYMENT_ID>
```

Use when:
- Dependencies changed (`requirements.txt`, `packages.txt`, `Dockerfile`)
- First deployment of new project
- Significant infrastructure changes

### DAG-Only Deploy (Recommended for Iteration)

Deploy only DAG files, skip Docker image rebuild:

```bash
astro deploy <DEPLOYMENT_ID> --dags
```

Use when:
- Only DAG files changed (Python files in `dags/` directory)
- Quick iteration during development
- Much faster than full deploy (seconds vs minutes)

**Requires**: `--dag-deploy-enabled` flag set on deployment (see Update Deployments)

### Image-Only Deploy

Deploy only Docker image, skip DAG sync:

```bash
astro deploy <DEPLOYMENT_ID> --image-only
```

Use when:
- Only dependencies changed
- Dockerfile or requirements updated
- No DAG changes

### Force Deploy

Bypass safety checks and deploy:

```bash
astro deploy <DEPLOYMENT_ID> --force
```

**Caution**: Skips validation that could prevent broken deployments.

---

## Deployment API Tokens

Manage API tokens for programmatic access to deployments:

```bash
# List tokens for a deployment
astro deployment token list --deployment-id <DEPLOYMENT_ID>

# Create a new token
astro deployment token create \
  --deployment-id <DEPLOYMENT_ID> \
  --name "CI/CD Pipeline" \
  --role DEPLOYMENT_ADMIN

# Create token with expiration
astro deployment token create \
  --deployment-id <DEPLOYMENT_ID> \
  --name "Temporary Access" \
  --role DEPLOYMENT_ADMIN \
  --expiry 30  # Days until expiration (0 = never expires)
```

**Roles**:
- `DEPLOYMENT_ADMIN`: Full access to deployment

**Note**: Token value is only shown at creation time. Store it securely.

---

## Common Workflows

### First-Time Production Deployment

```bash
# 1. Login
astro login

# 2. Switch to production workspace
astro workspace list
astro workspace switch <PROD_WORKSPACE_ID>

# 3. Create deployment
astro deployment create --label production --executor celery

# 4. Note the deployment ID, then deploy
astro deploy <DEPLOYMENT_ID>
```

### Iterative DAG Development

```bash
# 1. Enable fast deploys (one-time setup)
astro deployment update <DEPLOYMENT_ID> --dag-deploy-enabled

# 2. Make DAG changes locally

# 3. Deploy quickly
astro deploy <DEPLOYMENT_ID> --dags
```

### Promoting Code from Staging to Production

```bash
# 1. Deploy to staging first
astro workspace switch <STAGING_WORKSPACE_ID>
astro deploy <STAGING_DEPLOYMENT_ID>

# 2. Test in staging

# 3. Deploy same code to production
astro workspace switch <PROD_WORKSPACE_ID>
astro deploy <PROD_DEPLOYMENT_ID>
```

---

## Configuration Management

```bash
# View CLI configuration
astro config get

# Set configuration value
astro config set <KEY> <VALUE>

# Check CLI version
astro version

# Upgrade CLI to latest version
astro upgrade
```

---

## Tips

- Use `--dags` flag for fast iteration (seconds vs minutes)
- Always test in staging workspace before production
- Use `deployment inspect` to verify deployment health before deploying
- Deployment IDs are permanent, names can change
- Most commands work with deployment ID; `inspect` also accepts `--deployment-name`
- Set `--dag-deploy-enabled` once per deployment for fast deploys
- Keep workspace context visible with `astro workspace list` (shows asterisk for current)

---

## Related Skills

- **troubleshooting-astro-deployments**: Investigate deployment issues, view logs, manage environment variables
- **managing-astro-local-env**: Manage local Airflow development environment
- **setting-up-astro-project**: Initialize and configure Astro projects
