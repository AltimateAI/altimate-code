/**
 * Databricks driver using the `@databricks/sql` package.
 */

import type { ConnectionConfig, Connector, ConnectorResult, SchemaColumn } from "./types"

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let databricksModule: any
  try {
    databricksModule = await import("@databricks/sql")
    databricksModule = databricksModule.default || databricksModule
  } catch {
    throw new Error(
      "Databricks driver not installed. Run: bun add @databricks/sql",
    )
  }

  let client: any
  let session: any

  return {
    async connect() {
      const DBSQLClient = databricksModule.DBSQLClient ?? databricksModule

      // Suppress @databricks/sql Winston console logging — it writes JSON
      // log lines to stdout which corrupt the TUI display (see #249).
      // Use a no-op logger that satisfies the interface but discards all output.
      const logger = { log: () => {}, setLevel: () => {} }
      client = new DBSQLClient({ logger })
      const connectionOptions: Record<string, unknown> = {
        host: config.server_hostname,
        path: config.http_path,
        token: config.access_token,
      }

      await client.connect(connectionOptions)
      session = await client.openSession({
        initialCatalog: config.catalog as string | undefined,
        initialSchema: config.schema as string | undefined,
      })
    },

    async execute(sql: string, limit?: number): Promise<ConnectorResult> {
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

      const operation = await session.executeStatement(query)
      const rows = await operation.fetchAll()
      await operation.close()

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
      const operation = await session.executeStatement("SHOW SCHEMAS")
      const rows = await operation.fetchAll()
      await operation.close()
      return rows.map(
        (r: any) =>
          (r.databaseName ?? r.namespace ?? Object.values(r)[0]) as string,
      )
    },

    async listTables(
      schema: string,
    ): Promise<Array<{ name: string; type: string }>> {
      const operation = await session.executeStatement(
        `SHOW TABLES IN \`${schema}\``,
      )
      const rows = await operation.fetchAll()
      await operation.close()
      return rows.map((r: any) => ({
        name: (r.tableName ?? Object.values(r)[0]) as string,
        type:
          r.isTemporary === true
            ? "temporary"
            : "table",
      }))
    },

    async describeTable(
      schema: string,
      table: string,
    ): Promise<SchemaColumn[]> {
      const operation = await session.executeStatement(
        `DESCRIBE TABLE \`${schema}\`.\`${table}\``,
      )
      const rows = await operation.fetchAll()
      await operation.close()
      return rows
        .filter((r: any) => r.col_name && !r.col_name.startsWith("#"))
        .map((r: any) => ({
          name: r.col_name as string,
          data_type: r.data_type as string,
          nullable: r.nullable !== "false",
        }))
    },

    async close() {
      if (session) {
        try {
          await session.close()
        } catch {
          // ignore
        }
        session = null
      }
      if (client) {
        try {
          await client.close()
        } catch {
          // ignore
        }
        client = null
      }
    },
  }
}
