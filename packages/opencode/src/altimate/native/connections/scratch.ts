/**
 * Session-scoped `scratch` warehouse.
 *
 * An implicit, ephemeral DuckDB database that exists for the life of this
 * process. It is the landing zone for `sql_materialize`: rows read from any
 * warehouse are stored here in full so they can be joined with rows from
 * another engine in a single SQL statement, without the model carrying the rows
 * through its context.
 *
 * Design choice: a pure in-memory DuckDB (`:memory:`), not a temp file.
 *   - Nothing to clean up: the data vanishes with the process, including on a
 *     crash or SIGKILL, where a temp file would be left behind.
 *   - Process-scoped isolation falls out for free: a fresh process starts empty,
 *     and two CLI processes never contend for a file lock.
 *   - The existing DuckDB connector already supports it (`assertStoreExists`
 *     skips `:memory:`), so no driver change is needed.
 *   Trade-off: the working set is bounded by RAM; `sql_materialize` enforces a
 *   row cap and an estimated-byte cap for that reason.
 *
 * The connection is created lazily and shared, so `sql_execute(warehouse:
 * "scratch")` and `sql_materialize` always see the same tables.
 */

import type { Connector } from "@altimateai/drivers"

/** Reserved warehouse name. User configs cannot shadow or replace it. */
export const SCRATCH_NAME = "scratch"

/** Marker shown in `warehouse_list` (the `database` column). */
export const SCRATCH_DESCRIPTION = "session-scoped, ephemeral"

/** The synthetic config reported for the scratch warehouse. */
export const SCRATCH_CONFIG = Object.freeze({ type: "duckdb", path: ":memory:" })

export function isScratch(name: string | undefined | null): boolean {
  return name === SCRATCH_NAME
}

let connector: Connector | undefined
let inflight: Promise<Connector> | undefined
type ScratchOperation = <T>(operation: (connection: Connector) => Promise<T>) => Promise<T>
const operations = new WeakMap<Connector, ScratchOperation>()

function managedScratch(raw: Connector): Connector {
  let pending = Promise.resolve()
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = pending.then(operation)
    pending = next.then(
      () => {},
      () => {},
    )
    return next
  }

  async function initialize(): Promise<void> {
    // A query timeout can respawn the local engine while retaining this connector.
    // Its new in-memory database has neither the attachment nor the current catalog.
    const current = await raw.execute("SELECT current_database()", 1)
    if (current.rows[0]?.[0] === SCRATCH_NAME) return
    await raw.execute(`ATTACH IF NOT EXISTS ':memory:' AS ${SCRATCH_NAME}`, undefined, undefined, { noLimit: true })
    await raw.execute(`USE ${SCRATCH_NAME}`, undefined, undefined, { noLimit: true })
  }

  const run: ScratchOperation = (operation) =>
    exclusive(async () => {
      await initialize()
      return operation(raw)
    })
  const managed: Connector = {
    connect: () =>
      exclusive(async () => {
        await raw.connect()
        await initialize()
      }),
    execute: (sql, limit, binds, options) => {
      const execute = () => raw.execute(sql, limit, binds, options)
      // A failed transaction must be allowed to roll back even if a catalog probe
      // would itself be rejected because that transaction is aborted.
      return /^\s*ROLLBACK(?:\s+TRANSACTION)?\s*;?\s*$/i.test(sql) ? exclusive(execute) : run(execute)
    },
    listSchemas: () => run((connection) => connection.listSchemas()),
    listTables: (schema) => run((connection) => connection.listTables(schema)),
    describeTable: (schema, table) => run((connection) => connection.describeTable(schema, table)),
    close: () => exclusive(() => raw.close()),
  }
  operations.set(managed, run)
  return managed
}

/**
 * Hold the scratch connection for a complete operation, including its transaction.
 * Use the supplied connector inside the callback; calling the shared connector
 * there would queue behind this operation. The supplied connector must not escape.
 */
export async function withScratchConnection<T>(operation: (connection: Connector) => Promise<T>): Promise<T> {
  const c = await getScratch()
  return operations.get(c)!(operation)
}

/** The shared scratch connector, opened on first use. */
export function getScratch(): Promise<Connector> {
  if (connector) return Promise.resolve(connector)
  if (inflight) return inflight
  const mine: Promise<Connector> = (async () => {
    try {
      const { connect } = await import("@altimateai/drivers/duckdb")
      const c = managedScratch(await connect({ ...SCRATCH_CONFIG }))
      await c.connect()
      connector = c
      return c
    } finally {
      queueMicrotask(() => {
        if (inflight === mine) inflight = undefined
      })
    }
  })()
  inflight = mine
  return mine
}

/** Whether the scratch database has been opened in this process. */
export function scratchOpened(): boolean {
  return connector !== undefined
}

/** Close and forget the scratch database; the next use starts empty. */
export async function closeScratch(): Promise<void> {
  const pendingOpen = inflight
  if (pendingOpen) await pendingOpen.catch(() => {})
  const c = connector
  connector = undefined
  if (c) {
    try {
      await c.close()
    } catch {
      // best-effort
    }
  }
}
