/**
 * DuckDB driver using the `duckdb` package.
 */

import type { ConnectionConfig, Connector, ConnectorResult, ExecuteOptions, SchemaColumn } from "./types"

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

/** Read a positive, finite millisecond budget, or `undefined` if unusable. */
function positiveMs(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function resolveOpenTimeoutMs(config: ConnectionConfig): number {
  return (
    positiveMs(config.open_timeout_ms) ??
    positiveMs(globalThis.process?.env?.["ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS"]) ??
    DEFAULT_OPEN_TIMEOUT_MS
  )
}
// altimate_change end

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let duckdb: any
  try {
    duckdb = await import("duckdb")
    duckdb = duckdb.default || duckdb
  } catch {
    throw new Error("DuckDB driver not installed. Run: npm install duckdb")
  }

  const dbPath = (config.path as string) ?? ":memory:"
  // altimate_change start — configurable open budget
  const openTimeoutMs = resolveOpenTimeoutMs(config)
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
      msg.includes("conflicting lock") ||
      msg.includes("could not set lock") ||
      msg.includes("sqlite_busy") ||
      msg.includes("duckdb_locked")
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
              reject(
                new Error(
                  `DuckDB store "${dbPath}" did not finish opening within ${openTimeoutMs}ms. ` +
                  `This is a client-side deadline in the DuckDB driver, not a fault in the store ` +
                  `— the open may simply be queued behind other work in this process. ` +
                  `Raise it with ALTIMATE_DUCKDB_OPEN_TIMEOUT_MS if the machine is loaded.`,
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
