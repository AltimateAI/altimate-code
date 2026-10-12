import { expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { connect as connectPostgres } from "../src/postgres"
import { connect as connectMongo } from "../src/mongodb"

// Use pg's real row parser and accumulation behavior while replacing only transport/pooling.
// Import its implementation directly so other tests' pg module mocks cannot replace it.
const { default: Query } = await import(join(dirname(createRequire(import.meta.url).resolve("pg")), "query.js"))

async function postgres(rows: unknown[][]) {
  const queries: string[] = []
  const releases: unknown[] = []
  let consumed = 0
  let discarded = false
  let stream: any
  const fields = [{ name: "value", dataTypeID: 25, format: "text" }]
  const client = {
    query(query: any) {
      queries.push(typeof query === "string" ? query : query.text)
      if (typeof query === "string") {
        if (!query.startsWith("SELECT")) return Promise.resolve({ fields: [], rows: [] })
        consumed = rows.length
        return Promise.resolve({ fields, rows: rows.map(([value]) => ({ value })) })
      }
      stream = query
      queueMicrotask(() => {
        query.handleRowDescription({ fields })
        for (const row of rows) {
          if (discarded) return
          consumed++
          query.handleDataRow({ fields: row })
        }
        query.handleReadyForQuery({})
      })
      return query
    },
    release(discard?: boolean) {
      releases.push(discard)
      discarded = Boolean(discard)
    },
  }
  mock.module("pg", () => ({
    default: {
      Query,
      Pool: class {
        async connect() {
          return client
        }
        async end() {}
      },
    },
  }))
  const connector = await connectPostgres({ type: "postgres" })
  await connector.connect()
  return { connector, queries, releases, consumed: () => consumed, bufferedRows: () => stream?._result.rows.length }
}

test("Postgres stops row delivery and discards the client when extraction exceeds maxResultBytes", async () => {
  const db = await postgres([["a"], ["x".repeat(100)], ["must not be fetched"]])
  try {
    await expect(
      db.connector.execute("SELECT value FROM source", 100, undefined, {
        queryTimeoutMs: 0,
        readOnly: true,
        maxResultBytes: 20,
      }),
    ).rejects.toMatchObject({ code: "RESULT_BYTE_LIMIT" })
    expect(db.consumed()).toBe(2)
    expect(db.bufferedRows()).toBe(0)
    expect(db.releases).toEqual([true])
    expect(db.queries).toEqual(["BEGIN READ ONLY", "SELECT value FROM source LIMIT 101"])
  } finally {
    await db.connector.close()
  }
})

test("Postgres bounded extraction preserves rows and rolls back a successful read-only transaction", async () => {
  const db = await postgres([["a"], ["b"]])
  try {
    const result = await db.connector.execute("SELECT value FROM source", 100, undefined, {
      queryTimeoutMs: 0,
      readOnly: true,
      maxResultBytes: 20,
    })
    expect(result).toEqual({ columns: ["value"], rows: [["a"], ["b"]], row_count: 2, truncated: false })
    expect(db.connector.supportsResultByteLimit).toBe(true)
    expect(db.bufferedRows()).toBe(0)
    expect(db.queries.at(-1)).toBe("ROLLBACK")
    expect(db.releases).toEqual([undefined])
  } finally {
    await db.connector.close()
  }
})

async function mongo(docs: Record<string, unknown>[]) {
  let consumed = 0
  let closed = false
  let batchSize: number | undefined
  const cursor = {
    limit() {
      return this
    },
    batchSize(size: number) {
      batchSize = size
      return this
    },
    async toArray() {
      consumed = docs.length
      return docs
    },
    async close() {
      closed = true
    },
    async *[Symbol.asyncIterator]() {
      for (const doc of docs) {
        if (closed) return
        consumed++
        yield doc
      }
    },
  }
  mock.module("mongodb", () => ({
    default: {
      MongoClient: class {
        async connect() {}
        async close() {}
        db() {
          return { collection: () => ({ find: () => cursor, aggregate: () => cursor }) }
        }
      },
    },
  }))
  const connector = await connectMongo({ type: "mongodb" })
  await connector.connect()
  return { connector, consumed: () => consumed, closed: () => closed, batchSize: () => batchSize }
}

test.each(["find", "aggregate"])("Mongo %s closes the cursor before fetching past maxResultBytes", async (command) => {
  const db = await mongo([{ value: "a" }, { value: "x".repeat(100) }, { value: "must not be fetched" }])
  try {
    await expect(
      db.connector.execute(JSON.stringify({ command, collection: "source", pipeline: [] }), 100, undefined, {
        queryTimeoutMs: 0,
        maxResultBytes: 20,
      }),
    ).rejects.toMatchObject({ code: "RESULT_BYTE_LIMIT" })
    expect(db.consumed()).toBe(2)
    expect(db.closed()).toBe(true)
    expect(db.batchSize()).toBe(1)
  } finally {
    await db.connector.close()
  }
})

test("Mongo bounded extraction counts null padding introduced by heterogeneous document columns", async () => {
  const db = await mongo([{ a: 1 }, { b: 2 }])
  try {
    await expect(
      db.connector.execute(JSON.stringify({ command: "find", collection: "source" }), 100, undefined, {
        queryTimeoutMs: 0,
        maxResultBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "RESULT_BYTE_LIMIT" })
    expect(db.closed()).toBe(true)
  } finally {
    await db.connector.close()
  }
})

test("Mongo bounded extraction preserves ordinary tabular values", async () => {
  const db = await mongo([{ value: "a" }, { value: "b" }])
  try {
    const result = await db.connector.execute(
      JSON.stringify({ command: "find", collection: "source" }),
      100,
      undefined,
      {
        queryTimeoutMs: 0,
        maxResultBytes: 20,
      },
    )
    expect(result).toEqual({ columns: ["value"], rows: [["a"], ["b"]], row_count: 2, truncated: false })
    expect(db.connector.supportsResultByteLimit).toBe(true)
    expect(db.closed()).toBe(true)
  } finally {
    await db.connector.close()
  }
})
