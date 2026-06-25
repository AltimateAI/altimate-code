import { Database as BunDatabase } from "bun:sqlite"
import { Database } from "@opencode-ai/core/database/database"
import { disposeAllInstances, withDatabaseWriteLock } from "./fixture"

const dataTables = [
  "account_state",
  "account",
  "control_account",
  "credential",
  "data_migration",
  "event",
  "event_sequence",
  "message",
  "part",
  "permission",
  "project_directory",
  "session_context_epoch",
  "session_input",
  "session_message",
  "session_share",
  "todo",
  "workspace",
  "session",
  "project",
] as const

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
