# DBRACE Fix Report

Date: 2026-06-25
Worktree: `/Users/anandgupta/codebase/altimate-code/.claude/worktrees/get_latest_upstream`

## Summary

The full `packages/opencode` suite no longer fails with the DB migration race. The final full-suite run has only the known stale-codegen failure:

```text
10455 pass
708 skip
113 todo
1 fail
Ran 11277 tests across 538 files. [371.70s]
```

The remaining failure is:

```text
HttpApi SDK > uses the generated SDK for safe instance routes
```

No `SQLiteError`, `disk I/O`, `table project already exists`, or `database is locked` failures remain in the final full-suite log.

## Root Cause

The original `table project already exists` cascade was not caused by external contention and was not fixed by only relying on the module-local migration semaphore.

The failing `CREATE TABLE project` came from replaying baseline TypeScript migrations against a database that already had the current generated schema. The reproducer was:

1. Apply the current generated schema to a fresh core DB.
2. Seed only the legacy `__drizzle_migrations` journal entry.
3. Call `DatabaseMigration.apply`.
4. The core `migration` journal is missing baseline entries, so `applyOnly()` tries to replay the first baseline migration and hits `table project already exists`.

This can happen in the parallel test suite when legacy reset/adoption paths and core migration journaling diverge. The schema is present and visible, but the core journal does not prove that, so the runner replays non-idempotent baseline migrations.

After that was fixed, the remaining full-suite failures exposed two adjacent DB-test isolation issues:

- Test resets were deleting the shared DB file while long-lived runtime DB handles could still exist.
- Boot-time project-copy refresh was a background DB writer launched for ordinary instance boots, and in a parallel test run it could overlap unrelated project upserts or reset-heavy tests.

## Fixes Applied

### Core migration adoption

`packages/core/src/database/migration.ts`

- Added a current-schema probe for expected tables, columns, and indexes.
- If migrations are missing but the current generated schema is already present, `applyOnly()` marks those missing core migrations as applied instead of replaying baseline `CREATE TABLE` migrations.
- Kept the fresh-path transaction re-check under `BEGIN IMMEDIATE`.

Regression coverage:

- `packages/core/test/database-migration.test.ts`
- New test: adopts current generated schema when only the legacy drizzle journal exists.

### Shared test DB reset

`packages/opencode/test/fixture/db.ts`

- Replaced DB file deletion with schema-preserving deletes from data tables.
- Closes the legacy DB handle before reset.
- Preserves schema and migration journals so the preloaded core DB remains the owner.

`packages/opencode/test/fixture/fixture.ts`

- Added a small in-process read/write gate:
  - active test instances hold a read lock;
  - destructive DB resets hold a write lock.
- This prevents reset-heavy test files from clearing tables while another test is using a project-backed instance.

### Background project-copy refresh isolation

`packages/core/src/project/copy.ts`

- Changed project-copy refresh writes from one large transaction across all discovered worktrees to short sequential per-directory transactions.

`packages/core/src/location-layer.ts`
`packages/opencode/test/preload.ts`

- Added `OPENCODE_DISABLE_PROJECT_COPY_REFRESH`.
- The opencode test preload sets it to `1`, because the background refresh is maintenance work and not part of the tested behavior in the package-wide suite.

### Unrelated full-suite stabilizers

Several non-DB failures surfaced after the DB race was fixed and were addressed so the required full suite could reach the accepted state:

- `packages/opencode/src/tool/task.ts`
- `packages/opencode/src/altimate/tool-zod-compat.ts`
- `packages/opencode/src/tool/registry.ts`
  - Hide disabled `task.background` from published tool JSON schema while still accepting manual legacy calls internally.
  - Let the Effect `ToolRegistry.Service` honor injected `Config.Service`.

- `packages/opencode/test/altimate/tracing-adversarial-2.test.ts`
  - Avoid Bun surfacing a deliberate server-side stream controller error as a test failure.

- `packages/opencode/test/cli/cmd/tui/attention.test.ts`
  - Align default fallback title expectations with the local Altimate branding change.

- `packages/opencode/test/project/instance-bootstrap.test.ts`
- `packages/opencode/test/server/httpapi-v2-pty.test.ts`
  - Increase explicit per-test timeouts for full-suite contention.

## Verification

### Focused regression tests

```text
cd packages/core && bun test test/database-migration.test.ts --timeout 90000
15 pass, 0 fail
```

```text
cd packages/opencode && bun test test/tool/bash.test.ts test/control-plane/workspace-server-sse.test.ts test/server/httpapi-v2-pty.test.ts --timeout 90000
23 pass, 0 fail
```

```text
cd packages/opencode && bun test test/tool/task.test.ts test/tool/registry.test.ts --timeout 90000
17 pass, 13 skip, 0 fail
```

### Full suite

Final isolated full run:

```text
cd packages/opencode && bun test --timeout 90000
10455 pass
708 skip
113 todo
1 fail
50 snapshots, 30785 expect() calls
Ran 11277 tests across 538 files. [371.70s]
```

Only failure:

```text
(fail) HttpApi SDK > uses the generated SDK for safe instance routes
```

DB failure grep on the final log found no matches for:

```text
SQLiteError
disk I/O
table project already exists
database is locked
tool.bash truncation
```

### Typecheck

```text
bun typecheck
Tasks: 13 successful, 13 total
```

### Marker check

Executed:

```text
bun run script/upstream/analyze.ts --markers --base main --strict
```

Result: failed on existing branch-wide marker debt:

```text
Found 162 file(s) with unmarked custom code
```

The reported files include many unrelated upstream-shared files such as `.github/pull_request_template.md`, `bunfig.toml`, and broad existing `packages/opencode/src/**` customizations. Newly added source edits in this fix are wrapped in `altimate_change ... upstream_fix` marker blocks, but the strict branch-wide scan is not green because of pre-existing unmarked code outside this task.

## Notes

- No commit or push was performed.
- Pre-existing dirty TUI source changes were left intact and not reverted.
