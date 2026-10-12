import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { connect, type DuckDBEngine } from "../src/duckdb"
import type { ConnectionConfig, Connector } from "../src/types"

const connectors: Connector[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(connectors.splice(0).map((connector) => connector.close()))
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function storePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "duckdb-shared-engine-"))
  directories.push(directory)
  return path.join(directory, "warehouse.duckdb")
}

function engineFactory(hooks: { open?: (payload: Record<string, unknown>) => Promise<void>; close?: () => Promise<void> } = {}) {
  const engines: Array<{ openPayloads: Record<string, unknown>[]; closeCalls: number }> = []
  const createEngine = (): DuckDBEngine => {
    const state = { openPayloads: [] as Record<string, unknown>[], closeCalls: 0 }
    engines.push(state)
    return {
      async open(payload) {
        state.openPayloads.push(payload)
        await hooks.open?.(payload)
      },
      async call<T>() {
        return [{ value: 1 }] as T
      },
      async close() {
        state.closeCalls++
        await hooks.close?.()
      },
    }
  }
  return { createEngine, engines }
}

async function connectorWith(
  dbPath: string,
  factory: ReturnType<typeof engineFactory>,
  config: Partial<ConnectionConfig> = {},
) {
  const connector = await connect({ type: "duckdb", path: dbPath, create: true, ...config }, factory)
  connectors.push(connector)
  return connector
}

describe("DuckDB shared file engines", () => {
  test("coalesces eight opens while the first engine open is held at a barrier", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const factory = engineFactory({
      open: async () => {
        entered.resolve()
        await release.promise
      },
    })
    const dbPath = storePath()
    const group = await Promise.all(Array.from({ length: 8 }, () => connectorWith(dbPath, factory)))
    const opening = group.map((connector) => connector.connect())
    try {
      await entered.promise
      // All eight requests exist while the first open is unresolved. No helper
      // may be created for the remaining seven, regardless of machine timing.
      expect(factory.engines).toHaveLength(1)
      expect(factory.engines[0].openPayloads).toHaveLength(1)
    } finally {
      release.resolve()
      await Promise.all(opening)
    }
    expect(await Promise.all(group.map((connector) => connector.execute("SELECT 1 AS value"))))
      .toEqual(Array.from({ length: 8 }, () => ({ columns: ["value"], rows: [[1]], row_count: 1, truncated: false })))
  })

  test("creates an engine only when a connector opens", async () => {
    const factory = engineFactory()
    const connector = await connectorWith(storePath(), factory)
    expect(factory.engines).toHaveLength(0)
    await connector.close()
    expect(factory.engines).toHaveLength(0)
    await connector.connect()
    expect(factory.engines).toHaveLength(1)
  })

  test("keeps the engine alive until the last connector closes and releases each reference once", async () => {
    const factory = engineFactory()
    const dbPath = storePath()
    const first = await connectorWith(dbPath, factory)
    const second = await connectorWith(dbPath, factory)
    await Promise.all([first.connect(), first.connect(), second.connect()])
    expect(factory.engines).toHaveLength(1)
    expect(factory.engines[0].openPayloads).toHaveLength(1)
    await Promise.all([first.close(), first.close()])
    expect(factory.engines[0].closeCalls).toBe(0)
    expect((await second.execute("SELECT 1 AS value")).rows).toEqual([[1]])
    await expect(first.execute("SELECT 1")).rejects.toThrow("connection not open")
    await Promise.all([second.close(), second.close()])
    expect(factory.engines[0].closeCalls).toBe(1)
  })

  test("waits for the last engine to finish closing before opening its replacement", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let closing = false
    let openedDuringClose = false
    const factory = engineFactory({
      open: async () => {
        openedDuringClose ||= closing
      },
      close: async () => {
        closing = true
        entered.resolve()
        await release.promise
        closing = false
      },
    })
    const dbPath = storePath()
    const first = await connectorWith(dbPath, factory)
    const second = await connectorWith(dbPath, factory)
    await first.connect()
    const closed = first.close()
    await entered.promise
    const opening = second.connect()
    try {
      await Promise.resolve()
      expect(factory.engines).toHaveLength(1)
    } finally {
      release.resolve()
      await Promise.all([closed, opening])
    }
    expect(openedDuringClose).toBe(false)
    expect(factory.engines).toHaveLength(2)
    expect(factory.engines[0].closeCalls).toBe(1)
    expect(factory.engines[1].openPayloads).toHaveLength(1)
  })

  test("evicts a failed shared open so the same connectors can retry", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const failure = new Error("scripted open failure")
    let fail = true
    const factory = engineFactory({
      open: async () => {
        entered.resolve()
        await release.promise
        if (fail) throw failure
      },
    })
    const dbPath = storePath()
    const first = await connectorWith(dbPath, factory)
    const second = await connectorWith(dbPath, factory)
    const opening = Promise.allSettled([first.connect(), second.connect()])
    try {
      await entered.promise
      expect(factory.engines).toHaveLength(1)
    } finally {
      release.resolve()
      await opening
    }
    expect(await opening).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ])
    expect(factory.engines[0].closeCalls).toBe(1)
    fail = false
    await Promise.all([first.connect(), second.connect()])
    expect(factory.engines).toHaveLength(2)
    expect(factory.engines[1].openPayloads).toHaveLength(1)
  })

  test("shares equivalent relative and absolute store paths", async () => {
    const factory = engineFactory()
    const dbPath = storePath()
    const absolute = await connectorWith(dbPath, factory)
    const relative = await connectorWith(path.relative(process.cwd(), dbPath), factory)
    await Promise.all([absolute.connect(), relative.connect()])
    expect(factory.engines).toHaveLength(1)
    expect(factory.engines[0].openPayloads[0].path).toBe(dbPath)
  })

  test("keeps READ_ONLY engines separate from read-write engines", async () => {
    const factory = engineFactory()
    const dbPath = storePath()
    const writer = await connectorWith(dbPath, factory)
    const reader = await connectorWith(dbPath, factory, { readonly: true })
    const otherReader = await connectorWith(dbPath, factory, { readonly: true })
    await Promise.all([writer.connect(), reader.connect(), otherReader.connect()])
    expect(factory.engines).toHaveLength(2)
    expect(factory.engines.map((engine) => engine.openPayloads[0].accessMode))
      .toEqual([undefined, "READ_ONLY"])
    await writer.close()
    expect(factory.engines[0].closeCalls).toBe(1)
    expect(factory.engines[1].closeCalls).toBe(0)
  })

  test("a READ_ONLY retry joins the existing read-only engine and retains the other reader", async () => {
    const factory = engineFactory({
      open: async (payload) => {
        if (payload.accessMode !== "READ_ONLY") {
          throw new Error('IO Error: Could not set lock on file "warehouse.duckdb": Conflicting lock is held in another process')
        }
      },
    })
    const dbPath = storePath()
    const reader = await connectorWith(dbPath, factory, { readonly: true })
    const fallback = await connectorWith(dbPath, factory)
    await reader.connect()
    await fallback.connect()
    expect(factory.engines).toHaveLength(2)
    expect(factory.engines[0].openPayloads).toHaveLength(1)
    expect(factory.engines[0].openPayloads[0].accessMode).toBe("READ_ONLY")
    expect(factory.engines[1].openPayloads).toHaveLength(1)
    expect(factory.engines[1].openPayloads[0].accessMode).toBeUndefined()
    expect(factory.engines[1].closeCalls).toBe(1)
    await fallback.close()
    expect(factory.engines[0].closeCalls).toBe(0)
    expect((await reader.execute("SELECT 1 AS value")).rows).toEqual([[1]])
    await reader.close()
    expect(factory.engines[0].closeCalls).toBe(1)
  })

  test("does not share engines across different sandbox restrictions", async () => {
    const factory = engineFactory()
    const dbPath = storePath()
    const unrestricted = await connectorWith(dbPath, factory)
    const firstSandbox = path.dirname(dbPath)
    const secondSandbox = path.join(firstSandbox, "restricted")
    const restricted = await connectorWith(dbPath, factory, { sandbox_directory: firstSandbox })
    const otherRestricted = await connectorWith(dbPath, factory, { sandbox_directory: secondSandbox })
    const sameRestricted = await connectorWith(dbPath, factory, { sandbox_directory: firstSandbox })
    await Promise.all([unrestricted.connect(), restricted.connect(), otherRestricted.connect(), sameRestricted.connect()])
    expect(factory.engines).toHaveLength(3)
    expect(factory.engines.map((engine) => engine.openPayloads[0].sandboxDirectory))
      .toEqual([undefined, firstSandbox, secondSandbox])
  })

  test("keeps separate in-memory databases for separate connectors", async () => {
    const factory = engineFactory()
    const first = await connectorWith(":memory:", factory)
    const second = await connectorWith(":memory:", factory)
    await Promise.all([first.connect(), second.connect()])
    expect(factory.engines).toHaveLength(2)
    await first.close()
    expect(factory.engines[0].closeCalls).toBe(1)
    expect(factory.engines[1].closeCalls).toBe(0)
  })

  test("does not share helpers with different working directories for relative SQL paths", async () => {
    const factory = engineFactory()
    const dbPath = storePath()
    const previousCwd = process.cwd()
    let first: Connector
    let second: Connector
    try {
      first = await connectorWith(dbPath, factory)
      process.chdir(path.dirname(dbPath))
      second = await connectorWith(dbPath, factory)
    } finally {
      process.chdir(previousCwd)
    }
    await Promise.all([first.connect(), second.connect()])
    expect(factory.engines).toHaveLength(2)
  })

  test("closing a connector during a shared pending open releases only its own reference", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const factory = engineFactory({
      open: async () => {
        entered.resolve()
        await release.promise
      },
    })
    const dbPath = storePath()
    const first = await connectorWith(dbPath, factory)
    const second = await connectorWith(dbPath, factory)
    const opening = [first.connect(), first.connect(), second.connect()]
    await entered.promise
    const closing = [first.close(), first.close()]
    release.resolve()
    await Promise.all([...opening, ...closing])
    expect(factory.engines).toHaveLength(1)
    expect(factory.engines[0].closeCalls).toBe(0)
    await expect(first.execute("SELECT 1")).rejects.toThrow("connection not open")
    expect((await second.execute("SELECT 1 AS value")).rows).toEqual([[1]])
    await second.close()
    expect(factory.engines[0].closeCalls).toBe(1)
  })

  test("closing the sole connector during open releases the engine when open completes", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const factory = engineFactory({
      open: async () => {
        entered.resolve()
        await release.promise
      },
    })
    const connector = await connectorWith(storePath(), factory)
    const opening = connector.connect()
    await entered.promise
    const closing = connector.close()
    release.resolve()
    await Promise.all([opening, closing])
    expect(factory.engines[0].closeCalls).toBe(1)
    await expect(connector.execute("SELECT 1")).rejects.toThrow("connection not open")
    await connector.connect()
    expect(factory.engines).toHaveLength(2)
  })

  test("reconnecting the same connector waits for its pending close", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const factory = engineFactory({
      close: async () => {
        entered.resolve()
        await release.promise
      },
    })
    const connector = await connectorWith(storePath(), factory)
    await connector.connect()
    const closing = connector.close()
    await entered.promise
    const reopening = connector.connect()
    try {
      await Promise.resolve()
      expect(factory.engines).toHaveLength(1)
    } finally {
      release.resolve()
      await Promise.all([closing, reopening])
    }
    expect(factory.engines).toHaveLength(2)
    expect(factory.engines[0].closeCalls).toBe(1)
    expect((await connector.execute("SELECT 1 AS value")).rows).toEqual([[1]])
  })
})
