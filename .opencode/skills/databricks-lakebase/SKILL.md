---
name: databricks-lakebase
description: "Manage Lakebase Postgres Autoscaling projects, branches, and endpoints via Databricks CLI. Use when asked to create, configure, or manage Lakebase Postgres databases, projects, branches, computes, or endpoints."
compatibility: Requires databricks CLI (>= v0.292.0)
metadata:
  version: "0.1.0"
parent: databricks
tags: ["databricks"]
---

# Lakebase Postgres Autoscaling

**FIRST**: Use the parent `databricks` skill for CLI basics, authentication, and profile selection.

Lakebase is Databricks' serverless Postgres-compatible database (similar to Neon). It provides fully managed OLTP storage with autoscaling, branching, and scale-to-zero.

Manage Lakebase Postgres projects, branches, endpoints, and databases via `databricks postgres` CLI commands.

## Resource Hierarchy

```
Project (top-level container)
  └── Branch (isolated database environment, copy-on-write)
        ├── Endpoint (read-write or read-only)
        ├── Database (standard Postgres DB)
        └── Role (Postgres role)
```

- **Project**: Top-level container. Creating one auto-provisions a `production` branch and a `primary` read-write endpoint.
- **Branch**: Isolated database environment sharing storage with parent (copy-on-write). States: `READY`, `ARCHIVED`.
- **Endpoint** (called **Compute** in the Lakebase UI): Compute resource powering a branch. Types: `ENDPOINT_TYPE_READ_WRITE`, `ENDPOINT_TYPE_READ_ONLY` (read replica).
- **Database**: Standard Postgres database within a branch. Default: `databricks_postgres`.
- **Role**: Postgres role within a branch. Manage roles via `databricks postgres create-role -h`.

### Resource Name Formats

| Resource | Format |
|----------|--------|
| Project | `projects/{project_id}` |
| Branch | `projects/{project_id}/branches/{branch_id}` |
| Endpoint | `projects/{project_id}/branches/{branch_id}/endpoints/{endpoint_id}` |
| Database | `projects/{project_id}/branches/{branch_id}/databases/{database_id}` |

All IDs: 1-63 characters, start with lowercase letter, lowercase letters/numbers/hyphens only (RFC 1123).

## CLI Discovery — ALWAYS Do This First

> **Note:** "Lakebase" is the product name; the CLI command group is `postgres`. All commands use `databricks postgres ...`.

**Do NOT guess command syntax.** Discover available commands and their usage dynamically:

```bash
# List all postgres subcommands
databricks postgres -h

# Get detailed usage for any subcommand (flags, args, JSON fields)
databricks postgres <subcommand> -h
```

Run `databricks postgres -h` before constructing any command. Run `databricks postgres <subcommand> -h` to discover exact flags, positional arguments, and JSON spec fields for that subcommand.

## Create a Project

```bash
databricks postgres create-project <PROJECT_ID> \
  --json '{"spec": {"display_name": "<DISPLAY_NAME>"}}' \
  --profile <PROFILE>
```

- Auto-creates: `production` branch + `primary` read-write endpoint (1 CU min/max, scale-to-zero)
- Long-running operation; the CLI waits for completion by default. Use `--no-wait` to return immediately.
- Run `databricks postgres create-project -h` for all available spec fields (e.g. `pg_version`).

After creation, verify the auto-provisioned resources:

```bash
databricks postgres list-branches projects/<PROJECT_ID> --profile <PROFILE>
databricks postgres list-endpoints projects/<PROJECT_ID>/branches/<BRANCH_ID> --profile <PROFILE>
databricks postgres list-databases projects/<PROJECT_ID>/branches/<BRANCH_ID> --profile <PROFILE>
```

## Autoscaling

Endpoints use **compute units (CU)** for autoscaling. Configure min/max CU via `create-endpoint` or `update-endpoint`. Run `databricks postgres create-endpoint -h` to see all spec fields.

Scale-to-zero is enabled by default. When idle, compute scales down to zero; it resumes in seconds on next connection.

## Branches

Branches are copy-on-write snapshots of an existing branch. Use them for **experimentation**: testing schema migrations, trying queries, or previewing data changes -- without affecting production.

```bash
databricks postgres create-branch projects/<PROJECT_ID> <BRANCH_ID> \
  --json '{
    "spec": {
      "source_branch": "projects/<PROJECT_ID>/branches/<SOURCE_BRANCH_ID>",
      "no_expiry": true
    }
  }' --profile <PROFILE>
```

Branches require an expiration policy: use `"no_expiry": true` for permanent branches.

When done experimenting, delete the branch. Protected branches must be unprotected first -- use `update-branch` to set `spec.is_protected` to `false`, then delete:

```bash
# Step 1 — unprotect
databricks postgres update-branch projects/<PROJECT_ID>/branches/<BRANCH_ID> \
  --json '{"spec": {"is_protected": false}}' --profile <PROFILE>

# Step 2 — delete (run -h to confirm positional arg format for your CLI version)
databricks postgres delete-branch projects/<PROJECT_ID>/branches/<BRANCH_ID> \
  --profile <PROFILE>
```

**Never delete the `production` branch** — it is the authoritative branch auto-provisioned at project creation.

## What's Next

### Build a Databricks App

After creating a Lakebase project, scaffold a Databricks App connected to it.

**Step 1 — Discover branch name** (use `.name` from a `READY` branch):

```bash
databricks postgres list-branches projects/<PROJECT_ID> --profile <PROFILE>
```

**Step 2 — Discover database name** (use `.name` from the desired database; `<BRANCH_ID>` is the branch ID, not the full resource name):

```bash
databricks postgres list-databases projects/<PROJECT_ID>/branches/<BRANCH_ID> --profile <PROFILE>
```

**Step 3 — Scaffold the app** with the `lakebase` feature:

```bash
databricks apps init --name <APP_NAME> \
  --features lakebase \
  --set "lakebase.postgres.branch=<BRANCH_NAME>" \
  --set "lakebase.postgres.database=<DATABASE_NAME>" \
  --profile <PROFILE>
```

Where `<BRANCH_NAME>` is the full resource name (e.g. `projects/<PROJECT_ID>/branches/<BRANCH_ID>`) and `<DATABASE_NAME>` is the full resource name (e.g. `projects/<PROJECT_ID>/branches/<BRANCH_ID>/databases/<DB_ID>`).

For the full app development workflow, use the **`databricks-apps`** skill.

### Other Workflows

**Connect a Postgres client**
Get the connection string from the endpoint, then connect with psql, DBeaver, or any standard Postgres client.

```bash
databricks postgres get-endpoint projects/<PROJECT_ID>/branches/<BRANCH_ID>/endpoints/<ENDPOINT_ID> --profile <PROFILE>
```

**Manage roles and permissions**
Create Postgres roles and grant access to databases or schemas.

```bash
databricks postgres create-role -h   # discover role spec fields
```

**Add a read-only endpoint**
Create a read replica for analytics or reporting workloads to avoid contention on the primary read-write endpoint.

```bash
databricks postgres create-endpoint projects/<PROJECT_ID>/branches/<BRANCH_ID> <ENDPOINT_ID> \
  --json '{"spec": {"type": "ENDPOINT_TYPE_READ_ONLY"}}' --profile <PROFILE>
```

## Troubleshooting

| Error | Solution |
|-------|----------|
| `cannot configure default credentials` | Use `--profile` flag or authenticate first |
| `PERMISSION_DENIED` | Check workspace permissions |
| Protected branch cannot be deleted | `update-branch` to set `spec.is_protected` to `false` first |
| Long-running operation timeout | Use `--no-wait` and poll with `get-operation` |
