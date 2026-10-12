import { describe, expect, mock, test } from "bun:test"

async function fakeMongo(docs: Record<string, unknown>[] = []) {
  const pipelines: Record<string, unknown>[][] = []
  const counts: { filter: unknown; options: unknown }[] = []
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
  return { connector, query, pipelines, counts }
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
