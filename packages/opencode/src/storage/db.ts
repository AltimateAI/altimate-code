import { Database as BunDatabase } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
export * from "drizzle-orm"
import { Context } from "../util/context"
import { lazy } from "../util/lazy"
import { Global } from "../global"
import { Log } from "../util/log"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import * as schema from "./schema"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"
import { Effect } from "effect"
import freshSchema from "@opencode-ai/core/database/schema.gen"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })

export namespace Database {
  export const Path = iife(() => {
    // altimate_change upstream_fix — keep legacy storage on the same sqlite file
    // as core when callers override OPENCODE_DB.
    const overridden = process.env["OPENCODE_DB"]
    if (overridden) {
      if (overridden === ":memory:" || path.isAbsolute(overridden)) return overridden
      return path.join(Global.Path.data, overridden)
    }
    const channel = InstallationChannel
    if (["latest", "beta"].includes(channel) || Flag.OPENCODE_DISABLE_CHANNEL_DB)
      return path.join(Global.Path.data, "opencode.db")
    const safe = channel.replace(/[^a-zA-Z0-9._-]/g, "-")
    return path.join(Global.Path.data, `opencode-${safe}.db`)
  })

  type Schema = typeof schema
  export type Transaction = SQLiteTransaction<"sync", void, Schema>

  type Client = SQLiteBunDatabase

  type Journal = { sql: string; timestamp: number; name: string }[]

  const state = {
    sqlite: undefined as BunDatabase | undefined,
  }

  function time(tag: string) {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
    if (!match) return 0
    return Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    )
  }

  function migrations(dir: string): Journal {
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)

    const sql = dirs
      .map((name) => {
        const file = path.join(dir, name, "migration.sql")
        if (!existsSync(file)) return
        return {
          sql: readFileSync(file, "utf-8"),
          timestamp: time(name),
          name,
        }
      })
      .filter(Boolean) as Journal

    return sql.sort((a, b) => a.timestamp - b.timestamp)
  }

  // altimate_change start — fresh dev/test DBs need the current base schema before
  // fork-local Drizzle migrations can be considered applied. The fork migration
  // directory only carries deltas, while the canonical full schema lives in core.
  function userTables(sqlite: BunDatabase) {
    return (
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((row) => row.name)
  }

  function hasTable(sqlite: BunDatabase, table: string) {
    return !!sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  }

  function hasColumn(sqlite: BunDatabase, table: string, column: string) {
    return (sqlite.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as { name: string }[]).some(
      (row) => row.name === column,
    )
  }

  function addColumn(sqlite: BunDatabase, table: string, column: string, definition: string) {
    if (!hasTable(sqlite, table) || hasColumn(sqlite, table, column)) return false
    sqlite.run(`ALTER TABLE ${JSON.stringify(table)} ADD ${JSON.stringify(column)} ${definition}`)
    return true
  }

  function ensureDrizzleJournal(sqlite: BunDatabase) {
    sqlite.run(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id INTEGER PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric,
        name text,
        applied_at TEXT
      )
    `)
  }

  function markDrizzleEntriesApplied(sqlite: BunDatabase, entries: Journal) {
    ensureDrizzleJournal(sqlite)
    const appliedAt = new Date().toISOString()
    // altimate_change start — upstream_fix: make manual migration journal marks idempotent
    const insert = sqlite.prepare(
      `
        INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name", "applied_at")
        SELECT ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM "__drizzle_migrations" WHERE "name" = ?
        )
      `,
    )
    for (const entry of entries) {
      insert.run("", entry.timestamp, entry.name, appliedAt, entry.name)
    }
    // altimate_change end
  }

  function runFreshSchema(sqlite: BunDatabase) {
    const tx = {
      run: (query: string) =>
        Effect.sync(() => {
          sqlite.run(query)
        }),
    }
    Effect.runSync(freshSchema.up(tx as never))
  }

  function initializeFreshDatabase(sqlite: BunDatabase, entries: Journal) {
    if (userTables(sqlite).length > 0) return false

    log.info("initializing fresh database schema")
    sqlite
      .transaction(() => {
        runFreshSchema(sqlite)
        markDrizzleEntriesApplied(sqlite, entries)
      })()
    return true
  }

  function adoptCoreOwnedDatabase(sqlite: BunDatabase, entries: Journal) {
    // altimate_change start — upstream_fix: detect a core-owned schema in PRODUCTION, not only tests.
    // The core database (packages/core) and this legacy storage layer share one sqlite file
    // (Global.Path.data/opencode.db). On a FRESH install core runs first and creates its own
    // `migration` journal table plus the `session` table (already including columns like
    // `metadata`). Re-running the legacy storage migrations then duplicates those columns and
    // crashes ("ALTER TABLE `session` ADD `metadata`"), which kills /provider so no model
    // resolves. Adopt (mark the storage journal applied) instead. Previously this only fired
    // under OPENCODE_TEST_CORE_DB_OWNER=1, so production fresh installs fell through to migrate()
    // and were unusable — green tests masked it because tests set that flag.
    const coreOwned = hasTable(sqlite, "migration") && hasTable(sqlite, "session")
    if (process.env["OPENCODE_TEST_CORE_DB_OWNER"] !== "1" && !coreOwned) return false
    // altimate_change end
    if (!hasTable(sqlite, "session")) return false

    log.info("adopting core-owned database schema")
    sqlite
      .transaction(() => {
        markDrizzleEntriesApplied(sqlite, entries)
      })()
    return true
  }

  function repairLegacyDatabase(sqlite: BunDatabase, entries: Journal) {
    if (userTables(sqlite).length === 0) return false

    let changed = false
    sqlite
      .transaction(() => {
        changed = addColumn(sqlite, "project", "icon_url_override", "text") || changed
        if (changed && hasColumn(sqlite, "project", "icon_url")) {
          sqlite.run(`UPDATE "project" SET "icon_url_override" = "icon_url" WHERE "icon_url_override" IS NULL`)
        }

        changed = addColumn(sqlite, "workspace", "time_used", "integer NOT NULL DEFAULT 0") || changed
        changed = addColumn(sqlite, "event_sequence", "owner_id", "text") || changed

        changed = addColumn(sqlite, "session", "path", "text") || changed
        changed = addColumn(sqlite, "session", "metadata", "text") || changed
        changed = addColumn(sqlite, "session", "cost", "real DEFAULT 0 NOT NULL") || changed
        changed = addColumn(sqlite, "session", "tokens_input", "integer DEFAULT 0 NOT NULL") || changed
        changed = addColumn(sqlite, "session", "tokens_output", "integer DEFAULT 0 NOT NULL") || changed
        changed = addColumn(sqlite, "session", "tokens_reasoning", "integer DEFAULT 0 NOT NULL") || changed
        changed = addColumn(sqlite, "session", "tokens_cache_read", "integer DEFAULT 0 NOT NULL") || changed
        changed = addColumn(sqlite, "session", "tokens_cache_write", "integer DEFAULT 0 NOT NULL") || changed
        changed = addColumn(sqlite, "session", "agent", "text") || changed
        changed = addColumn(sqlite, "session", "model", "text") || changed

        if (!hasTable(sqlite, "project_directory")) {
          changed = true
          sqlite.run(`
            CREATE TABLE "project_directory" (
              "project_id" text NOT NULL,
              "directory" text NOT NULL,
              "type" text,
              "strategy" text,
              "time_created" integer NOT NULL,
              PRIMARY KEY("project_id", "directory"),
              FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE
            )
          `)
        }

        if (!hasTable(sqlite, "session_message")) {
          changed = true
          sqlite.run(`
            CREATE TABLE "session_message" (
              "id" text PRIMARY KEY,
              "session_id" text NOT NULL,
              "type" text NOT NULL,
              "seq" integer NOT NULL,
              "time_created" integer NOT NULL,
              "time_updated" integer NOT NULL,
              "data" text NOT NULL,
              FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE
            )
          `)
          sqlite.run(`CREATE UNIQUE INDEX IF NOT EXISTS "session_message_session_seq_idx" ON "session_message" ("session_id","seq")`)
          sqlite.run(`CREATE INDEX IF NOT EXISTS "session_message_session_type_seq_idx" ON "session_message" ("session_id","type","seq")`)
          sqlite.run(`CREATE INDEX IF NOT EXISTS "session_message_session_time_created_id_idx" ON "session_message" ("session_id","time_created","id")`)
          sqlite.run(`CREATE INDEX IF NOT EXISTS "session_message_time_created_idx" ON "session_message" ("time_created")`)
        }

        if (!hasTable(sqlite, "session_input")) {
          changed = true
          sqlite.run(`
            CREATE TABLE "session_input" (
              "id" text PRIMARY KEY,
              "session_id" text NOT NULL,
              "prompt" text NOT NULL,
              "delivery" text NOT NULL,
              "admitted_seq" integer NOT NULL,
              "promoted_seq" integer,
              "time_created" integer NOT NULL,
              FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE
            )
          `)
          sqlite.run(`CREATE INDEX IF NOT EXISTS "session_input_session_pending_delivery_seq_idx" ON "session_input" ("session_id","promoted_seq","delivery","admitted_seq")`)
          sqlite.run(`CREATE UNIQUE INDEX IF NOT EXISTS "session_input_session_admitted_seq_idx" ON "session_input" ("session_id","admitted_seq")`)
          sqlite.run(`CREATE UNIQUE INDEX IF NOT EXISTS "session_input_session_promoted_seq_idx" ON "session_input" ("session_id","promoted_seq")`)
        }

        if (!hasTable(sqlite, "session_context_epoch")) {
          changed = true
          sqlite.run(`
            CREATE TABLE "session_context_epoch" (
              "session_id" text PRIMARY KEY,
              "baseline" text NOT NULL,
              "agent" text DEFAULT 'build' NOT NULL,
              "snapshot" text NOT NULL,
              "baseline_seq" integer NOT NULL,
              "replacement_seq" integer,
              "revision" integer DEFAULT 0 NOT NULL,
              FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE
            )
          `)
        }

        if (!hasTable(sqlite, "credential")) {
          changed = true
          sqlite.run(`
            CREATE TABLE "credential" (
              "id" text PRIMARY KEY,
              "integration_id" text,
              "label" text NOT NULL,
              "value" text NOT NULL,
              "connector_id" text,
              "method_id" text,
              "active" integer,
              "time_created" integer NOT NULL,
              "time_updated" integer NOT NULL
            )
          `)
        }

        if (changed) {
          log.info("repaired legacy database schema")
          markDrizzleEntriesApplied(sqlite, entries)
        }
      })()
    return changed
  }
  // altimate_change end

  // altimate_change start — backfill migration names for upgrade compatibility
  function backfillMigrationNames(sqlite: BunDatabase, entries: Journal) {
    try {
      // Check if the migrations table exists and has the name column
      const tableInfo = sqlite.prepare("SELECT name FROM pragma_table_info('__drizzle_migrations')").all() as {
        name: string
      }[]
      if (!tableInfo.length || !tableInfo.some((c) => c.name === "name")) return

      // Find entries with NULL or empty names
      const rows = sqlite
        .prepare("SELECT created_at FROM __drizzle_migrations WHERE name IS NULL OR name = ''")
        .all() as { created_at: number }[]
      if (!rows.length) return

      log.info("backfilling migration names", { count: rows.length })

      // Build timestamp → name lookup from local migrations
      const byTimestamp = new Map<number, string>()
      for (const entry of entries) {
        byTimestamp.set(entry.timestamp, entry.name)
      }

      const stmt = sqlite.prepare("UPDATE __drizzle_migrations SET name = ? WHERE created_at = ?")
      for (const row of rows) {
        const name = byTimestamp.get(row.created_at)
        if (name) {
          stmt.run(name, row.created_at)
        }
      }
    } catch (e) {
      log.info("migration name backfill skipped", {
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  // altimate_change end

  // altimate_change start — upstream_fix: collapse duplicate manual migration journal marks
  function dedupeDrizzleJournal(sqlite: BunDatabase) {
    try {
      const tableInfo = sqlite.prepare("SELECT name FROM pragma_table_info('__drizzle_migrations')").all() as {
        name: string
      }[]
      const hasName = tableInfo.some((c) => c.name === "name")
      const hasID = tableInfo.some((c) => c.name === "id")
      if (!tableInfo.length || !hasName || !hasID) return

      const result = sqlite
        .prepare(
          `
            DELETE FROM "__drizzle_migrations"
            WHERE "name" IS NOT NULL
              AND "name" != ''
              AND "id" NOT IN (
                SELECT MIN("id")
                FROM "__drizzle_migrations"
                WHERE "name" IS NOT NULL AND "name" != ''
                GROUP BY "name"
              )
          `,
        )
        .run() as { changes: number }
      if (result.changes > 0) {
        log.info("deduplicated migration journal entries", { count: result.changes })
      }
    } catch (e) {
      log.info("migration journal dedupe skipped", {
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  // altimate_change end

  export const Client = lazy(() => {
    log.info("opening database", { path: Path })

    const sqlite = new BunDatabase(Path, { create: true })
    state.sqlite = sqlite

    sqlite.run("PRAGMA journal_mode = WAL")
    sqlite.run("PRAGMA synchronous = NORMAL")
    sqlite.run("PRAGMA busy_timeout = 5000")
    sqlite.run("PRAGMA cache_size = -64000")
    sqlite.run("PRAGMA foreign_keys = ON")
    sqlite.run("PRAGMA wal_checkpoint(PASSIVE)")

    const db = drizzle({ client: sqlite })

    // Apply schema migrations
    const entries =
      typeof OPENCODE_MIGRATIONS !== "undefined"
        ? OPENCODE_MIGRATIONS
        : migrations(path.join(import.meta.dirname, "../../migration"))
    if (entries.length > 0) {
      log.info("applying migrations", {
        count: entries.length,
        mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
      if (Flag.OPENCODE_SKIP_MIGRATIONS) {
        for (const item of entries) {
          item.sql = "select 1;"
        }
      }
      const adopted = adoptCoreOwnedDatabase(sqlite, entries)
      const initialized = adopted ? false : initializeFreshDatabase(sqlite, entries)
      const repaired = adopted || initialized ? false : repairLegacyDatabase(sqlite, entries)
      // altimate_change start — backfill migration names before migrate
      backfillMigrationNames(sqlite, entries)
      // altimate_change end
      // altimate_change start — upstream_fix: remove any duplicate manual journal marks before migrate
      dedupeDrizzleJournal(sqlite)
      // altimate_change end
      // altimate_change start — upstream_fix: the fork's PermissionNext reads a single JSON `data`
      // column from `permission` (packages/opencode/src/permission/permission.sql.ts), but a fresh or
      // core-owned database creates core's permission(action, resource) shape with NO `data` column.
      // The first permission read then throws "no such column: data" on every fresh install, blocking
      // all tool approvals. Ensure the fork-compatible column exists (idempotent; reads default null→[]).
      try {
        if (hasTable(sqlite, "permission")) addColumn(sqlite, "permission", "data", "text")
      } catch (e) {
        log.info("ensure permission.data column skipped", { error: e instanceof Error ? e.message : String(e) })
      }
      // altimate_change end
      if (!adopted && !initialized && !repaired) migrate(db, entries)
    }

    return db
  })

  export function close() {
    const sqlite = state.sqlite
    if (!sqlite) return
    sqlite.close()
    state.sqlite = undefined
    Client.reset()
  }

  export type TxOrDb = SQLiteTransaction<"sync", void, any, any> | Client

  const ctx = Context.create<{
    tx: TxOrDb
    effects: (() => void | Promise<void>)[]
  }>("database")

  export function use<T>(callback: (trx: TxOrDb) => T): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()))
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }

  export function effect(fn: () => any | Promise<any>) {
    try {
      ctx.use().effects.push(fn)
    } catch {
      fn()
    }
  }

  // altimate_change start — pass-through `behavior` option (deferred|immediate|exclusive).
  // SyncEvent.run requires "immediate" to safely read-then-write the event sequence.
  export type TransactionConfig = { behavior?: "deferred" | "immediate" | "exclusive" }
  // altimate_change end

  export function transaction<T>(callback: (tx: TxOrDb) => T, config?: TransactionConfig): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = (Client().transaction as any)((tx: TxOrDb) => {
          return ctx.provide({ tx, effects }, () => callback(tx))
        }, config)
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }
}
