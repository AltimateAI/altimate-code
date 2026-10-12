/**
 * Session-scoped `scratch` warehouse.
 *
 * An implicit, ephemeral DuckDB database that exists for the life of this
 * process. It is the landing zone for `sql_materialize`: rows read from any
 * warehouse are stored here in full so they can be joined with rows from
 * another engine in a single SQL statement, without the model carrying the rows
 * through its context.
 *
 * A private temporary DuckDB file preserves committed tables when a query
 * timeout restarts the engine helper. Each process gets an isolated directory,
 * removed on close or process exit (best effort).
 *
 * The connection is created lazily and shared, so `sql_execute(warehouse:
 * "scratch")` and `sql_materialize` always see the same tables.
 */

import type { Connector } from "@altimateai/drivers"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/** Reserved warehouse name. User configs cannot shadow or replace it. */
export const SCRATCH_NAME = "scratch"

/** Marker shown in `warehouse_list` (the `database` column). */
export const SCRATCH_DESCRIPTION = "session-scoped, ephemeral"

/** The synthetic config reported for scratch; the private store path stays internal. */
export const SCRATCH_CONFIG = Object.freeze({ type: "duckdb" })

export function isScratch(name: string | undefined | null): boolean {
  return name === SCRATCH_NAME
}

let connector: Connector | undefined
let inflight: Promise<Connector> | undefined
let scratchDirectory: string | undefined
const directories = new Set<string>()
type ScratchOperation = <T>(operation: (connection: Connector) => Promise<T>) => Promise<T>
const operations = new WeakMap<Connector, ScratchOperation>()

function removeDirectory(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    directories.delete(dir)
  } catch {
    // best-effort; retry on exit if the store is still open
  }
}

process.once("exit", () => {
  for (const dir of directories) removeDirectory(dir)
})

function redactPath(error: unknown, dir: string): unknown {
  const redact = (text: string) => {
    for (const value of [path.join(dir, "scratch.duckdb"), dir]) {
      text = text.replaceAll(value.replaceAll("'", "''"), SCRATCH_NAME).replaceAll(value, SCRATCH_NAME)
    }
    return text
  }
  if (error instanceof Error) {
    error.message = redact(error.message)
    if (error.stack) error.stack = redact(error.stack)
  }
  return typeof error === "string" ? redact(error) : error
}

function managedScratch(raw: Connector, dir: string): Connector {
  let pending = Promise.resolve()
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = pending.then(operation).catch((error) => {
      throw redactPath(error, dir)
    })
    pending = next.then(
      () => {},
      () => {},
    )
    return next
  }

  async function initialize(): Promise<void> {
    // The reopened scratch.duckdb has the same catalog after a helper restart.
    const current = await raw.execute("SELECT current_database()", 1)
    if (current.rows[0]?.[0] === SCRATCH_NAME) return
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
    let dir: string | undefined
    let c: Connector | undefined
    try {
      const { connect } = await import("@altimateai/drivers/duckdb")
      dir = fs.mkdtempSync(path.join(os.tmpdir(), `altimate-scratch-${process.pid}-`))
      directories.add(dir)
      if (process.platform !== "win32") fs.chmodSync(dir, 0o700)
      c = managedScratch(await connect({ ...SCRATCH_CONFIG, path: path.join(dir, "scratch.duckdb"), create: true }), dir)
      await c.connect()
      scratchDirectory = dir
      connector = c
      return c
    } catch (error) {
      await c?.close().catch(() => {})
      if (dir) removeDirectory(dir)
      throw dir ? redactPath(error, dir) : error
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
  const dir = scratchDirectory
  connector = undefined
  scratchDirectory = undefined
  if (c) {
    try {
      await c.close()
    } catch {
      // best-effort
    }
  }
  if (dir) removeDirectory(dir)
}
