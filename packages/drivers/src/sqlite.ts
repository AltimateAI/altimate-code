/**
 * SQLite driver using the `better-sqlite3` package.
 * Synchronous API wrapped in async interface.
 */

import { escapeSqlIdentifier } from "./sql-escape"
import type { ConnectionConfig, Connector, ConnectorResult, SchemaColumn } from "./types"

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let Database: any
  try {
    const mod = await import("better-sqlite3")
    Database = mod.default || mod
  } catch {
    throw new Error(
      "SQLite driver not installed. Run: bun add better-sqlite3",
    )
  }

  const dbPath = (config.path as string) ?? ":memory:"
  let db: any

  return {
    async connect() {
      db = new Database(dbPath, {
        readonly: config.readonly === true,
      })
      db.pragma("journal_mode = WAL")
    },

    async execute(sql: string, limit?: number): Promise<ConnectorResult> {
      const effectiveLimit = limit ?? 1000

      // Determine if this is a SELECT-like statement
      const trimmed = sql.trim().toLowerCase()
      const isSelect =
        trimmed.startsWith("select") ||
        trimmed.startsWith("pragma") ||
        trimmed.startsWith("with") ||
        trimmed.startsWith("explain")

      let query = sql
      if (
        isSelect &&
        effectiveLimit &&
        !/\bLIMIT\b/i.test(sql)
      ) {
        query = `${sql.replace(/;\s*$/, "")} LIMIT ${effectiveLimit + 1}`
      }

      if (!isSelect) {
        // Non-SELECT statements (INSERT, UPDATE, DELETE, CREATE, etc.)
        const info = db.prepare(sql).run()
        return {
          columns: ["changes", "lastInsertRowid"],
          rows: [[info.changes, info.lastInsertRowid]],
          row_count: 1,
          truncated: false,
        }
      }

      const stmt = db.prepare(query)
      const rows = stmt.all()
      const columns = rows.length > 0 ? Object.keys(rows[0]) : []
      const truncated = rows.length > effectiveLimit
      const limitedRows = truncated ? rows.slice(0, effectiveLimit) : rows

      return {
        columns,
        rows: limitedRows.map((row: any) =>
          columns.map((col) => row[col]),
        ),
        row_count: limitedRows.length,
        truncated,
      }
    },

    async listSchemas(): Promise<string[]> {
      // SQLite doesn't have schemas, return "main"
      return ["main"]
    },

    async listTables(
      _schema: string,
    ): Promise<Array<{ name: string; type: string }>> {
      const rows = db
        .prepare(
          "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
      return rows.map((r: any) => ({
        name: r.name as string,
        type: r.type as string,
      }))
    },

    async describeTable(
      _schema: string,
      table: string,
    ): Promise<SchemaColumn[]> {
      const rows = db.prepare(`PRAGMA table_info("${escapeSqlIdentifier(table)}")`).all()
      return rows.map((r: any) => ({
        name: r.name as string,
        data_type: r.type as string,
        nullable: r.notnull === 0,
      }))
    },

    async close() {
      if (db) {
        db.close()
        db = null
      }
    },
  }
}
