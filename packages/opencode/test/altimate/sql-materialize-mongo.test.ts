import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Connector } from "@altimateai/drivers"
import { QueryTimeoutError } from "@altimateai/drivers/types"
import * as Registry from "../../src/altimate/native/connections/registry"
import { registerAll } from "../../src/altimate/native/connections/register"
import { closeScratch, getScratch } from "../../src/altimate/native/connections/scratch"
import { materialize } from "../../src/altimate/tools/sql-materialize"

type Command = Record<string, any>
type Execution = { command: Command; limit: number | undefined; timeout: number | undefined }

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
    const call = { command: JSON.parse(sql), limit, timeout: options?.queryTimeoutMs }
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

function expectCount(call: Execution, command: Command, cap: number) {
  expect(call.command).toMatchObject({ database: "articles", collection: "articles" })
  if (command.command === "find") {
    expect(call.command).toMatchObject({ command: "countDocuments", filter: find.filter, skip: find.skip, limit: cap })
  } else {
    expect(call.command).toMatchObject({
      command: "aggregate",
      pipeline: [...command.pipeline, { $limit: cap }, { $count: "n" }],
    })
  }
  expect(call.limit).toBe(cap)
}

function expectSample(call: Execution, command: Command) {
  expect(call.command).toEqual(
    command.command === "find"
      ? { ...command, limit: 1000 }
      : { ...command, pipeline: [...command.pipeline, { $limit: 1000 }] },
  )
  expect(call.limit).toBe(1000)
}

describe("MongoDB materialization preflight", () => {
  for (const command of [find, aggregate]) {
    test(`${command.command}: refuses an over-cap count without sampling or extraction`, async () => {
      const seen = fakeMongo((_call, index) => {
        if (index === 0) return result([[4]], ["n"])
        throw new Error("Sampling and extraction must not run")
      })
      await expect(materialize({ ...input, sql: JSON.stringify(command), max_rows: 3 })).rejects.toThrow(
        /more than 3 rows.*row cap of 3/,
      )
      expect(seen).toHaveLength(1)
      expectCount(seen[0], command, 4)
      const scratch = await getScratch()
      const tables = await scratch.execute("SELECT table_name FROM information_schema.tables WHERE table_name = 'articles'")
      expect(tables.rows).toEqual([])
    })

    test(`${command.command}: samples before extraction and keeps rows in scratch`, async () => {
      const seen = fakeMongo((_call, index) => (index === 0 ? result([[2]], ["n"]) : result([["first"], ["second"]])))
      const materialized = await materialize({
        ...input,
        sql: JSON.stringify(command),
        max_rows: 10,
        max_bytes: 32,
        query_timeout_ms: 4321,
      })
      expect(materialized.rows).toBe(2)
      expect(materialized.warnings).toEqual([])
      expect(seen).toHaveLength(3)
      expectCount(seen[0], command, 11)
      expectSample(seen[1], command)
      expect(seen[2].command).toEqual(
        command.command === "aggregate" ? { ...command, pipeline: [...aggregate.pipeline, { $limit: 11 }] } : command,
      )
      expect(seen[2].limit).toBe(11)
      expect(seen.map((call) => call.timeout)).toEqual([4321, 4321, 4321])
      expect((await (await getScratch()).execute("SELECT text FROM articles ORDER BY text")).rows).toEqual([
        ["first"],
        ["second"],
      ])
    })

    test(`${command.command}: estimates count times mean UTF-8 bytes with the row codec`, async () => {
      const sample = [
        [1n, new Uint8Array([0, 255]), "é"],
        [22n, new Uint8Array(), "long🙂"],
      ]
      const estimatedBytes =
        10 * ((Buffer.byteLength('["1","00ff","é"]', "utf8") + Buffer.byteLength('["22","","long🙂"]', "utf8")) / 2)
      const seen = fakeMongo((_call, index) => {
        if (index === 0) return result([[10]], ["n"])
        if (index === 1) return result(sample, ["id", "binary", "text"])
        throw new Error("Extraction must not run")
      })
      await expect(
        materialize({ ...input, sql: JSON.stringify(command), max_rows: 20, max_bytes: estimatedBytes - 1 }),
      ).rejects.toThrow(`about 10 rows ≈ ${estimatedBytes} bytes, above the ${estimatedBytes - 1} bytes bound`)
      expect(seen).toHaveLength(2)
      expectCount(seen[0], command, 21)
      expectSample(seen[1], command)
    })

    test(`${command.command}: a failed count clamps extraction and reports the SQL fallback warning`, async () => {
      const seen = fakeMongo((_call, index) => {
        if (index === 0) throw new Error("count is unsupported")
        return result([["kept"]])
      })
      const materialized = await materialize({ ...input, sql: JSON.stringify(command) })
      expect(materialized.rows).toBe(1)
      expect(materialized.warnings).toEqual([
        "Pre-flight estimate unavailable (count is unsupported); extraction row cap clamped to 200,000 rows. The byte cap is enforced during transfer.",
      ])
      expect(seen).toHaveLength(2)
      expectCount(seen[0], command, 2_000_001)
      expect(seen[1].command).toEqual(
        command.command === "aggregate"
          ? { ...command, pipeline: [...aggregate.pipeline, { $limit: 200_001 }] }
          : command,
      )
      expect(seen[1].limit).toBe(200_001)
    })
  }

  test("find: retains a smaller user limit for both count and sample", async () => {
    const command = { ...find, limit: 7 }
    const seen = fakeMongo((_call, index) => (index === 0 ? result([[1]], ["n"]) : result([["kept"]])))
    await materialize({ ...input, sql: JSON.stringify(command) })
    expect(seen).toHaveLength(3)
    expect(seen[0].command).toMatchObject({ command: "countDocuments", limit: 7 })
    expect(seen[1].command).toEqual(command)
    expect(seen[1].limit).toBe(1000)
  })

  test("find: supports counting without an explicit filter", async () => {
    const seen = fakeMongo((_call, index) => (index === 0 ? result([[1]], ["n"]) : result([["kept"]])))
    await materialize({ ...input, sql: JSON.stringify({ command: "find", collection: "articles" }) })
    expect(seen[0].command).toMatchObject({ command: "countDocuments", collection: "articles", limit: 2_000_001 })
    expect(seen[0].command.filter ?? {}).toEqual({})
  })

  test("aggregate: an empty count result means zero rows, without fallback", async () => {
    const seen = fakeMongo(() => result([], []))
    const materialized = await materialize({ ...input, sql: JSON.stringify(aggregate) })
    expect(materialized.rows).toBe(0)
    expect(materialized.materialized).toBe(false)
    expect(materialized.warnings).toEqual([])
    expect(seen).toHaveLength(3)
    expectCount(seen[0], aggregate, 2_000_001)
    expectSample(seen[1], aggregate)
  })

  test.each(["successful", "failed"])(
    "aggregate: bounds extraction after $unwind with a %s preflight",
    async (preflight) => {
      const command = { ...aggregate, pipeline: [{ $limit: 1 }, { $unwind: "$items" }] }
      const seen = fakeMongo((_call, index) => {
        if (index === 0) {
          if (preflight === "failed") throw new Error("count is unsupported")
          return result([[1]], ["n"])
        }
        if (preflight === "successful" && index === 1) return result([["sample"]])
        return result([["one"], ["two"], ["three"], ["four"]])
      })
      await expect(materialize({ ...input, sql: JSON.stringify(command), max_rows: 3 })).rejects.toThrow(
        /row cap of 3 rows/,
      )
      const extraction = seen.at(-1)!
      expect(extraction.command).toEqual({ ...command, pipeline: [...command.pipeline, { $limit: 4 }] })
      expect(extraction.limit).toBe(4)
    },
  )

  test("failed count retains a smaller requested cap and reports its warning on refusal", async () => {
    const seen = fakeMongo((_call, index) => {
      if (index === 0) throw new Error("count is unsupported")
      return result([["one"], ["two"], ["three"], ["four"]])
    })
    await expect(materialize({ ...input, sql: JSON.stringify(find), max_rows: 3 })).rejects.toThrow(
      /extraction row cap clamped to 3 rows.*\n.*row cap of 3 rows/,
    )
    expect(seen).toHaveLength(2)
    expect(seen[1].limit).toBe(4)
  })

  test("a count timeout propagates without sampling or falling back to extraction", async () => {
    const seen = fakeMongo(() => {
      throw new QueryTimeoutError({ engine: "mongodb", timeoutMs: 4321, cancelled: true })
    })
    await expect(
      materialize({ ...input, sql: JSON.stringify(find), query_timeout_ms: 4321 }),
    ).rejects.toBeInstanceOf(QueryTimeoutError)
    expect(seen).toHaveLength(1)
  })

  test("distinct is refused before an unbounded driver call", async () => {
    const seen = fakeMongo(() => result([["science"]]))
    await expect(
      materialize({ ...input, sql: JSON.stringify({ distinct: "articles", key: "topic" }) }),
    ).rejects.toThrow(/distinct.*not allowed/)
    expect(seen).toHaveLength(0)
  })

  test.each(["$out", "$merge"])("aggregate %s is refused before any preflight or extraction", async (stage) => {
    const seen = fakeMongo(() => result([[1]], ["n"]))
    await expect(
      materialize({ ...input, sql: JSON.stringify({ aggregate: "articles", pipeline: [{ [stage]: "stolen" }] }) }),
    ).rejects.toThrow(/only reads/)
    expect(seen).toHaveLength(0)
  })
})
