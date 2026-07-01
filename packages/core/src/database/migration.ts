export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Cause, Effect, Exit, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
type Target = Pick<Database, "all" | "get" | "run">
const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

function userTables(db: Target) {
  return db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
}

function ensureMigrationTable(db: Target) {
  return db.run(
    sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
  )
}

function markMigrationsApplied(db: Target, input: Migration[]) {
  return Effect.forEach(input, (migration) =>
    db.run(
      sql`INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
    ),
  )
}

// altimate_change start — upstream_fix: seed the core journal for already-current schemas.
// EXPORTED for the drift-guard test (database-migration.test.ts): these hardcoded lists are a
// fingerprint of the generated schema (schema.gen). If a migration adds/renames/removes a schema
// object without updating this fingerprint, `currentSchemaApplied` silently misfires. The drift
// guard fails loudly when the fingerprint diverges from the generated schema, forcing an update.
export const currentSchemaTables = [
  "account",
  "account_state",
  "control_account",
  "credential",
  "data_migration",
  "event",
  "event_sequence",
  "message",
  "part",
  "permission",
  "project",
  "project_directory",
  "session",
  "session_context_epoch",
  "session_input",
  "session_message",
  "session_share",
  "todo",
  "workspace",
] as const

// COMPLETE per-table column set of the generated schema (NOT a curated subset). Completeness is
// required for soundness: currentSchemaApplied adopts (marks missing migrations applied) when this
// fingerprint matches, so if any column the schema declares were omitted here, an ADD COLUMN
// migration that adds it could be marked applied without running — silently dropping the column. The
// drift-guard test asserts BOTH directions (every listed column is live AND every live column is
// listed), so a forgotten column on the next schema change fails CI loudly instead of being lost.
export const currentSchemaColumns = {
  account: ["id", "email", "url", "access_token", "refresh_token", "token_expiry", "time_created", "time_updated"],
  account_state: ["id", "active_account_id", "active_org_id"],
  control_account: ["email", "url", "access_token", "refresh_token", "token_expiry", "active", "time_created", "time_updated"],
  credential: ["id", "integration_id", "label", "value", "connector_id", "method_id", "active", "time_created", "time_updated"],
  data_migration: ["name", "time_completed"],
  event: ["id", "aggregate_id", "seq", "type", "data"],
  event_sequence: ["aggregate_id", "seq", "owner_id"],
  message: ["id", "session_id", "time_created", "time_updated", "data"],
  part: ["id", "message_id", "session_id", "time_created", "time_updated", "data"],
  permission: ["id", "project_id", "action", "resource", "time_created", "time_updated"],
  project: ["id", "worktree", "vcs", "name", "icon_url", "icon_url_override", "icon_color", "time_created", "time_updated", "time_initialized", "sandboxes", "commands"],
  project_directory: ["project_id", "directory", "type", "strategy", "time_created"],
  session: ["id", "project_id", "workspace_id", "parent_id", "slug", "directory", "path", "title", "version", "share_url", "summary_additions", "summary_deletions", "summary_files", "summary_diffs", "metadata", "cost", "tokens_input", "tokens_output", "tokens_reasoning", "tokens_cache_read", "tokens_cache_write", "revert", "permission", "agent", "model", "time_created", "time_updated", "time_compacting", "time_archived"],
  session_context_epoch: ["session_id", "baseline", "agent", "snapshot", "baseline_seq", "replacement_seq", "revision"],
  session_input: ["id", "session_id", "prompt", "delivery", "admitted_seq", "promoted_seq", "time_created"],
  session_message: ["id", "session_id", "type", "seq", "time_created", "time_updated", "data"],
  session_share: ["session_id", "id", "secret", "url", "time_created", "time_updated"],
  todo: ["session_id", "content", "status", "priority", "position", "time_created", "time_updated"],
  workspace: ["id", "type", "name", "branch", "directory", "extra", "project_id", "time_used"],
} as const

export const currentSchemaIndexes = [
  "event_aggregate_seq_idx",
  "event_aggregate_type_seq_idx",
  "message_session_time_created_id_idx",
  "part_message_id_id_idx",
  "part_session_idx",
  "permission_project_action_resource_idx",
  "session_input_session_admitted_seq_idx",
  "session_input_session_pending_delivery_seq_idx",
  "session_input_session_promoted_seq_idx",
  "session_message_session_seq_idx",
  "session_message_session_time_created_id_idx",
  "session_message_session_type_seq_idx",
  "session_message_time_created_idx",
  "session_parent_idx",
  "session_project_idx",
  "session_workspace_idx",
  "todo_session_idx",
] as const

function currentSchemaApplied(db: Target) {
  return Effect.gen(function* () {
    const tableNames = new Set((yield* userTables(db)).map((table) => table.name))
    if (currentSchemaTables.some((table) => !tableNames.has(table))) return false

    for (const [table, required] of Object.entries(currentSchemaColumns)) {
      const columns = new Set(
        (yield* db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info(${table})`)).map(
          (column) => column.name,
        ),
      )
      if (required.some((column) => !columns.has(column))) return false
    }

    const indexNames = new Set(
      (yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`,
      )).map((index) => index.name),
    )
    return currentSchemaIndexes.every((index) => indexNames.has(index))
  })
}
// altimate_change end

export function apply(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      const tables = yield* userTables(db)
      if (tables.some((table) => table.name === "session")) return yield* applyOnly(db, migrations)
      if (tables.length > 0) return yield* Effect.die("Database is not empty and has no session table")
      // altimate_change start — upstream_fix: create the generated schema under BEGIN IMMEDIATE,
      // re-checking inside for a concurrent creator. If another process (possibly an OLDER binary that
      // won the write lock) created the schema during the race, do NOT blindly mark our whole
      // migration list applied — that would leave the DB at the other schema while recording newer
      // migrations as done, a permanently-lost migration. Instead fall through to applyOnly(db), which
      // only adopts when the schema actually matches (currentSchemaApplied) and otherwise runs the
      // still-missing migrations.
      let createdHere = false
      yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const current = yield* userTables(tx)
            if (current.some((table) => table.name === "session")) return // concurrent creator — applyOnly below
            if (current.length > 0) return yield* Effect.die("Database is not empty and has no session table")
            yield* schema.up(tx)
            yield* ensureMigrationTable(tx)
            yield* markMigrationsApplied(tx, migrations)
            createdHere = true
          }),
        { behavior: "immediate" },
      )
      if (!createdHere) return yield* applyOnly(db, migrations)
      // altimate_change end
    }),
  )
}

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    yield* ensureMigrationTable(db)
    let completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    // altimate_change start — upstream_fix: do not replay baseline CREATE migrations
    // when another migrator has already installed the current generated schema. The
    // fingerprint check and the journal write run together under BEGIN IMMEDIATE so a
    // concurrent migrator cannot slip a real migration between our check and our mark
    // (closes the currentSchemaApplied TOCTOU).
    const missing = input.filter((migration) => !completed.has(migration.id))
    if (missing.length > 0) {
      const adopted = yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            if (!(yield* currentSchemaApplied(tx))) return false
            yield* markMigrationsApplied(tx, missing)
            return true
          }),
        { behavior: "immediate" },
      )
      if (adopted) return
    }
    // altimate_change end

    if (completed.size === 0) {
      // Existing installs used Drizzle's migration journal. Seed the new
      // journal once so TypeScript migrations don't replay old SQL.
      if (
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`)
      ) {
        yield* db.run(sql`
          INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
          SELECT name, ${Date.now()}
          FROM ${sql.identifier("__drizzle_migrations")}
          WHERE name IS NOT NULL
        `)
        completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
        )
      }
    }

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      // altimate_change start — upstream_fix: idempotent adopt for schema objects a prior layer
      // already created. On mixed old/new-binary databases the legacy storage layer
      // (packages/opencode storage/db.ts, e.g. its guarded `addColumn(project, icon_url_override)`)
      // may have already ADDed a column that a core migration also ADDs, WITHOUT recording that
      // migration in this journal. Re-running the unguarded `ALTER TABLE ... ADD COLUMN` then throws
      // "duplicate column name" and crashes startup. SQLite has no `ADD COLUMN IF NOT EXISTS`, so
      // treat a "schema object already exists" failure as the migration already being effectively
      // applied: record its id and continue. Any other failure re-raises faithfully (failure OR
      // defect — SQL errors here surface as defects), so real migration breakage still crashes loudly.
      const exit = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* migration.up(tx)
            yield* tx.run(
              sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
            )
          }),
        )
        .pipe(Effect.exit)
      if (Exit.isFailure(exit)) {
        if (!isSchemaObjectExistsError(Cause.pretty(exit.cause))) return yield* Effect.failCause(exit.cause)
        yield* Effect.logWarning("adopting migration whose schema object already exists", { id: migration.id })
        yield* db.run(
          sql`INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
        )
      }
      // altimate_change end
    }
  })
}

// altimate_change start — upstream_fix: recognize SQLite "schema object already exists" errors so
// additive migrations can be adopted idempotently on mixed old/new-binary databases (see applyOnly).
function isSchemaObjectExistsError(message: string): boolean {
  return /duplicate column name|already exists/i.test(message)
}
// altimate_change end
