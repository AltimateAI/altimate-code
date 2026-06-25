export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
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

export const currentSchemaColumns = {
  credential: ["integration_id", "connector_id", "method_id", "active"],
  event_sequence: ["owner_id"],
  permission: ["action", "resource"],
  project: ["commands", "icon_url_override", "sandboxes"],
  project_directory: ["strategy", "time_created", "type"],
  session: [
    "agent",
    "cost",
    "metadata",
    "model",
    "path",
    "tokens_cache_read",
    "tokens_cache_write",
    "tokens_input",
    "tokens_output",
    "tokens_reasoning",
    "workspace_id",
  ],
  session_context_epoch: ["agent", "baseline_seq", "replacement_seq", "revision", "snapshot"],
  session_input: ["admitted_seq", "delivery", "promoted_seq"],
  session_message: ["data", "seq", "type"],
  workspace: ["directory", "extra", "time_used", "type"],
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
      yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            // altimate_change start — upstream_fix: re-check under BEGIN IMMEDIATE.
            const current = yield* userTables(tx)
            if (current.some((table) => table.name === "session")) {
              yield* ensureMigrationTable(tx)
              yield* markMigrationsApplied(tx, migrations)
              return
            }
            if (current.length > 0) return yield* Effect.die("Database is not empty and has no session table")
            // altimate_change end

            yield* schema.up(tx)
            yield* ensureMigrationTable(tx)
            yield* markMigrationsApplied(tx, migrations)
          }),
        { behavior: "immediate" },
      )
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
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* migration.up(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
    }
  })
}
