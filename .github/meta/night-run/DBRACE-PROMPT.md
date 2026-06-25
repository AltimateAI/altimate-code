# Fix the test-suite DB migration race (CI blocker for PR #964)

You are an autonomous engineer fixing the **real CI blocker** on branch `upstream/merge-v1.17.9` (altimate-code, an OpenCode fork). Be thorough, verify empirically, do NOT ask questions.

- Working dir: `/Users/anandgupta/codebase/altimate-code/.claude/worktrees/get_latest_upstream`
- Local bun is **1.3.14** (matches repo `packageManager`); run `bun` directly.

## Symptom
`cd packages/opencode && bun test --timeout 90000` produces **~324 failures** clustered as
`SQLiteError: table \`project\` already exists` (thrown at `packages/core/src/database/sqlite.bun.ts:58`,
the native query exec). The failures cascade across every DB-dependent test group (Project*, Worktree,
MessageV2*, tool.*, compaction, InstanceStore, Format, permission, etc.).

KEY FACTS (already established — do not re-litigate):
- It is **NOT external contention**: with nothing else running, the full suite still fails ~324.
  CI on bun 1.3.10 had 1437 `already exists` log lines too — so it is **inherent + version-independent**.
- It is a **parallel-test race**, NOT a production bug: `cd packages/opencode && bun test test/project/`
  in isolation passes **86/0**. Production boots one process and migrates once, so the shipped CLI is fine.
- Legacy `db.ts` paths are NOT the culprit: in a full run, log markers show `initializing fresh database`=0,
  `adopting core-owned`=1. The failing CREATE comes from **core** `schema.up` (the fresh-DB path).

## How the test DB is set up
- `packages/opencode/test/preload.ts` builds ONE shared file DB at `$OPENCODE_DB`
  (`<tmpdir>/share/altimate-code/opencode-local.db`), migrates it ONCE via
  `CoreDatabase.layerFromPath(testDb)` (the core `layer` runs `DatabaseMigration.apply(db)` on construct —
  see `packages/core/src/database/database.ts:22-40`), and sets `OPENCODE_TEST_CORE_DB_OWNER=1`.
- Core migration runner: `packages/core/src/database/migration.ts`.
  - `apply()` (line 37) wraps a module-level `Semaphore.makeUnsafe(1)` lock (line 12).
  - Line 40-41: reads `userTables`; if `session` table exists → `applyOnly` (idempotent, tracked in the
    `migration` table). Else → fresh path inside a `{ behavior: "immediate" }` transaction (line 43-61)
    with a re-check (the `altimate_change upstream_fix` at 46-54) then `schema.up(tx)` (CREATE everything).

## Your job
Make `cd packages/opencode && bun test --timeout 90000` go GREEN (target: 0 fail, or only the single
known `httpapi-sdk` "uses the generated SDK for safe instance routes" fail which is a stale-codegen issue —
leave that one if it remains). The shipped product must keep migrating correctly on a normal single-process
boot. Do not weaken real schema correctness.

### Investigate these hypotheses (in order of likelihood)
1. **The `Semaphore` lock is not shared across all callers** — core's `migration.ts` may be instantiated
   more than once (different import specifiers: `@opencode-ai/core/database` vs `.../database/database` vs a
   deep `./migration` path vs any bundled copy). Multiple module instances → multiple locks → `apply()` runs
   concurrently across parallel test files → fresh path races. Verify by logging the lock identity / module
   URL at import. If true, fix by making serialization robust (e.g., a single shared lock keyed on the DB
   file, or serialize at the SQLite level).
2. **`{ behavior: "immediate" }` does not actually emit `BEGIN IMMEDIATE`** in `@opencode-ai/effect-drizzle-sqlite`
   / `sqlite.bun.ts`, so the re-check transaction takes no early RESERVED lock and two fibers both read empty
   then both CREATE. Verify by checking the transaction-begin SQL emitted. If true, ensure IMMEDIATE is used
   AND set a `busy_timeout` (PRAGMA) so a losing writer waits + re-checks instead of proceeding/erroring.
3. **Connection/WAL visibility**: a fresh connection doesn't see the preload-migrated tables. The preload does
   `PRAGMA wal_checkpoint(FULL)`; confirm tables are actually committed to the main db file and visible to new
   connections.

### Acceptable fixes (pick the most robust + least invasive; combine if needed)
- Make `schema.up` idempotent (`CREATE TABLE IF NOT EXISTS`, indexes `IF NOT EXISTS`) so a racing fresh path
  is harmless. NOTE `schema.gen.ts` / `migration.gen.ts` may be generated — if so, fix the generator/source
  (`schema.sql.ts`) and regenerate, OR guard at the runner level instead.
- Add `PRAGMA busy_timeout=<ms>` on every connection + ensure real `BEGIN IMMEDIATE` so writers serialize.
- Truly serialize `apply()` across instances (shared lock).
- Short-circuit core `apply()` to a no-op when the DB is already fully migrated (robust check), so post-preload
  test calls never re-run the fresh path.

### Constraints
- Wrap any edit under `packages/opencode/src/` or `packages/core/src/` in
  `// altimate_change start — upstream_fix: <desc>` / `// altimate_change end` markers (this is a bug fix).
- After fixing, run the FULL suite **alone** (no other binary/DB processes): `cd packages/opencode && bun test --timeout 90000 2>&1 | tail -40`. Iterate until green.
- Run `bun run script/upstream/analyze.ts --markers --base main --strict` and fix any warnings on touched src files.
- Run `bun typecheck` (from repo root) — must be 0.
- Do NOT commit or push. Leave the working tree with the fix applied + write a report to
  `.github/meta/night-run/DBRACE-FIX.md` (root cause, the fix, before/after suite counts, files touched).
