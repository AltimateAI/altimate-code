/**
 * Unit tests for security-critical driver changes:
 * - DuckDB: wrapDuckDBError, lock retry with READ_ONLY
 * - MongoDB: $out/$merge/$function/$accumulator blocking
 * - PostgreSQL: password validation, statement_timeout guard
 * - Redshift: password validation
 * - Registry: known-unsupported DB hints, password validation
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"

// ---------------------------------------------------------------------------
// DuckDB: wrapDuckDBError + lock retry
//
// The handle lives in a helper process, so these tests script the engine the
// driver talks to instead of mocking the native binding in-process. Behaviour
// that moved into the helper (a synchronous open callback) is covered against
// the real helper in local-engine.test.ts.
// ---------------------------------------------------------------------------
describe("DuckDB driver", () => {
  interface FakeScript {
    /** One entry per open attempt: an Error to reject with, or null to succeed. */
    opens?: Array<Error | null>
    /** Result or error for each call. */
    call?: (sql: string) => any[] | Error
  }

  function fakeEngine(script: FakeScript) {
    const openPayloads: any[] = []
    const engine = {
      async open(payload: any) {
        openPayloads.push(payload)
        const outcome = script.opens?.[openPayloads.length - 1] ?? null
        if (outcome) throw outcome
      },
      async call(_op: string, payload: any) {
        const out = script.call ? script.call(payload.sql) : []
        if (out instanceof Error) throw out
        return out
      },
      async close() {},
    }
    return { engine, openPayloads }
  }

  async function connectorWith(config: any, script: FakeScript) {
    const fake = fakeEngine(script)
    const { connect } = await import("../src/duckdb")
    const connector = await connect(config, { createEngine: () => fake.engine as any })
    return { connector, ...fake }
  }

  describe("wrapDuckDBError", () => {
    test("wraps SQLITE_BUSY errors with user-friendly message", async () => {
      const { connector } = await connectorWith(
        { type: "duckdb", path: ":memory:" },
        { call: () => new Error("SQLITE_BUSY: database is locked") },
      )
      await connector.connect()

      try {
        await connector.execute("SELECT 1")
        expect.unreachable("Should have thrown")
      } catch (e: any) {
        expect(e.message).toContain("locked by another process")
        expect(e.message).toContain("exclusive file lock")
        // DuckDB's own text names the PID holding the lock, so it must survive
        // being wrapped rather than being replaced by the friendly summary.
        expect(e.message).toContain("SQLITE_BUSY: database is locked")
      }

      await connector.close()
    })

    test("passes through non-lock errors unchanged", async () => {
      const { connector } = await connectorWith(
        { type: "duckdb", path: ":memory:" },
        { call: () => new Error("syntax error at position 42") },
      )
      await connector.connect()

      try {
        await connector.execute("INVALID SQL")
        expect.unreachable("Should have thrown")
      } catch (e: any) {
        expect(e.message).toBe("syntax error at position 42")
      }

      await connector.close()
    })

    test("detects DUCKDB_LOCKED keyword", async () => {
      const { connector } = await connectorWith(
        { type: "duckdb", path: ":memory:" },
        { call: () => new Error("DUCKDB_LOCKED: cannot write") },
      )
      await connector.connect()

      try {
        await connector.execute("INSERT INTO t VALUES (1)")
        expect.unreachable("Should have thrown")
      } catch (e: any) {
        expect(e.message).toContain("locked by another process")
      }

      await connector.close()
    })
  })

  // Verbatim DuckDB output for a cross-process lock collision. It contains
  // "lock" but never "locked", which is why the driver's original
  // `.includes("locked")` check never matched a real collision.
  const REAL_DUCKDB_LOCK_ERROR =
    'IO Error: Could not set lock on file "/tmp/test.duckdb": Conflicting lock is held in ' +
    "/usr/bin/node (PID 65001) by user someone."

  describe("connect retry with READ_ONLY", () => {
    test("retries with READ_ONLY when file DB is locked on initial connect", async () => {
      const { connector, openPayloads } = await connectorWith(
        { type: "duckdb", path: "/tmp/test.duckdb", create: true },
        { opens: [new Error("DUCKDB_LOCKED: file is locked"), null] },
      )
      await connector.connect()
      expect(openPayloads.length).toBe(2) // First failed, second succeeded in READ_ONLY
      // The retry must specifically request READ_ONLY — two attempts alone don't
      // prove the lock was worked around correctly.
      expect(openPayloads[0].accessMode).toBeUndefined()
      expect(openPayloads[1].accessMode).toBe("READ_ONLY")

      await connector.close()
    })

    test("does not claim a non-contention lock failure as a foreign lock", async () => {
      // "Could not set lock" without "Conflicting lock" is a filesystem fault,
      // not contention. Wrapping it as "locked by another process" would send
      // the reader after a process to close and hide the real cause — and the
      // registry would trust that fabricated wrapper as recoverable.
      const { connector, openPayloads } = await connectorWith(
        { type: "duckdb", path: "/tmp/test.duckdb", create: true },
        { opens: [new Error('IO Error: Could not set lock on file "/tmp/test.duckdb": Operation not supported')] },
      )

      try {
        await connector.connect()
        expect.unreachable("Should have thrown")
      } catch (e: any) {
        expect(e.message).toContain("Operation not supported")
        expect(e.message).not.toContain("locked by another process")
      }

      // And it is not treated as contention, so no read-only retry is spent.
      expect(openPayloads.length).toBe(1)
    })

    test("retries with READ_ONLY when the first open fails with DuckDB's real lock text", async () => {
      // Only this test uses the message DuckDB actually emits, so only this one
      // would catch a regression that broke detection of a real lock collision
      // on the retry path.
      const { connector, openPayloads } = await connectorWith(
        { type: "duckdb", path: "/tmp/test.duckdb", create: true },
        { opens: [new Error(REAL_DUCKDB_LOCK_ERROR), null] },
      )
      await connector.connect()

      expect(openPayloads.length).toBe(2)
      expect(openPayloads[0].accessMode).toBeUndefined()
      expect(openPayloads[1].accessMode).toBe("READ_ONLY")

      await connector.close()
    })

    test("wraps a lock error on an explicitly read-only open, and does not retry it", async () => {
      // A caller that set `readonly` already gets READ_ONLY on the first open,
      // so there is nothing for the retry to try differently — DuckDB's file
      // lock is exclusive against read-only opens too. The failure must still
      // be *labelled* a lock, though: consumers classify it by the wrapper's
      // "locked by another process" wording.
      const { connector, openPayloads } = await connectorWith(
        { type: "duckdb", path: "/tmp/test.duckdb", readonly: true, create: true },
        { opens: [new Error(REAL_DUCKDB_LOCK_ERROR)] },
      )

      try {
        await connector.connect()
        expect.unreachable("Should have thrown")
      } catch (e: any) {
        expect(e.message).toContain("locked by another process")
        // DuckDB's own text survives: it names the PID holding the lock.
        expect(e.message).toContain("Conflicting lock is held")
      }

      // Exactly one attempt, and it asked for READ_ONLY up front.
      expect(openPayloads.map((p) => p.accessMode)).toEqual(["READ_ONLY"])
    })

    test("does not retry in-memory DB on lock error", async () => {
      const { connector, openPayloads } = await connectorWith(
        { type: "duckdb", path: ":memory:" },
        { opens: [new Error("DUCKDB_LOCKED")] },
      )

      try {
        await connector.connect()
        expect.unreachable("Should have thrown")
      } catch (e: any) {
        // In-memory DB should not retry, just throw the original error
        expect(e.message).toBe("DUCKDB_LOCKED")
      }
      expect(openPayloads.length).toBe(1)
    })

    test("propagates non-lock open errors without marking the connection open", async () => {
      const { connector } = await connectorWith(
        { type: "duckdb", path: "/tmp/corrupt.duckdb", create: true },
        { opens: [new Error("catalog is corrupt")] },
      )
      await expect(connector.connect()).rejects.toThrow("catalog is corrupt")
      await expect(connector.execute("SELECT 1")).rejects.toThrow("not open")
    })
  })
})

// ---------------------------------------------------------------------------
// MongoDB: aggregate pipeline security
// ---------------------------------------------------------------------------
describe("MongoDB driver", () => {
  // We test the security checks by calling execute() with crafted JSON queries.
  // The checks happen before any actual MongoDB operations, so we only need
  // to mock enough to get past the connect step.

  function createMockMongoClient() {
    return {
      connect: async () => {},
      close: async () => {},
      db: () => ({
        collection: () => ({
          aggregate: () => ({
            toArray: async () => [],
          }),
          find: () => ({
            project: function () { return this },
            sort: function () { return this },
            skip: function () { return this },
            limit: function () { return this },
            toArray: async () => [],
          }),
        }),
        command: async () => ({ ok: 1 }),
        admin: () => ({
          listDatabases: async () => ({ databases: [] }),
        }),
      }),
      databaseName: "test",
    }
  }

  let connector: any

  beforeEach(async () => {
    mock.module("mongodb", () => ({
      default: {
        MongoClient: class {
          constructor() {
            return createMockMongoClient()
          }
        },
      },
    }))

    const { connect } = await import("../src/mongodb")
    connector = await connect({ type: "mongodb", host: "localhost", port: 27017 })
    await connector.connect()
  })

  afterEach(async () => {
    if (connector) await connector.close()
    mock.restore()
  })

  describe("blocks dangerous aggregate stages", () => {
    test("blocks $out stage", async () => {
      const query = JSON.stringify({
        database: "test",
        collection: "users",
        command: "aggregate",
        pipeline: [{ $match: { age: { $gt: 25 } } }, { $out: "exported_users" }],
      })

      try {
        await connector.execute(query)
        expect.unreachable("Should have thrown")
      } catch (e: any) {
        expect(e.message).toContain("blocked write stage")
        expect(e.message).toContain("$out")
      }
    })

    test("blocks $merge stage", async () => {
      const query = JSON.stringify({
        database: "test",
        collection: "users",
        command: "aggregate",
        pipeline: [{ $merge: { into: "merged_users" } }],
      })

      try {
        await connector.execute(query)
        expect.unreachable("Should have thrown")
      } catch (e: any) {
        expect(e.message).toContain("blocked write stage")
        expect(e.message).toContain("$merge")
      }
    })

    test("blocks $function operator (nested)", async () => {
      const query = JSON.stringify({
        database: "test",
        collection: "users",
        command: "aggregate",
        pipeline: [
          {
            $addFields: {
              custom: {
                $function: { body: "function() { return 1 }", args: [], lang: "js" },
              },
            },
          },
        ],
      })

      try {
        await connector.execute(query)
        expect.unreachable("Should have thrown")
      } catch (e: any) {
        expect(e.message).toContain("blocked operator")
        expect(e.message).toContain("$function")
      }
    })

    test("blocks $accumulator operator (nested in $group)", async () => {
      const query = JSON.stringify({
        database: "test",
        collection: "users",
        command: "aggregate",
        pipeline: [
          {
            $group: {
              _id: "$category",
              total: {
                $accumulator: {
                  init: "function() { return 0 }",
                  accumulate: "function(state, val) { return state + val }",
                  accumulateArgs: ["$amount"],
                  merge: "function(s1, s2) { return s1 + s2 }",
                  finalize: "function(state) { return state }",
                  lang: "js",
                },
              },
            },
          },
        ],
      })

      try {
        await connector.execute(query)
        expect.unreachable("Should have thrown")
      } catch (e: any) {
        expect(e.message).toContain("blocked operator")
        expect(e.message).toContain("$accumulator")
      }
    })

    test("allows safe aggregate pipelines", async () => {
      const query = JSON.stringify({
        database: "test",
        collection: "users",
        command: "aggregate",
        pipeline: [{ $match: { age: { $gt: 25 } } }, { $group: { _id: "$city", count: { $sum: 1 } } }],
      })

      // Should not throw
      const result = await connector.execute(query)
      expect(result).toBeDefined()
      expect(result.row_count).toBe(0) // mock returns empty
    })
  })
})

// ---------------------------------------------------------------------------
// PostgreSQL: password validation + statement_timeout
// ---------------------------------------------------------------------------
describe("PostgreSQL driver", () => {
  test("rejects non-string password", async () => {
    mock.module("pg", () => ({
      default: {
        Pool: class {
          constructor() {}
        },
      },
    }))

    const { connect } = await import("../src/postgres")
    const connector = await connect({
      type: "postgres",
      host: "localhost",
      password: 12345 as any,
    })

    try {
      await connector.connect()
      expect.unreachable("Should have thrown")
    } catch (e: any) {
      expect(e.message).toContain("password must be a string")
    }
  })

  test("allows string password", async () => {
    let poolCreated = false
    mock.module("pg", () => ({
      default: {
        Pool: class {
          constructor() {
            poolCreated = true
          }
        },
      },
    }))

    const { connect } = await import("../src/postgres")
    const connector = await connect({
      type: "postgres",
      host: "localhost",
      password: "valid-string-password",
    })

    await connector.connect()
    expect(poolCreated).toBe(true)
  })

  test("allows null/undefined password (no validation needed)", async () => {
    let poolCreated = false
    mock.module("pg", () => ({
      default: {
        Pool: class {
          constructor() {
            poolCreated = true
          }
        },
      },
    }))

    const { connect } = await import("../src/postgres")
    const connector = await connect({
      type: "postgres",
      host: "localhost",
    })

    await connector.connect()
    expect(poolCreated).toBe(true)
  })

  test("skips password validation when using connection_string", async () => {
    let poolCreated = false
    mock.module("pg", () => ({
      default: {
        Pool: class {
          constructor() {
            poolCreated = true
          }
        },
      },
    }))

    const { connect } = await import("../src/postgres")
    const connector = await connect({
      type: "postgres",
      connection_string: "postgresql://user:pass@localhost/db",
      password: 12345 as any, // Should be ignored because connection_string is set
    })

    await connector.connect()
    expect(poolCreated).toBe(true)
  })

  test("statement_timeout with valid number sets timeout", async () => {
    let queriesSent: string[] = []
    mock.module("pg", () => ({
      default: {
        Pool: class {
          async connect() {
            return {
              query: async (sql: string) => {
                queriesSent.push(sql)
                return { fields: [], rows: [] }
              },
              release: () => {},
            }
          }
        },
      },
    }))

    const { connect } = await import("../src/postgres")
    const connector = await connect({
      type: "postgres",
      host: "localhost",
      password: "test",
      statement_timeout: 5000,
    })
    await connector.connect()
    await connector.execute("SELECT 1")

    expect(queriesSent.some((q) => q.includes("statement_timeout") && q.includes("5000"))).toBe(true)
  })

  const fakePg = (shown: string, queriesSent: string[]) =>
    mock.module("pg", () => ({
      default: {
        Pool: class {
          async connect() {
            return {
              query: async (sql: string) => {
                queriesSent.push(sql)
                return sql === "SHOW statement_timeout"
                  ? { fields: [], rows: [{ statement_timeout: shown }] }
                  : { fields: [], rows: [] }
              },
              release: () => {},
            }
          }
        },
      },
    }))

  test("a stricter server statement_timeout is never loosened by the default deadline", async () => {
    const queriesSent: string[] = []
    fakePg("30s", queriesSent)
    const { connect } = await import("../src/postgres")
    const connector = await connect({ type: "postgres", host: "localhost", password: "test" })
    await connector.connect()
    await connector.execute("SELECT 1")
    expect(queriesSent).toContain("SHOW statement_timeout")
    expect(queriesSent.some((q) => q.startsWith("SET statement_timeout"))).toBe(false)
  })

  test("a looser or unlimited server statement_timeout is tightened to ours", async () => {
    for (const shown of ["5min", "0"]) {
      const queriesSent: string[] = []
      fakePg(shown, queriesSent)
      const { connect } = await import("../src/postgres")
      const connector = await connect({ type: "postgres", host: "localhost", password: "test" })
      await connector.connect()
      await connector.execute("SELECT 1")
      expect(queriesSent).toContain("SET statement_timeout TO 120000")
    }
  })

  test("statement_timeout with NaN is ignored; the default deadline applies instead", async () => {
    let queriesSent: string[] = []
    mock.module("pg", () => ({
      default: {
        Pool: class {
          async connect() {
            return {
              query: async (sql: string) => {
                queriesSent.push(sql)
                return { fields: [], rows: [] }
              },
              release: () => {},
            }
          }
        },
      },
    }))

    const { connect } = await import("../src/postgres")
    const connector = await connect({
      type: "postgres",
      host: "localhost",
      password: "test",
      statement_timeout: "not-a-number" as any,
    })
    await connector.connect()
    await connector.execute("SELECT 1")

    // The unusable value is never sent; the common 120s deadline is, and reset after.
    expect(queriesSent.some((q) => q.includes("statement_timeout") && /NaN|-1|not-a-number/.test(q))).toBe(false)
    expect(queriesSent).toContain("SET statement_timeout TO 120000")
    expect(queriesSent).toContain("RESET statement_timeout")
  })

  test("statement_timeout with negative value is ignored; the default deadline applies instead", async () => {
    let queriesSent: string[] = []
    mock.module("pg", () => ({
      default: {
        Pool: class {
          async connect() {
            return {
              query: async (sql: string) => {
                queriesSent.push(sql)
                return { fields: [], rows: [] }
              },
              release: () => {},
            }
          }
        },
      },
    }))

    const { connect } = await import("../src/postgres")
    const connector = await connect({
      type: "postgres",
      host: "localhost",
      password: "test",
      statement_timeout: -1,
    })
    await connector.connect()
    await connector.execute("SELECT 1")

    // The unusable value is never sent; the common 120s deadline is, and reset after.
    expect(queriesSent.some((q) => q.includes("statement_timeout") && /NaN|-1|not-a-number/.test(q))).toBe(false)
    expect(queriesSent).toContain("SET statement_timeout TO 120000")
    expect(queriesSent).toContain("RESET statement_timeout")
  })
})

// ---------------------------------------------------------------------------
// Redshift: password validation
// ---------------------------------------------------------------------------
describe("Redshift driver", () => {
  test("rejects non-string password", async () => {
    mock.module("pg", () => ({
      default: {
        Pool: class {
          constructor() {}
        },
      },
    }))

    const { connect } = await import("../src/redshift")
    const connector = await connect({
      type: "redshift",
      host: "my-cluster.redshift.amazonaws.com",
      password: { nested: "object" } as any,
    })

    try {
      await connector.connect()
      expect.unreachable("Should have thrown")
    } catch (e: any) {
      expect(e.message).toContain("password must be a string")
    }
  })

  test("allows string password", async () => {
    let poolCreated = false
    mock.module("pg", () => ({
      default: {
        Pool: class {
          constructor() {
            poolCreated = true
          }
        },
      },
    }))

    const { connect } = await import("../src/redshift")
    const connector = await connect({
      type: "redshift",
      host: "my-cluster.redshift.amazonaws.com",
      password: "valid-password",
    })

    await connector.connect()
    expect(poolCreated).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Registry: known-unsupported hints + password validation
// ---------------------------------------------------------------------------
describe("Connection registry", () => {
  describe("known-unsupported databases", () => {
    let reset: any, setConfigs: any, get: any

    beforeEach(async () => {
      const registry = await import(
        "../../opencode/src/altimate/native/connections/registry"
      )
      reset = registry.reset
      setConfigs = registry.setConfigs
      get = registry.get
      reset()
    })

    test("Cassandra gives helpful hint", async () => {
      setConfigs({ cass: { type: "cassandra" } as any })
      try {
        await get("cass")
        expect.unreachable("Should have thrown")
      } catch (e: any) {
        expect(e.message).toContain("Cassandra is not yet supported")
        expect(e.message).toContain("cqlsh")
      }
    })

    test("CockroachDB suggests postgres type", async () => {
      setConfigs({ crdb: { type: "cockroachdb" } as any })
      try {
        await get("crdb")
        expect.unreachable("Should have thrown")
      } catch (e: any) {
        expect(e.message).toContain("CockroachDB is not yet supported")
        expect(e.message).toContain("type: postgres")
      }
    })

    test("TimescaleDB suggests postgres type", async () => {
      setConfigs({ tsdb: { type: "timescaledb" } as any })
      try {
        await get("tsdb")
        expect.unreachable("Should have thrown")
      } catch (e: any) {
        expect(e.message).toContain("TimescaleDB")
        expect(e.message).toContain("type: postgres")
      }
    })

    test("truly unknown type gets generic error with supported list", async () => {
      setConfigs({ foo: { type: "foobardb" } as any })
      try {
        await get("foo")
        expect.unreachable("Should have thrown")
      } catch (e: any) {
        expect(e.message).toContain("Unsupported database type: foobardb")
        expect(e.message).toContain("Supported:")
      }
    })
  })
})
