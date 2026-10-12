import { describe, expect, test } from "bun:test"
import { compileFunction } from "node:vm"
import { LOCAL_ENGINE_CHILD_SOURCE } from "../src/local-engine-child-source"
import { connect as sqlite } from "../src/sqlite"
import { connect as duckdb } from "../src/duckdb"

test("local helper stops a lazy DuckDB stream before retaining rows above the byte cap", async () => {
  let produced = 0
  let closed = false
  let finalized = false
  const responses: any[] = []
  const connection = {
    prepare() {
      return {
        stream: () => connection.stream(),
        finalize: (callback: () => void) => {
          finalized = true
          callback()
        },
      }
    },
    async *stream() {
      try {
        for (const value of ["x", "y".repeat(128), "must not be fetched"]) {
          produced++
          yield { value }
        }
      } finally {
        closed = true
      }
    },
    async all(_sql: string, callback: (error: null, rows: unknown[]) => void) {
      const rows = []
      for await (const row of this.stream()) rows.push(row)
      callback(null, rows)
    },
  }
  const run = compileFunction(
    LOCAL_ENGINE_CHILD_SOURCE.replace(
      "function closeDuckConnections()",
      'engine = "duckdb"; duckCon = connection;\nfunction closeDuckConnections()',
    ).replace("(async () => {", "return (async () => {"),
    ["Bun", "process", "connection"],
  )
  await run(
    {
      stdin: {
        async *stream() {
          yield Buffer.from(
            JSON.stringify({ id: 1, op: "all", payload: { sql: "SELECT value", maxResultBytes: 32 } }) + "\n",
          )
        },
      },
    },
    {
      argv: ["bun", "test", "0"],
      stdout: { write: (line: string) => responses.push(JSON.parse(line)) },
      exit: () => {},
    },
    connection,
  )
  expect(responses[0].error?.code).toBe("RESULT_BYTE_LIMIT")
  expect(produced).toBe(2)
  expect(closed).toBe(true)
  expect(finalized).toBe(true)
})

for (const [type, connect] of [
  ["sqlite", sqlite],
  ["duckdb", duckdb],
] as const) {
  describe(`${type} bounded results`, () => {
    test("rejects oversized serialized rows and keeps the connection usable", async () => {
      const connector = await connect({ type, path: ":memory:" })
      await connector.connect()
      try {
        await expect(
          connector.execute("SELECT '0123456789' AS value", 1, undefined, { maxResultBytes: 8 }),
        ).rejects.toMatchObject({ code: "RESULT_BYTE_LIMIT" })
        expect((await connector.execute("SELECT 1 AS value")).rows).toEqual([[1]])
        expect(connector.supportsResultByteLimit).toBe(true)
      } finally {
        await connector.close()
      }
    })

    test("rejects wide rows after a small initial sample in a real native stream", async () => {
      const connector = await connect({ type, path: ":memory:" })
      await connector.connect()
      try {
        const sql =
          "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000) SELECT CASE WHEN i <= 1000 THEN 'x' ELSE printf('%0200d', i) END AS value FROM n"
        expect(
          (
            await connector.execute(`SELECT * FROM (${sql}) AS sample LIMIT 1000`, 1000, undefined, {
              maxResultBytes: 8192,
            })
          ).rows,
        ).toHaveLength(1000)
        await expect(connector.execute(sql, 5000, undefined, { maxResultBytes: 8192 })).rejects.toMatchObject({
          code: "RESULT_BYTE_LIMIT",
        })
        expect((await connector.execute("SELECT 1 AS value")).rows).toEqual([[1]])
      } finally {
        await connector.close()
      }
    })
  })
}
