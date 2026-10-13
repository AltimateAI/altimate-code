import { expect, mock, test } from "bun:test"
import { connect } from "../src/postgres"
import { QueryTimeoutError } from "../src/types"

async function database(rollbackFails = false) {
  const queries: string[] = []
  const releases: unknown[] = []
  let readOnly = false
  let writes = 0
  let notifications = 0
  mock.module("pg", () => ({
    default: {
      Pool: class {
        async connect() {
          return {
            async query(sql: string) {
              queries.push(sql)
              if (sql === "BEGIN READ ONLY") readOnly = true
              else if (sql === "ROLLBACK") {
                if (rollbackFails) throw new Error("lost connection during rollback")
                readOnly = false
              } else if (sql.includes("custom_write_udf")) {
                if (readOnly) throw new Error("cannot execute INSERT in a read-only transaction")
                writes++
              } else if (sql.includes("pg_notify") && !readOnly) notifications++
              return { fields: [{ name: "value" }], rows: [{ value: 1 }] }
            },
            release(discard?: boolean) {
              releases.push(discard)
            },
          }
        }
        async end() {}
      },
    },
  }))
  const connector = await connect({ type: "postgres" })
  await connector.connect()
  const execute = (sql: string) => connector.execute(sql, 1, undefined, { queryTimeoutMs: 0, readOnly: true })
  return { connector, execute, queries, releases, writes: () => writes, notifications: () => notifications }
}

test("Postgres read-only extraction rolls back pg_notify on the same checked-out client", async () => {
  const db = await database()
  try {
    expect((await db.execute("SELECT pg_notify('channel', 'payload')")).rows).toEqual([[1]])
    expect(db.notifications()).toBe(0)
    expect(db.queries).toEqual(["BEGIN READ ONLY", "SELECT pg_notify('channel', 'payload') LIMIT 2", "ROLLBACK"])
    expect(db.releases).toEqual([undefined])
  } finally {
    await db.connector.close()
  }
})

test("Postgres rejects a writing UDF at the read-only transaction boundary", async () => {
  const db = await database()
  try {
    await expect(db.execute("SELECT custom_write_udf()")).rejects.toThrow(/read-only transaction/)
    expect(db.writes()).toBe(0)
    expect(db.queries.at(-1)).toBe("ROLLBACK")
    expect(db.releases).toEqual([undefined])
  } finally {
    await db.connector.close()
  }
})

test("Postgres discards a client when read-only rollback fails", async () => {
  const db = await database(true)
  try {
    await db.execute("SELECT 1")
    expect(db.releases).toEqual([true])
  } finally {
    await db.connector.close()
  }
})

async function queuedDatabase() {
  const queries: string[] = []
  const releases: unknown[] = []
  const client = {
    async query(sql: string) {
      queries.push(sql)
      return { fields: [{ name: "value" }], rows: [{ value: 1 }] }
    },
    release(discard?: boolean) {
      releases.push(discard)
    },
  }
  const admitted = Promise.withResolvers<typeof client>()
  mock.module("pg", () => ({
    default: {
      Pool: class {
        connect() { return admitted.promise }
        async end() {}
      },
    },
  }))
  const connector = await connect({ type: "postgres", query_timeout_ms: 0 })
  await connector.connect()
  return { connector, queries, releases, admit: () => admitted.resolve(client) }
}

test("Postgres abandons an aborted pool acquisition and releases the late client without executing SQL", async () => {
  const db = await queuedDatabase()
  const controller = new AbortController()
  const timeout = new QueryTimeoutError({ engine: "PostgreSQL", timeoutMs: 10 })
  const execution = db.connector.execute("INSERT INTO sentinel VALUES (1)", undefined, undefined, {
    signal: controller.signal,
  }).catch((error) => error)
  controller.abort(timeout)
  try {
    expect(await Promise.race([execution, Bun.sleep(100).then(() => "still queued")])).toBe(timeout)
  } finally {
    db.admit()
    await execution
    await db.connector.close()
  }
  expect(db.queries).toEqual([])
  expect(db.releases).toEqual([undefined])
})

test("Postgres executes a pool client admitted before cancellation", async () => {
  const db = await queuedDatabase()
  const controller = new AbortController()
  try {
    const execution = db.connector.execute("INSERT INTO sentinel VALUES (1)", undefined, undefined, {
      signal: controller.signal,
    })
    db.admit()
    expect((await execution).rows).toEqual([[1]])
    controller.abort()
    expect(db.queries).toEqual(["INSERT INTO sentinel VALUES (1)"])
    expect(db.releases).toEqual([undefined])
  } finally {
    await db.connector.close()
  }
})

test("Postgres never starts user SQL when cancellation arrives during session setup", async () => {
  const queries: string[] = []
  const releases: unknown[] = []
  const setupStarted = Promise.withResolvers<void>()
  const finishSetup = Promise.withResolvers<void>()
  mock.module("pg", () => ({
    default: {
      Pool: class {
        async connect() {
          return {
            async query(sql: string) {
              queries.push(sql)
              if (sql === "SHOW statement_timeout") {
                setupStarted.resolve()
                await finishSetup.promise
                return { fields: [], rows: [{ statement_timeout: "0" }] }
              }
              return { fields: [], rows: [] }
            },
            release(discard?: boolean) { releases.push(discard) },
          }
        }
        async end() {}
      },
    },
  }))
  const connector = await connect({ type: "postgres" })
  await connector.connect()
  const controller = new AbortController()
  const timeout = new QueryTimeoutError({ engine: "PostgreSQL", timeoutMs: 10 })
  try {
    const execution = connector.execute("INSERT INTO sentinel VALUES (1)", undefined, undefined, {
      signal: controller.signal,
      queryTimeoutMs: 10,
    }).catch((error) => error)
    await setupStarted.promise
    controller.abort(timeout)
    finishSetup.resolve()
    expect(await execution).toBe(timeout)
    expect(queries).toEqual(["SHOW statement_timeout", "SET statement_timeout TO 10", "RESET statement_timeout"])
    expect(releases).toEqual([undefined])
  } finally {
    finishSetup.resolve()
    await connector.close()
  }
})
