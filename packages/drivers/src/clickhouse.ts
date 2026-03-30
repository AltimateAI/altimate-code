/**
 * ClickHouse driver using the `@clickhouse/client` package.
 *
 * Supports ClickHouse server versions 23.3+ (all non-EOL versions as of 2026).
 * Uses the official ClickHouse JS client which communicates over HTTP(S).
 */

import type { ConnectionConfig, Connector, ConnectorResult, SchemaColumn } from "./types"

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let createClient: any
  try {
    const mod = await import("@clickhouse/client")
    createClient = mod.createClient ?? mod.default?.createClient
    if (!createClient) {
      throw new Error("createClient export not found in @clickhouse/client")
    }
  } catch {
    throw new Error("ClickHouse driver not installed. Run: npm install @clickhouse/client")
  }

  let client: any

  return {
    async connect() {
      const url =
        config.connection_string ??
        `${config.protocol ?? "http"}://${config.host ?? "localhost"}:${config.port ?? 8123}`

      const clientConfig: Record<string, unknown> = {
        url,
        request_timeout: Number(config.request_timeout) || 30000,
        compression: {
          request: false,
          response: true,
        },
      }

      if (config.user) clientConfig.username = config.user as string
      if (config.password) clientConfig.password = config.password as string
      if (config.database) clientConfig.database = config.database as string

      // TLS/SSL support — detect HTTPS from URL, protocol config, or explicit tls/ssl flags
      const isHttps = typeof url === "string" && url.startsWith("https://")
      if (config.tls || config.ssl || (config.protocol as string) === "https" || isHttps) {
        const tls: Record<string, unknown> = {}
        if (config.tls_ca_cert) tls.ca_cert = config.tls_ca_cert
        if (config.tls_cert) tls.cert = config.tls_cert
        if (config.tls_key) tls.key = config.tls_key
        if (Object.keys(tls).length > 0) {
          clientConfig.tls = tls
        }
      }

      // ClickHouse Cloud and custom settings
      if (config.clickhouse_settings) {
        clientConfig.clickhouse_settings = config.clickhouse_settings
      }

      client = createClient(clientConfig)
    },

    async execute(sql: string, limit?: number, binds?: any[]): Promise<ConnectorResult> {
      if (binds && binds.length > 0) {
        throw new Error("ClickHouse driver does not support parameterized binds — use ClickHouse query parameters instead")
      }
      const effectiveLimit = limit === undefined ? 1000 : limit
      let query = sql
      // Only SELECT and WITH...SELECT support LIMIT — SHOW/DESCRIBE/EXPLAIN/EXISTS do not
      const supportsLimit = /^\s*(SELECT|WITH)\b/i.test(sql)
      const isDDL =
        /^\s*(INSERT|CREATE|DROP|ALTER|TRUNCATE|RENAME|ATTACH|DETACH|OPTIMIZE|SYSTEM|SET|USE|GRANT|REVOKE)\b/i.test(sql)
      const hasDML = /\b(INSERT|CREATE|DROP|ALTER|TRUNCATE|RENAME|ATTACH|DETACH|OPTIMIZE|SYSTEM)\b/i.test(sql)

      // DDL/DML: use client.command() — no result set expected
      if (isDDL) {
        await client.command({ query: sql.replace(/;\s*$/, "") })
        return { columns: [], rows: [], row_count: 0, truncated: false }
      }

      // Read queries: use client.query() with JSONEachRow format
      // Only append LIMIT for SELECT/WITH queries (not SHOW/DESCRIBE/EXPLAIN/EXISTS)
      if (supportsLimit && !hasDML && effectiveLimit > 0 && !/\bLIMIT\b/i.test(sql)) {
        query = `${sql.replace(/;\s*$/, "")} LIMIT ${effectiveLimit + 1}`
      }

      const resultSet = await client.query({
        query,
        format: "JSONEachRow",
      })

      const rows: any[] = await resultSet.json()

      if (rows.length === 0) {
        return { columns: [], rows: [], row_count: 0, truncated: false }
      }

      const columns = Object.keys(rows[0])
      const truncated = effectiveLimit > 0 && rows.length > effectiveLimit
      const limitedRows = truncated ? rows.slice(0, effectiveLimit) : rows

      return {
        columns,
        rows: limitedRows.map((row: any) => columns.map((col: string) => row[col])),
        row_count: limitedRows.length,
        truncated,
      }
    },

    async listSchemas(): Promise<string[]> {
      const resultSet = await client.query({
        query: "SHOW DATABASES",
        format: "JSONEachRow",
      })
      const rows: any[] = await resultSet.json()
      return rows.map((r) => r.name ?? Object.values(r)[0]) as string[]
    },

    async listTables(schema: string): Promise<Array<{ name: string; type: string }>> {
      const resultSet = await client.query({
        query: `SELECT name, engine
                FROM system.tables
                WHERE database = {db:String}
                ORDER BY name`,
        format: "JSONEachRow",
        query_params: { db: schema },
      })
      const rows: any[] = await resultSet.json()
      return rows.map((r) => ({
        name: r.name as string,
        type: (r.engine as string)?.toLowerCase().includes("view") ? "view" : "table",
      }))
    },

    async describeTable(schema: string, table: string): Promise<SchemaColumn[]> {
      const resultSet = await client.query({
        query: `SELECT name, type,
                       position(type, 'Nullable') > 0 AS is_nullable
                FROM system.columns
                WHERE database = {db:String}
                  AND table = {tbl:String}
                ORDER BY position`,
        format: "JSONEachRow",
        query_params: { db: schema, tbl: table },
      })
      const rows: any[] = await resultSet.json()
      return rows.map((r) => ({
        name: r.name as string,
        data_type: r.type as string,
        nullable: r.is_nullable === 1 || r.is_nullable === true || r.is_nullable === "1",
      }))
    },

    async close() {
      if (client) {
        await client.close()
        client = null
      }
    },
  }
}
