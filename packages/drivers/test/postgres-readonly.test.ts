import { expect, mock, test } from "bun:test"
import { connect } from "../src/postgres"

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
