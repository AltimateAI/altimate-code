// altimate_change start — regression coverage for MongoDB write deadlines (4252054136)
import { describe, expect, mock, test } from "bun:test"
import { QueryTimeoutError } from "../src/types"

async function fakeMongo(queryTimeoutMs?: number | null, failWith?: Error) {
  const seen: Record<string, unknown> = {}
  function write(name: string, options: unknown, result: unknown) {
    seen[name] = options
    if (failWith) throw failWith
    return result
  }
  const coll = {
    insertOne: async (_doc: unknown, options: unknown) => write("insertOne", options, { insertedId: "id" }),
    insertMany: async (_docs: unknown, options: unknown) => write("insertMany", options, { insertedCount: 1 }),
    updateOne: async (_filter: unknown, _update: unknown, options: unknown) =>
      write("updateOne", options, { matchedCount: 1, modifiedCount: 1 }),
    updateMany: async (_filter: unknown, _update: unknown, options: unknown) =>
      write("updateMany", options, { matchedCount: 1, modifiedCount: 1 }),
    deleteOne: async (_filter: unknown, options: unknown) => write("deleteOne", options, { deletedCount: 1 }),
    deleteMany: async (_filter: unknown, options: unknown) => write("deleteMany", options, { deletedCount: 1 }),
    createIndex: async (_keys: unknown, options: unknown) => write("createIndex", options, "a_1"),
    drop: async (options: unknown) => write("dropCollection", options, true),
  }
  mock.module("mongodb", () => ({
    default: {
      MongoClient: class {
        async connect() {}
        async close() {}
        db() {
          return {
            collection: () => coll,
            createCollection: async (_name: unknown, options: unknown) => write("createCollection", options, {}),
          }
        }
      },
    },
  }))
  const { connect } = await import("../src/mongodb")
  const connector = await connect({ type: "mongodb", database: "test", query_timeout_ms: queryTimeoutMs })
  await connector.connect()
  return { connector, seen }
}

const writes = [
  ["insertOne", { document: { a: 1 } }],
  ["insertMany", { documents: [{ a: 1 }] }],
  ["updateOne", { filter: { a: 1 }, update: { $set: { a: 2 } } }],
  ["updateMany", { filter: { a: 1 }, update: { $set: { a: 2 } } }],
  ["deleteOne", { filter: { a: 1 } }],
  ["deleteMany", { filter: { a: 1 } }],
  ["createCollection", { options: { capped: true, size: 1024 } }],
  ["dropCollection", {}],
  ["createIndex", { keys: { a: 1 }, options: { unique: true } }],
] as const

describe.each(writes)("MongoDB %s write deadline", (command, extra) => {
  const query = JSON.stringify({ collection: "users", command, ...extra })
  const preservedOptions = "options" in extra ? extra.options : {}

  // Each fixture replaces the global MongoDB module mock, so these tests must run serially.
  test.serial("forwards the default maxTimeMS and preserves command options", async () => {
    const { connector, seen } = await fakeMongo()
    await connector.execute(query)
    expect(seen[command]).toEqual({ ...preservedOptions, maxTimeMS: 120_000 })
    await connector.close()
  })

  test.serial("honours connection and per-call deadlines", async () => {
    const { connector, seen } = await fakeMongo(4000)
    await connector.execute(query)
    expect(seen[command]).toEqual({ ...preservedOptions, maxTimeMS: 4000 })
    await connector.execute(query, undefined, undefined, { queryTimeoutMs: 250 })
    expect(seen[command]).toEqual({ ...preservedOptions, maxTimeMS: 250 })
    await connector.execute(query, undefined, undefined, { queryTimeoutMs: 0 })
    expect(seen[command]).toEqual(preservedOptions)
    await connector.close()
  })

  test.serial("omits maxTimeMS when the connection deadline is disabled", async () => {
    for (const disabled of [0, null]) {
      const { connector, seen } = await fakeMongo(disabled)
      await connector.execute(query)
      expect(seen[command]).toEqual(preservedOptions)
      await connector.close()
    }
  })

  test.serial("normalizes a server write timeout to QUERY_TIMEOUT", async () => {
    const error = Object.assign(new Error("operation exceeded time limit"), { code: 50, codeName: "MaxTimeMSExpired" })
    const { connector, seen } = await fakeMongo(900, error)
    const caught = await connector.execute(query).catch((err) => err)
    expect(caught).toBeInstanceOf(QueryTimeoutError)
    expect(caught).toMatchObject({ code: "QUERY_TIMEOUT", engine: "MongoDB", timeoutMs: 900, cancelled: true })
    expect(seen[command]).toEqual({ ...preservedOptions, maxTimeMS: 900 })
    await connector.close()
  })
})
// altimate_change end
