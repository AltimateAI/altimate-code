---
name: databricks-apps
description: Build apps on Databricks Apps platform. Use when asked to create dashboards, data apps, analytics tools, or visualizations. Invoke BEFORE starting implementation.
compatibility: Requires databricks CLI (>= v0.292.0)
metadata:
  version: "0.1.0"
parent: databricks
tags: ["databricks"]
---

# Databricks Apps Development

**FIRST**: Use the parent `databricks` skill for CLI basics, authentication, and profile selection.

Build apps that deploy to Databricks Apps platform.

## Required Reading by Phase

| Phase | READ BEFORE proceeding |
|-------|------------------------|
| Scaffolding | Parent `databricks` skill (auth, warehouse discovery); run `databricks apps manifest` and use its plugins/resources to build `databricks apps init` with `--features` and `--set` (see AppKit section below) |
| Writing SQL queries | [SQL Queries Guide](references/appkit/sql-queries.md) |
| Writing UI components | [Frontend Guide](references/appkit/frontend.md) |
| Using `useAnalyticsQuery` | [AppKit SDK](references/appkit/appkit-sdk.md) |
| Adding API endpoints | [tRPC Guide](references/appkit/trpc.md) |
| Using Lakebase (OLTP database) | [Lakebase Guide](references/appkit/lakebase.md) |

## Generic Guidelines

These apply regardless of framework:

- **Deployment**: `databricks apps deploy --profile <PROFILE>` (⚠️ USER CONSENT REQUIRED)
- **Validation**: `databricks apps validate --profile <PROFILE>` before deploying
- **App name**: Must be ≤26 characters, lowercase letters/numbers/hyphens only (no underscores). dev- prefix adds 4 chars, max 30 total.
- **Smoke tests**: ALWAYS update `tests/smoke.spec.ts` selectors BEFORE running validation. Default template checks for "Minimal Databricks App" heading and "hello world" text — these WILL fail in your custom app. See [testing guide](references/testing.md).
- **Authentication**: covered by parent `databricks` skill

## Project Structure (after `databricks apps init --features analytics`)
- `client/src/App.tsx` — main React component (start here)
- `config/queries/*.sql` — SQL query files (queryKey = filename without .sql)
- `server/server.ts` — backend entry (tRPC routers)
- `tests/smoke.spec.ts` — smoke test (⚠️ MUST UPDATE selectors for your app)
- `client/src/appKitTypes.d.ts` — auto-generated types (`npm run typegen`)

## Project Structure (after `databricks apps init --features lakebase`)
- `server/server.ts` — backend with Lakebase pool + tRPC routes
- `client/src/App.tsx` — React frontend
- `app.yaml` — manifest with `database` resource declaration
- `package.json` — includes `@databricks/lakebase` dependency
- Note: **No `config/queries/`** — Lakebase apps use `pool.query()` in tRPC, not SQL files

## Data Discovery

Before writing any SQL, use the parent `databricks` skill for data exploration — search `information_schema` by keyword, then batch `discover-schema` for the tables you need. Do NOT skip this step.

## Development Workflow (FOLLOW THIS ORDER)

**Analytics apps** (`--features analytics`):

1. Create SQL files in `config/queries/`
2. Run `npm run typegen` — verify all queries show ✓
3. Read `client/src/appKitTypes.d.ts` to see generated types
4. **THEN** write `App.tsx` using the generated types
5. Update `tests/smoke.spec.ts` selectors
6. Run `databricks apps validate --profile <PROFILE>`

**DO NOT** write UI code before running typegen — types won't exist and you'll waste time on compilation errors.

**Lakebase apps** (`--features lakebase`): No SQL files or typegen. See [Lakebase Guide](references/appkit/lakebase.md) for the tRPC pattern: initialize schema at startup, write procedures in `server/server.ts`, then build the React frontend.

## When to Use What
- **Read analytics data → display in chart/table**: Use visualization components with `queryKey` prop
- **Read analytics data → custom display (KPIs, cards)**: Use `useAnalyticsQuery` hook
- **Read analytics data → need computation before display**: Still use `useAnalyticsQuery`, transform client-side
- **Read/write persistent data (users, orders, CRUD state)**: Use Lakebase pool via tRPC — see [Lakebase Guide](references/appkit/lakebase.md)
- **Call ML model endpoint**: Use tRPC
- **⚠️ NEVER use tRPC to run SELECT queries against the warehouse** — always use SQL files in `config/queries/`
- **⚠️ NEVER use `useAnalyticsQuery` for Lakebase data** — it queries the SQL warehouse only

## Frameworks

### AppKit (Recommended)

TypeScript/React framework with type-safe SQL queries and built-in components.

**Official Documentation** — the source of truth for all API details:

```bash
npx @databricks/appkit docs                              # ← ALWAYS start here to see available pages
npx @databricks/appkit docs <query>                      # view a section by name or doc path
npx @databricks/appkit docs --full                       # full index with all API entries
npx @databricks/appkit docs "appkit-ui API reference"    # example: section by name
npx @databricks/appkit docs ./docs/plugins/analytics.md  # example: specific doc file
```

**DO NOT guess doc paths.** Run without args first, pick from the index. The `<query>` argument accepts both section names (from the index) and file paths. Docs are the authority on component props, hook signatures, and server APIs — skill files only cover anti-patterns and gotchas.

**App Manifest and Scaffolding**

**Agent workflow for scaffolding: get the manifest first, then build the init command.**

1. **Get the manifest** (JSON schema describing plugins and their resources):
   ```bash
   databricks apps manifest --profile <PROFILE>
   # Custom template:
   databricks apps manifest --template <GIT_URL> --profile <PROFILE>
   ```
   The output defines:
   - **Plugins**: each has a key (plugin ID for `--features`), plus `requiredByTemplate`, and `resources`.
   - **requiredByTemplate**: If **true**, that plugin is **mandatory** for this template — do **not** add it to `--features` (it is included automatically); you must still supply all of its required resources via `--set`. If **false** or absent, the plugin is **optional** — add it to `--features` only when the user's prompt indicates they want that capability (e.g. analytics/SQL), and then supply its required resources via `--set`.
   - **Resources**: Each plugin has `resources.required` and `resources.optional` (arrays). Each item has `resourceKey` and `fields` (object: field name → description/env). Use `--set <plugin>.<resourceKey>.<field>=<value>` for each required resource field of every plugin you include.

2. **Scaffold** (DO NOT use `npx`; use the CLI only):
   ```bash
   databricks apps init --name <NAME> --features <plugin1>,<plugin2> \
     --set <plugin1>.<resourceKey>.<field>=<value> \
     --set <plugin2>.<resourceKey>.<field>=<value> \
     --description "<DESC>" --run none --profile <PROFILE>
   # --run none: skip auto-run after scaffolding (review code first)
   # With custom template:
   databricks apps init --template <GIT_URL> --name <NAME> --features ... --set ... --profile <PROFILE>
   ```
   - **Required**: `--name`, `--profile`. Name: ≤26 chars, lowercase letters/numbers/hyphens only. Use `--features` only for **optional** plugins the user wants (plugins with `requiredByTemplate: false` or absent); mandatory plugins must not be listed in `--features`.
   - **Resources**: Pass `--set` for every required resource (each field in `resources.required`) for (1) all plugins with `requiredByTemplate: true`, and (2) any optional plugins you added to `--features`. Add `--set` for `resources.optional` only when the user requests them.
   - **Discovery**: Use the parent `databricks` skill to resolve IDs (e.g. warehouse: `databricks warehouses list --profile <PROFILE>` or `databricks experimental aitools tools get-default-warehouse --profile <PROFILE>`).

**DO NOT guess** plugin names, resource keys, or property names — always derive them from `databricks apps manifest` output. Example: if the manifest shows plugin `analytics` with a required resource `resourceKey: "sql-warehouse"` and `fields: { "id": ... }`, include `--set analytics.sql-warehouse.id=<ID>`.

**READ [AppKit Overview](references/appkit/overview.md)** for project structure, workflow, and pre-implementation checklist.

### Common Scaffolding Mistakes

```bash
# ❌ WRONG: name is NOT a positional argument
databricks apps init --features analytics my-app-name
# → "unknown command" error

# ✅ CORRECT: use --name flag
databricks apps init --name my-app-name --features analytics --set "..." --profile <PROFILE>
```

### Directory Naming

`databricks apps init` creates directories in kebab-case matching the app name.
App names must be lowercase with hyphens only (≤26 chars).

### Other Frameworks

Databricks Apps supports any framework that can run as a web server (Flask, FastAPI, Streamlit, Gradio, etc.). Use standard framework documentation - this skill focuses on AppKit.
