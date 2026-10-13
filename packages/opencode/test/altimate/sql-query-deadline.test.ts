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
  resolveDefaultTarget,
  resetDbtAdapter,
} from "../../src/altimate/native/connections/register"
import { Dispatcher } from "../../src/altimate/native"
import * as Registry from "../../src/altimate/native/connections/registry"
import { QueryTimeoutError, type Connector } from "@altimateai/drivers/types"

const FOREVER_SQLITE =
  "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 4000000000) SELECT count(*) AS n FROM c"

// The real adapter drags in a Python bridge; the tests hand the register module a scripted one.
let scriptedAdapter: unknown
mock.module("../../../dbt-tools/src/adapter", () => ({ create: async () => scriptedAdapter }))

// The real `pg` module, captured before any test replaces it, so the replacement can be undone.
// `pg` is an optional dependency of the drivers package, not of this one, so resolve it from there.
let realPg: Record<string, unknown> | undefined
beforeAll(async () => {
  try {
    const driversDir = path.resolve(import.meta.dir, "../../../drivers")
    realPg = await import(require.resolve("pg", { paths: [driversDir] }))
  } catch {
    realPg = undefined
  }
  registerAll()
})
afterAll(() => {
  // mock.module leaks across files: leave the adapter unavailable, which callers treat as "no dbt".
  mock.module("../../../dbt-tools/src/adapter", () => ({
    create: async () => {
      throw new Error("dbt adapter unavailable")
    },
  }))
  // Likewise put the real `pg` back (or an unreachable pool when it is not installed) so a later
  // file's connection probe against an unresolvable host fails instead of talking to the queued fake.
  const restored = realPg ? { ...realPg } : undefined
  mock.module(
    "pg",
    () =>
      restored ?? {
        default: {
          Pool: class {
            async connect() {
              throw new Error("pg unavailable")
            }
            async end() {}
          },
        },
      },
  )
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

async function queuedPostgres() {
  const queries: string[] = []
  const releases: unknown[] = []
  const client = {
    async query(sql: string) {
      queries.push(sql)
      if (sql === "SHOW statement_timeout") return { fields: [], rows: [{ statement_timeout: "0" }] }
      return { fields: [], rows: [] }
    },
    release(discard?: boolean) { releases.push(discard) },
  }
  const admitted = Promise.withResolvers<typeof client>()
  const connecting = Promise.withResolvers<void>()
  mock.module("pg", () => ({
    default: {
      Pool: class {
        connect() {
          connecting.resolve()
          return admitted.promise
        }
        async end() {}
      },
    },
  }))
  const { connect } = await import("@altimateai/drivers/postgres")
  const connector = await connect({ type: "postgres" })
  await connector.connect()
  const execute = spyOn(connector, "execute")
  const get = spyOn(Registry, "get").mockResolvedValue(connector)
  Registry.setConfigs({ pg: { type: "postgres" } })
  return { connector, execute, get, queries, releases, connecting: connecting.promise, admit: () => admitted.resolve(client) }
}

describe("sql.execute deadline — native engines", () => {
  test("the outer PostgreSQL deadline abandons a queued acquisition and releases its late client without executing SQL", async () => {
    const db = await queuedPostgres()
    try {
      const result = await run({ sql: "INSERT INTO sentinel VALUES (1)", warehouse: "pg", query_timeout_ms: 10 })
      expect(result.error).toContain("QUERY_TIMEOUT")
      db.admit()
      await Promise.resolve(db.execute.mock.results[0]!.value).catch(() => {})
      expect(db.queries).toEqual([])
      expect(db.releases).toEqual([undefined])
    } finally {
      db.admit()
      db.get.mockRestore()
      db.execute.mockRestore()
      await db.connector.close()
    }
  }, 15_000)

  test("a PostgreSQL client admitted before the outer deadline executes normally", async () => {
    const db = await queuedPostgres()
    try {
      const execution = run({ sql: "INSERT INTO sentinel VALUES (1)", warehouse: "pg", query_timeout_ms: 1000 })
      await db.connecting
      db.admit()
      expect((await execution).error).toBeUndefined()
      expect(db.queries).toContain("INSERT INTO sentinel VALUES (1)")
      expect(db.releases).toEqual([undefined])
    } finally {
      db.get.mockRestore()
      db.execute.mockRestore()
      await db.connector.close()
    }
  })

  test("sql.execute forwards requested read-only protection to PostgreSQL connectors", async () => {
    for (const type of ["postgres", "postgresql"]) {
      Registry.setConfigs({ source: { type } })
      const execute = mock<Connector["execute"]>(async () => ({ columns: [], rows: [], row_count: 0, truncated: false }))
      const get = spyOn(Registry, "get").mockResolvedValue({ execute } as never)
      try {
        expect((await run({ sql: "SELECT writing_view()", warehouse: "source", read_only: true })).error).toBeUndefined()
        expect(execute.mock.calls[0]?.[3]).toMatchObject({ readOnly: true })
      } finally {
        get.mockRestore()
      }
    }
  })

  test("sql.execute refuses a named non-PostgreSQL warehouse for read-only requests before executing SQL", async () => {
    Registry.setConfigs({ source: { type: "snowflake" } })
    const execute = mock<Connector["execute"]>(async () => ({ columns: [], rows: [], row_count: 0, truncated: false }))
    const get = spyOn(Registry, "get").mockResolvedValue({ execute } as never)
    try {
      const result = await run({ sql: "SELECT writing_view()", warehouse: "source", read_only: true })
      expect(result.error).toContain("Read-only SQL execution requires a native PostgreSQL connection. Configure one with warehouse.add or set ALTIMATE_CODE_CONN_* env vars.")
      expect(get).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
    } finally {
      get.mockRestore()
    }
  })

  test("sql.execute keeps non-PostgreSQL connector options unchanged for unprotected requests", async () => {
    Registry.setConfigs({ source: { type: "snowflake" } })
    const execute = mock<Connector["execute"]>(async () => ({ columns: [], rows: [], row_count: 0, truncated: false }))
    const get = spyOn(Registry, "get").mockResolvedValue({ execute } as never)
    try {
      expect((await run({ sql: "SELECT 1", warehouse: "source", read_only: false })).error).toBeUndefined()
      expect(execute.mock.calls[0]?.[3]).toEqual({ queryTimeoutMs: undefined })
    } finally {
      get.mockRestore()
    }
  })

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
  // restart rejects calls already queued on the lost session. They must never
  // execute after being reported as failed; a fresh call can use the new session.
  test("a call queued before a timeout loses its session without executing and fresh work succeeds", async () => {
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
      expect((b as any).error).toContain("session state was lost")
      expect((b as any).error).toContain("This statement was not executed")
      expect((b as any).rows).toEqual([])
      expect((b as any).row_count).toBe(0)
      // Allow SQLite to recover the helper's interrupted journal before reading.
      const check = new Database(db)
      try {
        expect(check.query("SELECT count(*) AS n FROM sentinel").get()).toEqual({ n: 0 })
        const fresh = await run({ sql: "INSERT INTO sentinel VALUES (2)", warehouse: "lite", query_timeout_ms: 500 })
        expect(fresh.error).toBeUndefined()
        expect(check.query("SELECT x FROM sentinel").all()).toEqual([{ x: 2 }])
      } finally {
        check.close()
      }
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

  test("a read-only PostgreSQL request skips the configured dbt adapter and uses a read-only transaction", async () => {
    const db = await queuedPostgres()
    const dbtExecute = mock(async () => ({ columnNames: ["one"], data: [{ one: 1 }] }))
    try {
      await withAdapter({ getAdapterType: () => "postgres", immediatelyExecuteSQL: dbtExecute, immediatelyExecuteSQLWithLimit: dbtExecute }, async () => {
        // Confirm dbt is configured and cached before exercising the protected path.
        expect(await resolveDefaultTarget("sql.execute")).toMatchObject({ source: "dbt", type: "postgres" })
        const sql = "SELECT writing_view() LIMIT 1"
        db.admit()
        expect((await run({ sql, read_only: true })).error).toBeUndefined()
        expect(dbtExecute).not.toHaveBeenCalled()
        expect(db.execute.mock.calls[0]?.[3]).toMatchObject({ readOnly: true })
        expect(db.queries).toContain("BEGIN READ ONLY")
        expect(db.queries.indexOf("BEGIN READ ONLY")).toBeLessThan(db.queries.indexOf(sql))
        expect(db.queries.indexOf("ROLLBACK")).toBeGreaterThan(db.queries.indexOf(sql))
      })
    } finally {
      db.admit()
      db.get.mockRestore()
      db.execute.mockRestore()
      await db.connector.close()
    }
  })

  test("a read-only request with only a dbt profile fails without executing unprotected SQL", async () => {
    Registry.setConfigs({})
    const dbtExecute = mock(async () => ({ columnNames: ["one"], data: [{ one: 1 }] }))
    const get = spyOn(Registry, "get")
    try {
      await withAdapter({ getAdapterType: () => "postgres", immediatelyExecuteSQL: dbtExecute, immediatelyExecuteSQLWithLimit: dbtExecute }, async () => {
        expect(await resolveDefaultTarget("sql.execute")).toMatchObject({ source: "dbt", type: "postgres" })
        const result = await run({ sql: "SELECT writing_view()", read_only: true, limit: 1 })
        expect(result.error).toContain("No warehouse configured")
        expect(result.error).toContain("requires a native PostgreSQL connection")
        expect(dbtExecute).not.toHaveBeenCalled()
        expect(get).not.toHaveBeenCalled()
      })
    } finally {
      get.mockRestore()
    }
  })

  test("a read-only PostgreSQL dbt request refuses a non-PostgreSQL native fallback", async () => {
    Registry.setConfigs({ source: { type: "snowflake", account: "a" } })
    const dbtExecute = mock(async () => ({ columnNames: ["one"], data: [{ one: 1 }] }))
    const execute = mock<Connector["execute"]>(async () => ({ columns: [], rows: [], row_count: 0, truncated: false }))
    const get = spyOn(Registry, "get").mockResolvedValue({ execute } as never)
    try {
      await withAdapter({ getAdapterType: () => "postgres", immediatelyExecuteSQL: dbtExecute, immediatelyExecuteSQLWithLimit: dbtExecute }, async () => {
        expect(await resolveDefaultTarget("sql.execute")).toMatchObject({
          source: "dbt", type: "postgres", fallback: { name: "source", type: "snowflake" },
        })
        const result = await run({ sql: "SELECT writing_view()", read_only: true })
        expect(result.error).toContain("requires a native PostgreSQL connection")
        expect(dbtExecute).not.toHaveBeenCalled()
        expect(get).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
      })
    } finally {
      get.mockRestore()
    }
  })

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
