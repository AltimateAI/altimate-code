/**
 * PostgreSQL driver using the `pg` package.
 */

import type { ConnectionConfig, Connector, ConnectorResult, SchemaColumn } from "../types"

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let pg: any
  try {
    // @ts-expect-error — optional dependency
    pg = await import("pg")
  } catch {
    throw new Error("PostgreSQL driver not installed. Run: bun add pg @types/pg")
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
        poolConfig.port = config.port ?? 5432
        poolConfig.database = config.database ?? "postgres"
        poolConfig.user = config.user
        poolConfig.password = config.password
        if (config.ssl !== undefined) {
          poolConfig.ssl = config.ssl
        }
      }

      poolConfig.max = 5
      poolConfig.idleTimeoutMillis = 30000
      poolConfig.connectionTimeoutMillis = 10000

      pool = new Pool(poolConfig)
    },

    async execute(sql: string, limit?: number): Promise<ConnectorResult> {
      const client = await pool.connect()
      try {
        if (config.statement_timeout) {
          await client.query(
            `SET statement_timeout = '${Number(config.statement_timeout)}ms'`,
          )
        }

        let query = sql
        const effectiveLimit = limit ?? 1000
        // Add LIMIT if not already present
        if (
          effectiveLimit &&
          !sql.trim().toLowerCase().includes("limit")
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
          rows: rows.map((row: any) => columns.map((col: string) => row[col])),
          row_count: rows.length,
          truncated,
        }
      } finally {
        client.release()
      }
    },

    async listSchemas(): Promise<string[]> {
      const result = await connector.execute(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
         ORDER BY schema_name`,
        10000,
      )
      return result.rows.map((r) => r[0] as string)
    },

    async listTables(
      schema: string,
    ): Promise<Array<{ name: string; type: string }>> {
      const result = await connector.execute(
        `SELECT table_name, table_type
         FROM information_schema.tables
         WHERE table_schema = '${schema.replace(/'/g, "''")}'
         ORDER BY table_name`,
        10000,
      )
      return result.rows.map((r) => ({
        name: r[0] as string,
        type: r[1] === "VIEW" ? "view" : "table",
      }))
    },

    async describeTable(
      schema: string,
      table: string,
    ): Promise<SchemaColumn[]> {
      const result = await connector.execute(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = '${schema.replace(/'/g, "''")}'
           AND table_name = '${table.replace(/'/g, "''")}'
         ORDER BY ordinal_position`,
        10000,
      )
      return result.rows.map((r) => ({
        name: r[0] as string,
        data_type: r[1] as string,
        nullable: r[2] === "YES",
      }))
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
