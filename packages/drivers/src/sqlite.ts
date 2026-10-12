/**
 * SQLite driver using Bun's built-in `bun:sqlite`.
 *
 * `bun:sqlite` is synchronous and has no interrupt, so the handle lives in a
 * supervised helper process (see `local-engine.ts`) that the driver can kill to
 * enforce the query execution deadline.
 */

import { LocalEngine } from "./local-engine"
import * as path from "path"
import { resolveQueryTimeout } from "./query-timeout"
import { allowsCreate, assertStoreExists, isLocalFilePath, requireStorePath } from "./file-store"
import type { ConnectionConfig, Connector, ConnectorResult, ExecuteOptions, SchemaColumn } from "./types"

export async function connect(config: ConnectionConfig): Promise<Connector> {
  // altimate_change start — a missing path must fail loudly, not become :memory:
  const cwd = process.cwd()
  const configuredPath = requireStorePath(config, "SQLite")
  const dbPath = isLocalFilePath(configuredPath) ? path.resolve(cwd, configuredPath) : configuredPath
  // altimate_change end
  const engine = new LocalEngine({ engine: "sqlite", label: "SQLite", storePath: dbPath, cwd })
  let opened = false

  return {
    async connect() {
      const isReadonly = config.readonly === true
      // altimate_change start — never conjure an empty store on open.
      // A read-only connection never creates, so `create: true` cannot excuse a
      // missing file there; the guard is told the effective decision.
      const willCreate = !isReadonly && allowsCreate(config)
      assertStoreExists(config, dbPath, "SQLite", willCreate)
      await engine.open({
        path: dbPath,
        readonly: isReadonly,
        // `create` alone is no longer implied by "not readonly", so the
        // read-write flag has to be explicit — bun:sqlite rejects an options
        // object that sets no open flag at all.
        readwrite: !isReadonly,
        create: willCreate,
        wal: !isReadonly,
      })
      opened = true
      // altimate_change end
    },

    async execute(sql: string, limit?: number, _binds?: any[], options?: ExecuteOptions): Promise<ConnectorResult> {
      if (!opened) throw new Error("SQLite connection not open")
      const timeoutMs = resolveQueryTimeout(config, options).ms
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
        const info = await engine.call<{ changes: number; lastInsertRowid: number | bigint }>("run", { sql }, timeoutMs)
        return {
          columns: ["changes", "lastInsertRowid"],
          rows: [[info.changes, info.lastInsertRowid]],
          row_count: 1,
          truncated: false,
        }
      }

      const rows = await engine.call<any[]>("all", { sql: query }, timeoutMs)
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
      if (!opened) throw new Error("SQLite connection not open")
      const rows = await engine.call<any[]>(
        "all",
        {
          sql: "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        },
        resolveQueryTimeout(config).ms,
      )
      return rows.map((r: any) => ({
        name: r.name as string,
        type: r.type as string,
      }))
    },

    async describeTable(
      _schema: string,
      table: string,
    ): Promise<SchemaColumn[]> {
      if (!opened) throw new Error("SQLite connection not open")
      const rows = await engine.call<any[]>(
        "all",
        { sql: "SELECT * FROM pragma_table_info(?) ORDER BY cid", params: [table] },
        resolveQueryTimeout(config).ms,
      )
      return rows.map((r: any) => ({
        name: r.name as string,
        data_type: r.type as string,
        nullable: r.notnull === 0,
      }))
    },

    async close() {
      if (opened) {
        opened = false
        await engine.close()
      }
    },
  }
}
