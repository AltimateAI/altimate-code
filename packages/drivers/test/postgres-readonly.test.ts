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
    expect(queries).toEqual(["SHOW statement_timeout"])
    expect(releases).toEqual([true])
  } finally {
    finishSetup.resolve()
    await connector.close()
  }
})

async function probeDatabase() {
  const queries: string[] = []
  const releases: unknown[] = []
  const started = Promise.withResolvers<void>()
  const shown = Promise.withResolvers<{ fields: never[]; rows: { statement_timeout: string }[] }>()
  mock.module("pg", () => ({
    default: {
      Pool: class {
        async connect() {
          return {
            async query(sql: string) {
              queries.push(sql)
              if (sql === "SHOW statement_timeout") {
                started.resolve()
                return shown.promise
              }
              return { fields: [{ name: "value" }], rows: [{ value: 1 }] }
            },
            release(discard?: boolean) { releases.push(discard) },
          }
        }
        async end() {}
      },
    },
  }))
  const connector = await connect({ type: "postgres", query_timeout_ms: 1000 })
  await connector.connect()
  return { connector, queries, releases, started: started.promise, shown }
}

for (const pgTimeoutReason of [false, true]) {
  test(`Postgres abandons a stalled initial timeout probe with the exact ${pgTimeoutReason ? "PostgreSQL-shaped" : "caller"} abort reason`, async () => {
    const db = await probeDatabase()
    const controller = new AbortController()
    const reason = pgTimeoutReason
      ? Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })
      : new Error("caller deadline expired")
    const execution = db.connector.execute("INSERT INTO sentinel VALUES (1)", undefined, undefined, {
      signal: controller.signal,
    }).catch((error) => error)
    try {
      await db.started
      controller.abort(reason)
      expect(await Promise.race([execution, Bun.sleep(100).then(() => "still probing")])).toBe(reason)
      expect(db.queries).toEqual(["SHOW statement_timeout"])
      expect(db.releases).toEqual([true])
    } finally {
      await db.connector.close()
    }
  })
}

test("Postgres abandons a stalled initial timeout probe at the resolved deadline without a signal", async () => {
  const db = await probeDatabase()
  try {
    const execution = db.connector.execute("INSERT INTO sentinel VALUES (1)", undefined, undefined, {
      queryTimeoutMs: 10,
    }).catch((error) => error)
    await db.started
    const error = await Promise.race([execution, Bun.sleep(100).then(() => "still probing")])
    expect(error).toBeInstanceOf(QueryTimeoutError)
    expect(error.timeoutMs).toBe(10)
    expect(db.queries).toEqual(["SHOW statement_timeout"])
    expect(db.releases).toEqual([true])
  } finally {
    await db.connector.close()
  }
})

test("Postgres executes user SQL after a fast initial timeout probe", async () => {
  const db = await probeDatabase()
  const controller = new AbortController()
  try {
    db.shown.resolve({ fields: [], rows: [{ statement_timeout: "0" }] })
    const result = await db.connector.execute("INSERT INTO sentinel VALUES (1)", undefined, undefined, {
      signal: controller.signal,
      queryTimeoutMs: 10,
    })
    expect(result.rows).toEqual([[1]])
    controller.abort(new Error("after completion"))
    expect(db.queries).toEqual([
      "SHOW statement_timeout",
      "SET statement_timeout TO 10",
      "INSERT INTO sentinel VALUES (1)",
      "RESET statement_timeout",
    ])
    expect(db.releases).toEqual([undefined])
  } finally {
    await db.connector.close()
  }
})

async function timeoutDatabase() {
  const queries: string[] = []
  let statementTimeout = "1s"
  const client = {
    async query(sql: string) {
      queries.push(sql)
      if (sql === "SHOW statement_timeout") {
        return { fields: [], rows: [{ statement_timeout: statementTimeout }] }
      }
      const set = /^SET statement_timeout (?:=|TO) (\d+)$/i.exec(sql)
      if (set) statementTimeout = set[1]!
      else if (/^(RESET statement_timeout|RESET ALL|DISCARD ALL)$/i.test(sql)) statementTimeout = "0"
      return { fields: [], rows: [] }
    },
    release() {},
  }
  mock.module("pg", () => ({
    default: {
      Pool: class {
        async connect() {
          return client
        }
        async end() {}
      },
    },
  }))
  const connector = await connect({ type: "postgres" })
  await connector.connect()
  const execute = (sql: string) => connector.execute(sql, 1, undefined, { queryTimeoutMs: 5000 })
  return { connector, execute, queries }
}

test("Postgres preserves a stricter cached statement timeout for ordinary queries", async () => {
  const db = await timeoutDatabase()
  try {
    await db.execute("SELECT 1")
    await db.execute("SELECT 2")
    expect(db.queries).toEqual(["SHOW statement_timeout", "SELECT 1 LIMIT 2", "SELECT 2 LIMIT 2"])
  } finally {
    await db.connector.close()
  }
})

for (const statement of ["SET STATEMENT_TIMEOUT = 0", "RESET statement_timeout", "RESET ALL", "discard all"]) {
  test(`Postgres rechecks a stricter cached timeout after ${statement}`, async () => {
    const db = await timeoutDatabase()
    try {
      await db.execute("SELECT 1")
      expect(db.queries).toEqual(["SHOW statement_timeout", "SELECT 1 LIMIT 2"])
      await db.execute(statement)
      await db.execute("SELECT 2")
      expect(db.queries).toEqual([
        "SHOW statement_timeout",
        "SELECT 1 LIMIT 2",
        statement,
        "SHOW statement_timeout",
        "SET statement_timeout TO 5000",
        "SELECT 2 LIMIT 2",
        "RESET statement_timeout",
      ])
    } finally {
      await db.connector.close()
    }
  })
}
