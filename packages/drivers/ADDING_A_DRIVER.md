# Adding a New Database Driver

Step-by-step checklist for adding a new warehouse/database driver to Altimate Code. This was derived from the ClickHouse driver addition and covers every integration point in the codebase.

## Prerequisites

Before starting, research:
- The official Node.js/TypeScript client package for the database
- Supported authentication methods
- SQL dialect specifics (LIMIT syntax, system tables, parameterized query format)
- Which server versions are not end-of-life (EOL)
- Docker image availability for E2E testing

## Checklist (23 integration points)

### Phase 1: Core Driver (4 files)

- [ ] **1. Create driver file** — `packages/drivers/src/{database}.ts`
  - Export `async function connect(config: ConnectionConfig): Promise<Connector>`
  - Implement all 6 `Connector` interface methods: `connect()`, `execute()`, `listSchemas()`, `listTables()`, `describeTable()`, `close()`
  - Lazy-import the npm package with helpful error message if not installed
  - Handle LIMIT injection for SELECT-like queries (watch out for `WITH...INSERT` patterns)
  - Use parameterized queries for `listTables` and `describeTable` (prevent SQL injection)
  - Follow the pattern in `postgres.ts` or `mysql.ts`

- [ ] **2. Export from index** — `packages/drivers/src/index.ts`
  ```typescript
  export { connect as connectNewdb } from "./newdb"
  ```

- [ ] **3. Add npm dependency** — `packages/drivers/package.json`
  ```json
  "optionalDependencies": {
    "newdb-client": "^1.0.0"
  }
  ```

- [ ] **4. Add config aliases** — `packages/drivers/src/normalize.ts`
  - Create a `NEWDB_ALIASES: AliasMap` with camelCase and dbt-style field name mappings
  - Add entries to `DRIVER_ALIASES` map (include type aliases like `newdb: NEWDB_ALIASES`)

### Phase 2: Registry Integration (4 files)

- [ ] **5. Add to DRIVER_MAP** — `packages/opencode/src/altimate/native/connections/registry.ts`
  ```typescript
  newdb: "@altimateai/drivers/newdb",
  ```

- [ ] **6. Add to import switch** — same file, `createConnector()` function
  ```typescript
  case "@altimateai/drivers/newdb":
    mod = await import("@altimateai/drivers/newdb")
    break
  ```

- [ ] **7. Add to PASSWORD_DRIVERS** — same file (if the database uses password auth)
  ```typescript
  const PASSWORD_DRIVERS = new Set([..., "newdb"])
  ```

- [ ] **8. Remove from KNOWN_UNSUPPORTED** — same file (if previously listed there)

### Phase 3: Discovery (4 files)

- [ ] **9. Docker container discovery** — `packages/opencode/src/altimate/native/connections/docker-discovery.ts`
  - Add image pattern to `IMAGE_MAP`: `{ pattern: /newdb/i, type: "newdb" }`
  - Add env var mapping to `ENV_MAP`
  - Add default port to `DEFAULT_PORTS`
  - Add default user to `DEFAULT_USERS`

- [ ] **10. Environment variable detection** — `packages/opencode/src/altimate/tools/project-scan.ts`
  - Add entry to the `warehouses` array in `detectEnvVars()` with signal env vars and config mapping

- [ ] **11. dbt adapter mapping** — `packages/opencode/src/altimate/native/connections/dbt-profiles.ts`
  ```typescript
  newdb: "newdb",  // in ADAPTER_TYPE_MAP
  ```

- [ ] **12. dbt lineage dialect** — `packages/opencode/src/altimate/native/dbt/lineage.ts`
  ```typescript
  newdb: "newdb",  // in detectDialect() dialectMap
  ```

### Phase 4: FinOps (1 file)

- [ ] **13. Query history** — `packages/opencode/src/altimate/native/finops/query-history.ts`
  - Add a SQL template querying the database's system query log (if available)
  - Add handler in `buildHistoryQuery()` function
  - Export the template in `SQL_TEMPLATES`
  - If no query history exists, add `return null` with a comment (like DuckDB)

### Phase 5: Publish & Build (1 file)

- [ ] **14. Peer dependencies** — `packages/opencode/script/publish.ts`
  ```typescript
  "newdb-client": ">=1",  // in driverPeerDependencies
  ```

### Phase 6: Tool Descriptions (1 file)

- [ ] **15. warehouse_add tool** — `packages/opencode/src/altimate/tools/warehouse-add.ts`
  - Add canonical fields to the config `.describe()` string
  - Update the error message listing supported types

### Phase 7: Tests (3 files)

- [ ] **16. E2E driver tests** — `packages/opencode/test/altimate/drivers-{database}-e2e.test.ts` (new file)
  - Follow the pattern in `drivers-docker-e2e.test.ts` or `drivers-clickhouse-e2e.test.ts`
  - Test: connect, SELECT, DDL+DML, listSchemas, listTables, describeTable, LIMIT handling, close
  - Use Docker containers with `DRIVER_E2E_DOCKER=1` opt-in guard
  - Test multiple server versions (at least latest + oldest non-EOL LTS)
  - Support CI env vars (`TEST_{DB}_HOST`, `TEST_{DB}_PORT`, etc.)

- [ ] **17. Normalization tests** — `packages/opencode/test/altimate/driver-normalize.test.ts`
  - Add a `describe("normalizeConfig - {Database}")` block testing all aliases

- [ ] **18. Connection registry tests** — verify existing tests in `connections.test.ts` still pass

### Phase 8: Documentation (5 files)

- [ ] **19. Warehouse config docs** — `docs/docs/configure/warehouses.md`
  - Add a full section with JSON config example, field table, and auth variants
  - Update the warehouse count in the header
  - Add server compatibility note

- [ ] **20. Driver support matrix** — `docs/docs/drivers.md`
  - Add row to the support matrix table
  - Add to installation section
  - Add auth methods section
  - Add to auto-discovery list
  - Update count in header

- [ ] **21. Warehouse tools docs** — `docs/docs/data-engineering/tools/warehouse-tools.md`
  - Add env var signals to the detection table
  - Add to Docker discovery description

- [ ] **22. README** — `README.md`
  - Add to the "Supported Warehouses" list

- [ ] **23. Getting started** — `docs/docs/getting-started/index.md`
  - Add to the warehouse list on the homepage

### Phase 9: Optional Enhancements

- [ ] **Guide page** — `docs/docs/data-engineering/guides/{database}.md`
  - Database-specific workflows, optimization tips, dialect translation examples
  - Add to `docs/docs/data-engineering/guides/index.md` and `docs/mkdocs.yml` nav

- [ ] **Fingerprint detection** — `packages/opencode/src/altimate/fingerprint/index.ts`
  - Add to the dbt adapter type regex (if not already present)

## Common Pitfalls

1. **LIMIT injection for CTEs**: The `isSelectLike` regex matches `WITH`, but `WITH...INSERT INTO...SELECT` is valid in many databases. Add a `hasDML` guard to prevent appending LIMIT to write queries.

2. **TLS detection from connection strings**: If the database supports HTTPS URLs, detect `https://` from the resolved URL, not just from `config.protocol`.

3. **Lazy connection**: Some clients (like `@clickhouse/client`) connect lazily on first query. Don't add an explicit `connect()` call if the library handles it.

4. **`any` types for imports**: Dynamic imports of optional packages require `any` types. This is consistent with all existing drivers.

5. **Default user/password**: Some databases (ClickHouse, DuckDB, SQLite) don't require auth. Don't add them to `PASSWORD_DRIVERS` if passwordless auth is the default, or ensure the check only triggers on non-null non-string passwords.

6. **Marker check**: If modifying files under `packages/opencode/src/` that exist upstream, wrap changes in `// altimate_change start/end` markers and run `bun run script/upstream/analyze.ts --markers --base main --strict`.

## Quality Gates (run before committing)

```bash
# Tests
cd packages/opencode && bun test test/altimate/driver-normalize.test.ts test/altimate/connections.test.ts

# Typecheck
bun turbo typecheck

# Marker check
bun run script/upstream/analyze.ts --markers --base main --strict
```

## File Map

```text
packages/drivers/
  src/
    {database}.ts          ← NEW: driver implementation
    index.ts               ← export
    normalize.ts           ← aliases
  package.json             ← optionalDependency

packages/opencode/
  src/altimate/
    native/connections/
      registry.ts          ← DRIVER_MAP, switch, PASSWORD_DRIVERS
      docker-discovery.ts  ← Docker detection
      dbt-profiles.ts      ← dbt adapter mapping
    native/dbt/
      lineage.ts           ← dialect detection
    native/finops/
      query-history.ts     ← query log SQL template
    tools/
      project-scan.ts      ← env var detection
      warehouse-add.ts     ← tool description + error message
    fingerprint/
      index.ts             ← dbt adapter regex
  script/
    publish.ts             ← peerDependencies
  test/altimate/
    drivers-{db}-e2e.test.ts     ← NEW: E2E tests
    driver-normalize.test.ts     ← alias tests

docs/docs/
  configure/warehouses.md        ← config docs
  drivers.md                     ← support matrix
  data-engineering/
    tools/warehouse-tools.md     ← env var + Docker docs
    guides/{database}.md         ← NEW: optional guide
    guides/index.md              ← guide index
  getting-started/index.md       ← homepage

README.md                        ← warehouse list
docs/mkdocs.yml                  ← nav (if adding guide)
```
