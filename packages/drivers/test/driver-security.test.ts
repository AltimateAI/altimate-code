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
// ---------------------------------------------------------------------------
describe("DuckDB driver", () => {
  function openCallback(optsOrCb: any, cb?: (err: Error | null) => void): (err: Error | null) => void {
    return typeof optsOrCb === "function" ? optsOrCb : cb!
  }

  // Test wrapDuckDBError logic inline (it's a closure, so we test via connect behavior)
  describe("wrapDuckDBError", () => {
    test("wraps SQLITE_BUSY errors with user-friendly message", async () => {
      const mockDb = {
        connect: () => ({
          all: (_sql: string, cb: (err: Error | null, rows: any[]) => void) => {
            cb(new Error("SQLITE_BUSY: database is locked"), [])
          },
        }),
        close: (_cb: any) => {},
      }

      // Mock duckdb module
      mock.module("duckdb", () => ({
        default: {
          Database: class {
            constructor(_path: string, optsOrCb: any, cb?: (err: Error | null) => void) {
              setTimeout(() => openCallback(optsOrCb, cb)(null), 0)
            }
            connect() {
              return mockDb.connect()
            }
            close(cb: any) {
              if (cb) cb(null)
            }
          },
        },
      }))

      const { connect } = await import("../src/duckdb")
      const connector = await connect({ type: "duckdb", path: ":memory:" })
      await connector.connect()

      try {
        await connector.execute("SELECT 1")
        expect.unreachable("Should have thrown")
      } catch (e: any) {
        expect(e.message).toContain("locked by another process")
        expect(e.message).toContain("does not support concurrent write access")
      }

      await connector.close()
    })

    test("passes through non-lock errors unchanged", async () => {
      const originalError = new Error("syntax error at position 42")

      mock.module("duckdb", () => ({
        default: {
          Database: class {
            constructor(_path: string, optsOrCb: any, cb?: (err: Error | null) => void) {
              setTimeout(() => openCallback(optsOrCb, cb)(null), 0)
            }
            connect() {
              return {
                all: (_sql: string, cb: (err: Error | null, rows: any[]) => void) => {
                  cb(originalError, [])
                },
              }
            }
            close(cb: any) {
              if (cb) cb(null)
            }
          },
        },
      }))

      const { connect } = await import("../src/duckdb")
      const connector = await connect({ type: "duckdb", path: ":memory:" })
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
      mock.module("duckdb", () => ({
        default: {
          Database: class {
            constructor(_path: string, optsOrCb: any, cb?: (err: Error | null) => void) {
              setTimeout(() => openCallback(optsOrCb, cb)(null), 0)
            }
            connect() {
              return {
                all: (_sql: string, cb: (err: Error | null, rows: any[]) => void) => {
                  cb(new Error("DUCKDB_LOCKED: cannot write"), [])
                },
              }
            }
            close(cb: any) {
              if (cb) cb(null)
            }
          },
        },
      }))

      const { connect } = await import("../src/duckdb")
      const connector = await connect({ type: "duckdb", path: ":memory:" })
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

  describe("connect retry with READ_ONLY", () => {
    test("retries with READ_ONLY when file DB is locked on initial connect", async () => {
      let connectAttempts = 0
      const accessModes: Array<string | undefined> = []
      mock.module("duckdb", () => ({
        default: {
          Database: class {
            constructor(_path: string, optsOrCb: any, cb?: (err: Error | null) => void) {
              const opts = typeof optsOrCb === "function" ? undefined : optsOrCb
              const done = openCallback(optsOrCb, cb)
              accessModes.push(opts?.access_mode)
              connectAttempts++
              if (connectAttempts === 1 && !opts?.access_mode) {
                // First attempt fails with lock error
                setTimeout(() => done(new Error("DUCKDB_LOCKED: file is locked")), 0)
              } else {
                // READ_ONLY retry succeeds
                setTimeout(() => done(null), 0)
              }
            }
            connect() {
              return {
                all: (_sql: string, cb: (err: Error | null, rows: any[]) => void) => {
                  cb(null, [{ result: 1 }])
                },
              }
            }
            close(cb: any) {
              if (cb) cb(null)
            }
          },
        },
      }))

      const { connect } = await import("../src/duckdb")
      const connector = await connect({ type: "duckdb", path: "/tmp/test.duckdb" })
      await connector.connect()
      expect(connectAttempts).toBe(2) // First failed, second succeeded in READ_ONLY
      // The retry must specifically request READ_ONLY — two attempts alone don't
      // prove the lock was worked around correctly.
      expect(accessModes[0]).toBeUndefined()
      expect(accessModes[1]).toBe("READ_ONLY")

      await connector.close()
    })

    test("does not retry in-memory DB on lock error", async () => {
      mock.module("duckdb", () => ({
        default: {
          Database: class {
            constructor(_path: string, optsOrCb: any, cb?: (err: Error | null) => void) {
              setTimeout(() => openCallback(optsOrCb, cb)(new Error("DUCKDB_LOCKED")), 0)
            }
            connect() {
              return {}
            }
            close(cb: any) {
              if (cb) cb(null)
            }
          },
        },
      }))

      const { connect } = await import("../src/duckdb")
      const connector = await connect({ type: "duckdb", path: ":memory:" })

      try {
        await connector.connect()
        expect.unreachable("Should have thrown")
      } catch (e: any) {
        // In-memory DB should not retry, just throw the original error
        expect(e.message).toBe("DUCKDB_LOCKED")
      }
    })

    test("handles native open callback invoked synchronously", async () => {
      mock.module("duckdb", () => ({
        default: {
          Database: class {
            constructor(_path: string, optsOrCb: any, cb?: (err: Error | null) => void) {
              openCallback(optsOrCb, cb)(null)
            }
            connect() {
              return {
                all: (_sql: string, cb: (err: Error | null, rows: any[]) => void) => {
                  cb(null, [{ ok: 1 }])
                },
              }
            }
            close(cb: any) {
              if (cb) cb(null)
            }
          },
        },
      }))

      const { connect } = await import("../src/duckdb")
      const connector = await connect({ type: "duckdb", path: ":memory:" })
      await connector.connect()
      expect(await connector.execute("SELECT 1")).toMatchObject({ columns: ["ok"], rows: [[1]], row_count: 1 })
      await connector.close()
    })

    test("retries read-only when native open synchronously reports a file lock", async () => {
      let connectAttempts = 0
      mock.module("duckdb", () => ({
        default: {
          Database: class {
            constructor(_path: string, optsOrCb: any, cb?: (err: Error | null) => void) {
              const opts = typeof optsOrCb === "function" ? undefined : optsOrCb
              const done = openCallback(optsOrCb, cb)
              connectAttempts++
              done(connectAttempts === 1 && !opts?.access_mode ? new Error("DUCKDB_LOCKED: file is locked") : null)
            }
            connect() {
              return {
                all: (_sql: string, cb: (err: Error | null, rows: any[]) => void) => {
                  cb(null, [{ ok: 1 }])
                },
              }
            }
            close(cb: any) {
              if (cb) cb(null)
            }
          },
        },
      }))

      const { connect } = await import("../src/duckdb")
      const connector = await connect({ type: "duckdb", path: "/tmp/sync-lock.duckdb" })
      await connector.connect()
      expect(connectAttempts).toBe(2)
      expect(await connector.execute("SELECT 1")).toMatchObject({ columns: ["ok"], rows: [[1]], row_count: 1 })
      await connector.close()
    })

    test("propagates synchronous non-lock open errors without connecting undefined db", async () => {
      mock.module("duckdb", () => ({
        default: {
          Database: class {
            constructor(_path: string, optsOrCb: any, cb?: (err: Error | null) => void) {
              openCallback(optsOrCb, cb)(new Error("catalog is corrupt"))
            }
            connect() {
              throw new Error("should not connect")
            }
            close(cb: any) {
              if (cb) cb(null)
            }
          },
        },
      }))

      const { connect } = await import("../src/duckdb")
      const connector = await connect({ type: "duckdb", path: "/tmp/corrupt.duckdb" })
      await expect(connector.connect()).rejects.toThrow("catalog is corrupt")
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

  test("statement_timeout with NaN is silently skipped", async () => {
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

    expect(queriesSent.some((q) => q.includes("statement_timeout"))).toBe(false)
  })

  test("statement_timeout with negative value is silently skipped", async () => {
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

    expect(queriesSent.some((q) => q.includes("statement_timeout"))).toBe(false)
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
