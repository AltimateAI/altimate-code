/**
 * Databricks driver using the `@databricks/sql` package.
 */

import type { ConnectionConfig, Connector, ConnectorResult, ExecuteOptions, SchemaColumn } from "./types"
import { QueryTimeoutError } from "./types"
import { isStopRequest, untilStopped, type Stopped } from "./stop"
import { loadOptionalDriver } from "./resolve"

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let databricksModule: any
  databricksModule = await loadOptionalDriver("databricks", "@databricks/sql")
  databricksModule = databricksModule.default || databricksModule

  let client: any
  let session: any

  function escapeIdentifier(value: string): string {
    return value.replace(/`/g, "``")
  }

  // How long to wait for the server to acknowledge a cancel before reporting the statement as
  // possibly still running.
  const CANCEL_WAIT_MS = 30_000

  /** Frees the statement on the server. A failed close never replaces the query's own outcome. */
  const closeQuietly = (operation: any): Promise<void> => operation.close().catch(() => {})

  async function cancelAndClose(operation: any): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancelled = await Promise.race([
      operation.cancel().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), CANCEL_WAIT_MS)
      }),
    ]).finally(() => clearTimeout(timer))
    void closeQuietly(operation)
    return cancelled
  }

  // Past `cancelAfterMs`, or when `signal` is stopped, the statement is cancelled on the warehouse: SQL
  // warehouses ignore the client's server-side `queryTimeout`. Otherwise, a client-side query timeout
  // included, it runs to the end.
  async function runStatement(
    query: string,
    stmtOptions: Record<string, any>,
    options?: ExecuteOptions,
  ): Promise<any[]> {
    const deadlineMs = options?.cancelAfterMs && options.cancelAfterMs > 0 ? options.cancelAfterMs : undefined
    const signal = options?.signal
    if (deadlineMs === undefined && !signal) {
      const operation = await session.executeStatement(query, stmtOptions)
      let rows: any[]
      try {
        rows = await operation.fetchAll()
      } catch (error) {
        // A statement that failed while fetching is still open on the session: free it, and
        // report the fetch's own error rather than any from the close.
        void closeQuietly(operation)
        throw error
      }
      await closeQuietly(operation)
      return rows
    }
    signal?.throwIfAborted()
    let stopped = false
    let operation: any
    const work = (async () => {
      const started = await session.executeStatement(query, stmtOptions)
      // A statement the server accepted only after the stop is cancelled as soon as it exists.
      if (stopped) {
        await cancelAndClose(started)
        return [] as any[]
      }
      operation = started
      return operation.fetchAll() as Promise<any[]>
    })()
    let outcome: Stopped<any[]>
    try {
      outcome = await untilStopped(work, { deadlineMs, signal, stopsOnAbort: isStopRequest, onStop: () => (stopped = true) })
    } catch (error) {
      // The fetch failed before any stop: the statement is still open on the session.
      if (operation) void closeQuietly(operation)
      throw error
    }
    if (!outcome.stopped) {
      // Closing frees the server's result, and a failed close must not fail a query that already
      // returned. Without a deadline it is awaited as on the plain path; under one it runs in the
      // background, so a slow close cannot push the query past it.
      if (deadlineMs === undefined) await closeQuietly(operation)
      else void closeQuietly(operation)
      return outcome.value
    }
    const cancelled = operation ? await cancelAndClose(operation) : false
    if (outcome.stopped === "aborted") throw signal!.reason
    throw new QueryTimeoutError({ engine: "databricks", timeoutMs: deadlineMs!, cancelled })
  }

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

    async execute(sql: string, limit?: number, binds?: any[], options?: ExecuteOptions): Promise<ConnectorResult> {
      const effectiveLimit = options?.noLimit ? 0 : (limit ?? 1000)
      let query = sql
      const isSelectLike = /^\s*(SELECT|WITH|VALUES)\b/i.test(sql)
      if (
        isSelectLike &&
        effectiveLimit &&
        !/\bLIMIT\b/i.test(sql)
      ) {
        query = `${sql.replace(/;\s*$/, "")} LIMIT ${effectiveLimit + 1}`
      }

      const stmtOptions: Record<string, any> = {}
      if (binds?.length) {
        stmtOptions.ordinalParameters = binds
      }
      const rows = await runStatement(query, stmtOptions, options)

      const columns = rows.length > 0 ? Object.keys(rows[0]) : []
      const truncated = effectiveLimit > 0 && rows.length > effectiveLimit
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
        `SHOW TABLES IN \`${escapeIdentifier(schema)}\``,
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
        `DESCRIBE TABLE \`${escapeIdentifier(schema)}\`.\`${escapeIdentifier(table)}\``,
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
