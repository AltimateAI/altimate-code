/**
 * Query deadline contract: policy resolution, the typed error, and how the
 * Postgres and MongoDB drivers plumb the deadline to the server.
 */
import { describe, expect, mock, test } from "bun:test"
import {
  DEFAULT_QUERY_TIMEOUT_MS,
  MAX_TIMER_MS,
  QUERY_TIMEOUT_ENV,
  resolveQueryTimeout,
  tighter,
} from "../src/query-timeout"
import { QUERY_TIMEOUT_CODE, QueryTimeoutError, isQueryTimeoutError } from "../src/types"

describe("resolveQueryTimeout", () => {
  const cfg = (query_timeout_ms?: unknown) => ({ type: "x", query_timeout_ms })

  test("defaults to 120s", () => {
    expect(resolveQueryTimeout({ type: "x" }, undefined, {})).toEqual({ ms: DEFAULT_QUERY_TIMEOUT_MS, source: "default" })
    expect(DEFAULT_QUERY_TIMEOUT_MS).toBe(120_000)
  })

  test("precedence: call > connection > env > default", () => {
    const env = { [QUERY_TIMEOUT_ENV]: "3000" }
    expect(resolveQueryTimeout(cfg(2000), { queryTimeoutMs: 1000 }, env)).toEqual({ ms: 1000, source: "call" })
    expect(resolveQueryTimeout(cfg(2000), undefined, env)).toEqual({ ms: 2000, source: "connection" })
    expect(resolveQueryTimeout(cfg(), undefined, env)).toEqual({ ms: 3000, source: "env" })
  })

  test("0 disables at every level; null disables on the connection", () => {
    expect(resolveQueryTimeout(cfg(), { queryTimeoutMs: 0 }, {}).ms).toBeUndefined()
    expect(resolveQueryTimeout(cfg(0), undefined, {}).ms).toBeUndefined()
    expect(resolveQueryTimeout(cfg(null), undefined, {}).ms).toBeUndefined()
    expect(resolveQueryTimeout(cfg(), undefined, { [QUERY_TIMEOUT_ENV]: "0" }).ms).toBeUndefined()
    // a connection's 0 beats the env deadline
    expect(resolveQueryTimeout(cfg(0), undefined, { [QUERY_TIMEOUT_ENV]: "500" }).ms).toBeUndefined()
  })

  test("unusable values fall through to the next source", () => {
    const env = { [QUERY_TIMEOUT_ENV]: "750" }
    for (const bad of ["abc", -5, NaN, true, ""]) {
      expect(resolveQueryTimeout(cfg(bad), undefined, env)).toEqual({ ms: 750, source: "env" })
    }
    expect(resolveQueryTimeout(cfg(), undefined, { [QUERY_TIMEOUT_ENV]: "nope" }).source).toBe("default")
    expect(resolveQueryTimeout(cfg("2500"), undefined, {}).ms).toBe(2500)
  })

  test("over-large values clamp to the timer maximum instead of overflowing", () => {
    expect(resolveQueryTimeout(cfg(1e15), undefined, {}).ms).toBe(MAX_TIMER_MS)
  })

  test("tighter keeps the stricter positive limit", () => {
    expect(tighter(undefined, undefined)).toBeUndefined()
    expect(tighter(5, undefined)).toBe(5)
    expect(tighter(undefined, 7)).toBe(7)
    expect(tighter(5, 7)).toBe(5)
  })
})

describe("QueryTimeoutError", () => {
  test("carries a stable code and names the deadline and engine", () => {
    const e = new QueryTimeoutError({ engine: "PostgreSQL", timeoutMs: 120_000 })
    expect(e.code).toBe(QUERY_TIMEOUT_CODE)
    expect(isQueryTimeoutError(e)).toBe(true)
    expect(e.message).toContain("QUERY_TIMEOUT")
    expect(e.message).toContain("PostgreSQL")
    expect(e.message).toContain("120s")
    expect(e.message).toContain("query_timeout_ms")
    expect(e.cancelled).toBe(true)
    expect(String(e).toLowerCase()).toContain("timeout") // categorizeQueryError keys off this
  })

  test("an abandoned (not cancelled) query says it may still be running", () => {
    const e = new QueryTimeoutError({ engine: "Snowflake", timeoutMs: 1500, cancelled: false })
    expect(e.cancelled).toBe(false)
    expect(e.message).toContain("may still be running")
    expect(e.message).toContain("1500ms")
  })

  test("isQueryTimeoutError ignores ordinary errors", () => {
    expect(isQueryTimeoutError(new Error("timeout"))).toBe(false)
    expect(isQueryTimeoutError(null)).toBe(false)
    expect(isQueryTimeoutError("QUERY_TIMEOUT")).toBe(false)
  })
})

describe("PostgreSQL deadline plumbing", () => {
  function fakePg(opts: { failWith?: any; resetFails?: boolean } = {}) {
    const sent: string[] = []
    const released: Array<unknown> = []
    mock.module("pg", () => ({
      default: {
        Pool: class {
          async connect() {
            return {
              query: async (sql: string) => {
                // The server-default probe is not part of the SET/RESET sequence under test.
                if (sql === "SHOW statement_timeout") return { fields: [], rows: [{ statement_timeout: "0" }] }
                sent.push(sql)
                if (sql === "RESET statement_timeout" && opts.resetFails) throw new Error("reset failed")
                if (opts.failWith && !sql.includes("statement_timeout")) throw opts.failWith
                return { fields: [], rows: [] }
              },
              release: (arg?: unknown) => released.push(arg),
            }
          }
        },
      },
    }))
    return { sent, released }
  }
  const base = { type: "postgres", host: "localhost", password: "x" }

  test("every query runs under the default 120s statement_timeout and resets it before release", async () => {
    const { sent, released } = fakePg()
    const { connect } = await import("../src/postgres")
    const c = await connect(base)
    await c.connect()
    await c.execute("SELECT 1")
    expect(sent[0]).toBe("SET statement_timeout TO 120000")
    expect(sent.at(-1)).toBe("RESET statement_timeout")
    expect(released).toEqual([undefined])
  })

  test("connection query_timeout_ms, call option and 0 are honoured", async () => {
    const { connect } = await import("../src/postgres")
    let f = fakePg()
    let c = await connect({ ...base, query_timeout_ms: 5000 })
    await c.connect()
    await c.execute("SELECT 1")
    expect(f.sent[0]).toBe("SET statement_timeout TO 5000")

    f = fakePg()
    c = await connect({ ...base, query_timeout_ms: 5000 })
    await c.connect()
    await c.execute("SELECT 1", 10, undefined, { queryTimeoutMs: 900 })
    expect(f.sent[0]).toBe("SET statement_timeout TO 900")

    f = fakePg()
    c = await connect({ ...base, query_timeout_ms: 0 })
    await c.connect()
    await c.execute("SELECT 1")
    expect(f.sent.some((q) => q.includes("statement_timeout"))).toBe(false)
  })

  test("a tighter configured statement_timeout is preserved; a looser one is capped by the deadline", async () => {
    const { connect } = await import("../src/postgres")
    let f = fakePg()
    let c = await connect({ ...base, statement_timeout: 2000 })
    await c.connect()
    await c.execute("SELECT 1")
    expect(f.sent[0]).toBe("SET statement_timeout TO 2000")

    f = fakePg()
    c = await connect({ ...base, statement_timeout: 600_000 })
    await c.connect()
    await c.execute("SELECT 1")
    expect(f.sent[0]).toBe("SET statement_timeout TO 120000")

    // disabling the common deadline keeps the explicit limit
    f = fakePg()
    c = await connect({ ...base, statement_timeout: 2000, query_timeout_ms: 0 })
    await c.connect()
    await c.execute("SELECT 1")
    expect(f.sent[0]).toBe("SET statement_timeout TO 2000")
  })

  test("a server-side statement timeout becomes a QUERY_TIMEOUT error", async () => {
    const err = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })
    const { sent } = fakePg({ failWith: err })
    const { connect } = await import("../src/postgres")
    const c = await connect({ ...base, query_timeout_ms: 1500 })
    await c.connect()
    const caught = await c.execute("SELECT pg_sleep(99)").catch((e) => e)
    expect(isQueryTimeoutError(caught)).toBe(true)
    expect(caught.timeoutMs).toBe(1500)
    expect(sent.at(-1)).toBe("RESET statement_timeout") // reset even on failure
  })

  test("a user cancel (same SQLSTATE) is not reported as a timeout", async () => {
    const err = Object.assign(new Error("canceling statement due to user request"), { code: "57014" })
    fakePg({ failWith: err })
    const { connect } = await import("../src/postgres")
    const c = await connect(base)
    await c.connect()
    const caught = await c.execute("SELECT 1").catch((e) => e)
    expect(isQueryTimeoutError(caught)).toBe(false)
  })

  test("a client whose reset failed is discarded instead of returned to the pool", async () => {
    const { released } = fakePg({ resetFails: true })
    const { connect } = await import("../src/postgres")
    const c = await connect(base)
    await c.connect()
    await c.execute("SELECT 1")
    expect(released).toEqual([true])
  })
})

describe("MongoDB deadline plumbing", () => {
  function fakeMongo(opts: { failWith?: any } = {}) {
    const seen: Record<string, any> = {}
    const cursor = (name: string) => ({
      project: () => cursor(name),
      sort: () => cursor(name),
      skip: () => cursor(name),
      limit: () => cursor(name),
      toArray: async () => {
        if (opts.failWith) throw opts.failWith
        return [{ a: 1 }]
      },
    })
    const coll = {
      find: (_f: unknown, o: unknown) => ((seen.find = o), cursor("find")),
      aggregate: (_p: unknown, o: unknown) => ((seen.aggregate = o), cursor("aggregate")),
      countDocuments: async (_f: unknown, o: unknown) => {
        seen.countDocuments = o
        if (opts.failWith) throw opts.failWith
        return 3
      },
      distinct: async (_field: unknown, _f: unknown, o: unknown) => ((seen.distinct = o), ["x"]),
      listIndexes: (o: unknown) => ((seen.listIndexes = o), { toArray: async () => [{ name: "_id_", key: { _id: 1 } }] }),
    }
    mock.module("mongodb", () => ({
      default: {
        MongoClient: class {
          async connect() {}
          async close() {}
          db() {
            return { databaseName: "test", collection: () => coll }
          }
        },
      },
    }))
    return seen
  }
  const run = (c: any, command: string, extra: object = {}, options?: object) =>
    c.execute(JSON.stringify({ database: "test", collection: "users", command, field: "a", ...extra }), 10, undefined, options)

  test("maxTimeMS is set on every read path from the default", async () => {
    const seen = fakeMongo()
    const { connect } = await import("../src/mongodb")
    const c = await connect({ type: "mongodb", host: "localhost", database: "test" })
    await c.connect()
    await run(c, "find")
    await run(c, "aggregate", { pipeline: [{ $match: {} }] })
    await run(c, "countDocuments")
    await run(c, "distinct")
    await run(c, "listIndexes")
    for (const op of ["find", "aggregate", "countDocuments", "distinct", "listIndexes"]) {
      expect(seen[op]).toEqual({ maxTimeMS: 120_000 })
    }
  })

  test("connection value, call option and 0 are honoured", async () => {
    const { connect } = await import("../src/mongodb")
    let seen = fakeMongo()
    let c = await connect({ type: "mongodb", host: "localhost", database: "test", query_timeout_ms: 4000 })
    await c.connect()
    await run(c, "find")
    expect(seen.find).toEqual({ maxTimeMS: 4000 })
    await run(c, "find", {}, { queryTimeoutMs: 250 })
    expect(seen.find).toEqual({ maxTimeMS: 250 })

    seen = fakeMongo()
    c = await connect({ type: "mongodb", host: "localhost", database: "test", query_timeout_ms: 0 })
    await c.connect()
    await run(c, "find")
    await run(c, "countDocuments")
    expect(seen.find).toEqual({})
    expect(seen.countDocuments).toEqual({})
  })

  test("MaxTimeMSExpired becomes a QUERY_TIMEOUT error", async () => {
    fakeMongo({ failWith: Object.assign(new Error("operation exceeded time limit"), { code: 50, codeName: "MaxTimeMSExpired" }) })
    const { connect } = await import("../src/mongodb")
    const c = await connect({ type: "mongodb", host: "localhost", database: "test", query_timeout_ms: 900 })
    await c.connect()
    for (const command of ["find", "countDocuments"]) {
      const caught = await run(c, command).catch((e: any) => e)
      expect(isQueryTimeoutError(caught)).toBe(true)
      expect(caught.timeoutMs).toBe(900)
      expect(caught.engine).toBe("MongoDB")
    }
  })

  test("other server errors pass through unchanged", async () => {
    fakeMongo({ failWith: Object.assign(new Error("not authorized"), { code: 13 }) })
    const { connect } = await import("../src/mongodb")
    const c = await connect({ type: "mongodb", host: "localhost", database: "test" })
    await c.connect()
    const caught = await run(c, "countDocuments").catch((e: any) => e)
    expect(isQueryTimeoutError(caught)).toBe(false)
    expect(caught.message).toBe("not authorized")
  })
})
