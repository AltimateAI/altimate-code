import { expect, mock, test } from "bun:test"
import { connect } from "../src/mongodb"
import { restoreModuleMocksAfterTests } from "./module-mock"

await restoreModuleMocksAfterTests("mongodb")

async function database() {
  const started = Promise.withResolvers<void>()
  const delivered = Promise.withResolvers<Record<string, unknown>>()
  let fetched = 0
  let closed = 0
  const cursor = {
    limit() { return this },
    batchSize() { return this },
    async close() { closed++ },
    async *[Symbol.asyncIterator]() {
      fetched++
      started.resolve()
      yield await delivered.promise
      fetched++
      yield { value: "late" }
    },
    async toArray() {
      const docs = []
      for await (const doc of this) docs.push(doc)
      return docs
    },
  }
  mock.module("mongodb", () => ({ default: { MongoClient: class {
    async connect() {}
    async close() {}
    db() {
      return {
        databaseName: "test",
        listCollections: () => ({ toArray: async () => [{ name: "source", type: "collection" }] }),
        collection: () => ({ find: () => cursor, aggregate: () => cursor }),
      }
    }
  } } }))
  const connector = await connect({ type: "mongodb", query_timeout_ms: 0 })
  await connector.connect()
  return { connector, started: started.promise, deliver: () => delivered.resolve({ value: "first" }), fetched: () => fetched, closed: () => closed }
}

for (const command of ["find", "aggregate"]) {
  for (const maxResultBytes of [undefined, 1000]) {
    test(`Mongo ${command} abort closes a pending cursor and prevents subsequent fetches (byte bound ${maxResultBytes})`, async () => {
      const db = await database()
      const controller = new AbortController()
      const reason = new Error("session stopped")
      const execution = db.connector.execute(JSON.stringify({ command, collection: "source", pipeline: [] }), 100, undefined, {
        signal: controller.signal,
        maxResultBytes,
      }).catch((error) => error)
      try {
        // Surface validation/setup failures instead of waiting forever for an unopened cursor.
        await Promise.race([db.started, execution.then((error) => { throw error })])
        const start = performance.now()
        controller.abort(reason)
        expect(await Promise.race([execution, Bun.sleep(100).then(() => "still reading")])).toBe(reason)
        expect(performance.now() - start).toBeLessThan(2000)
        expect(db.closed()).toBe(1)
        db.deliver()
        await Bun.sleep(10)
        expect(db.fetched()).toBe(1)
      } finally {
        db.deliver()
        await execution
        await db.connector.close()
      }
    })
  }
}

for (const maxResultBytes of [undefined, 1000]) {
  test(`Mongo cursor deadline closes a stalled read without a caller signal (byte bound ${maxResultBytes})`, async () => {
    const db = await database()
    const execution = db.connector.execute(JSON.stringify({ command: "find", collection: "source" }), 100, undefined, {
      queryTimeoutMs: 20,
      maxResultBytes,
    }).catch((error) => error)
    try {
      await Promise.race([db.started, execution.then((error) => { throw error })])
      expect(await Promise.race([execution, Bun.sleep(100).then(() => "still reading")])).toMatchObject({ code: "QUERY_TIMEOUT" })
      expect(db.closed()).toBe(1)
      db.deliver()
      await Bun.sleep(10)
      expect(db.fetched()).toBe(1)
    } finally {
      db.deliver()
      await execution
      await db.connector.close()
    }
  })
}
