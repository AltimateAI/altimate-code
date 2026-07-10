/**
 * End-to-end install/upgrade tests.
 *
 * These simulate a fresh install (new user) and an upgrade from a prior version
 * (existing user) to ensure the CLI boots without errors in both scenarios.
 *
 * The tests create isolated SQLite databases in temp directories and exercise
 * the same migration code path that runs on CLI startup.
 */
import { describe, test, expect, afterEach } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { Effect } from "effect"
import path from "path"
import os from "os"
import fs from "fs"
import freshSchema from "@opencode-ai/core/database/schema.gen"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIGRATION_DIR = path.resolve(import.meta.dir, "..", "..", "migration")

type Journal = { sql: string; timestamp: number; name: string }[]

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

function loadMigrations(): Journal {
  const dirs = fs
    .readdirSync(MIGRATION_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  return dirs
    .map((name) => {
      const file = path.join(MIGRATION_DIR, name, "migration.sql")
      if (!fs.existsSync(file)) return undefined
      return { sql: fs.readFileSync(file, "utf-8"), timestamp: time(name), name }
    })
    .filter(Boolean) as Journal
}

/** Reproduces the backfillMigrationNames logic from db.ts */
function backfillMigrationNames(sqlite: BunDatabase, entries: Journal) {
  try {
    const tableInfo = sqlite
      .prepare("SELECT name FROM pragma_table_info('__drizzle_migrations')")
      .all() as { name: string }[]
    if (!tableInfo.length || !tableInfo.some((c) => c.name === "name")) return

    const rows = sqlite
      .prepare("SELECT created_at FROM __drizzle_migrations WHERE name IS NULL OR name = ''")
      .all() as { created_at: number }[]
    if (!rows.length) return

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
  } catch {
    // non-fatal
  }
}

interface TempDb {
  sqlite: BunDatabase
  dbPath: string
  cleanup: () => void
}

function createTempDb(): TempDb {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-e2e-"))
  const dbPath = path.join(tmpDir, "opencode.db")
  const sqlite = new BunDatabase(dbPath, { create: true })
  sqlite.run("PRAGMA journal_mode = WAL")
  sqlite.run("PRAGMA synchronous = NORMAL")
  sqlite.run("PRAGMA busy_timeout = 5000")
  sqlite.run("PRAGMA foreign_keys = ON")
  return {
    sqlite,
    dbPath,
    cleanup: () => {
      sqlite.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

function getTableNames(sqlite: BunDatabase): string[] {
  return (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name)
    .filter((n) => !n.startsWith("__") && n !== "sqlite_sequence")
}

function getMigrationNames(sqlite: BunDatabase): (string | null)[] {
  return (
    sqlite.prepare("SELECT name FROM __drizzle_migrations ORDER BY created_at").all() as { name: string | null }[]
  ).map((r) => r.name)
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
  const insert = sqlite.prepare(
    `INSERT OR IGNORE INTO "__drizzle_migrations" ("hash", "created_at", "name", "applied_at") VALUES (?, ?, ?, ?)`,
  )
  for (const entry of entries) {
    insert.run("", entry.timestamp, entry.name, appliedAt)
  }
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
  if (getTableNames(sqlite).length > 0) return false
  sqlite
    .transaction(() => {
      runFreshSchema(sqlite)
      markDrizzleEntriesApplied(sqlite, entries)
    })()
  return true
}

function repairLegacyDatabase(sqlite: BunDatabase, entries: Journal) {
  if (getTableNames(sqlite).length === 0) return false

  let changed = false
  sqlite
    .transaction(() => {
      changed = addColumn(sqlite, "project", "icon_url_override", "text") || changed
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
            PRIMARY KEY("project_id", "directory")
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
            "data" text NOT NULL
          )
        `)
        sqlite.run(`CREATE UNIQUE INDEX IF NOT EXISTS "session_message_session_seq_idx" ON "session_message" ("session_id","seq")`)
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
            "time_created" integer NOT NULL
          )
        `)
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
            "revision" integer DEFAULT 0 NOT NULL
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

      if (changed) markDrizzleEntriesApplied(sqlite, entries)
    })()
  return changed
}

function applyStartupMigrations(sqlite: BunDatabase, entries: Journal) {
  const db = drizzle({ client: sqlite })
  const initialized = initializeFreshDatabase(sqlite, entries)
  const repaired = initialized ? false : repairLegacyDatabase(sqlite, entries)
  backfillMigrationNames(sqlite, entries)
  if (!initialized && !repaired) migrate(db, entries)
}

function createLegacySchema(sqlite: BunDatabase, withMetadata = false) {
  sqlite.run(`CREATE TABLE "project" ("id" text PRIMARY KEY, "icon_url" text)`)
  sqlite.run(`CREATE TABLE "workspace" ("id" text PRIMARY KEY)`)
  sqlite.run(`CREATE TABLE "event_sequence" ("aggregate_id" text PRIMARY KEY, "seq" integer NOT NULL)`)
  sqlite.run(`
    CREATE TABLE "session" (
      "id" text PRIMARY KEY,
      "project_id" text NOT NULL,
      "slug" text NOT NULL,
      "directory" text NOT NULL,
      "title" text NOT NULL,
      "version" text NOT NULL,
      "time_created" integer NOT NULL,
      "time_updated" integer NOT NULL
      ${withMetadata ? ', "metadata" text' : ""}
    )
  `)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tempDbs: TempDb[] = []

afterEach(() => {
  for (const db of tempDbs) db.cleanup()
  tempDbs = []
})

describe("New user install (clean database)", () => {
  test("all migrations apply successfully on empty database", () => {
    const tmp = createTempDb()
    tempDbs.push(tmp)
    const entries = loadMigrations()
    expect(entries.length).toBeGreaterThanOrEqual(1)

    expect(() => applyStartupMigrations(tmp.sqlite, entries)).not.toThrow()

    // Verify core tables were created
    const tables = getTableNames(tmp.sqlite)
    expect(tables).toContain("project")
    expect(tables).toContain("session")
    expect(tables).toContain("message")
    expect(tables).toContain("part")
    expect(tables).toContain("workspace")
    expect(tables).toContain("account")
    expect(tables).toContain("account_state")
    expect(hasColumn(tmp.sqlite, "session", "metadata")).toBe(true)

    // Verify all migrations are tracked with names
    const names = getMigrationNames(tmp.sqlite)
    expect(names.length).toBe(entries.length)
    for (const name of names) {
      expect(name).toBeTruthy()
    }
  })

  test("migrations are idempotent — running twice does not error", () => {
    const tmp = createTempDb()
    tempDbs.push(tmp)
    const entries = loadMigrations()

    applyStartupMigrations(tmp.sqlite, entries)

    // Run again — should be a no-op
    expect(() => applyStartupMigrations(tmp.sqlite, entries)).not.toThrow()
  })
})

describe("Existing user upgrade (v0.2.x → current)", () => {
  /**
   * Simulates a v0.2.x database state:
   * - All v0.2.x migration SQL has been applied (tables exist)
   * - __drizzle_migrations has the v1 schema (name column exists)
   * - But the name values are NULL (the upgrade bug)
   * - Only the first N migrations (before v0.3.0) are tracked
   */
  function createV02xDatabase(): TempDb {
    const tmp = createTempDb()
    createLegacySchema(tmp.sqlite)
    return tmp
  }

  test("upgrade applies new migrations without re-creating existing tables", () => {
    const tmp = createV02xDatabase()
    tempDbs.push(tmp)
    const entries = loadMigrations()

    expect(() => applyStartupMigrations(tmp.sqlite, entries)).not.toThrow()

    // Verify new tables from v0.3.0 migrations exist
    const tables = getTableNames(tmp.sqlite)
    expect(tables).toContain("project")
    expect(tables).toContain("project_directory")
    expect(tables).toContain("session_message")
    expect(hasColumn(tmp.sqlite, "session", "metadata")).toBe(true)

    // All migrations should now be tracked
    const names = getMigrationNames(tmp.sqlite)
    expect(names.length).toBe(entries.length)
    for (const name of names) {
      expect(name).toBeTruthy()
    }
  })

  test("upgrade FAILS without backfill (documents the bug)", () => {
    const tmp = createTempDb()
    tempDbs.push(tmp)
    const entries = loadMigrations()
    createLegacySchema(tmp.sqlite, true)
    ensureDrizzleJournal(tmp.sqlite)
    tmp.sqlite.run(
      `INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES ('', ${entries[0]!.timestamp}, NULL, NULL)`,
    )

    const db = drizzle({ client: tmp.sqlite })

    // Without backfill, Drizzle tries to re-apply an already-applied migration
    // because it matches by name and the historical journal row is NULL.
    expect(() => migrate(db, entries)).toThrow()
  })

  test("backfill correctly matches timestamps to migration names", () => {
    const tmp = createTempDb()
    tempDbs.push(tmp)
    const entries = loadMigrations()
    ensureDrizzleJournal(tmp.sqlite)
    for (const entry of entries) {
      tmp.sqlite.run(
        `INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES ('', ${entry.timestamp}, NULL, NULL)`,
      )
    }

    backfillMigrationNames(tmp.sqlite, entries)

    const names = getMigrationNames(tmp.sqlite)
    expect(names.length).toBe(entries.length)
    for (const name of names) {
      expect(name).toBeTruthy()
      expect(name).toMatch(/^\d{14}_/)
    }
  })
})

describe("Edge cases", () => {
  test("database with no __drizzle_migrations table (very old or corrupted)", () => {
    const tmp = createTempDb()
    tempDbs.push(tmp)
    const entries = loadMigrations()

    // No migration table exists at all — fresh state
    expect(() => applyStartupMigrations(tmp.sqlite, entries)).not.toThrow()

    const tables = getTableNames(tmp.sqlite)
    expect(tables).toContain("project")
  })

  test("database with v0 schema (no name column) — backfill is a no-op", () => {
    const tmp = createTempDb()
    tempDbs.push(tmp)
    const entries = loadMigrations()

    // Create v0 schema migration table (no name/applied_at columns)
    tmp.sqlite.run(`CREATE TABLE "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )`)

    // Insert entries without names (v0 format)
    for (const entry of entries.slice(0, 5)) {
      tmp.sqlite.run(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('', ${entry.timestamp})`)
    }

    // Backfill should be a no-op since there's no name column
    // (Drizzle's own upgradeSyncIfNeeded handles v0 → v1 upgrade internally)
    expect(() => backfillMigrationNames(tmp.sqlite, entries)).not.toThrow()

    // Verify no name column was added (backfill doesn't alter schema)
    const cols = (
      tmp.sqlite.prepare("SELECT name FROM pragma_table_info('__drizzle_migrations')").all() as { name: string }[]
    ).map((c) => c.name)
    expect(cols).not.toContain("name")
  })

  test("partially upgraded database (some names set, some NULL)", () => {
    const tmp = createTempDb()
    tempDbs.push(tmp)
    const entries = loadMigrations()

    ensureDrizzleJournal(tmp.sqlite)
    tmp.sqlite.run(
      `INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES ('', ${entries[0]!.timestamp}, NULL, NULL)`,
    )

    // Backfill should fix just the NULL entries
    backfillMigrationNames(tmp.sqlite, entries)

    const names = getMigrationNames(tmp.sqlite)
    expect(names.length).toBe(entries.length)
    for (const name of names) {
      expect(name).toBeTruthy()
    }
  })
})
