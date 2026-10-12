// altimate_change - new file
//
// Deadline behaviour at the sql.execute boundary: a timeout is an error result
// (never an empty successful table), and it never causes the query to be
// re-executed on another backend.
import { afterAll, afterEach, beforeAll, beforeEach, mock, describe, expect, spyOn, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  dbtAdapterInternals,
  registerAll,
  resetDbtAdapter,
} from "../../src/altimate/native/connections/register"
import { Dispatcher } from "../../src/altimate/native"
import * as Registry from "../../src/altimate/native/connections/registry"
import { QueryTimeoutError } from "@altimateai/drivers/types"

const FOREVER_SQLITE =
  "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 4000000000) SELECT count(*) AS n FROM c"

// The real adapter drags in a Python bridge; the tests hand the register module a scripted one.
let scriptedAdapter: unknown
mock.module("../../../dbt-tools/src/adapter", () => ({ create: async () => scriptedAdapter }))

beforeAll(() => registerAll())
afterAll(() => {
  // mock.module leaks across files: leave the adapter unavailable, which callers treat as "no dbt".
  mock.module("../../../dbt-tools/src/adapter", () => ({
    create: async () => {
      throw new Error("dbt adapter unavailable")
    },
  }))
})
beforeEach(() => {
  resetDbtAdapter()
  Registry.reset()
})
afterEach(() => {
  resetDbtAdapter()
  delete dbtAdapterInternals.readConfig
  Registry.reset()
})

const run = (params: Record<string, unknown>) => Dispatcher.call("sql.execute", params as never) as Promise<any>

describe("sql.execute deadline — native engines", () => {
  test("a timeout is an error result with a stable code, and the connection recovers", async () => {
    Registry.setConfigs({ lite: { type: "sqlite", path: ":memory:", query_timeout_ms: 400 } as never })
    const t = performance.now()
    const slow = await run({ sql: FOREVER_SQLITE, warehouse: "lite" })
    expect(performance.now() - t).toBeLessThan(4000)
    expect(slow.error).toContain("QUERY_TIMEOUT")
    expect(slow.rows).toEqual([])
    expect(slow.row_count).toBe(0)

    const fast = await run({ sql: "SELECT 1 AS one", warehouse: "lite" })
    expect(fast.error).toBeUndefined()
    expect(fast.rows).toEqual([[1]])
    await Registry.reset()
  })

  test("query_timeout_ms on the call overrides the connection", async () => {
    Registry.setConfigs({ lite: { type: "sqlite", path: ":memory:", query_timeout_ms: 0 } as never })
    const slow = await run({ sql: FOREVER_SQLITE, warehouse: "lite", query_timeout_ms: 300 })
    expect(slow.error).toContain("QUERY_TIMEOUT")
    expect(slow.error).toContain("300ms")
  })

  // Policy for local engines: the engine's own deadline (execution only, queue
  // wait excluded) is authoritative and no outer race abandons a queued call. A
  // call queued behind a slow one therefore runs normally once it reaches the
  // front, and is never reported as timed out while still executing later.
  test("a call queued behind a slow one runs normally and is never abandoned then executed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queued-deadline-"))
    const db = path.join(dir, "q.db")
    const { Database } = await import("bun:sqlite")
    const seed = new Database(db)
    seed.exec("CREATE TABLE sentinel(x)")
    seed.close()
    Registry.setConfigs({ lite: { type: "sqlite", path: db } as never })
    try {
      // A holds the engine for 7s (past B's 500ms budget + the 5s outer grace).
      const a = run({ sql: FOREVER_SQLITE, warehouse: "lite", query_timeout_ms: 7000 })
      await Bun.sleep(200)
      const b = await Promise.race([
        run({ sql: "INSERT INTO sentinel VALUES (1)", warehouse: "lite", query_timeout_ms: 500 }),
        Bun.sleep(20_000).then(() => "stuck"),
      ])
      expect((await a).error).toContain("QUERY_TIMEOUT")
      expect(b).not.toBe("stuck")
      expect((b as any).error).toBeUndefined()
      const check = new Database(db, { readonly: true })
      expect(check.query("SELECT count(*) AS n FROM sentinel").get()).toEqual({ n: 1 })
      check.close()
    } finally {
      await Registry.reset()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 40_000)

  test("an engine that cannot cancel is bounded by the outer deadline and reported as abandoned", async () => {
    Registry.setConfigs({ remote: { type: "snowflake", account: "a", query_timeout_ms: 200 } as never })
    const get = spyOn(Registry, "get").mockResolvedValue({
      execute: () => new Promise(() => {}),
    } as never)
    try {
      const t = performance.now()
      const r = await run({ sql: "SELECT 1", warehouse: "remote" })
      const elapsed = performance.now() - t
      expect(r.error).toContain("QUERY_TIMEOUT")
      expect(r.error).toContain("may still be running")
      expect(r.rows).toEqual([])
      // deadline + grace, not forever
      expect(elapsed).toBeGreaterThan(190)
      expect(elapsed).toBeLessThan(8000)
    } finally {
      get.mockRestore()
    }
  }, 15000)
})

describe("sql.execute deadline — dbt path never falls back", () => {
  let projectRoot: string
  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-deadline-"))
    fs.writeFileSync(path.join(projectRoot, "dbt_project.yml"), "name: t\n")
    dbtAdapterInternals.readConfig = async () => ({ projectRoot }) as never
  })

  async function withAdapter(adapter: any, body: () => Promise<void>) {
    scriptedAdapter = adapter
    await body()
  }

  test("a dbt query that outruns the deadline errors without running on the native connection", async () => {
    Registry.setConfigs({ lite: { type: "sqlite", path: ":memory:" } as never })
    const get = spyOn(Registry, "get")
    await withAdapter({ immediatelyExecuteSQL: () => new Promise(() => {}), immediatelyExecuteSQLWithLimit: () => new Promise(() => {}) }, async () => {
      const t = performance.now()
      const r = await run({ sql: "SELECT 1 AS one", query_timeout_ms: 200 })
      expect(performance.now() - t).toBeLessThan(4000)
      expect(r.error).toContain("QUERY_TIMEOUT")
      expect(r.rows).toEqual([])
      expect(get).not.toHaveBeenCalled()
    })
    get.mockRestore()
  })

  test("a dbt adapter that reports a timeout itself is not retried natively", async () => {
    Registry.setConfigs({ lite: { type: "sqlite", path: ":memory:" } as never })
    const get = spyOn(Registry, "get")
    const failing = async () => {
      throw new QueryTimeoutError({ engine: "dbt", timeoutMs: 1000 })
    }
    await withAdapter({ immediatelyExecuteSQL: failing, immediatelyExecuteSQLWithLimit: failing }, async () => {
      const r = await run({ sql: "SELECT 1 AS one" })
      expect(r.error).toContain("QUERY_TIMEOUT")
      expect(get).not.toHaveBeenCalled()
    })
    get.mockRestore()
  })

  test("an ordinary dbt failure still falls back to the native connection", async () => {
    Registry.setConfigs({ lite: { type: "sqlite", path: ":memory:" } as never })
    const failing = async () => {
      throw new Error("adapter exploded")
    }
    await withAdapter({ immediatelyExecuteSQL: failing, immediatelyExecuteSQLWithLimit: failing }, async () => {
      const r = await run({ sql: "SELECT 1 AS one" })
      expect(r.error).toBeUndefined()
      expect(r.rows).toEqual([[1]])
    })
  })
})
