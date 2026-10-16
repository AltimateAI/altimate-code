import { afterEach, expect, spyOn, test } from "bun:test"
import type { Connector, ExecuteOptions } from "@altimateai/drivers/types"
import * as Registry from "../../src/altimate/native/connections/registry"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import * as Precedence from "../../src/altimate/workspace/precedence"
import { closeScratch, getScratch } from "../../src/altimate/native/connections/scratch"
import * as Scratch from "../../src/altimate/native/connections/scratch"
import { SqlMaterializeTool, materialize } from "../../src/altimate/tools/sql-materialize"
import { SqlCheckTool } from "../../src/altimate/tools/sql-check"
import { SqlExecuteTool } from "../../src/altimate/tools/sql-execute"
import { initTool } from "./tool-fixture"
import { RunBudget } from "../../src/altimate/run-budget"

afterEach(async () => {
  await closeScratch()
  await Registry.reset()
})

const context = (abort: AbortSignal) => ({
  sessionID: "sql-cancellation-session",
  messageID: "sql-cancellation-message",
  agent: "test",
  abort,
  messages: [],
  metadata: () => {},
  ask: async () => {},
})

for (const kind of ["materialize", "check"] as const) {
  test(`${kind} forwards session abort to its active read without retrying`, async () => {
    Registry.setConfigs({ source: { type: "postgres" } })
    const started = Promise.withResolvers<ExecuteOptions | undefined>()
    const pending = Promise.withResolvers<never>()
    let reads = 0
    let closed = false
    const execute: Connector["execute"] = (_sql, _limit, _binds, options) => {
      reads++
      started.resolve(options)
      options?.signal?.addEventListener("abort", () => {
        closed = true
        pending.reject(options.signal!.reason)
      }, { once: true })
      return pending.promise
    }
    const original = Registry.get.bind(Registry)
    const get = spyOn(Registry, "get").mockImplementation(async (name: string) =>
      name === "source" ? { execute, supportsResultByteLimit: true } as Connector : original(name),
    )
    const precedence = spyOn(Precedence, "check").mockResolvedValue({})
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let task: Promise<any> | undefined
    try {
      const tool = await initTool(kind === "materialize" ? SqlMaterializeTool : SqlCheckTool)
      task = tool.execute(kind === "materialize"
        ? { source_warehouse: "source", sql: "SELECT id FROM items", target_table: "items" }
        : { warehouse: "source", check: "nulls", sql: "SELECT id FROM items", columns: ["id"] }, context(abort.signal))
      await started.promise
      const start = performance.now()
      abort.abort(new Error("Session cancelled"))
      const result = await Promise.race([
        task,
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1000) }),
      ])
      expect(result).toBeDefined()
      expect(performance.now() - start).toBeLessThan(2000)
      expect(result.metadata.error).toContain("Session cancelled")
      expect(closed).toBe(true)
      expect(reads).toBe(1)
    } finally {
      clearTimeout(timer)
      pending.reject(new Error("Session cancelled"))
      await task?.catch(() => {})
      precedence.mockRestore()
      get.mockRestore()
    }
  })
}

test("sql_execute passes the session signal and budget identity through dispatch", async () => {
  const abort = new AbortController()
  const dispatch = spyOn(Dispatcher, "call").mockResolvedValue({ error: "Stopped", columns: [], rows: [], row_count: 0, truncated: false } as never)
  const precedence = spyOn(Precedence, "check").mockResolvedValue({})
  try {
    const tool = await initTool(SqlExecuteTool)
    await tool.execute({ warehouse: "source", query: "SELECT id FROM items" }, context(abort.signal))
    const call = dispatch.mock.calls.find(([method]) => method === "sql.execute")
    expect(call?.[2]).toEqual({ signal: abort.signal, sessionID: "sql-cancellation-session" })
  } finally {
    dispatch.mockRestore()
    precedence.mockRestore()
  }
})

test("a zero materialize deadline cannot outlive the run cutoff or start another probe", async () => {
  Registry.setConfigs({ source: { type: "postgres", query_timeout_ms: 0 } })
  await getScratch()
  let reads = 0
  let closed = false
  let timeout: number | undefined
  const execute: Connector["execute"] = (_sql, _limit, _binds, options) => {
    reads++
    timeout = options?.queryTimeoutMs
    return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => {
      closed = true
      reject(options.signal!.reason)
    }, { once: true }))
  }
  const original = Registry.get.bind(Registry)
  const get = spyOn(Registry, "get").mockImplementation(async (name: string) =>
    name === "source" ? { execute, supportsResultByteLimit: true } as Connector : original(name),
  )
  const release = RunBudget.registerQueryDeadline("short-run", Date.now() + 100)
  try {
    const start = performance.now()
    await expect(materialize({ source_warehouse: "source", sql: "SELECT id FROM items", target_table: "items", query_timeout_ms: 0 },
      { sessionID: "short-run" })).rejects.toMatchObject({ code: "QUERY_TIMEOUT" })
    expect(performance.now() - start).toBeLessThan(2000)
    expect(timeout).toBeGreaterThan(0)
    expect(timeout).toBeLessThanOrEqual(100)
    expect(closed).toBe(true)
    expect(reads).toBe(1)
  } finally {
    release()
    get.mockRestore()
  }
})

test("materialize rolls back when cancellation arrives between scratch statements", async () => {
  Registry.setConfigs({ source: { type: "postgres" } })
  const original = Registry.get.bind(Registry)
  const get = spyOn(Registry, "get").mockImplementation(async (name: string) =>
    name === "source" ? {
      supportsResultByteLimit: true,
      connect: async () => {},
      close: async () => {},
      listSchemas: async () => [],
      listTables: async () => [],
      describeTable: async () => [],
      execute: async () => ({ columns: ["id"], rows: [[1]], row_count: 1, truncated: false }),
    } as Connector : original(name),
  )
  const scratch = await getScratch()
  const abort = new AbortController()
  const statements: string[] = []
  const rolledBack = Promise.withResolvers<void>()
  const withScratch = Scratch.withScratchConnection
  const operation = spyOn(Scratch, "withScratchConnection").mockImplementation((run, sessionID) =>
    withScratch((connection, directory) => run({
      ...connection,
      execute: async (...args) => {
        statements.push(args[0])
        const result = await connection.execute(...args)
        if (args[0] === "ROLLBACK") rolledBack.resolve()
        if (args[0].startsWith("CREATE TABLE")) abort.abort(new Error("Session cancelled"))
        return result
      },
    }, directory), sessionID),
  )
  try {
    await expect(materialize({ source_warehouse: "source", sql: "SELECT id FROM items", target_table: "items" },
      { signal: abort.signal })).rejects.toThrow("Session cancelled")
    await rolledBack.promise
    expect(statements).toContain("ROLLBACK")
    expect((await scratch.execute("SELECT table_name FROM information_schema.tables WHERE table_name = 'items'")).rows).toEqual([])
  } finally {
    operation.mockRestore()
    get.mockRestore()
  }
})

for (const kind of ["materialize", "check"] as const) {
  test(`${kind} aborts during connection admission and cannot execute a late read`, async () => {
    Registry.setConfigs({ source: { type: "postgres" } })
    const entered = Promise.withResolvers<void>()
    const admitted = Promise.withResolvers<Connector>()
    let reads = 0
    const connector: Connector = {
      execute: async () => { reads++; throw new Error("Unexpected late read") },
      supportsResultByteLimit: true,
      connect: async () => {},
      close: async () => {},
      listSchemas: async () => [],
      listTables: async () => [],
      describeTable: async () => [],
    }
    const get = spyOn(Registry, "get").mockImplementation(() => {
      entered.resolve()
      return admitted.promise
    })
    const precedence = spyOn(Precedence, "check").mockResolvedValue({})
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let task: Promise<any> | undefined
    try {
      const tool = await initTool(kind === "materialize" ? SqlMaterializeTool : SqlCheckTool)
      task = tool.execute(kind === "materialize"
        ? { source_warehouse: "source", sql: "SELECT id FROM items", target_table: "items" }
        : { warehouse: "source", check: "nulls", sql: "SELECT id FROM items", columns: ["id"] }, context(abort.signal))
      await entered.promise
      abort.abort(new Error("Session cancelled"))
      const result = await Promise.race([task, new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 1000)
      })])
      expect(result?.metadata.error).toContain("Session cancelled")
      admitted.resolve(connector)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(reads).toBe(0)
    } finally {
      clearTimeout(timer)
      admitted.resolve(connector)
      await task?.catch(() => {})
      precedence.mockRestore()
      get.mockRestore()
    }
  })
}
