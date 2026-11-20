/**
 * Databricks server-side cancel: a caller that sets `cancelAfterMs` gets its statement cancelled
 * on the warehouse when the deadline passes, and an aborted signal cancels it with or without one.
 * `queryTimeoutMs`, which every `executeQuery` call fills in, does not cancel anything.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { restoreModuleMocksAfterTests } from "./module-mock"
import { isQueryTimeoutError, QueryTimeoutError } from "../src/types"

await restoreModuleMocksAfterTests("@databricks/sql")

let fetch: () => Promise<any[]>
let startDelayMs = 0
let cancelResult: () => Promise<unknown>
let closeResult: () => Promise<unknown>
let cancels = 0
let closes = 0

beforeEach(() => {
  fetch = async () => [{ n: 1 }]
  startDelayMs = 0
  cancelResult = async () => ({})
  closeResult = async () => ({})
  cancels = 0
  closes = 0
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeClient {
  async connect() {}
  async openSession() {
    return {
      executeStatement: async () => {
        if (startDelayMs > 0) await sleep(startDelayMs)
        return {
          fetchAll: () => fetch(),
          cancel: async () => {
            cancels++
            return cancelResult()
          },
          close: async () => {
            closes++
            return closeResult()
          },
        }
      },
    }
  }
}

// The driver reads `default` first (the package is CommonJS), so both shapes point at the fake.
mock.module("@databricks/sql", () => ({ default: { DBSQLClient: FakeClient }, DBSQLClient: FakeClient }))

const { connect } = await import("../src/databricks")

async function connector() {
  const one = await connect({
    type: "databricks",
    server_hostname: "h",
    http_path: "/sql/1.0/warehouses/w",
    access_token: "t",
  })
  await one.connect()
  return one
}

const never = () => new Promise<any[]>(() => {})

describe("Databricks server-side cancel", () => {
  test("a statement past `cancelAfterMs` is cancelled on the warehouse and reported as a timeout", async () => {
    fetch = never
    const db = await connector()
    const error = await db.execute("SELECT 1", 10, [], { cancelAfterMs: 30 }).catch((e) => e)
    expect(isQueryTimeoutError(error)).toBe(true)
    expect(error.cancelled).toBe(true)
    expect(error.timeoutMs).toBe(30)
    expect(error.engine).toBe("databricks")
    expect([cancels, closes]).toEqual([1, 1])
  })

  test("`queryTimeoutMs` alone never cancels: a slow statement still returns its rows", async () => {
    fetch = async () => {
      await sleep(80)
      return [{ n: 3 }]
    }
    const db = await connector()
    const result = await db.execute("SELECT 1", 10, [], { queryTimeoutMs: 30 })
    expect(result.rows).toEqual([[3]])
    expect(cancels).toBe(0)
  })

  test("a statement the server accepts only after the deadline is cancelled once it exists", async () => {
    startDelayMs = 80
    const db = await connector()
    const error = await db.execute("SELECT 1", 10, [], { cancelAfterMs: 30 }).catch((e) => e)
    expect(isQueryTimeoutError(error)).toBe(true)
    // Nothing existed to cancel yet, so the error does not claim it was cancelled.
    expect(error.cancelled).toBe(false)
    expect(cancels).toBe(0)
    await sleep(120)
    expect([cancels, closes]).toEqual([1, 1])
  })

  test("an aborted signal cancels the statement and rejects with the abort reason", async () => {
    fetch = never
    const controller = new AbortController()
    const db = await connector()
    const pending = db.execute("SELECT 1", 10, [], { cancelAfterMs: 60_000, signal: controller.signal }).catch((e) => e)
    await sleep(20)
    controller.abort(new Error("session stopped"))
    const error = await pending
    expect(isQueryTimeoutError(error)).toBe(false)
    expect(error.message).toBe("session stopped")
    expect(cancels).toBe(1)
  })

  test("when the cancel itself fails, the error says the statement may still be running", async () => {
    fetch = never
    cancelResult = async () => {
      throw new Error("network")
    }
    const db = await connector()
    const error = await db.execute("SELECT 1", 10, [], { cancelAfterMs: 30 }).catch((e) => e)
    expect(isQueryTimeoutError(error)).toBe(true)
    expect(error.cancelled).toBe(false)
    expect(error.message).toContain("it may still be running on the server")
  })

  test("a statement that finishes in time returns its rows and is not cancelled", async () => {
    const db = await connector()
    const result = await db.execute("SELECT 1", 10, [], { cancelAfterMs: 5_000 })
    expect(result.rows).toEqual([[1]])
    expect([cancels, closes]).toEqual([0, 1])
  })

  test("a query error inside the deadline is the query's own error, not a timeout", async () => {
    fetch = async () => {
      throw new Error("[TABLE_OR_VIEW_NOT_FOUND] system.x")
    }
    const db = await connector()
    const error = await db.execute("SELECT 1", 10, [], { cancelAfterMs: 5_000 }).catch((e) => e)
    expect(isQueryTimeoutError(error)).toBe(false)
    expect(error.message).toContain("TABLE_OR_VIEW_NOT_FOUND")
    expect(cancels).toBe(0)
  })
})

describe("Databricks statement cleanup when the fetch fails", () => {
  const failingFetch = async (): Promise<any[]> => {
    throw new Error("[TABLE_OR_VIEW_NOT_FOUND] system.x")
  }

  for (const [label, options] of [
    ["with a deadline", { cancelAfterMs: 5_000 }],
    ["without a deadline", { queryTimeoutMs: 5_000 }],
  ] as const) {
    test(`${label}, the statement is closed and the fetch's error is reported`, async () => {
      fetch = failingFetch
      const db = await connector()
      const error = await db.execute("SELECT 1", 10, [], options).catch((e) => e)
      expect(error.message).toContain("TABLE_OR_VIEW_NOT_FOUND")
      expect(isQueryTimeoutError(error)).toBe(false)
      expect([cancels, closes]).toEqual([0, 1])
    })

    test(`${label}, a close that also fails does not replace the fetch's error`, async () => {
      fetch = failingFetch
      closeResult = async () => {
        throw new Error("close failed")
      }
      const db = await connector()
      const error = await db.execute("SELECT 1", 10, [], options).catch((e) => e)
      expect(error.message).toContain("TABLE_OR_VIEW_NOT_FOUND")
      expect(closes).toBe(1)
    })
  }

  test("a statement that returns rows without a deadline is closed once", async () => {
    const db = await connector()
    const result = await db.execute("SELECT 1", 10, [])
    expect(result.rows).toEqual([[1]])
    expect([cancels, closes]).toEqual([0, 1])
  })

  test("a close that fails after the rows were fetched does not fail the query", async () => {
    closeResult = async () => {
      throw new Error("close failed")
    }
    const db = await connector()
    const result = await db.execute("SELECT 1", 10, [])
    expect(result.rows).toEqual([[1]])
    expect(closes).toBe(1)
  })
})

describe("Databricks cancel on abort without a deadline", () => {
  test("without `cancelAfterMs`, an aborted signal still cancels the statement on the warehouse", async () => {
    fetch = never
    const controller = new AbortController()
    const db = await connector()
    const pending = db.execute("SELECT 1", 10, [], { queryTimeoutMs: 60_000, signal: controller.signal }).catch((e) => e)
    await sleep(20)
    controller.abort(new Error("session stopped"))
    const error = await pending
    expect(isQueryTimeoutError(error)).toBe(false)
    expect(error.message).toBe("session stopped")
    expect([cancels, closes]).toEqual([1, 1])
  })

  test("with a signal that never aborts and no `cancelAfterMs`, a slow statement still returns its rows", async () => {
    fetch = async () => {
      await sleep(40)
      return [{ n: 1 }]
    }
    const db = await connector()
    const result = await db.execute("SELECT 1", 10, [], { signal: new AbortController().signal })
    expect(result.rows).toEqual([[1]])
    expect(cancels).toBe(0)
  })

  test("a client-side query timeout abandons the statement: it is not cancelled and runs to its end", async () => {
    fetch = async () => {
      await sleep(40)
      return [{ n: 1 }]
    }
    const controller = new AbortController()
    const db = await connector()
    const pending = db.execute("SELECT 1", 10, [], { queryTimeoutMs: 10, signal: controller.signal })
    await sleep(10)
    // As `executeQuery` aborts its signal when its own deadline passes.
    controller.abort(new QueryTimeoutError({ engine: "databricks", timeoutMs: 10, cancelled: false }))
    const result = await pending
    expect(result.rows).toEqual([[1]])
    expect([cancels, closes]).toEqual([0, 1])
  })

  test("with a signal and no `cancelAfterMs`, the close is awaited before the rows return, as on the plain path", async () => {
    let closed = false
    closeResult = async () => {
      await sleep(30)
      closed = true
    }
    const db = await connector()
    await db.execute("SELECT 1", 10, [], { signal: new AbortController().signal })
    expect(closed).toBe(true)
  })

  test("under a deadline, a slow close does not hold up rows that already returned", async () => {
    let closed = false
    closeResult = async () => {
      await sleep(200)
      closed = true
    }
    const db = await connector()
    const result = await db.execute("SELECT 1", 10, [], { cancelAfterMs: 5_000 })
    expect(result.rows).toEqual([[1]])
    expect(closed).toBe(false)
    expect(closes).toBe(1)
  })
})
