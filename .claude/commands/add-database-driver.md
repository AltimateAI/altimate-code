---
description: Add a new database driver to Altimate Code. Scaffolds the driver, registers it across all 23 integration points, writes E2E tests, and updates docs. Usage - /add-database-driver <database-name>
---

# Add Database Driver

Scaffold and fully integrate a new database/warehouse driver into Altimate Code. This command handles all 23 integration points — driver code, registry, discovery, finops, tests, and documentation.

## Input

`$ARGUMENTS` = the database name (e.g., `cockroachdb`, `timescaledb`, `cassandra`, `neo4j`).

If empty, ask: "Which database should I add support for?"

## Step 0: Research

Before writing any code, research the database:

1. **Find the official Node.js/TypeScript client package** on npm. Search for `@{database}/client`, `{database}-js`, or similar.
2. **Check supported server versions** — which versions are not EOL?
3. **Identify auth methods** — password, token, TLS/certificate, connection string, cloud-specific?
4. **Check SQL dialect** — standard SQL? Custom syntax? LIMIT vs TOP vs FETCH FIRST? System tables for schemas/tables/columns?
5. **Find Docker image** — official image on Docker Hub for E2E testing?
6. **Check if dbt adapter exists** — search for `dbt-{database}` on PyPI.

Present findings to the user before proceeding:
```
## Research: {Database}

- **npm package**: `{package}` (v{version})
- **Server versions**: {non-EOL versions}
- **Auth methods**: {list}
- **SQL dialect**: {notes on LIMIT, system tables, parameterized queries}
- **Docker image**: `{image}:{tag}`
- **dbt adapter**: {exists/not found}

Proceed with implementation?
```

## Step 1: Read Reference Document

Read the comprehensive checklist:
```bash
cat packages/drivers/ADDING_A_DRIVER.md
```

This document has all 23 integration points with exact file paths and code patterns.

## Step 2: Read Existing Driver for Pattern

Read a similar existing driver as a template. Choose based on database type:

- **SQL database with password auth** → read `packages/drivers/src/mysql.ts`
- **Cloud warehouse with token auth** → read `packages/drivers/src/databricks.ts`
- **Database with connection string support** → read `packages/drivers/src/postgres.ts`
- **HTTP-based client** → read `packages/drivers/src/clickhouse.ts`
- **Document database (non-SQL)** → read `packages/drivers/src/mongodb.ts`

Also read:
- `packages/drivers/src/normalize.ts` — for alias pattern
- `packages/opencode/src/altimate/native/connections/registry.ts` — for registration pattern
- `packages/opencode/test/altimate/drivers-docker-e2e.test.ts` — for E2E test pattern

## Step 3: Implement (23 integration points)

Work through all 9 phases from the checklist. Use parallel edits where possible.

### Phase 1: Core Driver (4 files)

1. **Create `packages/drivers/src/{database}.ts`**
   - Follow the Connector interface: `connect()`, `execute()`, `listSchemas()`, `listTables()`, `describeTable()`, `close()`
   - Lazy-import the npm package
   - Use parameterized queries for schema introspection
   - Handle LIMIT injection with DML guard: `!hasDML` check before appending LIMIT
   - Handle TLS detection from connection strings

2. **Add export to `packages/drivers/src/index.ts`**

3. **Add optionalDependency to `packages/drivers/package.json`**

4. **Add aliases to `packages/drivers/src/normalize.ts`**

### Phase 2: Registry (4 files in registry.ts)

5. Add to `DRIVER_MAP`
6. Add to import switch statement
7. Add to `PASSWORD_DRIVERS` (if applicable)
8. Remove from `KNOWN_UNSUPPORTED` (if listed)

### Phase 3: Discovery (4 files)

9. Docker discovery — `docker-discovery.ts` (IMAGE_MAP, ENV_MAP, DEFAULT_PORTS, DEFAULT_USERS)
10. Env var detection — `project-scan.ts` (detectEnvVars warehouses array)
11. dbt adapter — `dbt-profiles.ts` (ADAPTER_TYPE_MAP)
12. dbt lineage — `dbt/lineage.ts` (detectDialect dialectMap)

### Phase 4: FinOps (1 file)

13. Query history — `finops/query-history.ts` (SQL template + handler if database has system query log)

### Phase 5: Build (1 file)

14. Peer deps — `script/publish.ts` (driverPeerDependencies)

### Phase 6: Tool Descriptions (1 file)

15. warehouse_add — `tools/warehouse-add.ts` (config description + error message)

### Phase 7: Tests (2 new files + 1 edit)

16. E2E tests — `test/altimate/drivers-{database}-e2e.test.ts`
17. Normalization tests — add to `test/altimate/driver-normalize.test.ts`
18. Verify existing tests pass

### Phase 8: Documentation (5 files)

19. `docs/docs/configure/warehouses.md` — config section + update count
20. `docs/docs/drivers.md` — support matrix + installation + auth + update count
21. `docs/docs/data-engineering/tools/warehouse-tools.md` — env vars + Docker
22. `README.md` — warehouse list
23. `docs/docs/getting-started/index.md` — homepage list

### Phase 9: Optional

- Guide page at `docs/docs/data-engineering/guides/{database}.md`
- Update `mkdocs.yml` nav and `guides/index.md`
- Check fingerprint regex in `fingerprint/index.ts`

## Step 4: Run Quality Gates

```bash
# Tests (from packages/opencode/)
cd packages/opencode && bun test test/altimate/driver-normalize.test.ts test/altimate/connections.test.ts test/altimate/drivers-{database}-e2e.test.ts

# Typecheck (from repo root)
cd "$(git rev-parse --show-toplevel)" && bun turbo typecheck

# Marker check (from repo root)
bun run script/upstream/analyze.ts --markers --base main --strict
```

All three must pass before proceeding.

## Step 5: Run Code Review

Run `/consensus:code-review` to get the implementation reviewed by multiple models before committing.

## Step 6: Summary

Present final summary:
```
## {Database} Driver Added

### Files Created
- packages/drivers/src/{database}.ts
- packages/opencode/test/altimate/drivers-{database}-e2e.test.ts
- docs/docs/data-engineering/guides/{database}.md (if created)

### Files Modified
- {list all modified files}

### Test Results
- {N} normalization tests pass
- {N} connection tests pass
- Typecheck: pass
- Marker check: pass

### E2E Test Coverage
- {list of test suites and server versions}

Ready to commit.
```

## Rules

1. **Read before writing.** Always read existing drivers and the reference doc before creating new code.
2. **Don't skip integration points.** All 23 points exist for a reason — missing one causes inconsistencies users will hit.
3. **Use parameterized queries** for `listTables` and `describeTable` — never interpolate user input into SQL.
4. **Test multiple server versions** — at minimum: latest stable + oldest non-EOL LTS.
5. **Run all quality gates** before presenting the summary.
6. **Don't modify finops tools** (credit-analyzer, warehouse-advisor, unused-resources) unless the database has equivalent cost/credit APIs.
