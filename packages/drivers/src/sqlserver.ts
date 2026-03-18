/**
 * SQL Server driver using the `mssql` (tedious) package.
 */

import type { ConnectionConfig, Connector, ConnectorResult, SchemaColumn } from "./types"

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let mssql: any
  try {
    // @ts-expect-error — optional dependency, loaded at runtime
    mssql = await import("mssql")
    mssql = mssql.default || mssql
  } catch {
    throw new Error(
      "SQL Server driver not installed. Run: bun add mssql",
    )
  }

  let pool: any

  return {
    async connect() {
      const mssqlConfig: Record<string, unknown> = {
        server: config.host ?? "127.0.0.1",
        port: config.port ?? 1433,
        database: config.database,
        user: config.user,
        password: config.password,
        options: {
          encrypt: config.encrypt ?? false,
          trustServerCertificate: config.trust_server_certificate ?? true,
          connectTimeout: 10000,
          requestTimeout: 30000,
        },
        pool: {
          max: 5,
          min: 0,
          idleTimeoutMillis: 30000,
        },
      }

      pool = await mssql.connect(mssqlConfig)
    },

    async execute(sql: string, limit?: number, _binds?: any[]): Promise<ConnectorResult> {
      const effectiveLimit = limit ?? 1000

      let query = sql
      const isSelectLike = /^\s*SELECT\b/i.test(sql)
      // SQL Server uses TOP, not LIMIT
      if (
        isSelectLike &&
        effectiveLimit &&
        !/\bTOP\b/i.test(sql) &&
        !/\bLIMIT\b/i.test(sql)
      ) {
        // Insert TOP after SELECT
        query = sql.replace(
          /^(\s*SELECT\s)/i,
          `$1TOP ${effectiveLimit + 1} `,
        )
      }

      const result = await pool.request().query(query)
      const rows = result.recordset ?? []
      const columns =
        rows.length > 0
          ? Object.keys(rows[0]).filter((k) => !k.startsWith("_"))
          : (result.recordset?.columns
              ? Object.keys(result.recordset.columns)
              : [])
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
      const result = await pool
        .request()
        .query(
          "SELECT name FROM sys.schemas WHERE name NOT IN ('guest','INFORMATION_SCHEMA','sys') ORDER BY name",
        )
      return result.recordset.map((r: any) => r.name as string)
    },

    async listTables(
      schema: string,
    ): Promise<Array<{ name: string; type: string }>> {
      const result = await pool
        .request()
        .input("schema", schema)
        .query(
          `SELECT t.name, t.type
           FROM sys.tables t
           INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
           WHERE s.name = @schema
           UNION ALL
           SELECT v.name, 'V' as type
           FROM sys.views v
           INNER JOIN sys.schemas s ON v.schema_id = s.schema_id
           WHERE s.name = @schema
           ORDER BY name`,
        )
      return result.recordset.map((r: any) => ({
        name: r.name as string,
        type: r.type?.trim() === "V" ? "view" : "table",
      }))
    },

    async describeTable(
      schema: string,
      table: string,
    ): Promise<SchemaColumn[]> {
      const result = await pool
        .request()
        .input("schema", schema)
        .input("table", table)
        .query(
          `SELECT c.name AS column_name,
                  tp.name AS data_type,
                  c.is_nullable
           FROM sys.columns c
           INNER JOIN sys.types tp ON c.user_type_id = tp.user_type_id
           INNER JOIN sys.objects o ON c.object_id = o.object_id
           INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
           WHERE s.name = @schema AND o.name = @table
             AND o.type IN ('U', 'V')
           ORDER BY c.column_id`,
        )
      return result.recordset.map((r: any) => ({
        name: r.column_name as string,
        data_type: r.data_type as string,
        nullable: r.is_nullable === 1,
      }))
    },

    async close() {
      if (pool) {
        await pool.close()
        pool = null
      }
    },
  }
}
