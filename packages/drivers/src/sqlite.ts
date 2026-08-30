/**
 * SQLite driver using Bun's built-in `bun:sqlite`.
 * Synchronous API wrapped in async interface.
 */

import { Database } from "bun:sqlite"
import { allowsCreate, assertStoreExists } from "./file-store"
import type { ConnectionConfig, Connector, ConnectorResult, ExecuteOptions, SchemaColumn } from "./types"

export async function connect(config: ConnectionConfig): Promise<Connector> {
  const dbPath = (config.path as string) ?? ":memory:"
  let db: Database | null = null

  return {
    async connect() {
      const isReadonly = config.readonly === true
      // altimate_change start — never conjure an empty store on open.
      // A read-only connection never creates, so `create: true` cannot excuse a
      // missing file there; the guard is told the effective decision.
      const willCreate = !isReadonly && allowsCreate(config)
      assertStoreExists(config, dbPath, "SQLite", willCreate)
      db = new Database(dbPath, {
        readonly: isReadonly,
        // `create` alone is no longer implied by "not readonly", so the
        // read-write flag has to be explicit — bun:sqlite rejects an options
        // object that sets no open flag at all.
        readwrite: !isReadonly,
        create: willCreate,
      })
      // altimate_change end
      if (!isReadonly) {
        db.exec("PRAGMA journal_mode = WAL")
      }
    },

    async execute(sql: string, limit?: number, _binds?: any[], options?: ExecuteOptions): Promise<ConnectorResult> {
      if (!db) throw new Error("SQLite connection not open")
      const effectiveLimit = options?.noLimit ? 0 : (limit ?? 1000)

      // Determine if this is a SELECT-like statement
      const trimmed = sql.trim().toLowerCase()
      const isPragma = trimmed.startsWith("pragma")
      const isSelect =
        trimmed.startsWith("select") ||
        isPragma ||
        trimmed.startsWith("with") ||
        trimmed.startsWith("explain")

      // PRAGMA statements don't support LIMIT clause
      let query = sql
      if (
        isSelect &&
        !isPragma &&
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
      const rows = stmt.all() as any[]
      const columns = rows.length > 0 ? Object.keys(rows[0]) : []
      const truncated = effectiveLimit > 0 && rows.length > effectiveLimit
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
      if (!db) throw new Error("SQLite connection not open")
      const rows = db
        .prepare(
          "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as any[]
      return rows.map((r: any) => ({
        name: r.name as string,
        type: r.type as string,
      }))
    },

    async describeTable(
      _schema: string,
      table: string,
    ): Promise<SchemaColumn[]> {
      if (!db) throw new Error("SQLite connection not open")
      const rows = db.prepare('SELECT * FROM pragma_table_info(?) ORDER BY cid').all(table) as any[]
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
