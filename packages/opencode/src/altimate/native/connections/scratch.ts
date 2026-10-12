/**
 * Session-scoped `scratch` warehouse.
 *
 * An implicit, ephemeral DuckDB database that exists for the life of this
 * session. It is the landing zone for `sql_materialize`: rows read from any
 * warehouse are stored here in full so they can be joined with rows from
 * another engine in a single SQL statement, without the model carrying the rows
 * through its context.
 *
 * A private temporary DuckDB file preserves committed tables when a query
 * timeout restarts the engine helper. Each root session and its subagents share
 * an isolated directory, removed on root deletion, close or process exit (best effort).
 *
 * The connection is created lazily and shared within its session, so `sql_execute(warehouse:
 * "scratch")` and `sql_materialize` always see the same tables.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import type { Connector } from "@altimateai/drivers"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { SessionStore } from "@opencode-ai/core/session/store"
import type { SessionID } from "@/session/schema"

/** Reserved warehouse name. User configs cannot shadow or replace it. */
export const SCRATCH_NAME = "scratch"

/** Marker shown in `warehouse_list` (the `database` column). */
export const SCRATCH_DESCRIPTION = "session-scoped, ephemeral"

/** The synthetic config reported for scratch; the private store path stays internal. */
export const SCRATCH_CONFIG = Object.freeze({ type: "duckdb" })

export function isScratch(name: string | undefined | null): boolean {
  return name === SCRATCH_NAME
}

interface ScratchStore {
  connector?: Connector
  inflight?: Promise<Connector>
  directory?: string
}
const stores = new Map<string, ScratchStore>()
const session = new AsyncLocalStorage<string>()
const sessionStore = makeRuntime(SessionStore.Service, SessionStore.defaultLayer)
let sessionStoreReady = false

function rootSessionID(store: SessionStore.Interface, sessionID: string) {
  return Effect.gen(function* () {
    let root = sessionID as SessionID
    const seen = new Set<string>()
    while (!seen.has(root)) {
      seen.add(root)
      const row = yield* store.get(root)
      // Synthetic or removed sessions must not share another root's store.
      if (!row) return sessionID
      if (!row.parentID) return root
      root = row.parentID
    }
    return sessionID
  })
}

/** Bind all native calls made by one tool invocation to its session. */
export function withScratchSession<T>(sessionID: string, operation: () => T): T {
  return session.run(sessionID, operation)
}

// Direct, non-tool callers retain the existing single-store behavior.
const currentSession = () => session.getStore() ?? ""
const directories = new Set<string>()
type ScratchOperation = <T>(operation: (connection: Connector, directory: string) => Promise<T>) => Promise<T>
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
      return operation(raw, dir)
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
    // Shutdown must reach the helper even while an exclusive query is running.
    close: () => raw.close(),
  }
  operations.set(managed, run)
  return managed
}

/**
 * Hold the scratch connection for a complete operation, including its transaction.
 * Use the supplied connector inside the callback; calling the shared connector
 * there would queue behind this operation. The supplied connector must not escape.
 */
export async function withScratchConnection<T>(
  operation: (connection: Connector, directory: string) => Promise<T>,
  sessionID = currentSession(),
): Promise<T> {
  const c = await getScratch(sessionID)
  return operations.get(c)!(operation)
}

/** The session's scratch connector, opened on first use. */
export async function getScratch(sessionID = currentSession()): Promise<Connector> {
  // Direct callers without a tool/session context retain the default store.
  if (sessionID) {
    sessionID = await sessionStore.runPromise((store) => rootSessionID(store, sessionID))
    sessionStoreReady = true
  }
  let store = stores.get(sessionID)
  if (!store) {
    store = {}
    stores.set(sessionID, store)
  }
  if (store.connector) return Promise.resolve(store.connector)
  if (store.inflight) return store.inflight
  const state = store
  const mine: Promise<Connector> = (async () => {
    let dir: string | undefined
    let c: Connector | undefined
    try {
      const { connect } = await import("@altimateai/drivers/duckdb")
      dir = fs.mkdtempSync(path.join(os.tmpdir(), `altimate-scratch-${process.pid}-`))
      directories.add(dir)
      if (process.platform !== "win32") fs.chmodSync(dir, 0o700)
      c = managedScratch(
        await connect({
          ...SCRATCH_CONFIG,
          path: path.join(dir, "scratch.duckdb"),
          create: true,
          sandbox_directory: dir,
        }),
        dir,
      )
      await c.connect()
      state.directory = dir
      state.connector = c
      return c
    } catch (error) {
      await c?.close().catch(() => {})
      if (dir) removeDirectory(dir)
      throw dir ? redactPath(error, dir) : error
    } finally {
      queueMicrotask(() => {
        if (state.inflight === mine) state.inflight = undefined
      })
    }
  })()
  state.inflight = mine
  return mine
}

/** Whether this session's scratch database has been opened. */
export function scratchOpened(sessionID = currentSession()): boolean {
  // Before the first scoped lookup, only the default store can have been opened.
  if (sessionID && sessionStoreReady) {
    sessionID = sessionStore.runSync((store) => rootSessionID(store, sessionID))
  }
  return stores.get(sessionID)?.connector !== undefined
}

/** Close one root's store, or all stores. Deleting a child leaves its root's store open. */
export async function closeScratch(sessionID?: string): Promise<void> {
  const keys = sessionID === undefined ? [...stores.keys()] : [sessionID]
  await Promise.all(keys.map(async (key) => {
    const state = stores.get(key)
    if (!state) return
    stores.delete(key)
    await state.inflight?.catch(() => {})
    await state.connector?.close().catch(() => {})
    if (state.directory) removeDirectory(state.directory)
  }))
}
