/**
 * Oracle driver using the `oracledb` package (thin mode, pure JS).
 */

import type { ConnectionConfig, Connector, ConnectorResult, SchemaColumn } from "../types"

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let oracledb: any
  try {
    // @ts-expect-error — optional dependency, loaded at runtime
    oracledb = await import("oracledb")
    oracledb = oracledb.default || oracledb
  } catch {
    throw new Error(
      "Oracle driver not installed. Run: bun add oracledb",
    )
  }

  // Use thin mode (pure JS, no Oracle client needed)
  oracledb.initOracleClient = undefined

  let pool: any

  const connector: Connector = {
    async connect() {
      const connectString =
        config.connection_string ??
        `${config.host ?? "127.0.0.1"}:${config.port ?? 1521}/${config.service_name ?? config.database ?? "ORCL"}`

      pool = await oracledb.createPool({
        user: config.user,
        password: config.password,
        connectString,
        poolMin: 0,
        poolMax: 5,
        poolTimeout: 30,
      })
    },

    async execute(sql: string, limit?: number): Promise<ConnectorResult> {
      const effectiveLimit = limit ?? 1000
      let query = sql

      // Oracle uses FETCH FIRST N ROWS ONLY (12c+) or ROWNUM
      if (
        effectiveLimit &&
        !sql.trim().toLowerCase().includes("rownum") &&
        !sql.trim().toLowerCase().includes("fetch first")
      ) {
        query = `SELECT * FROM (${sql.replace(/;\s*$/, "")}) WHERE ROWNUM <= ${effectiveLimit + 1}`
      }

      const connection = await pool.getConnection()
      try {
        const result = await connection.execute(query, [], {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        })
        const rows = result.rows ?? []
        const columns =
          result.metaData?.map((m: any) => m.name) ??
          (rows.length > 0 ? Object.keys(rows[0]) : [])
        const truncated = rows.length > effectiveLimit
        const limitedRows = truncated
          ? rows.slice(0, effectiveLimit)
          : rows

        return {
          columns,
          rows: limitedRows.map((row: any) =>
            columns.map((col: string) => row[col]),
          ),
          row_count: limitedRows.length,
          truncated,
        }
      } finally {
        await connection.close()
      }
    },

    async listSchemas(): Promise<string[]> {
      const result = await connector.execute(
        "SELECT username FROM all_users ORDER BY username",
        10000,
      )
      return result.rows.map((r) => r[0] as string)
    },

    async listTables(
      schema: string,
    ): Promise<Array<{ name: string; type: string }>> {
      const result = await connector.execute(
        `SELECT object_name, object_type
         FROM all_objects
         WHERE owner = '${schema.replace(/'/g, "''").toUpperCase()}'
           AND object_type IN ('TABLE', 'VIEW')
         ORDER BY object_name`,
        10000,
      )
      return result.rows.map((r) => ({
        name: r[0] as string,
        type: (r[1] as string).toLowerCase(),
      }))
    },

    async describeTable(
      schema: string,
      table: string,
    ): Promise<SchemaColumn[]> {
      const result = await connector.execute(
        `SELECT column_name, data_type, nullable
         FROM all_tab_columns
         WHERE owner = '${schema.replace(/'/g, "''").toUpperCase()}'
           AND table_name = '${table.replace(/'/g, "''").toUpperCase()}'
         ORDER BY column_id`,
        10000,
      )
      return result.rows.map((r) => ({
        name: r[0] as string,
        data_type: r[1] as string,
        nullable: r[2] === "Y",
      }))
    },

    async close() {
      if (pool) {
        await pool.close(0)
        pool = null
      }
    },
  }
  return connector
}
