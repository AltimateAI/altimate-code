/**
 * Trino driver using the official `trino-client` package.
 *
 * Supports Trino's HTTP(S) protocol via trino-js-client. Catalog should be set
 * for schema/table introspection.
 */

import type { ConnectionConfig, Connector, ConnectorResult, ExecuteOptions, SchemaColumn } from "./types"

type QueryResult = {
  columns?: Array<{ name: string; type: string }>
  data?: any[][]
  error?: { message?: string; errorName?: string; errorCode?: number }
}

function cleanSql(sql: string): string {
  // Trino escapes single quotes by doubling them ('') and does not use
  // backslash escapes, so the literal pattern must not treat \' as an escape.
  return sql
    .replace(/'(?:[^']|'{2})*'/g, "")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
}

// Escapes a value for use inside a single-quoted SQL string literal. Doubling
// single quotes is the complete and correct escape in Trino — used for the
// schema/table predicates in information_schema introspection queries, whose
// inputs originate from the driver's own catalog walks, not raw user SQL.
function escapeStringLiteral(value: string): string {
  return String(value ?? "").replace(/'/g, "''")
}

function quoteIdent(value: unknown): string {
  const text = String(value ?? "").trim()
  if (!text) {
    throw new Error("Trino identifier cannot be empty")
  }
  return `"${text.replace(/"/g, '""')}"`
}

function defaultCatalog(config: ConnectionConfig): string {
  return String(config.catalog ?? "").trim()
}

function serverUrl(config: ConnectionConfig): string {
  const configured = config.connection_string ?? config.server ?? config.url
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim()
  }

  const protocol = typeof config.protocol === "string" ? config.protocol : config.ssl || config.tls ? "https" : "http"
  const host = String(config.host ?? "localhost")
  const defaultPort = protocol === "https" ? 8443 : 8080
  const parsedPort = Number(config.port)
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : defaultPort
  return `${protocol}://${host}:${port}`
}

function extraHeaders(config: ConnectionConfig): Record<string, string> {
  const headers: Record<string, string> = {}

  if (config.extra_headers && typeof config.extra_headers === "object" && !Array.isArray(config.extra_headers)) {
    for (const [key, value] of Object.entries(config.extra_headers as Record<string, unknown>)) {
      if (value !== undefined && value !== null) headers[key] = String(value)
    }
  }

  const token = config.access_token ?? config.token
  if (typeof token === "string" && token.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`
  }

  if (config.user && !headers["X-Trino-User"]) {
    headers["X-Trino-User"] = String(config.user)
  }

  return headers
}

function trinoError(result: QueryResult): Error | null {
  if (!result.error) return null
  const name = result.error.errorName ? ` ${result.error.errorName}` : ""
  const code = result.error.errorCode !== undefined ? ` (${result.error.errorCode})` : ""
  return new Error(`Trino query failed${name}${code}: ${result.error.message ?? "unknown error"}`)
}

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let Trino: any
  let BasicAuth: any
  let mod: any
  try {
    mod = await import("trino-client")
  } catch {
    throw new Error("Trino driver not installed. Run: npm install trino-client")
  }
  Trino = mod.Trino ?? mod.default?.Trino ?? mod.default
  BasicAuth = mod.BasicAuth ?? mod.default?.BasicAuth
  if (!Trino?.create) {
    throw new Error("Trino.create export not found in trino-client — check the installed package version")
  }

  let client: any

  const connector: Connector = {
    async connect() {
      // Basic (password) and Bearer (access_token) auth are mutually exclusive;
      // sending both produces ambiguous, silently-wrong authentication.
      const bearerToken = config.access_token ?? config.token
      if (config.password && typeof bearerToken === "string" && bearerToken.trim()) {
        throw new Error(
          "Trino: both 'password' (Basic auth) and 'access_token' (Bearer) are set. Configure only one authentication method.",
        )
      }

      const headers = extraHeaders(config)
      const options: Record<string, unknown> = {
        server: serverUrl(config),
        source: config.source ?? "altimate-code",
        catalog: config.catalog,
        schema: config.schema,
        extraHeaders: headers,
      }

      if (config.password) {
        if (typeof config.password !== "string") {
          throw new Error("Trino password must be a string. Check your warehouse configuration.")
        }
        if (!BasicAuth) {
          throw new Error("Trino BasicAuth export not found in trino-client")
        }
        options.auth = new BasicAuth(String(config.user ?? "trino"), config.password)
      }
      if (config.ssl && typeof config.ssl === "object") {
        options.ssl = config.ssl
      }
      if (config.session && typeof config.session === "object" && !Array.isArray(config.session)) {
        options.session = config.session
      }
      if (
        config.extra_credential &&
        typeof config.extra_credential === "object" &&
        !Array.isArray(config.extra_credential)
      ) {
        options.extraCredential = config.extra_credential
      }

      client = Trino.create(options)
    },

    async execute(sql: string, limit?: number, _binds?: any[], options?: ExecuteOptions): Promise<ConnectorResult> {
      if (!client) {
        throw new Error("Trino client not connected — call connect() first")
      }

      // Coerce/clamp the limit so a non-numeric or negative value can never be
      // interpolated into the query as `LIMIT NaN` / `LIMIT -5`.
      const requestedLimit = options?.noLimit ? 0 : Math.floor(Number(limit ?? 1000))
      const effectiveLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 0
      const sqlCleaned = cleanSql(sql)
      const isSelectLike = /^\s*(SELECT|WITH|VALUES|TABLE)\b/i.test(sqlCleaned)
      const hasDML = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|CALL|GRANT|REVOKE)\b/i.test(sqlCleaned)
      // NOTE: this matches LIMIT/FETCH anywhere, so a subquery/CTE LIMIT suppresses
      // outer-LIMIT injection. Acceptable: results are still truncated client-side below.
      const hasLimit = /\b(LIMIT|FETCH\s+(FIRST|NEXT))\b/i.test(sqlCleaned)

      let query = sql
      if (isSelectLike && !hasDML && effectiveLimit > 0 && !hasLimit) {
        query = `${sql.replace(/;\s*$/, "")}\nLIMIT ${effectiveLimit + 1}`
      }

      const iter = await client.query(query)
      let columns: string[] = []
      const rows: any[][] = []

      for await (const result of iter as AsyncIterable<QueryResult>) {
        const err = trinoError(result)
        if (err) throw err
        if (result.columns) {
          columns = result.columns.map((c) => c.name)
        }
        if (result.data) {
          rows.push(...result.data)
        }
      }

      const truncated = effectiveLimit > 0 && rows.length > effectiveLimit
      const limitedRows = truncated ? rows.slice(0, effectiveLimit) : rows
      return {
        columns,
        rows: limitedRows,
        row_count: limitedRows.length,
        truncated,
      }
    },

    async listSchemas(): Promise<string[]> {
      const catalog = defaultCatalog(config)
      if (!catalog) {
        const result = await connector.execute("SHOW CATALOGS", 10000)
        return result.rows.map((r) => String(r[0]))
      }

      const result = await connector.execute(
        `SELECT schema_name
         FROM ${quoteIdent(catalog)}.information_schema.schemata
         WHERE schema_name NOT IN ('information_schema')
         ORDER BY schema_name`,
        10000,
      )
      return result.rows.map((r) => String(r[0]))
    },

    async listTables(schema: string): Promise<Array<{ name: string; type: string }>> {
      const catalog = defaultCatalog(config)
      if (!catalog) {
        throw new Error("Trino catalog is required to list tables. Set catalog in the warehouse config.")
      }

      const result = await connector.execute(
        `SELECT table_name, table_type
         FROM ${quoteIdent(catalog)}.information_schema.tables
         WHERE table_schema = '${escapeStringLiteral(schema)}'
         ORDER BY table_name`,
        10000,
      )
      return result.rows.map((r) => ({
        name: String(r[0]),
        type: String(r[1] ?? "")
          .toUpperCase()
          .includes("VIEW")
          ? "view"
          : "table",
      }))
    },

    async describeTable(schema: string, table: string): Promise<SchemaColumn[]> {
      const catalog = defaultCatalog(config)
      if (!catalog) {
        throw new Error("Trino catalog is required to describe tables. Set catalog in the warehouse config.")
      }

      const result = await connector.execute(
        `SELECT column_name, data_type, is_nullable
         FROM ${quoteIdent(catalog)}.information_schema.columns
         WHERE table_schema = '${escapeStringLiteral(schema)}'
           AND table_name = '${escapeStringLiteral(table)}'
         ORDER BY ordinal_position`,
        10000,
      )
      return result.rows.map((r) => ({
        name: String(r[0]),
        data_type: String(r[1]),
        nullable: String(r[2]).toUpperCase() === "YES",
      }))
    },

    async close() {
      // trino-client is a stateless HTTP client (no close/destroy method and no
      // persistent connection pool), so dropping the reference is sufficient.
      client = null
    },
  }

  return connector
}
