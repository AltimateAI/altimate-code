import { describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { normalizeMqlCommand } from "../src/mongodb"
import { restoreModuleMocksAfterTests } from "./module-mock"

await restoreModuleMocksAfterTests("mongodb")

// Use the driver's BSON package directly so the MongoDB client mock cannot replace Binary.
const { Binary } = createRequire(import.meta.resolve("mongodb"))("bson")

async function fakeMongo(
  docs?: Record<string, unknown>[],
  metadata: { collections?: Record<string, string[]>; error?: Error } = {},
) {
  const finds: unknown[] = []
  const pipelines: Record<string, unknown>[][] = []
  const aggregateOptions: unknown[] = []
  const counts: { filter: unknown; options: unknown }[] = []
  const distincts: { field: string; filter: unknown; options: unknown }[] = []
  const collections = metadata.collections ?? { test: ["articles", "orders"], archive: [] }
  const collectionLists: { database: string; options: unknown }[] = []
  const databaseLists: unknown[] = []
  const estimates: unknown[] = []
  mock.module("mongodb", () => ({
    default: {
      MongoClient: class {
        async connect() {}
        async close() {}
        db(database = "test") {
          return {
            databaseName: database,
            admin: () => ({
              listDatabases: async (options: unknown) => {
                databaseLists.push(options)
                if (metadata.error) throw metadata.error
                return { databases: Object.keys(collections).map((name) => ({ name })) }
              },
            }),
            listCollections: (filter: { name?: string }, options: unknown) => ({
              toArray: async () => {
                collectionLists.push({ database, options })
                if (metadata.error) throw metadata.error
                return (collections[database] ?? [])
                  .filter((name) => !filter.name || name === filter.name)
                  .map((name) => ({ name, type: "collection" }))
              },
            }),
            createCollection: async (name: string) => {
              collections[database] ??= []
              collections[database].push(name)
            },
            collection: () => ({
              find: (filter: unknown) => {
                finds.push(filter)
                return { limit: () => ({ toArray: async () => docs ?? [], async *[Symbol.asyncIterator]() { yield* docs ?? [] } }) }
              },
              aggregate: (pipeline: Record<string, unknown>[], options: unknown) => {
                pipelines.push(pipeline)
                aggregateOptions.push(options)
                return { toArray: async () => docs ?? [], async *[Symbol.asyncIterator]() { yield* docs ?? [] } }
              },
              countDocuments: async (filter: Record<string, unknown>, options: unknown) => {
                counts.push({ filter, options })
                return docs?.filter((doc) => Object.entries(filter).every(([key, value]) => doc[key] === value)).length ?? 11
              },
              estimatedDocumentCount: async (options: unknown) => {
                estimates.push(options)
                return 13
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
  return { connector, query, collections, finds, pipelines, aggregateOptions, counts, distincts, collectionLists, databaseLists, estimates }
}

describe("MongoDB read command shapes", () => {
  test.each([null, [], 1, "find"].map((value) => ({ value })))("rejects a non-object query: $value", async ({ value }) => {
    const { connector } = await fakeMongo()
    await expect(connector.execute(JSON.stringify(value))).rejects.toThrow("MQL query must be a JSON command object")
  })

  test("collection and find filter execute like the explicit command", async () => {
    const { connector, query, finds } = await fakeMongo([{ a: 1 }])
    const filter = { a: 1 }
    const expected = await connector.execute(query("find", { filter }))
    expect(await connector.execute(JSON.stringify({ collection: "articles", find: filter }))).toEqual(expected)
    expect(finds).toEqual([filter, filter])
  })

  test("collection and aggregate pipeline execute like the explicit command", async () => {
    const { connector, query, pipelines } = await fakeMongo([{ a: 1 }])
    const pipeline = [{ $match: { a: 1 } }]
    const expected = await connector.execute(query("aggregate", { pipeline }))
    expect(await connector.execute(JSON.stringify({ collection: "articles", aggregate: pipeline }))).toEqual(expected)
    expect(pipelines[0]).toEqual(pipelines[1])
  })

  test.each(["listCollections", "estimatedDocumentCount"])("executes native and explicit %s", async (command) => {
    const { connector, estimates } = await fakeMongo()
    const native = command === "listCollections" ? { listCollections: 1 } : { estimatedDocumentCount: "articles" }
    const explicit = { command, ...(command === "listCollections" ? {} : { collection: "articles" }) }
    const expected = await connector.execute(JSON.stringify(explicit), 10, undefined, { queryTimeoutMs: 250 })
    expect(await connector.execute(JSON.stringify(native), 10, undefined, { queryTimeoutMs: 250 })).toEqual(expected)
    expect(expected.rows).toEqual(command === "listCollections" ? [["articles", "collection"], ["orders", "collection"]] : [[13]])
    if (command === "estimatedDocumentCount") expect(estimates).toEqual([{ maxTimeMS: 250 }, { maxTimeMS: 250 }])
  })

  test("listCollections honors its filter and row cap", async () => {
    const { connector } = await fakeMongo()
    expect(await connector.execute(JSON.stringify({ listCollections: 1 }), 1)).toMatchObject({
      rows: [["articles", "collection"]], row_count: 1, truncated: true,
    })
    expect(await connector.execute(JSON.stringify({ listCollections: 1, filter: { name: "orders" } }), 1)).toMatchObject({
      rows: [["orders", "collection"]], row_count: 1, truncated: false,
    })
  })
})

describe("MongoDB read namespace validation", () => {
  test("wrong database lists available databases before opening a cursor", async () => {
    const { connector, query, finds } = await fakeMongo()
    await expect(connector.execute(query("find", { database: "missing" }))).rejects.toThrow(
      'MongoDB database "missing" does not exist or is not accessible. Available databases: archive, test',
    )
    expect(finds).toEqual([])
  })

  test("wrong collection lists available collections before opening a cursor", async () => {
    const { connector, query, finds } = await fakeMongo()
    await expect(connector.execute(query("find", { collection: "missing" }))).rejects.toThrow(
      'MongoDB collection "missing" does not exist or is not accessible in database "test". Available collections: articles, orders',
    )
    expect(finds).toEqual([])
  })

  test("existing empty collections still return a legitimate empty result", async () => {
    const { connector, query } = await fakeMongo()
    expect(await connector.execute(query("find"))).toEqual({ columns: [], rows: [], row_count: 0, truncated: false })
  })

  test("caches authorized collection metadata without requiring database listing for populated databases", async () => {
    const { connector, query, collectionLists, databaseLists } = await fakeMongo()
    await connector.execute(query("find"), undefined, undefined, { queryTimeoutMs: 250 })
    await connector.execute(query("countDocuments"))
    expect(collectionLists).toEqual([{
      database: "test", options: { nameOnly: true, authorizedCollections: true, maxTimeMS: 250 },
    }])
    expect(databaseLists).toEqual([])
  })

  test("a collection created by another client is found after one re-list", async () => {
    const { connector, query, collections, collectionLists } = await fakeMongo()
    await connector.execute(query("find"))
    collections.test.push("late")
    await connector.execute(query("find", { collection: "late" }))
    expect(collectionLists).toHaveLength(2)
  })

  test("an existing empty database can list its collections", async () => {
    const { connector, databaseLists } = await fakeMongo()
    expect(await connector.execute(JSON.stringify({ command: "listCollections", database: "archive" }))).toEqual({
      columns: ["name", "type"], rows: [], row_count: 0, truncated: false,
    })
    expect(databaseLists).toEqual([{ nameOnly: true, authorizedDatabases: true, maxTimeMS: 120_000 }])
  })

  test("metadata failures cannot become an empty read", async () => {
    const { connector, query, finds } = await fakeMongo([], { error: new Error("metadata unavailable") })
    await expect(connector.execute(query("find"))).rejects.toThrow("metadata unavailable")
    expect(finds).toEqual([])
  })

  test("writes invalidate cached names and may create a collection", async () => {
    const { connector, query, collectionLists } = await fakeMongo()
    await connector.execute(query("find"))
    await connector.execute(query("createCollection", { collection: "new_items" }))
    await connector.execute(query("find", { collection: "new_items" }))
    expect(collectionLists).toHaveLength(2)
  })

  test("reconnecting clears cached metadata", async () => {
    const { connector, query, collectionLists } = await fakeMongo()
    await connector.execute(query("find"))
    await connector.close()
    await connector.connect()
    await connector.execute(query("find"))
    expect(collectionLists).toHaveLength(2)
  })
})

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
    expect(pipelines).toEqual([[...pipeline, { $limit: 11 }]])
    expect(result.rows).toEqual(docs.slice(0, 10).map(({ n }) => [n]))
    expect(result.row_count).toBe(10)
    expect(result.truncated).toBe(true)
  })

  test("aggregate appends a terminal cap after $limit 5 followed by $unwind", async () => {
    const { connector, query, pipelines } = await fakeMongo()
    const pipeline = [{ $limit: 5 }, { $unwind: "$items" }]
    await connector.execute(query("aggregate", { pipeline }), 100)
    expect(pipelines).toEqual([[...pipeline, { $limit: 101 }]])
  })

  test("aggregate preserves a terminal $limit 3 with cap 100", async () => {
    const { connector, query, pipelines } = await fakeMongo([{ n: 1 }])
    const result = await connector.execute(query("aggregate", { pipeline: [{ $limit: 3 }] }), 100)
    expect(pipelines).toEqual([[{ $limit: 3 }]])
    expect(result.truncated).toBe(false)
  })

  test("aggregate appends a terminal cap to the bounded preflight count pipeline", async () => {
    const { connector, query, pipelines } = await fakeMongo([{ n: 11 }])
    const pipeline = [{ $match: { category: "news" } }, { $limit: 11 }, { $count: "n" }]
    const result = await connector.execute(query("aggregate", { pipeline }), 11)
    expect(pipelines).toEqual([[...pipeline, { $limit: 12 }]])
    expect(result.rows).toEqual([[11]])
  })

  test("distinct uses a bounded aggregate with the filter and deadline and reports truncation", async () => {
    const docs = [{ _id: "A" }, { _id: "B" }, { _id: "C" }]
    const { connector, query, pipelines, aggregateOptions, distincts } = await fakeMongo(docs)
    const result = await connector.execute(
      query("distinct", { field: "status", filter: { customer: 42 } }),
      2,
      undefined,
      { queryTimeoutMs: 250 },
    )
    expect(pipelines).toEqual([
      [
        { $match: { customer: 42 } },
        { $match: { status: { $exists: true, $ne: [] } } },
        { $unwind: { path: "$status", preserveNullAndEmptyArrays: true } },
        { $group: { _id: "$status" } },
        { $limit: 3 },
      ],
    ])
    expect(aggregateOptions).toEqual([{ maxTimeMS: 250 }])
    expect(distincts).toEqual([])
    expect(result).toEqual({ columns: ["status"], rows: [["A"], ["B"]], row_count: 2, truncated: true })
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
    expect(counts).toEqual([{ filter: {}, options: { maxTimeMS: 120_000 } }])
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
  test("count command alias counts only documents matching the query filter", async () => {
    const { connector, counts } = await fakeMongo([{ status: "A" }, { status: "B" }, { status: "A" }])
    const result = await connector.execute(
      JSON.stringify({ command: "count", collection: "orders", query: { status: "A" } }),
      1,
      undefined,
      { queryTimeoutMs: 0 },
    )
    expect(result.rows).toEqual([[2]])
    expect(counts).toEqual([{ filter: { status: "A" }, options: { maxTimeMS: 120_000 } }])
  })

  test("count forwards the native query filter", async () => {
    const { connector, counts } = await fakeMongo()
    await connector.execute(JSON.stringify({ count: "orders", query: { status: "A" } }), 1, undefined, { queryTimeoutMs: 0 })
    expect(counts).toEqual([{ filter: { status: "A" }, options: { maxTimeMS: 120_000 } }])
  })

  test("distinct forwards the native key and query filter", async () => {
    const { connector, pipelines, aggregateOptions } = await fakeMongo([{ _id: "A" }])
    const result = await connector.execute(
      JSON.stringify({ distinct: "orders", key: "status", query: { customer: 42 } }),
      10,
      undefined,
      { queryTimeoutMs: 0 },
    )
    expect(pipelines).toEqual([
      [
        { $match: { customer: 42 } },
        { $match: { status: { $exists: true, $ne: [] } } },
        { $unwind: { path: "$status", preserveNullAndEmptyArrays: true } },
        { $group: { _id: "$status" } },
        { $limit: 11 },
      ],
    ])
    expect(aggregateOptions).toEqual([{ maxTimeMS: 120_000 }])
    expect(result.rows).toEqual([["A"]])
  })

  test("an explicit filter takes precedence over the native query alias", async () => {
    const { connector, counts } = await fakeMongo()
    await connector.execute(JSON.stringify({ count: "orders", query: { status: "A" }, filter: { status: "B" } }), 1, undefined, { queryTimeoutMs: 0 })
    expect(counts).toEqual([{ filter: { status: "B" }, options: { maxTimeMS: 120_000 } }])
  })
})

describe("MongoDB collection command shorthand", () => {
  test.each([
    { name: "key", aliases: { key: "status" } },
    { name: "field", aliases: { field: "status" } },
    { name: "field with an agreeing key", aliases: { key: "category", field: "status" } },
    { name: "key with an agreeing field", aliases: { key: "status", field: "category" } },
  ])("refuses ambiguous distinct form with conflicting $name and names both values", ({ aliases }) => {
    expect(() => normalizeMqlCommand({ collection: "items", distinct: "category", ...aliases })).toThrow(
      /ambiguous distinct form.*category.*status/i,
    )
  })

  test("normalizes distinct-as-field shorthand without changing the collection", () => {
    expect(normalizeMqlCommand({ collection: "items", distinct: "category" })).toEqual({
      collection: "items",
      command: "distinct",
      field: "category",
    })
  })

  test.each([
    { name: "key", aliases: { key: "category" } },
    { name: "field", aliases: { field: "category" } },
    { name: "key and field", aliases: { key: "category", field: "category" } },
  ])("accepts distinct shorthand with agreeing $name", ({ aliases }) => {
    const normalized = normalizeMqlCommand({ collection: "items", distinct: "category", ...aliases })
    expect(normalized).toMatchObject({ collection: "items", command: "distinct", field: "category" })
    expect(normalized).not.toHaveProperty("distinct")
  })

  test.each([
    { collection: "items", find: "other" },
    { collection: "", distinct: "category", key: "category" },
    { collection: null, distinct: "category", key: "category" },
  ])("does not fall through to native parsing when collection is present: %j", (input) => {
    expect(normalizeMqlCommand(input)).toEqual(input)
  })

  test.each([
    { name: "find and filter", input: { collection: "items", find: { status: "x" }, filter: { status: "y" } } },
    { name: "count and query", input: { collection: "items", count: { status: "x" }, query: { status: "y" } } },
    { name: "distinct and field", input: { collection: "items", distinct: "status", field: "category" } },
  ])("refuses conflicting $name arguments", ({ input }) => {
    expect(() => normalizeMqlCommand(input)).toThrow(/ambiguous.*conflict/i)
  })

  test("accepts equivalent embedded and explicit filters regardless of key order", () => {
    expect(normalizeMqlCommand({
      collection: "items",
      find: { status: "x", active: true },
      filter: { active: true, status: "x" },
    })).toEqual({
      collection: "items",
      command: "find",
      filter: { active: true, status: "x" },
    })
  })

  test("normalizes a collection with an embedded find filter and projection", () => {
    const command = {
      collection: "articles",
      find: {},
      projection: { _id: 0, article_id: 1, title: 1, description: 1 },
    }
    expect(normalizeMqlCommand(command)).toEqual({
      collection: "articles",
      command: "find",
      filter: {},
      projection: command.projection,
    })
  })

  test.each([
    [
      { collection: "items", aggregate: [{ $match: { active: true } }] },
      { collection: "items", command: "aggregate", pipeline: [{ $match: { active: true } }] },
    ],
    [
      { collection: "items", count: { active: true } },
      { collection: "items", command: "countDocuments", filter: { active: true } },
    ],
    [
      { collection: "items", distinct: "category", query: { active: true } },
      {
        collection: "items",
        command: "distinct",
        field: "category",
        query: { active: true },
        filter: { active: true },
      },
    ],
    [
      { command: "count", collection: "items", filter: {} },
      { command: "countDocuments", collection: "items", filter: {} },
    ],
  ])("normalizes supported collection command keys: %j", (input, expected) => {
    expect(normalizeMqlCommand(input)).toEqual(expected)
  })
})
