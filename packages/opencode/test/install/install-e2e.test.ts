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
import path from "path"
import os from "os"
import fs from "fs"

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
    expect(entries.length).toBeGreaterThanOrEqual(9)

    const db = drizzle({ client: tmp.sqlite })
    // Should not throw
    backfillMigrationNames(tmp.sqlite, entries)
    migrate(db, entries)

    // Verify core tables were created
    const tables = getTableNames(tmp.sqlite)
    expect(tables).toContain("project")
    expect(tables).toContain("session")
    expect(tables).toContain("message")
    expect(tables).toContain("part")
    expect(tables).toContain("workspace")
    expect(tables).toContain("account")
    expect(tables).toContain("account_state")

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

    const db = drizzle({ client: tmp.sqlite })
    backfillMigrationNames(tmp.sqlite, entries)
    migrate(db, entries)

    // Run again — should be a no-op
    backfillMigrationNames(tmp.sqlite, entries)
    expect(() => migrate(db, entries)).not.toThrow()
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
    const entries = loadMigrations()

    // Apply only the first 7 migrations (v0.2.x had these)
    const v02xEntries = entries.slice(0, 7)
    const db = drizzle({ client: tmp.sqlite })
    migrate(db, v02xEntries)

    // Now simulate the v0.2.x bug: clear all names (they were NULL in old versions)
    tmp.sqlite.run("UPDATE __drizzle_migrations SET name = NULL")

    return tmp
  }

  test("upgrade applies new migrations without re-creating existing tables", () => {
    const tmp = createV02xDatabase()
    tempDbs.push(tmp)
    const entries = loadMigrations()

    const db = drizzle({ client: tmp.sqlite })

    // Without backfill, this would throw "table already exists"
    backfillMigrationNames(tmp.sqlite, entries)
    expect(() => migrate(db, entries)).not.toThrow()

    // Verify new tables from v0.3.0 migrations exist
    const tables = getTableNames(tmp.sqlite)
    expect(tables).toContain("project")
    expect(tables).toContain("account")
    expect(tables).toContain("account_state")

    // All migrations should now be tracked
    const names = getMigrationNames(tmp.sqlite)
    expect(names.length).toBe(entries.length)
    for (const name of names) {
      expect(name).toBeTruthy()
    }
  })

  test("upgrade FAILS without backfill (documents the bug)", () => {
    const tmp = createV02xDatabase()
    tempDbs.push(tmp)
    const entries = loadMigrations()

    const db = drizzle({ client: tmp.sqlite })

    // Without backfill, Drizzle tries to re-apply all migrations
    // because it matches by name and all names are NULL
    expect(() => migrate(db, entries)).toThrow()
  })

  test("backfill correctly matches timestamps to migration names", () => {
    const tmp = createV02xDatabase()
    tempDbs.push(tmp)
    const entries = loadMigrations()

    backfillMigrationNames(tmp.sqlite, entries)

    const names = getMigrationNames(tmp.sqlite)
    // Should have 7 entries (from v0.2.x), all with proper names now
    expect(names.length).toBe(7)
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
    const db = drizzle({ client: tmp.sqlite })
    backfillMigrationNames(tmp.sqlite, entries)
    expect(() => migrate(db, entries)).not.toThrow()

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

    // Apply first 5 migrations normally
    const db = drizzle({ client: tmp.sqlite })
    migrate(db, entries.slice(0, 5))

    // Clear names for only the first 3 (simulate partial upgrade)
    const first3 = entries.slice(0, 3)
    for (const entry of first3) {
      tmp.sqlite.run(`UPDATE __drizzle_migrations SET name = NULL WHERE created_at = ${entry.timestamp}`)
    }

    // Backfill should fix just the 3 NULL entries
    backfillMigrationNames(tmp.sqlite, entries)

    const names = getMigrationNames(tmp.sqlite)
    expect(names.length).toBe(5)
    for (const name of names) {
      expect(name).toBeTruthy()
    }

    // Full migration should succeed — only new migrations applied
    expect(() => migrate(db, entries)).not.toThrow()
    expect(getMigrationNames(tmp.sqlite).length).toBe(entries.length)
  })
})
