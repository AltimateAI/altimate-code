/**
 * DuckDB driver using the `duckdb` package.
 */

import type { ConnectionConfig, Connector, ConnectorResult, SchemaColumn } from "./types"

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let duckdb: any
  try {
    duckdb = await import("duckdb")
    duckdb = duckdb.default || duckdb
  } catch {
    throw new Error("DuckDB driver not installed. Run: bun add duckdb")
  }

  const dbPath = (config.path as string) ?? ":memory:"
  let db: any
  let connection: any

  function query(sql: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
      connection.all(sql, (err: Error | null, rows: any[]) => {
        if (err) reject(err)
        else resolve(rows ?? [])
      })
    })
  }

  function queryWithParams(sql: string, params: any[]): Promise<any[]> {
    return new Promise((resolve, reject) => {
      connection.all(sql, ...params, (err: Error | null, rows: any[]) => {
        if (err) reject(err)
        else resolve(rows ?? [])
      })
    })
  }

  return {
    async connect() {
      db = await new Promise<any>((resolve, reject) => {
        let resolved = false
        const instance = new duckdb.Database(
          dbPath,
          (err: Error | null) => {
            if (resolved) return // Already resolved via timeout
            resolved = true
            if (err) reject(err)
            else resolve(instance)
          },
        )
        // Bun: native callback may not fire; fall back after 2s
        setTimeout(() => {
          if (!resolved) {
            resolved = true
            resolve(instance)
          }
        }, 2000)
      })
      connection = db.connect()
    },

    async execute(sql: string, limit?: number, binds?: any[]): Promise<ConnectorResult> {
      const effectiveLimit = limit ?? 1000

      let finalSql = sql
      const isSelectLike = /^\s*(SELECT|WITH|VALUES)\b/i.test(sql)
      if (
        isSelectLike &&
        effectiveLimit &&
        !/\bLIMIT\b/i.test(sql)
      ) {
        finalSql = `${sql.replace(/;\s*$/, "")} LIMIT ${effectiveLimit + 1}`
      }

      const rows = binds?.length
        ? await queryWithParams(finalSql, binds)
        : await query(finalSql)
      const columns =
        rows.length > 0 ? Object.keys(rows[0]) : []
      const truncated = rows.length > effectiveLimit
      const limitedRows = truncated ? rows.slice(0, effectiveLimit) : rows

      return {
        columns,
        rows: limitedRows.map((row) =>
          columns.map((col) => row[col]),
        ),
        row_count: limitedRows.length,
        truncated,
      }
    },

    async listSchemas(): Promise<string[]> {
      const rows = await query(
        "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
      )
      return rows.map((r) => r.schema_name as string)
    },

    async listTables(
      schema: string,
    ): Promise<Array<{ name: string; type: string }>> {
      const rows = await queryWithParams(
        `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
        [schema],
      )
      return rows.map((r) => ({
        name: r.table_name as string,
        type: r.table_type === "VIEW" ? "view" : "table",
      }))
    },

    async describeTable(
      schema: string,
      table: string,
    ): Promise<SchemaColumn[]> {
      const rows = await queryWithParams(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [schema, table],
      )
      return rows.map((r) => ({
        name: r.column_name as string,
        data_type: r.data_type as string,
        nullable: r.is_nullable === "YES",
      }))
    },

    async close() {
      if (db) {
        await new Promise<void>((resolve) => {
          db.close((err: Error | null) => {
            resolve()
          })
          // Bun: native callback may not fire; fall back after timeout
          setTimeout(resolve, 500)
        })
        db = null
        connection = null
      }
    },
  }
}
