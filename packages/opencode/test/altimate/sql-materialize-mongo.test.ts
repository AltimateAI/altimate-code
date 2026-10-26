import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Connector } from "@altimateai/drivers"
import { QueryTimeoutError } from "@altimateai/drivers/types"
import { ResultByteLimitError } from "@altimateai/drivers/result-byte-limit"
import * as Registry from "../../src/altimate/native/connections/registry"
import { registerAll } from "../../src/altimate/native/connections/register"
import { closeScratch, getScratch } from "../../src/altimate/native/connections/scratch"
import { materialize } from "../../src/altimate/tools/sql-materialize"

type Command = Record<string, any>
type Execution = {
  command: Command
  limit: number | undefined
  timeout: number | undefined
  maxBytes: number | undefined
}

const find = {
  command: "find",
  database: "articles",
  collection: "articles",
  filter: { topic: "science" },
  projection: { text: 1 },
  sort: { published: -1 },
  skip: 2,
}
const aggregate = {
  command: "aggregate",
  database: "articles",
  collection: "articles",
  pipeline: [{ $match: { topic: "science" } }, { $project: { text: 1 } }, { $limit: 5000 }],
}
const input = { source_warehouse: "mongo_source", target_table: "articles" }

let previousTelemetry: string | undefined
let restoreSource: (() => void) | undefined

beforeAll(() => {
  previousTelemetry = process.env.ALTIMATE_TELEMETRY_DISABLED
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  registerAll()
})

beforeEach(async () => {
  Registry.setConfigs({ mongo_source: { type: "mongodb" } })
  await closeScratch()
})

afterEach(async () => {
  restoreSource?.()
  restoreSource = undefined
  await Registry.closeAll()
})

afterAll(async () => {
  await closeScratch()
  if (previousTelemetry === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
  else process.env.ALTIMATE_TELEMETRY_DISABLED = previousTelemetry
})

function result(rows: unknown[][], columns = ["text"]) {
  return { columns, rows, row_count: rows.length, truncated: false }
}

function fakeMongo(respond: (call: Execution, index: number) => ReturnType<typeof result>) {
  const seen: Execution[] = []
  const execute: Connector["execute"] = async (sql, limit, _binds, options) => {
    const call = { command: JSON.parse(sql), limit, timeout: options?.queryTimeoutMs, maxBytes: options?.maxResultBytes }
    seen.push(call)
    return respond(call, seen.length - 1)
  }
  const real = Registry.get.bind(Registry)
  const get = spyOn(Registry, "get").mockImplementation(async (name: string) =>
    name === "mongo_source" ? ({ execute, supportsResultByteLimit: true } as Connector) : real(name),
  )
  restoreSource = () => get.mockRestore()
  return seen
}

function expectRead(call: Execution, command: Command, cap: number) {
  expect(call.command).toEqual(
    command.command === "aggregate" ? { ...command, pipeline: [...command.pipeline, { $limit: cap }] } : command,
  )
  expect(call.limit).toBe(cap)
}

describe("MongoDB materialization", () => {
  for (const command of [find, aggregate]) {
    test(`${command.command}: accepts collection with an inline filter or pipeline`, async () => {
      const { command: name, filter, pipeline, ...options } = command as Command
      const shorthand = { ...options, [name]: name === "find" ? filter : pipeline }
      const seen = fakeMongo(() => result([["kept"]]))
      const materialized = await materialize({ ...input, sql: JSON.stringify(shorthand), max_rows: 10 })
      expect(materialized.rows).toBe(1)
      expect(seen).toHaveLength(1)
      expect(seen[0].command).toEqual(
        name === "aggregate" ? { ...command, pipeline: [...pipeline, { $limit: 11 }] } : command,
      )
      expect((await (await getScratch()).execute("SELECT text FROM articles")).rows).toEqual([["kept"]])
    })

    test(`${command.command}: reads the source once with row, byte and timeout bounds`, async () => {
      const seen = fakeMongo(() => result([["first"], ["second"]]))
      const materialized = await materialize({
        ...input,
        sql: JSON.stringify(command),
        max_rows: 10,
        max_bytes: 32,
        query_timeout_ms: 4321,
      })
      expect(materialized.rows).toBe(2)
      expect(materialized.warnings).toEqual([])
      expect(seen).toHaveLength(1)
      expectRead(seen[0], command, 11)
      expect(seen[0].maxBytes).toBe(32)
      expect(seen[0].timeout).toBeGreaterThan(0)
      expect(seen[0].timeout).toBeLessThanOrEqual(4321)
      expect((await (await getScratch()).execute("SELECT text FROM articles ORDER BY text")).rows).toEqual([
        ["first"],
        ["second"],
      ])
    })

    test(`${command.command}: refuses the extra row without creating a table`, async () => {
      const seen = fakeMongo(() => result([["one"], ["two"], ["three"], ["four"]]))
      await expect(materialize({ ...input, sql: JSON.stringify(command), max_rows: 3 })).rejects.toThrow(
        /row cap of 3 rows/,
      )
      expect(seen).toHaveLength(1)
      expectRead(seen[0], command, 4)
      const scratch = await getScratch()
      const tables = await scratch.execute("SELECT table_name FROM information_schema.tables WHERE table_name = 'articles'")
      expect(tables.rows).toEqual([])
    })

    test(`${command.command}: refuses a truncated result without retrying`, async () => {
      const seen = fakeMongo(() => ({ ...result([["first"]]), truncated: true }))
      await expect(materialize({ ...input, sql: JSON.stringify(command), max_rows: 3 })).rejects.toThrow(
        /row cap of 3 rows/,
      )
      expect(seen).toHaveLength(1)
      expectRead(seen[0], command, 4)
    })

    test(`${command.command}: checks actual UTF-8 bytes with the row codec`, async () => {
      const rows = [
        [1n, new Uint8Array([0, 255]), "é"],
        [22n, new Uint8Array(), "long🙂"],
      ]
      const actualBytes =
        Buffer.byteLength('["1","00ff","é"]', "utf8") + Buffer.byteLength('["22","","long🙂"]', "utf8")
      const seen = fakeMongo(() => result(rows, ["id", "binary", "text"]))
      await expect(
        materialize({ ...input, sql: JSON.stringify(command), max_rows: 20, max_bytes: actualBytes - 1 }),
      ).rejects.toThrow(`above the ${actualBytes - 1} bytes bound`)
      expect(seen).toHaveLength(1)
      expectRead(seen[0], command, 21)
      expect(seen[0].maxBytes).toBe(actualBytes - 1)
    })
  }

  test("find: preserves a smaller user limit and all read options", async () => {
    const command = { ...find, limit: 7 }
    const seen = fakeMongo(() => result([["kept"]]))
    await materialize({ ...input, sql: JSON.stringify(command), max_rows: 10 })
    expect(seen).toHaveLength(1)
    expectRead(seen[0], command, 11)
  })

  test("find: supports a query without an explicit filter", async () => {
    const command = { command: "find", collection: "articles" }
    const seen = fakeMongo(() => result([["kept"]]))
    await materialize({ ...input, sql: JSON.stringify(command) })
    expect(seen).toHaveLength(1)
    expectRead(seen[0], command, 2_000_001)
  })

  test("aggregate: an empty result needs only one source read", async () => {
    const seen = fakeMongo(() => result([], []))
    const materialized = await materialize({ ...input, sql: JSON.stringify(aggregate) })
    expect(materialized.rows).toBe(0)
    expect(materialized.materialized).toBe(false)
    expect(materialized.warnings).toEqual([])
    expect(seen).toHaveLength(1)
    expectRead(seen[0], aggregate, 2_000_001)
  })

  test("aggregate: bounds extraction after an expanding stage", async () => {
    const command = { ...aggregate, pipeline: [{ $limit: 1 }, { $unwind: "$items" }] }
    const seen = fakeMongo(() => result([["one"], ["two"], ["three"], ["four"]]))
    await expect(materialize({ ...input, sql: JSON.stringify(command), max_rows: 3 })).rejects.toThrow(
      /row cap of 3 rows/,
    )
    expect(seen).toHaveLength(1)
    expectRead(seen[0], command, 4)
  })

  test("countDocuments: materializes the requested count once", async () => {
    const command = { command: "countDocuments", collection: "articles", filter: { topic: "science" } }
    const seen = fakeMongo(() => result([[3]], ["count"]))
    const materialized = await materialize({ ...input, sql: JSON.stringify(command), max_rows: 10 })
    expect(materialized.rows).toBe(1)
    expect(materialized.warnings).toEqual([])
    expect(seen).toHaveLength(1)
    expectRead(seen[0], command, 11)
    expect((await (await getScratch()).execute('SELECT "count" FROM articles')).rows).toEqual([[3n]])
  })

  test("a source failure propagates without retrying the read", async () => {
    const seen = fakeMongo(() => {
      throw new Error("source disconnected")
    })
    await expect(materialize({ ...input, sql: JSON.stringify(find) })).rejects.toThrow("source disconnected")
    expect(seen).toHaveLength(1)
    expectRead(seen[0], find, 2_000_001)
  })

  test("a source timeout propagates without retrying the read", async () => {
    const seen = fakeMongo(() => {
      throw new QueryTimeoutError({ engine: "mongodb", timeoutMs: 4321, cancelled: true })
    })
    await expect(
      materialize({ ...input, sql: JSON.stringify(find), query_timeout_ms: 4321 }),
    ).rejects.toBeInstanceOf(QueryTimeoutError)
    expect(seen).toHaveLength(1)
    expectRead(seen[0], find, 2_000_001)
  })

  test("a transfer byte limit refuses the result without creating a table", async () => {
    const seen = fakeMongo(() => {
      throw new ResultByteLimitError(32)
    })
    await expect(materialize({ ...input, sql: JSON.stringify(find), max_bytes: 32 })).rejects.toThrow(
      /above the 32 bytes bound.*nothing was materialized/,
    )
    expect(seen).toHaveLength(1)
    expectRead(seen[0], find, 2_000_001)
    const scratch = await getScratch()
    const tables = await scratch.execute("SELECT table_name FROM information_schema.tables WHERE table_name = 'articles'")
    expect(tables.rows).toEqual([])
  })

  test("distinct is refused before an unbounded driver call", async () => {
    const seen = fakeMongo(() => result([["science"]]))
    await expect(
      materialize({ ...input, sql: JSON.stringify({ distinct: "articles", key: "topic" }) }),
    ).rejects.toThrow(/distinct.*not allowed/)
    expect(seen).toHaveLength(0)
  })

  test.each([null, [], {}, { collection: "articles" }, { command: 42 }, { command: "" }].map((command) => ({ command })))(
    "invalid command shape %j gets JSON command guidance before execution",
    async ({ command }) => {
      const seen = fakeMongo(() => result([["unused"]]))
      await expect(materialize({ ...input, sql: JSON.stringify(command) })).rejects.toThrow(
        'A MongoDB source query must be a JSON command, e.g. {"command":"find","collection":"c"}.',
      )
      expect(seen).toHaveLength(0)
    },
  )

  test("SQL input gets MongoDB JSON command guidance before execution", async () => {
    const seen = fakeMongo(() => result([["unused"]]))
    await expect(materialize({ ...input, sql: "SELECT text FROM articles" })).rejects.toThrow(
      'A MongoDB source query must be a JSON command, e.g. {"command":"find","collection":"c"}.',
    )
    expect(seen).toHaveLength(0)
  })

  test.each(["$out", "$merge"])("aggregate %s is refused before any source read", async (stage) => {
    const seen = fakeMongo(() => result([[1]], ["n"]))
    await expect(
      materialize({ ...input, sql: JSON.stringify({ aggregate: "articles", pipeline: [{ [stage]: "stolen" }] }) }),
    ).rejects.toThrow(/only reads/)
    expect(seen).toHaveLength(0)
  })
})

test("materializes a collection with an embedded find filter and projection", async () => {
  const command = { collection: "articles", find: {}, projection: { _id: 0, article_id: 1, title: 1, description: 1 } }
  const seen = fakeMongo(() => result([["body"]]))
  const materialized = await materialize({ ...input, sql: JSON.stringify(command) })
  expect(materialized.rows).toBe(1)
  expect(seen).toHaveLength(1)
  expect(seen[0].command).toEqual({
    collection: "articles",
    command: "find",
    filter: {},
    projection: command.projection,
  })
})

test.each(["$out", "$merge"])("embedded aggregate %s is refused before source reads", async (stage) => {
  const seen = fakeMongo(() => result([[1]], ["n"]))
  await expect(
    materialize({ ...input, sql: JSON.stringify({ collection: "articles", aggregate: [{ [stage]: "target" }] }) }),
  ).rejects.toThrow(/only reads/)
  expect(seen).toHaveLength(0)
})
