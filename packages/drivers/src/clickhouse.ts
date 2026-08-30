/**
 * ClickHouse driver using the `@clickhouse/client` package.
 *
 * Supports ClickHouse server versions 23.3+ (all non-EOL versions as of 2026).
 * Uses the official ClickHouse JS client which communicates over HTTP(S).
 */

import type { ConnectionConfig, Connector, ConnectorResult, ExecuteOptions, SchemaColumn } from "./types"
import { loadOptionalDriver } from "./resolve"

function connectionUrl(config: ConnectionConfig): string {
  const tlsRequested = Boolean(config.tls || config.ssl)
  const configuredProtocol = typeof config.protocol === "string" ? config.protocol.trim().toLowerCase() : ""
  const secureIntent = tlsRequested || configuredProtocol === "https"
  const configured = typeof config.connection_string === "string" ? config.connection_string.trim() : ""

  if (configured) {
    if (secureIntent) {
      let protocol: string
      try {
        protocol = new URL(configured).protocol.toLowerCase()
      } catch {
        throw new Error("ClickHouse TLS requires a valid https:// connection_string")
      }
      if (protocol !== "https:") {
        throw new Error("ClickHouse TLS was requested, but connection_string is not https://")
      }
    }
    return configured
  }

  if (tlsRequested && configuredProtocol && configuredProtocol !== "https") {
    throw new Error("ClickHouse TLS was requested, but protocol is not https")
  }

  const protocol = configuredProtocol || (tlsRequested ? "https" : "http")
  const defaultPort = protocol === "https" ? 8443 : 8123
  const hasExplicitPort = config.port !== undefined && config.port !== null
  const parsedPort =
    typeof config.port === "number"
      ? config.port
      : typeof config.port === "string" && config.port.trim()
        ? Number(config.port)
        : Number.NaN
  if (hasExplicitPort && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)) {
    throw new Error("ClickHouse port must be an integer between 1 and 65535")
  }
  const port = hasExplicitPort ? parsedPort : defaultPort
  return `${protocol}://${config.host ?? "localhost"}:${port}`
}

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let createClient: any
  const clickhouseModule = await loadOptionalDriver("clickhouse", "@clickhouse/client")
  createClient = clickhouseModule.createClient ?? clickhouseModule.default?.createClient
  if (!createClient) {
    throw new Error("createClient export not found in @clickhouse/client — check the installed package version")
  }

  let client: any

  return {
    async connect() {
      const url = connectionUrl(config)

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

      // Silence the client's internal stderr logger — its ERROR-level output
      // writes raw lines directly to stderr and corrupts terminal TUI rendering.
      clientConfig.log = { level: 127 } // ClickHouseLogLevel.OFF = 127
      client = createClient(clientConfig)
    },

    async execute(sql: string, limit?: number, _binds?: any[], options?: ExecuteOptions): Promise<ConnectorResult> {
      if (!client) {
        throw new Error("ClickHouse client not connected — call connect() first")
      }
      const effectiveLimit = options?.noLimit ? 0 : (limit ?? 1000)
      let query = sql

      // Strip string literals, then comments, for accurate SQL heuristic checks.
      // This prevents comment-like content inside strings from fooling detection,
      // and ensures leading/trailing comments don't hide keywords.
      const sqlCleaned = sql
        .replace(/'(?:[^'\\]|\\.|\'{2})*'/g, "") // strip single-quoted strings (handles \' and '' escaping)
        .replace(/--[^\n]*/g, "") // strip line comments
        .replace(/\/\*[\s\S]*?\*\//g, "") // strip block comments

      // Only SELECT and WITH...SELECT support LIMIT — SHOW/DESCRIBE/EXPLAIN/EXISTS do not
      const supportsLimit = /^\s*(SELECT|WITH)\b/i.test(sqlCleaned)
      const isDDL =
        /^\s*(INSERT|CREATE|DROP|ALTER|TRUNCATE|RENAME|ATTACH|DETACH|OPTIMIZE|SYSTEM|SET|USE|GRANT|REVOKE)\b/i.test(sqlCleaned)

      // DDL/DML: use client.command() — no result set expected
      if (isDDL) {
        await client.command({ query: sql.replace(/;\s*$/, "") })
        return { columns: [], rows: [], row_count: 0, truncated: false }
      }

      // Read queries: use client.query() with JSONEachRow format
      // Only append LIMIT for SELECT/WITH queries that don't already have one.
      if (supportsLimit && effectiveLimit > 0 && !/\bLIMIT\b/i.test(sqlCleaned)) {
        query = `${sql.replace(/;\s*$/, "")}\nLIMIT ${effectiveLimit + 1}`
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
      if (!client) {
        throw new Error("ClickHouse client not connected — call connect() first")
      }
      const resultSet = await client.query({
        query: "SHOW DATABASES",
        format: "JSONEachRow",
      })
      const rows: any[] = await resultSet.json()
      return rows.map((r) => r.name ?? Object.values(r)[0]) as string[]
    },

    async listTables(schema: string): Promise<Array<{ name: string; type: string }>> {
      if (!client) {
        throw new Error("ClickHouse client not connected — call connect() first")
      }
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
      if (!client) {
        throw new Error("ClickHouse client not connected — call connect() first")
      }
      const resultSet = await client.query({
        query: `SELECT name, type
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
        // Detect Nullable from the type string directly — stable across all versions.
        // LowCardinality(Nullable(T)) is also nullable (LowCardinality is a storage optimization).
        nullable: /^(?:LowCardinality\(\s*)?Nullable\b/i.test((r.type as string) ?? ""),
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
