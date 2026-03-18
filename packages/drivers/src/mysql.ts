/**
 * MySQL driver using the `mysql2` package.
 */

import type { ConnectionConfig, Connector, ConnectorResult, SchemaColumn } from "./types"

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let mysql: any
  try {
    mysql = await import("mysql2/promise")
    mysql = mysql.default || mysql
  } catch {
    throw new Error("MySQL driver not installed. Run: bun add mysql2")
  }

  let pool: any

  return {
    async connect() {
      const poolConfig: Record<string, unknown> = {
        host: config.host ?? "127.0.0.1",
        port: config.port ?? 3306,
        database: config.database,
        user: config.user,
        password: config.password,
        waitForConnections: true,
        connectionLimit: 5,
        connectTimeout: 10000,
      }

      if (config.ssl !== undefined) {
        poolConfig.ssl = config.ssl
      } else if (config.ssl_ca || config.ssl_cert || config.ssl_key) {
        const sslObj: Record<string, unknown> = {}
        if (config.ssl_ca) sslObj.ca = config.ssl_ca
        if (config.ssl_cert) sslObj.cert = config.ssl_cert
        if (config.ssl_key) sslObj.key = config.ssl_key
        poolConfig.ssl = sslObj
      }

      pool = mysql.createPool(poolConfig)
    },

    async execute(sql: string, limit?: number, _binds?: any[]): Promise<ConnectorResult> {
      const effectiveLimit = limit ?? 1000
      let query = sql
      const isSelectLike = /^\s*(SELECT|WITH|VALUES)\b/i.test(sql)
      if (
        isSelectLike &&
        effectiveLimit &&
        !/\bLIMIT\b/i.test(sql)
      ) {
        query = `${sql.replace(/;\s*$/, "")} LIMIT ${effectiveLimit + 1}`
      }

      const [rows, fields] = await pool.query(query)
      const columns = fields?.map((f: any) => f.name) ?? []
      const rowsArr = Array.isArray(rows) ? rows : []
      const truncated = rowsArr.length > effectiveLimit
      const limitedRows = truncated
        ? rowsArr.slice(0, effectiveLimit)
        : rowsArr

      return {
        columns,
        rows: limitedRows.map((row: any) =>
          columns.map((col: string) => row[col]),
        ),
        row_count: limitedRows.length,
        truncated,
      }
    },

    async listSchemas(): Promise<string[]> {
      const [rows] = await pool.query("SHOW DATABASES")
      return (rows as any[]).map(
        (r) => r.Database ?? r.database ?? Object.values(r)[0],
      ) as string[]
    },

    async listTables(
      schema: string,
    ): Promise<Array<{ name: string; type: string }>> {
      const [rows] = await pool.query(
        `SELECT table_name, table_type
         FROM information_schema.tables
         WHERE table_schema = ?
         ORDER BY table_name`,
        [schema],
      )
      return (rows as any[]).map((r) => ({
        name: (r.TABLE_NAME ?? r.table_name) as string,
        type: (r.TABLE_TYPE ?? r.table_type) === "VIEW" ? "view" : "table",
      }))
    },

    async describeTable(
      schema: string,
      table: string,
    ): Promise<SchemaColumn[]> {
      const [rows] = await pool.query(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = ?
           AND table_name = ?
         ORDER BY ordinal_position`,
        [schema, table],
      )
      return (rows as any[]).map((r) => ({
        name: (r.COLUMN_NAME ?? r.column_name) as string,
        data_type: (r.DATA_TYPE ?? r.data_type) as string,
        nullable: (r.IS_NULLABLE ?? r.is_nullable) === "YES",
      }))
    },

    async close() {
      if (pool) {
        await pool.end()
        pool = null
      }
    },
  }
}
