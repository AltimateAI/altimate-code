import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import path from "path"
import os from "os"
import fs from "fs"

// Import the backfillMigrationNames function indirectly via testing the behavior
// We recreate the logic here since the function is not exported
function backfillMigrationNames(
  sqlite: InstanceType<typeof BunDatabase>,
  entries: { sql: string; timestamp: number; name: string }[],
) {
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
}

function createTempDb(): { db: InstanceType<typeof BunDatabase>; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-test-"))
  const dbPath = path.join(tmpDir, "test.db")
  const db = new BunDatabase(dbPath, { create: true })
  return {
    db,
    cleanup: () => {
      db.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

describe("backfillMigrationNames", () => {
  const migrations = [
    { sql: "CREATE TABLE t1 (id text);", timestamp: 1769552633000, name: "20260127222353_familiar_lady_ursula" },
    { sql: "ALTER TABLE t1 ADD col text;", timestamp: 1770830228000, name: "20260211171708_add_project_commands" },
    { sql: "CREATE TABLE t2 (id text);", timestamp: 1772579546000, name: "20260303231226_add_workspace_fields" },
  ]

  test("backfills NULL names in v0 → v1 upgraded migration table", () => {
    const { db, cleanup } = createTempDb()
    try {
      // Simulate old DB: migration table with name column but NULL values
      db.run(`CREATE TABLE "__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric,
        "name" text,
        "applied_at" TEXT
      )`)
      db.run(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('', 1769552633000)`)
      db.run(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('', 1770830228000)`)
      db.run(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('', 1772579546000)`)

      backfillMigrationNames(db, migrations)

      const rows = db.prepare("SELECT name FROM __drizzle_migrations ORDER BY created_at").all() as { name: string }[]
      expect(rows[0].name).toBe("20260127222353_familiar_lady_ursula")
      expect(rows[1].name).toBe("20260211171708_add_project_commands")
      expect(rows[2].name).toBe("20260303231226_add_workspace_fields")
    } finally {
      cleanup()
    }
  })

  test("skips entries that already have names", () => {
    const { db, cleanup } = createTempDb()
    try {
      db.run(`CREATE TABLE "__drizzle_migrations" (
        id INTEGER PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric,
        "name" text,
        "applied_at" TEXT
      )`)
      db.run(
        `INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES ('', 1769552633000, '20260127222353_familiar_lady_ursula')`,
      )
      db.run(
        `INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES ('', 1770830228000, '20260211171708_add_project_commands')`,
      )

      backfillMigrationNames(db, migrations)

      const rows = db.prepare("SELECT name FROM __drizzle_migrations ORDER BY created_at").all() as { name: string }[]
      expect(rows[0].name).toBe("20260127222353_familiar_lady_ursula")
      expect(rows[1].name).toBe("20260211171708_add_project_commands")
    } finally {
      cleanup()
    }
  })

  test("handles missing migration table gracefully", () => {
    const { db, cleanup } = createTempDb()
    try {
      // No migration table — should not throw
      expect(() => backfillMigrationNames(db, migrations)).not.toThrow()
    } finally {
      cleanup()
    }
  })

  test("handles table without name column (pre-v0 upgrade)", () => {
    const { db, cleanup } = createTempDb()
    try {
      db.run(`CREATE TABLE "__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      )`)
      db.run(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('', 1769552633000)`)

      // Should not throw — name column missing means Drizzle will handle the upgrade
      expect(() => backfillMigrationNames(db, migrations)).not.toThrow()
    } finally {
      cleanup()
    }
  })

  test("leaves unmatched timestamps unchanged", () => {
    const { db, cleanup } = createTempDb()
    try {
      db.run(`CREATE TABLE "__drizzle_migrations" (
        id INTEGER PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric,
        "name" text,
        "applied_at" TEXT
      )`)
      // Timestamp that doesn't match any local migration
      db.run(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('', 9999999999000)`)

      backfillMigrationNames(db, migrations)

      const rows = db.prepare("SELECT name FROM __drizzle_migrations").all() as { name: string | null }[]
      expect(rows[0].name).toBeNull()
    } finally {
      cleanup()
    }
  })
})
