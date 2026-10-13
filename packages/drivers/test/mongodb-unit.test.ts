import { describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"

// Use the driver's BSON package directly so the MongoDB client mock cannot replace Binary.
const { Binary } = createRequire(import.meta.resolve("mongodb"))("bson")

async function fakeMongo(docs: Record<string, unknown>[] = []) {
  const pipelines: Record<string, unknown>[][] = []
  const counts: { filter: unknown; options: unknown }[] = []
  const distincts: { field: string; filter: unknown; options: unknown }[] = []
  mock.module("mongodb", () => ({
    default: {
      MongoClient: class {
        async connect() {}
        async close() {}
        db() {
          return {
            collection: () => ({
              find: () => ({ limit: () => ({ toArray: async () => docs }) }),
              aggregate: (pipeline: Record<string, unknown>[]) => {
                pipelines.push(pipeline)
                return { toArray: async () => docs }
              },
              countDocuments: async (filter: unknown, options: unknown) => {
                counts.push({ filter, options })
                return 11
              },
              distinct: async (field: string, filter: unknown, options: unknown) => {
                distincts.push({ field, filter, options })
                return ["A"]
              },
            }),
          }
        }
      },
    },
  }))
  const { connect } = await import("../src/mongodb")
  const connector = await connect({ type: "mongodb", database: "test" })
  await connector.connect()
  const query = (command: string, extra: object = {}) => JSON.stringify({ collection: "articles", command, ...extra })
  return { connector, query, pipelines, counts, distincts }
}

describe("MongoDB BSON normalization", () => {
  test.each([
    { name: "raw value API", legacy: false },
    { name: "legacy value API", legacy: true },
  ])("preserves null and high-bit Binary bytes as base64 ($name)", async ({ legacy }) => {
    const bytes = Buffer.from([0x00, 0x80, 0xff])
    const value = new Binary(bytes)
    if (legacy) {
      // Older BSON versions default to a latin1 string; raw=true returns bytes.
      Object.defineProperty(value, "value", { value: (raw?: boolean) => raw ? bytes : bytes.toString("latin1") })
    }
    const { connector, query } = await fakeMongo([{ value }])
    const result = await connector.execute(query("aggregate", { pipeline: [] }))
    expect(result.rows).toEqual([["base64:AID/"]])
  })

  test("preserves distinct same-length Binary values as base64", async () => {
    const { connector, query } = await fakeMongo([
      { value: new Binary(Buffer.from([0, 1, 2, 3])) },
      { value: new Binary(Buffer.from([0, 1, 2, 4])) },
    ])
    const result = await connector.execute(query("aggregate", { pipeline: [] }))
    expect(result.rows).toEqual([["base64:AAECAw=="], ["base64:AAECBA=="]])
    expect(result.rows[0][0]).not.toBe(result.rows[1][0])
    expect(await connector.describeTable("test", "articles")).toMatchObject([{ data_type: "binary" }])
  })

  test("normalizes a subtype 4 Binary to its canonical UUID string and type", async () => {
    const { connector, query } = await fakeMongo([
      { value: new Binary(Buffer.from("00112233445566778899aabbccddeeff", "hex"), Binary.SUBTYPE_UUID) },
    ])
    const result = await connector.execute(query("aggregate", { pipeline: [] }))
    expect(result.rows).toEqual([["00112233-4455-6677-8899-aabbccddeeff"]])
    expect(await connector.describeTable("test", "articles")).toMatchObject([{ data_type: "uuid" }])
  })

  test("normalizes an empty Binary to base64 without spare buffer bytes", async () => {
    const { connector, query } = await fakeMongo([{ value: new Binary() }])
    const result = await connector.execute(query("aggregate", { pipeline: [] }))
    expect(result.rows).toEqual([["base64:"]])
  })

  test("falls back to base64 when a UUID Binary has no toUUID method", async () => {
    const value = new Binary(Buffer.from("00112233445566778899aabbccddeeff", "hex"), Binary.SUBTYPE_UUID)
    Object.defineProperty(value, "toUUID", { value: undefined })
    const { connector, query } = await fakeMongo([{ value }])
    const result = await connector.execute(query("aggregate", { pipeline: [] }))
    expect(result.rows).toEqual([["base64:ABEiM0RVZneImaq7zN3u/w=="]])
  })
})

describe("MongoDB extraction limits", () => {
  test.each([
    { name: "caps a larger user $limit", pipeline: [{ $match: {} }, { $limit: 2_000_000 }] },
    { name: "appends a missing $limit", pipeline: [{ $match: {} }] },
  ])("aggregate $name at the tool limit", async ({ pipeline }) => {
    const docs = Array.from({ length: 11 }, (_, n) => ({ n }))
    const { connector, query, pipelines } = await fakeMongo(docs)
    const result = await connector.execute(query("aggregate", { pipeline }), 10)

    // Fetch one extra document to report truncation, but only return the tool limit.
    expect(pipelines).toEqual([[{ $match: {} }, { $limit: 11 }]])
    expect(result.rows).toEqual(docs.slice(0, 10).map(({ n }) => [n]))
    expect(result.row_count).toBe(10)
    expect(result.truncated).toBe(true)
  })

  test("aggregate preserves a smaller user $limit", async () => {
    const { connector, query, pipelines } = await fakeMongo([{ n: 1 }])
    const result = await connector.execute(query("aggregate", { pipeline: [{ $limit: 1 }] }), 10)
    expect(pipelines).toEqual([[{ $limit: 1 }]])
    expect(result.truncated).toBe(false)
  })

  test("aggregate preserves the bounded preflight count pipeline", async () => {
    const { connector, query, pipelines } = await fakeMongo([{ n: 11 }])
    const pipeline = [{ $match: { category: "news" } }, { $limit: 11 }, { $count: "n" }]
    const result = await connector.execute(query("aggregate", { pipeline }), 11)
    expect(pipelines).toEqual([pipeline])
    expect(result.rows).toEqual([[11]])
  })

  test("countDocuments forwards the count bound, filter, skip and deadline", async () => {
    const { connector, query, counts } = await fakeMongo()
    const result = await connector.execute(
      query("countDocuments", { filter: { category: "news" }, limit: 11, skip: 3 }),
      1,
      undefined,
      { queryTimeoutMs: 250 },
    )
    expect(counts).toEqual([{ filter: { category: "news" }, options: { maxTimeMS: 250, limit: 11, skip: 3 } }])
    expect(result.rows).toEqual([[11]])
  })

  test("countDocuments without an explicit bound still counts all matches", async () => {
    const { connector, query, counts } = await fakeMongo()
    await connector.execute(query("countDocuments"), 1, undefined, { queryTimeoutMs: 0 })
    expect(counts).toEqual([{ filter: {}, options: {} }])
  })
})

describe("MongoDB aggregate write protection", () => {
  for (const writeStage of [{ $merge: { into: "target" } }, { $out: "target" }]) {
    test.each([
      { name: "top-level stages", pipeline: [writeStage] },
      { name: "$unionWith.pipeline", pipeline: [{ $unionWith: { coll: "other", pipeline: [writeStage] } }] },
      { name: "$lookup.pipeline", pipeline: [{ $lookup: { from: "other", as: "joined", pipeline: [writeStage] } }] },
      { name: "$facet branches", pipeline: [{ $facet: { reads: [{ $match: {} }], writes: [writeStage] } }] },
      { name: "nested pipeline arrays", pipeline: [{ $custom: { options: { pipeline: [writeStage] } } }] },
      {
        name: "multiple nested pipelines",
        pipeline: [{ $facet: { joined: [{ $lookup: { from: "other", as: "joined", pipeline: [writeStage] } }] } }],
      },
    ])(`rejects ${Object.keys(writeStage)[0].slice(1)} stage in $name before execution`, async ({ pipeline }) => {
      const { connector, query, pipelines } = await fakeMongo()
      await expect(connector.execute(query("aggregate", { pipeline }), 10)).rejects.toThrow("blocked write stage")
      expect(pipelines).toEqual([])
    })
  }

  test("allows write-stage names inside ordinary literal objects", async () => {
    const { connector, query, pipelines } = await fakeMongo()
    const pipeline = [{ $project: { value: { $literal: { $merge: "value", $out: "value" } } } }]
    await connector.execute(query("aggregate", { pipeline }), 10)
    expect(pipelines).toEqual([[...pipeline, { $limit: 11 }]])
  })
})

describe("MongoDB native command filters", () => {
  test("count forwards the native query filter", async () => {
    const { connector, counts } = await fakeMongo()
    await connector.execute(JSON.stringify({ count: "orders", query: { status: "A" } }), 1, undefined, { queryTimeoutMs: 0 })
    expect(counts).toEqual([{ filter: { status: "A" }, options: {} }])
  })

  test("distinct forwards the native key and query filter", async () => {
    const { connector, distincts } = await fakeMongo()
    const result = await connector.execute(
      JSON.stringify({ distinct: "orders", key: "status", query: { customer: 42 } }),
      10,
      undefined,
      { queryTimeoutMs: 0 },
    )
    expect(distincts).toEqual([{ field: "status", filter: { customer: 42 }, options: {} }])
    expect(result.rows).toEqual([["A"]])
  })

  test("an explicit filter takes precedence over the native query alias", async () => {
    const { connector, counts } = await fakeMongo()
    await connector.execute(JSON.stringify({ count: "orders", query: { status: "A" }, filter: { status: "B" } }), 1, undefined, { queryTimeoutMs: 0 })
    expect(counts).toEqual([{ filter: { status: "B" }, options: {} }])
  })
})
