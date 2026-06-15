/**
 * DuckDB driver using the `duckdb` package.
 */

import type { ConnectionConfig, Connector, ConnectorResult, ExecuteOptions, SchemaColumn } from "./types"

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let duckdb: any
  try {
    duckdb = await import("duckdb")
    duckdb = duckdb.default || duckdb
  } catch {
    throw new Error("DuckDB driver not installed. Run: npm install duckdb")
  }

  const dbPath = (config.path as string) ?? ":memory:"
  let db: any
  let connection: any

  // altimate_change start — improve DuckDB error messages
  function wrapDuckDBError(err: Error): Error {
    const msg = err.message || String(err)
    if (msg.toLowerCase().includes("locked") || msg.includes("SQLITE_BUSY") || msg.includes("DUCKDB_LOCKED")) {
      return new Error(
        `Database "${dbPath}" is locked by another process. ` +
        `DuckDB does not support concurrent write access. ` +
        `Close other connections to this file and try again.`,
      )
    }
    return err
  }
  // altimate_change end

  function query(sql: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
      connection.all(sql, (err: Error | null, rows: any[]) => {
        if (err) reject(wrapDuckDBError(err))
        else resolve(rows ?? [])
      })
    })
  }

  function queryWithParams(sql: string, params: any[]): Promise<any[]> {
    return new Promise((resolve, reject) => {
      connection.all(sql, ...params, (err: Error | null, rows: any[]) => {
        if (err) reject(wrapDuckDBError(err))
        else resolve(rows ?? [])
      })
    })
  }

  return {
    async connect() {
      // altimate_change start — retry with read-only on lock errors
      const tryConnect = (accessMode?: string): Promise<any> =>
        new Promise<any>((resolve, reject) => {
          let resolved = false
          let timeout: ReturnType<typeof setTimeout> | undefined
          let instance: any
          // Sentinel for an open callback that fired synchronously (before
          // `instance` was assigned): `undefined` = not yet fired, `null` =
          // fired with success, `Error` = fired with failure. Replayed once
          // `instance` exists.
          let pendingOpen: Error | null | undefined
          const opts = accessMode ? { access_mode: accessMode } : undefined
          const closeQuietly = () => {
            try {
              if (instance && typeof instance.close === "function") instance.close()
            } catch {
              // best-effort cleanup of a half-open handle
            }
          }
          const onOpen = (err: Error | null) => {
            if (!instance) {
              pendingOpen = err
              return
            }
            if (resolved) {
              closeQuietly()
              return
            }
            resolved = true
            if (timeout) clearTimeout(timeout)
            if (err) {
              // Open failed — release the half-open handle so it doesn't leak.
              closeQuietly()
              const msg = err.message || String(err)
              if (msg.toLowerCase().includes("locked") || msg.includes("SQLITE_BUSY") || msg.includes("DUCKDB_LOCKED")) {
                reject(new Error("DUCKDB_LOCKED"))
              } else {
                reject(err)
              }
            } else {
              resolve(instance)
            }
          }
          instance = opts
            ? new duckdb.Database(dbPath, opts, onOpen)
            : new duckdb.Database(dbPath, onOpen)
          // Bun: native callback may not fire; fall back after 2s. Arm the timer
          // BEFORE replaying a synchronous callback so a sync resolve/reject can
          // actually clear it (otherwise it lingers ~2s and delays process exit).
          timeout = setTimeout(() => {
            if (!resolved) {
              resolved = true
              reject(new Error(`Timed out opening DuckDB database "${dbPath}"`))
            }
          }, 2000)
          if (pendingOpen !== undefined) onOpen(pendingOpen)
        })

      try {
        db = await tryConnect()
      } catch (err: any) {
        if (err.message === "DUCKDB_LOCKED" && dbPath !== ":memory:") {
          // Retry in read-only mode — allows concurrent reads
          try {
            db = await tryConnect("READ_ONLY")
          } catch (retryErr) {
            throw wrapDuckDBError(
              retryErr instanceof Error ? retryErr : new Error(String(retryErr)),
            )
          }
        } else {
          throw err
        }
      }
      // altimate_change end
      connection = db.connect()
    },

    async execute(sql: string, limit?: number, binds?: any[], options?: ExecuteOptions): Promise<ConnectorResult> {
      const effectiveLimit = options?.noLimit ? 0 : (limit ?? 1000)

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
      const truncated = effectiveLimit > 0 && rows.length > effectiveLimit
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
