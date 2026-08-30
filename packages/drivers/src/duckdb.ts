/**
 * DuckDB driver using the `duckdb` package.
 */

import { assertStoreExists, requireStorePath } from "./file-store"
import type { ConnectionConfig, Connector, ConnectorResult, ExecuteOptions, SchemaColumn } from "./types"
import { loadOptionalDriver } from "./resolve"

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
  let duckdb: any
  duckdb = await loadOptionalDriver("duckdb", "duckdb")
  duckdb = duckdb.default || duckdb

  // altimate_change start — a missing path must fail loudly, not become :memory:
  const dbPath = requireStorePath(config, "DuckDB")
  // altimate_change end
  // altimate_change start — configurable open budget
  const { ms: openTimeoutMs, source: openTimeoutSource } = resolveOpenTimeoutMs(config)
  // altimate_change end
  let db: any
  let connection: any

  // altimate_change start — improve DuckDB error messages
  // Real DuckDB lock failures read "Could not set lock on file ... Conflicting
  // lock is held", which contains "lock" but never "locked". Matching only
  // "locked"/"DUCKDB_LOCKED" therefore missed every genuine lock collision, so
  // the read-only retry never fired and concurrent readers just failed.
  function isLockError(err: unknown): boolean {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
    return (
      msg.includes("locked") ||
      // Both halves, not either. "could not set lock" on its own also covers
      // non-contention failures — an unsupported filesystem lock, a permissions
      // problem — and matching it alone would wrap those as "locked by another
      // process", fabricating a wrapper that Registry.categorizeConnectionError
      // then trusts as a recoverable `store_locked`. That would send the reader
      // hunting for a process to close while hiding the real filesystem fault.
      // Registry's raw matcher already requires both; these must agree.
      (msg.includes("could not set lock") && msg.includes("conflicting lock")) ||
      msg.includes("sqlite_busy")
    )
  }

  function wrapDuckDBError(err: Error): Error {
    if (isLockError(err)) {
      // Keep DuckDB's own text: it names the PID and executable holding the
      // conflicting lock, which is the only way to find the other process.
      return new Error(
        `Database "${dbPath}" is locked by another process. ` +
        `DuckDB takes an exclusive file lock, so a store already open ` +
        `read-write elsewhere cannot be opened again — not even read-only. ` +
        `Close the other connection and try again.\n${err.message || String(err)}`,
      )
    }
    return err
  }
  // altimate_change end

  function query(sql: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
      connection.all(sql, (err: Error | null, rows: any[]) => {
        if (err) reject(wrapDuckDBError(err))
        else resolve(rows ?? [])
      })
    })
  }

  function queryWithParams(sql: string, params: any[]): Promise<any[]> {
    return new Promise((resolve, reject) => {
      connection.all(sql, ...params, (err: Error | null, rows: any[]) => {
        if (err) reject(wrapDuckDBError(err))
        else resolve(rows ?? [])
      })
    })
  }

  return {
    async connect() {
      // altimate_change start — never conjure an empty store on open
      assertStoreExists(config, dbPath, "DuckDB")
      // altimate_change end
      // altimate_change start — retry with read-only on lock errors
      const tryConnect = (accessMode?: string): Promise<any> =>
        new Promise<any>((resolve, reject) => {
          let resolved = false
          let timeout: ReturnType<typeof setTimeout> | undefined
          let instance: any
          // Sentinel for an open callback that fired synchronously (before
          // `instance` was assigned), replayed once `instance` exists.
          //
          // This MUST be a value the callback can never supply. It used to be
          // `undefined`, which is exactly what a success callback invoked with
          // no arguments passes — so such a callback was recorded and then
          // never replayed, the promise never settled, and the open failed on
          // the deadline below with a timeout message that named nothing.
          const NOT_FIRED = Symbol("duckdb-open-not-fired")
          let pendingOpen: Error | null | typeof NOT_FIRED = NOT_FIRED
          const opts = accessMode ? { access_mode: accessMode } : undefined
          const closeQuietly = () => {
            try {
              if (instance && typeof instance.close === "function") instance.close()
            } catch {
              // best-effort cleanup of a half-open handle
            }
          }
          const onOpen = (err?: Error | null) => {
            // Normalise a zero-argument success callback to `null` so it is
            // never confused with "has not fired yet".
            const outcome = err ?? null
            if (!instance) {
              pendingOpen = outcome
              return
            }
            if (resolved) {
              closeQuietly()
              return
            }
            resolved = true
            if (timeout) clearTimeout(timeout)
            if (outcome) {
              // Open failed — release the half-open handle so it doesn't leak.
              // Reject with DuckDB's own error: callers classify it with
              // isLockError(), and its text names the conflicting process.
              closeQuietly()
              reject(outcome)
            } else {
              resolve(instance)
            }
          }
          instance = opts
            ? new duckdb.Database(dbPath, opts, onOpen)
            : new duckdb.Database(dbPath, onOpen)
          // Liveness guard against an open callback that never fires. Arm the
          // timer BEFORE replaying a synchronous callback so a sync
          // resolve/reject can actually clear it (otherwise it lingers and
          // delays process exit).
          timeout = setTimeout(() => {
            if (!resolved) {
              resolved = true
              // Nothing can reach this handle once the promise rejects. If the
              // callback arrives later it closes the handle itself (see the
              // `resolved` branch in onOpen); if it never arrives, that branch
              // never runs, so close here too. Both paths are idempotent
              // because closeQuietly swallows a double close.
              closeQuietly()
              reject(
                new Error(
                  `DuckDB store "${dbPath}" did not finish opening within ${openTimeoutMs}ms. ` +
                  `This is a client-side deadline in the DuckDB driver, not a fault in the store ` +
                  `— the open may simply be queued behind other work in this process. ` +
                  (openTimeoutSource === "connection"
                    ? // Named so callers can tell a self-inflicted deadline from one
                      // they did not choose. Registry.categorizeConnectionError keys
                      // off this phrase to report it as configuration rather than as
                      // a broken client.
                      `This deadline was set on this connection as open_timeout_ms=${openTimeoutMs}; ` +
                      `raise or remove it.`
                    : `Raise the budget with this connection's open_timeout_ms (which takes ` +
                      `priority) or ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS if the machine is loaded.`),
                ),
              )
            }
          }, openTimeoutMs)
          if (pendingOpen !== NOT_FIRED) onOpen(pendingOpen)
        })

      // altimate_change start — honour an explicit read-only connection.
      // DuckDB takes an EXCLUSIVE file lock when opened read-write, so N
      // concurrent readers of one .duckdb file leave N-1 of them failing to
      // connect at all. Opening READ_ONLY up front is the only way several
      // processes can share a file, and it is what a caller that declared
      // `readonly` asked for. Relying on the lock-error retry below is not
      // equivalent: it is best-effort string matching, and it wastes a full
      // open attempt per connection.
      const wantReadOnly = config.readonly === true && dbPath !== ":memory:"
      try {
        db = await tryConnect(wantReadOnly ? "READ_ONLY" : undefined)
      } catch (err: any) {
        // altimate_change end
        if (isLockError(err) && !wantReadOnly && dbPath !== ":memory:") {
          // Retry in read-only mode — allows concurrent reads
          try {
            db = await tryConnect("READ_ONLY")
          } catch (retryErr) {
            throw wrapDuckDBError(
              retryErr instanceof Error ? retryErr : new Error(String(retryErr)),
            )
          }
        } else if (isLockError(err) && dbPath !== ":memory:") {
          // An explicit read-only open is NOT rescued by the retry above — and
          // must not be: DuckDB's file lock is exclusive against read-only
          // opens too, so re-opening READ_ONLY when we already asked for
          // READ_ONLY would only repeat the same failure. It still has to be
          // wrapped, because categorizeConnectionError matches the wrapper's
          // "locked by another process" wording; the raw DuckDB text would be
          // reported as an unclassified failure. An in-memory store is excluded
          // for the same reason the retry excludes it: no other process can
          // hold it, so the wrapper's text would be false.
          throw wrapDuckDBError(err instanceof Error ? err : new Error(String(err)))
        } else {
          throw err
        }
      }
      // altimate_change end
      connection = db.connect()
    },

    async execute(sql: string, limit?: number, binds?: any[], options?: ExecuteOptions): Promise<ConnectorResult> {
      const effectiveLimit = options?.noLimit ? 0 : (limit ?? 1000)

      let finalSql = sql
      const isSelectLike = /^\s*(SELECT|WITH|VALUES)\b/i.test(sql)
      if (
        isSelectLike &&
        effectiveLimit &&
        !/\bLIMIT\b/i.test(sql)
      ) {
        finalSql = `${sql.replace(/;\s*$/, "")} LIMIT ${effectiveLimit + 1}`
      }

      const rows = binds?.length
        ? await queryWithParams(finalSql, binds)
        : await query(finalSql)
      const columns =
        rows.length > 0 ? Object.keys(rows[0]) : []
      const truncated = effectiveLimit > 0 && rows.length > effectiveLimit
      const limitedRows = truncated ? rows.slice(0, effectiveLimit) : rows

      return {
        columns,
        rows: limitedRows.map((row) =>
          columns.map((col) => row[col]),
        ),
        row_count: limitedRows.length,
        truncated,
      }
    },

    async listSchemas(): Promise<string[]> {
      const rows = await query(
        "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
      )
      return rows.map((r) => r.schema_name as string)
    },

    async listTables(
      schema: string,
    ): Promise<Array<{ name: string; type: string }>> {
      const rows = await queryWithParams(
        `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
        [schema],
      )
      return rows.map((r) => ({
        name: r.table_name as string,
        type: r.table_type === "VIEW" ? "view" : "table",
      }))
    },

    async describeTable(
      schema: string,
      table: string,
    ): Promise<SchemaColumn[]> {
      const rows = await queryWithParams(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [schema, table],
      )
      return rows.map((r) => ({
        name: r.column_name as string,
        data_type: r.data_type as string,
        nullable: r.is_nullable === "YES",
      }))
    },

    async close() {
      if (db) {
        await new Promise<void>((resolve) => {
          db.close((err: Error | null) => {
            resolve()
          })
          // Bun: native callback may not fire; fall back after timeout
          setTimeout(resolve, 500)
        })
        db = null
        connection = null
      }
    },
  }
}
