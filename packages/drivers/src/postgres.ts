/**
 * PostgreSQL driver using the `pg` package.
 */

import type { ConnectionConfig, Connector, ConnectorResult, ExecuteOptions, SchemaColumn } from "./types"
import { loadOptionalDriver } from "./resolve"
import { QueryTimeoutError } from "./types"
import { resolveQueryTimeout, tighter } from "./query-timeout"

/** SQLSTATE for a statement cancelled by the server (statement_timeout or a manual cancel). */
const PG_QUERY_CANCELED = "57014"

const PG_UNIT_MS: Record<string, number> = { us: 0.001, ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 }

/** Parse a `SHOW statement_timeout` value ("30s", "5min", "0", "250ms") to ms; `0` means unlimited. */
export function parsePgDuration(value: unknown): { ms: number | undefined } | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?\s*$/i.exec(String(value ?? ""))
  if (!m) return undefined
  const ms = Number(m[1]) * PG_UNIT_MS[(m[2] ?? "ms").toLowerCase()]!
  return { ms: ms > 0 ? Math.ceil(ms) : undefined }
}

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let pg: any
  pg = await loadOptionalDriver("postgres", "pg")

  const Pool = pg.default?.Pool ?? pg.Pool
  let pool: any
  // The role/database/session default a pooled client starts each call with
  // (we RESET back to it), so it is read once per client. `undefined` = not read yet.
  const existingTimeout = new WeakMap<object, { ms: number | undefined } | null>()

  const connector: Connector = {
    async connect() {
      const poolConfig: Record<string, unknown> = {}

      if (config.connection_string) {
        poolConfig.connectionString = config.connection_string
      } else {
        // Validate required credentials before connecting to avoid cryptic
        // SASL/SCRAM errors from the pg driver when password is missing
        if (config.password != null && typeof config.password !== "string") {
          throw new Error(
            "PostgreSQL password must be a string. Check your warehouse configuration.",
          )
        }
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

    async execute(sql: string, limit?: number, _binds?: any[], options?: ExecuteOptions): Promise<ConnectorResult> {
      const client = await pool.connect()
      // Tighter of the explicit statement_timeout and the common execution
      // deadline: a configured limit stricter than the default is preserved.
      const configured = Number(config.statement_timeout)
      const configuredMs = Number.isFinite(configured) && configured > 0 ? Math.round(configured) : undefined
      const ourMs = tighter(configuredMs, resolveQueryTimeout(config, options).ms)
      let effectiveMs = ourMs
      let timeoutApplied = false
      let discardClient = false
      // altimate_change start — keep source extraction inside one client's read-only transaction
      let readOnlyTransaction = false
      // altimate_change end
      try {
        if (ourMs !== undefined) {
          // Never loosen a stricter limit the server or role already imposes.
          let existing = existingTimeout.get(client)
          if (existing === undefined) {
            try {
              const shown = await client.query("SHOW statement_timeout")
              existing = parsePgDuration(shown?.rows?.[0]?.statement_timeout) ?? null
            } catch {
              existing = null
            }
            existingTimeout.set(client, existing)
          }
          effectiveMs = tighter(existing?.ms, ourMs)
          if (existing?.ms === undefined || ourMs < existing.ms) {
            await client.query(`SET statement_timeout TO ${ourMs}`)
            timeoutApplied = true
          }
        }

        let query = sql
        const effectiveLimit = options?.noLimit ? 0 : (limit ?? 1000)
        const isSelectLike = /^\s*(SELECT|WITH|VALUES)\b/i.test(sql)
        // Add LIMIT only for SELECT-like queries and if not already present
        if (
          isSelectLike &&
          effectiveLimit &&
          !/\bLIMIT\b/i.test(sql)
        ) {
          query = `${sql.replace(/;\s*$/, "")} LIMIT ${effectiveLimit + 1}`
        }

        // altimate_change start — a derived SELECT can still invoke a writing function
        if (options?.readOnly) {
          await client.query("BEGIN READ ONLY")
          readOnlyTransaction = true
        }
        // altimate_change end
        const result = await client.query(query)
        const columns = result.fields?.map((f: any) => f.name) ?? []
        const truncated = effectiveLimit > 0 && result.rows.length > effectiveLimit
        const rows = truncated
          ? result.rows.slice(0, effectiveLimit)
          : result.rows

        return {
          columns,
          rows: rows.map((row: any) => columns.map((col: string) => row[col])),
          row_count: rows.length,
          truncated,
        }
      } catch (err: any) {
        // 57014 is also a manual cancel; only the message names a timeout.
        if (effectiveMs !== undefined && err?.code === PG_QUERY_CANCELED && /statement timeout/i.test(String(err?.message))) {
          throw new QueryTimeoutError({ engine: "PostgreSQL", timeoutMs: effectiveMs })
        }
        throw err
      } finally {
        // altimate_change start — rollback also suppresses transaction-delayed pg_notify calls
        if (readOnlyTransaction) {
          try {
            await client.query("ROLLBACK")
          } catch {
            discardClient = true
          }
        }
        // altimate_change end
        // Restore the session default before the client returns to the pool, so
        // one call's deadline never leaks into the next caller's query. If the
        // reset fails the session state is unknown: drop the connection instead.
        if (timeoutApplied) {
          try {
            await client.query("RESET statement_timeout")
          } catch {
            discardClient = true
          }
        }
        client.release(discardClient ? true : undefined)
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
      const client = await pool.connect()
      try {
        const result = await client.query(
          `SELECT table_name, table_type
           FROM information_schema.tables
           WHERE table_schema = $1
           ORDER BY table_name`,
          [schema],
        )
        return result.rows.map((r: any) => ({
          name: r.table_name as string,
          type: r.table_type === "VIEW" ? "view" : "table",
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
          `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name = $2
           ORDER BY ordinal_position`,
          [schema, table],
        )
        return result.rows.map((r: any) => ({
          name: r.column_name as string,
          data_type: r.data_type as string,
          nullable: r.is_nullable === "YES",
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
