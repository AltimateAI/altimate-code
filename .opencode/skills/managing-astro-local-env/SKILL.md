---
name: managing-astro-local-env
description: Manage local Airflow environment with Astro CLI. Use when the user wants to start, stop, or restart Airflow, view logs, troubleshoot containers, or fix environment issues. For project setup, see setting-up-astro-project.
tags: ["airflow", "astronomer"]
---

# Astro Local Environment

This skill helps you manage your local Airflow environment using the Astro CLI.

> **To set up a new project**, see the **setting-up-astro-project** skill.
> **When Airflow is running**, use MCP tools from **authoring-dags** and **testing-dags** skills.

---

## Start / Stop / Restart

```bash
# Start local Airflow (webserver at http://localhost:8080)
astro dev start

# Stop containers (preserves data)
astro dev stop

# Kill and remove volumes (clean slate)
astro dev kill

# Restart all containers
astro dev restart

# Restart specific component
astro dev restart --scheduler
astro dev restart --webserver
```

**Default credentials:** admin / admin

**Restart after modifying:** `requirements.txt`, `packages.txt`, `Dockerfile`

---

## Check Status

```bash
astro dev ps
```

---

## View Logs

```bash
# All logs
astro dev logs

# Specific component
astro dev logs --scheduler
astro dev logs --webserver

# Follow in real-time
astro dev logs -f
```

---

## Access Container Shell

```bash
# Bash into scheduler container
astro dev bash

# Run Airflow CLI commands
astro dev run airflow info
astro dev run airflow dags list
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Port 8080 in use | Stop other containers or edit `.astro/config.yaml` |
| Container won't start | `astro dev kill` then `astro dev start` |
| Package install failed | Check `requirements.txt` syntax |
| DAG not appearing | Run `astro dev parse` to check for import errors |
| Out of disk space | `docker system prune` |

### Reset Environment

When things are broken:

```bash
astro dev kill
astro dev start
```

---

## Upgrade Airflow

### Test compatibility first

```bash
astro dev upgrade-test
```

### Change version

1. Edit `Dockerfile`:
   ```dockerfile
   FROM quay.io/astronomer/astro-runtime:13.0.0
   ```

2. Restart:
   ```bash
   astro dev kill && astro dev start
   ```

---

## Related Skills

- **setting-up-astro-project**: Initialize projects and configure dependencies
- **authoring-dags**: Write DAGs (uses MCP tools, requires running Airflow)
- **testing-dags**: Test DAGs (uses MCP tools, requires running Airflow)
- **deploying-airflow**: Deploy DAGs to production (Astro, Docker Compose, Kubernetes)
