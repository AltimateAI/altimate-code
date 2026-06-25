import { Database as BunDatabase } from "bun:sqlite"
import { Database } from "@opencode-ai/core/database/database"
import { disposeAllInstances, withDatabaseWriteLock } from "./fixture"

// Tables whose schema/state must survive a data reset (the migration journal — clearing it would make
// the DB look unmigrated and replay migrations on the next test).
const preservedTables = new Set(["migration", "__drizzle_migrations"])

export async function resetDatabase() {
  await withDatabaseWriteLock(async () => {
    await disposeAllInstances().catch(() => undefined)
    const { Database: LegacyDatabase } = await import("../../src/storage/db")
    LegacyDatabase.close()
    const dbPath = Database.path()
    const sqlite = new BunDatabase(dbPath, { create: true })
    try {
      sqlite.run("PRAGMA busy_timeout = 5000")
      sqlite.run("PRAGMA journal_mode = WAL")
      sqlite.run("PRAGMA foreign_keys = OFF")
      // Derive the data tables from the live schema so a table added by a future migration is cleared
      // automatically — no hardcoded list to drift out of sync. foreign_keys is OFF here, so DELETE
      // order across tables is irrelevant.
      const dataTables = (
        sqlite
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      )
        .map((row) => row.name)
        .filter((name) => !preservedTables.has(name))
      sqlite.run("BEGIN IMMEDIATE")
      for (const table of dataTables) {
        sqlite.run(`DELETE FROM ${JSON.stringify(table)}`)
      }
      sqlite.run("COMMIT")
      sqlite.run("PRAGMA foreign_keys = ON")
      sqlite.run("PRAGMA wal_checkpoint(PASSIVE)")
    } catch (error) {
      if (sqlite.inTransaction) sqlite.run("ROLLBACK")
      if (!(error instanceof Error && /no such table/.test(error.message))) throw error
    } finally {
      sqlite.close()
    }
  })
}
