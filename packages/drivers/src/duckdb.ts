/** DuckDB driver using the interruptible, prebuilt Node API. */
import type { DuckDBConnection, DuckDBInstance, DuckDBValue, blobValue, timestampValue } from "@duckdb/node-api"
import { assertStoreExists, requireStorePath } from "./file-store"
import { loadOptionalDriver } from "./resolve"
import type { ConnectionConfig, Connector, ConnectorResult, ExecuteOptions, SchemaColumn } from "./types"

type BindValue = DuckDBValue | Date | Uint8Array

type DuckDBApi = {
  DuckDBInstance: typeof DuckDBInstance
  blobValue: typeof blobValue
  timestampValue: typeof timestampValue
}

// altimate_change start — configurable, generous open budget
/**
 * How long to wait for DuckDB to finish opening a store before giving up.
 *
 * This is a liveness guard, not a performance budget. Opening a store is
 * dispatched to the libuv threadpool, so the wait covers queueing behind every
 * other threadpool user in the process (fs, dns, crypto), not just DuckDB's own
 * work. A busy agent process can therefore push a healthy open well past a
 * second, and the previous hard-coded 2s ceiling turned that into an
 * unrecoverable failure on a store that was fine.
 */
const DEFAULT_OPEN_TIMEOUT_MS = 30_000

/**
 * Largest delay `setTimeout` represents. A larger value overflows the timer's
 * 32-bit signed delay and is clamped to 1ms, which would turn a deliberately
 * huge budget into an immediate deadline — the exact failure this file exists
 * to remove. Clamp instead, so an over-large budget still behaves like a very
 * long one.
 */
const MAX_TIMER_MS = 2_147_483_647

/** Read a positive, finite millisecond budget, or `undefined` if unusable. */
function positiveMs(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_TIMER_MS) : undefined
}

/**
 * Where the budget came from, which decides how a caller should read a
 * deadline failure: one the connection set is that connection's own doing and
 * is fixed by changing it, while the default or a machine-wide env var firing
 * says something about the machine instead.
 */
type TimeoutSource = "connection" | "env" | "default"

function resolveOpenTimeoutMs(config: ConnectionConfig): { ms: number; source: TimeoutSource } {
  const fromConfig = positiveMs(config.open_timeout_ms)
  if (fromConfig !== undefined) return { ms: fromConfig, source: "connection" }
  const fromEnv = positiveMs(globalThis.process?.env?.["ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS"])
  if (fromEnv !== undefined) return { ms: fromEnv, source: "env" }
  return { ms: DEFAULT_OPEN_TIMEOUT_MS, source: "default" }
}
// altimate_change end

export async function connect(config: ConnectionConfig): Promise<Connector> {
  const api: DuckDBApi = await loadOptionalDriver("duckdb", "@duckdb/node-api")
  const dbPath = requireStorePath(config, "DuckDB")
  const timeout = resolveOpenTimeoutMs(config)
  let db: DuckDBInstance | undefined
  let connection: DuckDBConnection | undefined
  let closing: Promise<void> | undefined
  const queries = new Set<Promise<unknown>>()
  let tail = Promise.resolve()

  function wrapDuckDBError(error: unknown) {
    if (!isLockError(error)) return error
    return new Error(
      `Database "${dbPath}" is locked by another process. ` +
        `DuckDB takes an exclusive file lock, so a store already open ` +
        `read-write elsewhere cannot be opened again - not even read-only. ` +
        `Close the other connection and try again.\n${error instanceof Error ? error.message : String(error)}`,
    )
  }

  function open(accessMode?: string) {
    return new Promise<DuckDBInstance>((resolve, reject) => {
      let expired = false
      const timer = setTimeout(() => {
        expired = true
        reject(
          new Error(
            `DuckDB store "${dbPath}" did not finish opening within ${timeout.ms}ms. ` +
              `This is a client-side deadline in the DuckDB driver, not a fault in the store. ` +
              (timeout.source === "connection"
                ? `This deadline was set on this connection as open_timeout_ms=${timeout.ms}; raise or remove it.`
                : `Raise open_timeout_ms or ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS if the machine is loaded.`),
          ),
        )
      }, timeout.ms)
      api.DuckDBInstance.create(dbPath, accessMode ? { access_mode: accessMode } : undefined).then(
        (instance) => {
          clearTimeout(timer)
          // A timed-out open still owns a native handle when it eventually resolves.
          if (expired) return instance.closeSync()
          resolve(instance)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  function query(sql: string, binds?: BindValue[], signal?: AbortSignal) {
    const active = connection
    if (!active || closing) throw new Error("DuckDB connection is closed.")
    signal?.throwIfAborted()
    // DuckDB interrupts the active connection query, not a particular queued
    // call. Admit one query at a time so aborting a waiter cannot cancel its predecessor.
    const pending = tail
      .then(async () => {
        signal?.throwIfAborted()
        if (closing) throw new Error("DuckDB connection is closed.")
        const interrupt = () => active.interrupt()
        signal?.addEventListener("abort", interrupt, { once: true })
        try {
          const reader = await active.runAndReadAll(
            sql,
            binds?.length
              ? binds.map((value) => {
                  if (value instanceof Date) return api.timestampValue(BigInt(value.getTime()) * 1000n)
                  if (value instanceof Uint8Array) return api.blobValue(value)
                  return value
                })
              : undefined,
          )
          signal?.throwIfAborted()
          return { columns: reader.columnNames(), rows: reader.getRowsJS() }
        } catch (error) {
          signal?.throwIfAborted()
          throw wrapDuckDBError(error)
        } finally {
          signal?.removeEventListener("abort", interrupt)
        }
      })
      .finally(() => queries.delete(pending))
    tail = pending.then(
      () => undefined,
      () => undefined,
    )
    queries.add(pending)
    return pending
  }

  return {
    async connect() {
      assertStoreExists(config, dbPath, "DuckDB")
      const wantReadOnly = config.readonly === true && dbPath !== ":memory:"
      db = await open(wantReadOnly ? "READ_ONLY" : undefined)
        .catch((error: unknown) => {
          if (isLockError(error) && !wantReadOnly && dbPath !== ":memory:") return open("READ_ONLY")
          throw error
        })
        .catch((error: unknown) => {
          throw wrapDuckDBError(error)
        })
      connection = await db.connect().catch((error: unknown) => {
        db?.closeSync()
        db = undefined
        throw error
      })
      closing = undefined
    },

    async execute(
      sql: string,
      limit?: number,
      binds?: BindValue[],
      options?: ExecuteOptions,
    ): Promise<ConnectorResult> {
      const effectiveLimit = options?.noLimit ? 0 : (limit ?? 1000)
      const finalSql =
        /^\s*(SELECT|WITH|VALUES)\b/i.test(sql) && effectiveLimit && !/\bLIMIT\b/i.test(sql)
          ? `${sql.replace(/;\s*$/, "")} LIMIT ${effectiveLimit + 1}`
          : sql
      const result = await query(finalSql, binds, options?.signal)
      const truncated = effectiveLimit > 0 && result.rows.length > effectiveLimit
      const rows = truncated ? result.rows.slice(0, effectiveLimit) : result.rows
      return { columns: result.columns, rows, row_count: rows.length, truncated }
    },

    async listSchemas(): Promise<string[]> {
      const result = await query("SELECT schema_name FROM information_schema.schemata ORDER BY schema_name")
      return result.rows.map((row) => String(row[0]))
    },

    async listTables(schema: string): Promise<Array<{ name: string; type: string }>> {
      const result = await query(
        "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
        [schema],
      )
      return result.rows.map((row) => ({ name: String(row[0]), type: row[1] === "VIEW" ? "view" : "table" }))
    },

    async describeTable(schema: string, table: string): Promise<SchemaColumn[]> {
      const result = await query(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
        [schema, table],
      )
      return result.rows.map((row) => ({ name: String(row[0]), data_type: String(row[1]), nullable: row[2] === "YES" }))
    },

    async close() {
      if (closing) return closing
      closing = (async () => {
        // Wait for interrupted native work before disconnecting; never depend on GC for locks.
        connection?.interrupt()
        await Promise.allSettled([...queries])
        connection?.closeSync()
        connection = undefined
        db?.closeSync()
        db = undefined
      })()
      return closing
    },
  }
}

function isLockError(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    message.includes("locked") ||
    (message.includes("could not set lock") && message.includes("conflicting lock")) ||
    message.includes("sqlite_busy")
  )
}
