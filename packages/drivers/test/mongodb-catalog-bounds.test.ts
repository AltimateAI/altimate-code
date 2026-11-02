// altimate_change start — schema discovery never materializes all collection metadata
import { expect, mock, test } from "bun:test"
import { connect } from "../src/mongodb"
import { restoreModuleMocksAfterTests } from "./module-mock"

await restoreModuleMocksAfterTests("mongodb")

test("two million MongoDB collections stop at 501 and close the cursor", async () => {
  let fetched = 0
  let closed = 0
  const options: unknown[] = []
  const commands: unknown[] = []
  mock.module("mongodb", () => ({
    default: {
      MongoClient: class {
        async connect() {}
        async close() {}
        db() {
          return {
            databaseName: "large",
            command: async (command: unknown) => {
              commands.push(command)
              return { collections: 2_000_000 }
            },
            listCollections: (_filter: unknown, opts: unknown) => {
              options.push(opts)
              return {
                async toArray() {
                  throw new Error("unbounded collection fetch")
                },
                async close() {
                  closed++
                },
                async *[Symbol.asyncIterator]() {
                  for (let i = 0; i < 2_000_000; i++) {
                    fetched++
                    yield { name: `c${i}`, type: "collection" }
                  }
                },
              }
            },
          }
        }
      },
    },
  }))
  const connector = await connect({ type: "mongodb" })
  await connector.connect()
  try {
    const start = performance.now()
    const result = await connector.execute(
      JSON.stringify({ command: "listCollections", database: "large" }),
      500,
      undefined,
      { readOnly: true, queryTimeoutMs: 1000 },
    )
    expect(result.rows).toHaveLength(500)
    expect(result.truncated).toBe(true)
    expect(fetched).toBe(501)
    expect(closed).toBe(1)
    expect(performance.now() - start).toBeLessThan(1000)
    expect(options[0]).toMatchObject({ nameOnly: true, authorizedCollections: true, batchSize: 501, maxTimeMS: 1000 })
    const counts = await connector.execute(JSON.stringify({ command: "dbStats", database: "large" }), 1, undefined, {
      readOnly: true,
      queryTimeoutMs: 1000,
    })
    expect(counts.rows).toEqual([[2_000_000]])
    expect(fetched).toBe(501)
    expect(commands).toEqual([{ dbStats: 1, maxTimeMS: 1000 }])
  } finally {
    await connector.close()
  }
})
// altimate_change end
