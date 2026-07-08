import { afterEach, describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import fs from "fs"
import os from "os"
import path from "path"

const packageRoot = path.resolve(import.meta.dir, "..", "..")
const migrationDir = path.join(packageRoot, "migration")

type MigrationEntry = { name: string; timestamp: number }
type TempDb = { dbPath: string; dir: string }

const tempDbs: TempDb[] = []

afterEach(() => {
  for (const tmp of tempDbs) {
    fs.rmSync(tmp.dir, { recursive: true, force: true })
  }
  tempDbs.length = 0
})

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

function loadMigrations() {
  return fs
    .readdirSync(migrationDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(migrationDir, entry.name, "migration.sql")))
    .map((entry) => ({ name: entry.name, timestamp: time(entry.name) }))
    .sort((a, b) => a.timestamp - b.timestamp)
}

function createCoreOwnedDatabase(entries: MigrationEntry[], options: { duplicateFirstJournalEntry?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-db-journal-"))
  const dbPath = path.join(dir, "opencode.db")
  const sqlite = new BunDatabase(dbPath, { create: true })
  try {
    sqlite.run(`CREATE TABLE "migration" ("id" text PRIMARY KEY)`)
    sqlite.run(`CREATE TABLE "session" ("id" text PRIMARY KEY)`)

    if (options.duplicateFirstJournalEntry) {
      const first = entries[0]
      expect(first).toBeDefined()
      sqlite.run(`
        CREATE TABLE "__drizzle_migrations" (
          id INTEGER PRIMARY KEY,
          hash text NOT NULL,
          created_at numeric,
          name text,
          applied_at TEXT
        )
      `)
      sqlite.run(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name", "applied_at") VALUES ('', ?, ?, ?)`,
        [first!.timestamp, first!.name, "2026-01-01T00:00:00.000Z"],
      )
      sqlite.run(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name", "applied_at") VALUES ('', ?, ?, ?)`,
        [first!.timestamp, first!.name, "2026-01-02T00:00:00.000Z"],
      )
    }
  } finally {
    sqlite.close()
  }

  const tmp = { dbPath, dir }
  tempDbs.push(tmp)
  return tmp
}

function runLegacyStorageBoot(dbPath: string) {
  const proc = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `
        const { Database } = await import("./src/storage/db.ts")
        Database.Client()
        Database.close()
      `,
    ],
    cwd: packageRoot,
    env: {
      ...process.env,
      OPENCODE_DB: dbPath,
      OPENCODE_TEST_CORE_DB_OWNER: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr)
    const stdout = new TextDecoder().decode(proc.stdout)
    throw new Error(`legacy storage boot failed\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
}

function readJournal(dbPath: string) {
  const sqlite = new BunDatabase(dbPath, { readonly: true })
  try {
    const total = sqlite.prepare(`SELECT COUNT(*) AS count FROM "__drizzle_migrations"`).get() as { count: number }
    const rows = sqlite
      .prepare(
        `SELECT name, COUNT(*) AS count FROM "__drizzle_migrations" GROUP BY name ORDER BY name`,
      )
      .all() as { name: string | null; count: number }[]
    return { total: total.count, rows }
  } finally {
    sqlite.close()
  }
}

describe("legacy storage migration journal", () => {
  test("core-owned adoption marks migration entries only once across boots", () => {
    const entries = loadMigrations()
    expect(entries.length).toBeGreaterThan(0)
    const tmp = createCoreOwnedDatabase(entries)

    runLegacyStorageBoot(tmp.dbPath)
    const first = readJournal(tmp.dbPath)

    runLegacyStorageBoot(tmp.dbPath)
    const second = readJournal(tmp.dbPath)

    expect(second.total).toBe(first.total)
    expect(second.total).toBe(entries.length)
    expect(second.rows.map((row) => row.name)).toEqual(entries.map((entry) => entry.name))
    for (const row of second.rows) {
      expect(row.count).toBe(1)
    }
  })

  test("core-owned adoption collapses duplicate migration journal rows by name", () => {
    const entries = loadMigrations()
    expect(entries.length).toBeGreaterThan(0)
    const tmp = createCoreOwnedDatabase(entries, { duplicateFirstJournalEntry: true })

    runLegacyStorageBoot(tmp.dbPath)
    const journal = readJournal(tmp.dbPath)

    expect(journal.total).toBe(entries.length)
    expect(journal.rows.map((row) => row.name)).toEqual(entries.map((entry) => entry.name))
    for (const row of journal.rows) {
      expect(row.count).toBe(1)
    }
  })
})
