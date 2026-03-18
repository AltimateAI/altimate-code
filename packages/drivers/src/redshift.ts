/**
 * Redshift driver using the `pg` package (wire-compatible with PostgreSQL).
 * Uses svv_ system views for introspection.
 */

import type { ConnectionConfig, Connector, ConnectorResult, SchemaColumn } from "./types"

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let pg: any
  try {
    pg = await import("pg")
  } catch {
    throw new Error(
      "Redshift driver not installed (uses pg). Run: bun add pg @types/pg",
    )
  }

  const Pool = pg.default?.Pool ?? pg.Pool
  let pool: any

  const connector: Connector = {
    async connect() {
      const poolConfig: Record<string, unknown> = {}

      if (config.connection_string) {
        poolConfig.connectionString = config.connection_string
      } else {
        poolConfig.host = config.host ?? "127.0.0.1"
        poolConfig.port = config.port ?? 5439 // Redshift default
        poolConfig.database = config.database ?? "dev"
        poolConfig.user = config.user
        poolConfig.password = config.password
        poolConfig.ssl = config.ssl ?? { rejectUnauthorized: false }
      }

      poolConfig.max = 5
      poolConfig.idleTimeoutMillis = 30000
      poolConfig.connectionTimeoutMillis = 10000

      pool = new Pool(poolConfig)
    },

    async execute(sql: string, limit?: number): Promise<ConnectorResult> {
      const client = await pool.connect()
      try {
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

        const result = await client.query(query)
        const columns = result.fields?.map((f: any) => f.name) ?? []
        const truncated = result.rows.length > effectiveLimit
        const rows = truncated
          ? result.rows.slice(0, effectiveLimit)
          : result.rows

        return {
          columns,
          rows: rows.map((row: any) =>
            columns.map((col: string) => row[col]),
          ),
          row_count: rows.length,
          truncated,
        }
      } finally {
        client.release()
      }
    },

    async listSchemas(): Promise<string[]> {
      const result = await connector.execute(
        `SELECT DISTINCT schemaname
         FROM svv_tables
         WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_internal')
         ORDER BY schemaname`,
        10000,
      )
      return result.rows.map((r) => r[0] as string)
    },

    async listTables(
      schema: string,
    ): Promise<Array<{ name: string; type: string }>> {
      const client = await pool.connect()
      try {
        const result = await client.query(
          `SELECT tablename, tabletype
           FROM svv_tables
           WHERE schemaname = $1
           ORDER BY tablename`,
          [schema],
        )
        return result.rows.map((r: any) => ({
          name: r.tablename as string,
          type: String(r.tabletype).toLowerCase() === "view" ? "view" : "table",
        }))
      } finally {
        client.release()
      }
    },

    async describeTable(
      schema: string,
      table: string,
    ): Promise<SchemaColumn[]> {
      const client = await pool.connect()
      try {
        const result = await client.query(
          `SELECT columnname, data_type, is_nullable
           FROM svv_columns
           WHERE schemaname = $1
             AND tablename = $2
           ORDER BY ordinal_position`,
          [schema, table],
        )
        return result.rows.map((r: any) => ({
          name: r.columnname as string,
          data_type: r.data_type as string,
          nullable: String(r.is_nullable).toUpperCase() === "YES",
        }))
      } finally {
        client.release()
      }
    },

    async close() {
      if (pool) {
        await pool.end()
        pool = null
      }
    },
  }
  return connector
}
