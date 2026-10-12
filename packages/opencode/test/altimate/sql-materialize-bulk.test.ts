import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Connector } from "@altimateai/drivers"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as Registry from "../../src/altimate/native/connections/registry"
import { registerAll } from "../../src/altimate/native/connections/register"
import * as Scratch from "../../src/altimate/native/connections/scratch"
import { closeScratch, getScratch } from "../../src/altimate/native/connections/scratch"
import { materialize } from "../../src/altimate/tools/sql-materialize"

let previousTelemetry: string | undefined
let restoreSource: (() => void) | undefined
const source_warehouse = "bulk_source"

beforeAll(() => {
  previousTelemetry = process.env.ALTIMATE_TELEMETRY_DISABLED
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  registerAll()
})

beforeEach(async () => {
  await closeScratch()
  Registry.setConfigs({ [source_warehouse]: { type: "duckdb", path: ":memory:" } })
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

function sourceRows(columns: string[], rows: unknown[][]) {
  const execute: Connector["execute"] = async (sql) =>
    /^SELECT count\(\*\)/i.test(sql)
      ? { columns: ["count"], rows: [[rows.length]], row_count: 1, truncated: false }
      : { columns, rows, row_count: rows.length, truncated: false }
  const real = Registry.get.bind(Registry)
  const get = spyOn(Registry, "get").mockImplementation(async (name: string) =>
    name === source_warehouse ? ({ execute } as Connector) : real(name),
  )
  restoreSource = () => get.mockRestore()
}

async function scratchRows(sql: string) {
  return (await (await getScratch()).execute(sql)).rows
}

describe("sql_materialize bulk loading", () => {
  test("round-trips local-engine bigint, dates, bytes, NULL and lossless text", async () => {
    const source = await Registry.get(source_warehouse)
    const text = "single ' and double \" quotes\nsecond line\r\n雪🙂\\slash\0tail"
    await source.execute(
      "CREATE TABLE typed_rows (id INTEGER, big BIGINT, huge HUGEINT, day DATE, stamp TIMESTAMP, bytes BLOB, note VARCHAR, absent VARCHAR, active BOOLEAN)",
    )
    await source.execute(
      `INSERT INTO typed_rows VALUES
        (1, 9007199254740993, 170141183460469231731687303715884105727,
         DATE '2024-02-29', TIMESTAMP '2024-02-29 12:34:56.789', from_hex('00017f80ff'), ?, NULL, true),
        (2, -9223372036854775808, -170141183460469231731687303715884105728,
         DATE '1970-01-01', TIMESTAMP '1970-01-01 00:00:00', from_hex(''), '', NULL, false),
        (3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
      undefined,
      [text],
    )
    const sourceResult = await source.execute("SELECT * FROM typed_rows ORDER BY id")
    expect(sourceResult.rows[0][1]).toBe(9007199254740993n)
    expect(sourceResult.rows[0][2]).toBe(170141183460469231731687303715884105727n)
    expect(sourceResult.rows[0][3]).toBeInstanceOf(Date)
    expect(sourceResult.rows[0][4]).toBeInstanceOf(Date)
    expect(sourceResult.rows[0][5]).toEqual(new Uint8Array([0, 1, 127, 128, 255]))

    const result = await materialize({
      source_warehouse,
      sql: "SELECT * FROM typed_rows ORDER BY id",
      target_table: "typed",
    })
    expect(result.columns.map((column) => column.type)).toEqual([
      "BIGINT",
      "BIGINT",
      "HUGEINT",
      "TIMESTAMP",
      "TIMESTAMP",
      "BLOB",
      "VARCHAR",
      "VARCHAR",
      "BOOLEAN",
    ])
    expect(result.rows).toBe(3)
    expect(result.total_rows).toBe(3)
    const rows = await scratchRows("SELECT * FROM typed ORDER BY id")
    expect(rows).toEqual(sourceResult.rows.map(([id, ...rest]) => [BigInt(id as number), ...rest]))
    expect(rows[0][6]).toBe(text)
  })

  test("keeps non-finite doubles, widening and arbitrary column names", async () => {
    sourceRows(
      ["n", "number", "mixed", "__proto__", 'quoted"name', "same", "SAME", ""],
      [
        [1, NaN, true, "first", "雪\n\0", 1, "a", null],
        [2, Infinity, { nested: 9007199254740993n, bytes: new Uint8Array([0, 255]) }, "second", "'\"", 2.5, "b", null],
        [3, -Infinity, 9007199254740993n, "third", "", 3, "c", null],
        [4, null, null, null, null, null, null, null],
      ],
    )
    const result = await materialize({ source_warehouse, sql: "SELECT values FROM source_rows", target_table: "mixed" })
    expect(result.columns).toEqual([
      { name: "n", type: "BIGINT" },
      { name: "number", type: "DOUBLE" },
      { name: "mixed", type: "VARCHAR" },
      { name: "__proto__", type: "VARCHAR" },
      { name: 'quoted"name', type: "VARCHAR" },
      { name: "same", type: "DOUBLE" },
      { name: "SAME_2", type: "VARCHAR" },
      { name: "column_8", type: "VARCHAR" },
    ])
    expect(
      await scratchRows(
        'SELECT n, number, mixed, "__proto__" AS proto, "quoted""name", same, SAME_2, column_8 FROM mixed ORDER BY n',
      ),
    ).toEqual([
      [1n, NaN, "true", "first", "雪\n\0", 1, "a", null],
      [2n, Infinity, '{"nested":"9007199254740993","bytes":"00ff"}', "second", "'\"", 2.5, "b", null],
      [3n, -Infinity, "9007199254740993", "third", "", 3, "c", null],
      [4n, null, null, null, null, null, null, null],
    ])
  })

  test("append maps reordered and subset columns case-insensitively", async () => {
    const initial = await materialize({
      source_warehouse,
      sql: "SELECT 1 AS ID, 'first' AS Note, true AS Active",
      target_table: "appended",
    })
    const reordered = await materialize({
      source_warehouse,
      sql: "SELECT false AS active, 'second' AS NOTE, 2 AS id",
      target_table: "appended",
      mode: "append",
    })
    const subset = await materialize({
      source_warehouse,
      sql: "SELECT 3 AS id",
      target_table: "appended",
      mode: "append",
    })
    expect(reordered.columns).toEqual(initial.columns)
    expect(subset.columns).toEqual(initial.columns)
    expect(reordered.rows).toBe(1)
    expect(reordered.total_rows).toBe(2)
    expect(subset.rows).toBe(1)
    expect(subset.total_rows).toBe(3)
    expect(await scratchRows("SELECT * FROM appended ORDER BY ID")).toEqual([
      [1n, "first", true],
      [2n, "second", false],
      [3n, null, null],
    ])
  })

  test("a failed append conversion rolls back every input row", async () => {
    await materialize({ source_warehouse, sql: "SELECT 1 AS id", target_table: "rollback_rows" })
    await expect(
      materialize({
        source_warehouse,
        sql: "SELECT '2' AS id UNION ALL SELECT 'not an integer' AS id",
        target_table: "rollback_rows",
        mode: "append",
      }),
    ).rejects.toThrow(/scratch\.rollback_rows.*append was rolled back/s)
    expect(await scratchRows("SELECT id FROM rollback_rows")).toEqual([[1n]])
    const result = await materialize({
      source_warehouse,
      sql: "SELECT 3 AS id",
      target_table: "rollback_rows",
      mode: "append",
    })
    expect(result.total_rows).toBe(2)
    expect(await scratchRows("SELECT id FROM rollback_rows ORDER BY id")).toEqual([[1n], [3n]])
  })

  test("loads one JSON record larger than DuckDB's default object limit", async () => {
    const text = "x".repeat(17 * 1024 * 1024) + "雪\0tail"
    sourceRows(["note"], [[text]])
    const result = await materialize({
      source_warehouse,
      sql: "SELECT note FROM wide_rows",
      target_table: "wide_row",
      max_bytes: 20 * 1024 * 1024,
    })
    expect(result.rows).toBe(1)
    expect(await scratchRows("SELECT length(note), right(note, 6) FROM wide_row")).toEqual([
      [BigInt(17 * 1024 * 1024 + 6), "雪\0tail"],
    ])
  })

  test("private load files are removed after success and failed replace, with paths redacted", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sql-materialize-'"))
    const tmpdir = spyOn(os, "tmpdir").mockReturnValue(tempDir)
    const files: string[] = []
    let fail = false
    const original = Scratch.withScratchConnection
    const inspect: typeof Scratch.withScratchConnection = (operation) =>
      original(async (connection) => {
        const realExecute = connection.execute.bind(connection)
        const execute = spyOn(connection, "execute").mockImplementation(async (sql, ...args) => {
          const match = /read_json(?:_auto)?\('((?:''|[^'])+)'/.exec(sql)
          if (match) {
            const file = match[1].replaceAll("''", "'")
            files.push(file)
            expect(file).toContain(tempDir)
            expect(fs.existsSync(file)).toBe(true)
            if (process.platform !== "win32") {
              expect(fs.statSync(file).mode & 0o777).toBe(0o600)
              expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
            }
            if (fail) throw new Error(`simulated load failure in ${sql} for ${file}`)
          }
          return realExecute(sql, ...args)
        })
        try {
          return await operation(connection)
        } finally {
          execute.mockRestore()
        }
      })
    const withConnection = spyOn(Scratch, "withScratchConnection").mockImplementation(inspect)
    try {
      const input = { source_warehouse, sql: "SELECT 1 AS id", target_table: "kept" }
      const result = await materialize(input)
      expect(result.table).toBe("kept")
      expect(files).toHaveLength(1)
      expect(fs.existsSync(path.dirname(files[0]))).toBe(false)
      expect(JSON.stringify(result)).not.toContain(files[0])

      fail = true
      let error: Error | undefined
      try {
        await materialize({ ...input, sql: "SELECT 2 AS id", mode: "replace" })
      } catch (e) {
        error = e as Error
      }
      expect(error).toBeDefined()
      expect(error!.message).toContain("Failed to write scratch.kept")
      expect(error!.message).toContain("simulated load failure")
      expect(files).toHaveLength(2)
      for (const file of files) {
        expect(fs.existsSync(path.dirname(file))).toBe(false)
        expect(error!.message).not.toContain(path.dirname(file))
        expect(error!.message).not.toContain(path.dirname(file).replaceAll("'", "''"))
      }
      expect(await scratchRows("SELECT id FROM kept")).toEqual([[1n]])
    } finally {
      withConnection.mockRestore()
      tmpdir.mockRestore()
      await closeScratch()
      await Registry.closeAll()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
