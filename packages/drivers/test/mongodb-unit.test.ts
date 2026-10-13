import { describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { normalizeMqlCommand } from "../src/mongodb"

// Use the driver's BSON package directly so the MongoDB client mock cannot replace Binary.
const { Binary } = createRequire(import.meta.resolve("mongodb"))("bson")

async function fakeMongo(docs: Record<string, unknown>[] = []) {
  const finds: unknown[] = []
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
              find: (filter: unknown) => {
                finds.push(filter)
                return { limit: () => ({ toArray: async () => docs }) }
              },
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
  return { connector, query, finds, pipelines, counts, distincts }
}

describe("normalizeMqlCommand bounds", () => {
  const forms = [
    { name: "string-form", input: (bounds: object) => JSON.parse(JSON.stringify({ find: "events", ...bounds })) },
    { name: "object-form", input: (bounds: object) => ({ find: "events", ...bounds }) },
    { name: "explicit command-form", input: (bounds: object) => ({ command: "find", collection: "events", ...bounds }) },
  ]

  for (const { name, input } of forms) {
    test.each([
      { name: "limit: -1", bounds: { limit: -1 }, error: "MongoDB find limit must be a positive integer" },
      { name: "limit: 1.5", bounds: { limit: 1.5 }, error: "MongoDB find limit must be a positive integer" },
      { name: "unsafe limit", bounds: { limit: Number.MAX_SAFE_INTEGER + 1 }, error: "MongoDB find limit must be a positive integer" },
      { name: "string limit", bounds: { limit: "5" }, error: "MongoDB find limit must be a positive integer" },
      { name: "null limit", bounds: { limit: null }, error: "MongoDB find limit must be a positive integer" },
      { name: "skip: -3", bounds: { skip: -3 }, error: "MongoDB find skip must be a non-negative integer" },
      { name: "skip: 1.5", bounds: { skip: 1.5 }, error: "MongoDB find skip must be a non-negative integer" },
      { name: "unsafe skip", bounds: { skip: Number.MAX_SAFE_INTEGER + 1 }, error: "MongoDB find skip must be a non-negative integer" },
    ])(`rejects $name in ${name}`, ({ bounds, error }) => {
      expect(() => normalizeMqlCommand(input(bounds))).toThrow(error)
    })

    test.each([0, 5])(`preserves limit: %i and skip: 0 in ${name}`, (limit) => {
      expect(normalizeMqlCommand(input({ limit, skip: 0 }))).toEqual({
        command: "find", collection: "events", limit, skip: 0,
      })
    })
  }

  test.each(["aggregate", "countDocuments"])("validates top-level limit and skip for %s", (command) => {
    for (const bounds of [{ limit: -1 }, { limit: 1.5 }, { skip: -3 }]) {
      const field = "limit" in bounds ? "limit" : "skip"
      const rule = field === "limit" ? "a positive" : "a non-negative"
      expect(() => normalizeMqlCommand({ command, collection: "events", pipeline: [], ...bounds })).toThrow(
        `MongoDB ${command} ${field} must be ${rule} integer`,
      )
    }
  })

  test.each([
    { name: "$limit: -1", stage: { $limit: -1 }, error: "MongoDB aggregate $limit must be a positive integer" },
    { name: "$limit: 0", stage: { $limit: 0 }, error: "MongoDB aggregate $limit must be a positive integer" },
    { name: "$limit: 1.5", stage: { $limit: 1.5 }, error: "MongoDB aggregate $limit must be a positive integer" },
    { name: "unsafe $limit", stage: { $limit: Number.MAX_SAFE_INTEGER + 1 }, error: "MongoDB aggregate $limit must be a positive integer" },
    { name: "$skip: -3", stage: { $skip: -3 }, error: "MongoDB aggregate $skip must be a non-negative integer" },
    { name: "$skip: 1.5", stage: { $skip: 1.5 }, error: "MongoDB aggregate $skip must be a non-negative integer" },
  ])("rejects aggregate pipeline $name", ({ stage, error }) => {
    expect(() => normalizeMqlCommand({ aggregate: "events", pipeline: [stage] })).toThrow(error)
  })

  test("preserves valid aggregate pipeline bounds", () => {
    const pipeline = [{ $skip: 0 }, { $limit: 5 }]
    expect(normalizeMqlCommand({ aggregate: "events", pipeline })).toEqual({
      command: "aggregate", collection: "events", pipeline,
    })
  })

  test("rejects invalid bounds before opening find or aggregate cursors", async () => {
    const { connector, finds, pipelines } = await fakeMongo()
    await expect(connector.execute(JSON.stringify({ find: "events", limit: -1 }))).rejects.toThrow(
      "MongoDB find limit must be a positive integer",
    )
    await expect(connector.execute(JSON.stringify({ aggregate: "events", pipeline: [{ $skip: -3 }] }))).rejects.toThrow(
      "MongoDB aggregate $skip must be a non-negative integer",
    )
    expect(finds).toEqual([])
    expect(pipelines).toEqual([])
  })
})

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
