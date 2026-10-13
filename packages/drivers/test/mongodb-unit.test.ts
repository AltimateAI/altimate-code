import { describe, expect, mock, test } from "bun:test"
import { normalizeMqlCommand } from "../src/mongodb"

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

describe("normalizeMqlCommand", () => {
  test("normalizes the live collection/find object payload with its projection", () => {
    const projection = { _id: 0, article_id: 1, title: 1, description: 1 }
    expect(normalizeMqlCommand({ collection: "articles", find: {}, projection })).toEqual({
      command: "find",
      collection: "articles",
      filter: {},
      projection,
    })
  })

  test("uses the find object body as the filter", () => {
    const filter = { article_id: { $in: [1, 2] } }
    expect(normalizeMqlCommand({ collection: "articles", find: filter })).toEqual({
      command: "find",
      collection: "articles",
      filter,
    })
  })

  test("normalizes the collection/aggregate array body as the pipeline", () => {
    const pipeline = [{ $match: { category: "news" } }, { $count: "n" }]
    expect(normalizeMqlCommand({ collection: "articles", aggregate: pipeline })).toEqual({
      command: "aggregate",
      collection: "articles",
      pipeline,
    })
  })

  test.each(["count", "countDocuments"])("normalizes the collection/%s object body as the filter", (key) => {
    const filter = { category: "news" }
    expect(normalizeMqlCommand({ collection: "articles", [key]: filter })).toEqual({
      command: "countDocuments",
      collection: "articles",
      filter,
    })
  })

  test("normalizes the collection/distinct object body as field and filter", () => {
    const filter = { category: "news" }
    expect(normalizeMqlCommand({ collection: "articles", distinct: { key: "article_id", filter } })).toEqual({
      command: "distinct",
      collection: "articles",
      field: "article_id",
      filter,
    })
  })

  test("normalizes distinct field shorthand with an explicit collection", () => {
    const filter = { category: "news" }
    expect(normalizeMqlCommand({ collection: "articles", distinct: "article_id", filter })).toEqual({
      command: "distinct",
      collection: "articles",
      field: "article_id",
      filter,
    })
  })

  test.each([
    { name: "find", input: { find: "articles", filter: {} }, output: { command: "find", filter: {} } },
    { name: "aggregate", input: { aggregate: "articles", pipeline: [] }, output: { command: "aggregate", pipeline: [] } },
    {
      name: "count",
      input: { count: "articles", query: { n: 1 } },
      output: { command: "countDocuments", query: { n: 1 }, filter: { n: 1 } },
    },
    {
      name: "countDocuments",
      input: { countDocuments: "articles", filter: { n: 1 } },
      output: { command: "countDocuments", filter: { n: 1 } },
    },
    {
      name: "distinct",
      input: { distinct: "articles", key: "article_id", query: { n: 1 } },
      output: { command: "distinct", field: "article_id", query: { n: 1 }, filter: { n: 1 } },
    },
  ])("preserves the native $name string form", ({ input, output }) => {
    expect(normalizeMqlCommand(input)).toEqual({ collection: "articles", ...output })
  })

  test("preserves an explicit command unchanged", () => {
    const input = { command: "find", collection: "articles", filter: { category: "news" }, projection: { _id: 0 } }
    expect(normalizeMqlCommand(input)).toBe(input)
  })

  test.each(["key", "field"])("preserves native distinct with an explicit collection and %s", (key) => {
    const input = { collection: "articles", distinct: "articles", [key]: "article_id", filter: {} }
    expect(normalizeMqlCommand(input)).toEqual({
      command: "distinct",
      collection: "articles",
      field: "article_id",
      filter: {},
    })
  })

  test.each([
    { name: "object bodies", input: { collection: "articles", find: {}, aggregate: [] } },
    { name: "string values", input: { find: "articles", aggregate: "articles" } },
    { name: "mixed values", input: { collection: "articles", find: {}, count: "articles" } },
    { name: "an explicit command", input: { command: "find", collection: "articles", find: {}, aggregate: [] } },
  ])("rejects two native command keys with $name", ({ input }) => {
    expect(() => normalizeMqlCommand(input)).toThrow(/multiple native command keys.*find.*(?:aggregate|count)/i)
  })

  test("does not infer an object command without a collection", () => {
    expect(normalizeMqlCommand({ find: {} })).toEqual({ find: {} })
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

  test("distinct shorthand without a collection or field remains refused", async () => {
    const { connector, distincts } = await fakeMongo()
    await expect(connector.execute(JSON.stringify({ distinct: "article_id" }), 10)).rejects.toThrow(
      "distinct requires a 'field' string",
    )
    expect(distincts).toEqual([])
  })

  test("an explicit filter takes precedence over the native query alias", async () => {
    const { connector, counts } = await fakeMongo()
    await connector.execute(JSON.stringify({ count: "orders", query: { status: "A" }, filter: { status: "B" } }), 1, undefined, { queryTimeoutMs: 0 })
    expect(counts).toEqual([{ filter: { status: "B" }, options: {} }])
  })
})
