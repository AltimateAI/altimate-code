import { describe, expect, test } from "bun:test"
import type { SqlExecuteResult } from "../../../src/altimate/native/types"
import {
  formatSqlResult,
  SQL_MAX_PREVIEW_BYTES,
  SQL_MAX_PREVIEW_COLUMNS,
  SQL_MAX_PREVIEW_ROWS,
  SQL_MAX_SPILL_BYTES,
} from "../../../src/altimate/tools/sql-result-format"

const resultPath = "/tmp/tool_sql_result_test"

function result(rows: unknown[][], columns = ["value"], truncated = false): SqlExecuteResult {
  return { columns, rows, row_count: rows.length, truncated }
}

function spill() {
  const writes: string[] = []
  return {
    writes,
    write: async (text: string) => {
      writes.push(text)
      return resultPath
    },
    rows: () =>
      writes[0]!
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
  }
}

// The envelope, column names, and separator are not part of the clipped body.
function body(output: string, columns = ["value"]): string {
  const header = columns.join(" | ")
  const separator = columns.map((column) => "-".repeat(Math.max(column.length, 4))).join("-+-")
  const start = output.indexOf(`${header}\n${separator}\n`)
  expect(start).toBeGreaterThanOrEqual(0)
  return output.slice(start + header.length + separator.length + 2).replace(/\n\n\(\d+ rows\).*$/s, "")
}

describe("SQL result previews", () => {
  test("preserves small scalar output byte-for-byte without spilling", async () => {
    const saved = spill()
    const formatted = await formatSqlResult(result([[42]], ["answer"]), { limit: 100, write: saved.write })

    expect(formatted.output).toBe("answer\n------\n42\n\n(1 rows)")
    expect(formatted.metadata).toMatchObject({
      rowCount: 1,
      rows_returned: 1,
      preview_rows: 1,
      row_limited: false,
      output_truncated: false,
      truncated: false,
    })
    expect(formatted.metadata.result_path).toBeUndefined()
    expect(saved.writes).toHaveLength(0)
  })

  test("preserves a short table and NULL versus the string NULL", async () => {
    const saved = spill()
    const formatted = await formatSqlResult(
      result(
        [
          [1, null],
          [2, "NULL"],
        ],
        ["id", "text"],
      ),
      {
        limit: 100,
        write: saved.write,
      },
    )

    expect(formatted.output).toBe("id | text\n-----+-----\n1 | NULL\n2 | NULL\n\n(2 rows)")
    expect(saved.writes).toHaveLength(0)
  })

  test("preserves an empty result byte-for-byte", async () => {
    const saved = spill()
    const formatted = await formatSqlResult(result([]), { limit: 100, write: saved.write })
    expect(formatted.output).toBe("(0 rows)")
    expect(formatted.metadata.preview_rows).toBe(0)
    expect(saved.writes).toHaveLength(0)
  })

  test("clips and spills an oversized single cell even when the backend did not truncate rows", async () => {
    const cell = "x".repeat(SQL_MAX_PREVIEW_BYTES * 4)
    const saved = spill()
    const formatted = await formatSqlResult(result([[cell]]), { limit: 100, write: saved.write })

    expect(formatted.output).toStartWith("Preview: 1 of 1 returned rows shown.")
    expect(formatted.output).toContain(`…[cell clipped, ${cell.length} chars]`)
    expect(formatted.output).toContain("Output truncated: yes.")
    expect(Buffer.byteLength(formatted.output, "utf8")).toBeLessThanOrEqual(SQL_MAX_PREVIEW_BYTES)
    expect(Buffer.byteLength(body(formatted.output), "utf8")).toBeLessThanOrEqual(SQL_MAX_PREVIEW_BYTES)
    expect(formatted.output).toContain(resultPath)
    expect(formatted.metadata).toMatchObject({
      rows_returned: 1,
      preview_rows: 1,
      row_limited: false,
      output_truncated: true,
      truncated: true,
      result_path: resultPath,
    })
    expect(saved.writes).toHaveLength(1)
    expect(saved.rows()).toEqual([{ columns: ["value"], values: [cell] }])
  })

  test("leads a row-limited result with an honest envelope and saves every returned row", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => [i])
    const saved = spill()
    const formatted = await formatSqlResult(result(rows, ["id"], true), { limit: 100, write: saved.write })

    expect(formatted.output).toStartWith(`Preview: ${SQL_MAX_PREVIEW_ROWS} of 100 returned rows shown.`)
    expect(formatted.output.toLowerCase()).toContain("may be row-limited")
    expect(formatted.output.toLowerCase()).toContain("total unknown")
    expect(formatted.output).toContain(`All 100 returned rows saved to ${resultPath}`)
    expect(formatted.metadata).toMatchObject({
      rowCount: 100,
      rows_returned: 100,
      preview_rows: SQL_MAX_PREVIEW_ROWS,
      row_limited: true,
      output_truncated: true,
    })
    expect(saved.rows().map((row) => row.values)).toEqual(rows)
  })

  test("exactly-N dbt-style truncation says may rather than claiming another row exists", async () => {
    const saved = spill()
    const formatted = await formatSqlResult(result([[1], [2]], ["id"], true), { limit: 2, write: saved.write })

    expect(formatted.output).toStartWith("Preview: 2 of 2 returned rows shown.")
    expect(formatted.output.toLowerCase()).toContain("may be row-limited")
    expect(formatted.output.toLowerCase()).toContain("total unknown")
    expect(formatted.output).not.toContain("at least 3")
    expect(formatted.output).toContain("Output truncated: no.")
    expect(formatted.metadata.row_limited).toBe(true)
    expect(formatted.metadata.output_truncated).toBe(false)
    expect(saved.rows()).toHaveLength(2)
  })

  test("previews the first 50 rows and spills all rows even without a backend row limit", async () => {
    const rows = Array.from({ length: 75 }, (_, i) => [`row-${String(i).padStart(3, "0")}`])
    const saved = spill()
    const formatted = await formatSqlResult(result(rows), { limit: 100, write: saved.write })

    expect(body(formatted.output).split("\n").slice(0, SQL_MAX_PREVIEW_ROWS)).toEqual(rows.slice(0, 50).flat())
    expect(formatted.output).not.toContain("row-050")
    expect(formatted.output).not.toContain("row-074")
    expect(formatted.metadata.row_limited).toBe(false)
    expect(formatted.metadata.preview_rows).toBe(SQL_MAX_PREVIEW_ROWS)
    expect(saved.rows().map((row) => row.values)).toEqual(rows)
  })

  test("clips UTF-8 on character boundaries and escapes embedded newlines in JSONL", async () => {
    const cell = "😀漢字\nsecond line\r\n".repeat(2000)
    const saved = spill()
    const formatted = await formatSqlResult(result([[cell], ["tail\nvalue"]]), {
      limit: 100,
      maxBytes: 1024,
      write: saved.write,
    })

    expect(formatted.output).not.toContain("\uFFFD")
    expect(formatted.output).toContain("…[cell clipped,")
    expect(Buffer.byteLength(body(formatted.output), "utf8")).toBeLessThanOrEqual(1024)
    expect(saved.writes[0]!.trimEnd().split("\n")).toHaveLength(2)
    expect(saved.rows().map((row) => row.values)).toEqual([[cell], ["tail\nvalue"]])
  })

  test("keeps the envelope, short column list and spill path within the configured cap", async () => {
    const columns = ["identifier", "description"]
    const saved = spill()
    const formatted = await formatSqlResult(result([[7, "q".repeat(10_000)]], columns), {
      limit: 100,
      maxBytes: 1024,
      write: saved.write,
    })

    expect(formatted.output).toStartWith("Preview: 1 of 1 returned rows shown.")
    expect(formatted.output).toContain(columns.join(" | "))
    expect(formatted.output).toContain(`All 1 returned rows saved to ${resultPath}`)
    expect(Buffer.byteLength(formatted.output, "utf8")).toBeLessThanOrEqual(1024)
    expect(Buffer.byteLength(body(formatted.output, columns), "utf8")).toBeLessThanOrEqual(1024)
    expect(formatted.metadata.result_path).toBe(resultPath)
  })

  test("clips a 20,000-character alias visibly and includes the entire output in the byte cap", async () => {
    const alias = "漢".repeat(20_000)
    const saved = spill()
    const formatted = await formatSqlResult(result([[42]], [alias]), { limit: 100, write: saved.write })

    expect(formatted.output).toContain("…[alias clipped]")
    expect(formatted.output).not.toContain("\uFFFD")
    expect(Buffer.byteLength(formatted.output, "utf8")).toBeLessThanOrEqual(SQL_MAX_PREVIEW_BYTES)
    expect(formatted.metadata).toMatchObject({ schema_truncated: true, preview_columns: 1, output_truncated: true })
    expect(saved.rows()).toEqual([{ columns: [alias], values: [42] }])
  })

  test("caps a 500-column preview and saves the full schema and rows", async () => {
    const columns = Array.from({ length: 500 }, (_, i) => `column_${i}`)
    const values = columns.map((_, i) => `value_${i}`)
    const saved = spill()
    const formatted = await formatSqlResult(result([values], columns), { limit: 100, write: saved.write })

    expect(formatted.output).toContain(`(+${500 - SQL_MAX_PREVIEW_COLUMNS} more columns, see spill)`)
    expect(formatted.output).not.toContain("column_60")
    expect(formatted.output).not.toContain("value_60")
    expect(Buffer.byteLength(formatted.output, "utf8")).toBeLessThanOrEqual(SQL_MAX_PREVIEW_BYTES)
    expect(formatted.metadata).toMatchObject({
      schema_truncated: true,
      preview_columns: SQL_MAX_PREVIEW_COLUMNS,
      output_truncated: true,
    })
    expect(saved.rows()).toEqual([{ columns, values }])
  })

  test.each([0, 8, 64, 512, 1024])(
    "keeps wide schemas and a long spill envelope within a %i-byte cap",
    async (maxBytes) => {
      const columns = Array.from({ length: 500 }, (_, i) => `${i}_${"alias".repeat(100)}`)
      const formatted = await formatSqlResult(result([columns], columns), {
        limit: 100,
        maxBytes,
        write: async () => "/tmp/" + "long-path".repeat(100),
      })
      expect(Buffer.byteLength(formatted.output, "utf8")).toBeLessThanOrEqual(maxBytes)
      expect(formatted.metadata.output_truncated).toBe(true)
    },
  )

  test("respects a smaller configured line limit", async () => {
    const saved = spill()
    const formatted = await formatSqlResult(result([["first"], ["second"], ["third"]]), {
      limit: 100,
      maxLines: 6,
      write: saved.write,
    })

    expect(body(formatted.output).split("\n").length).toBeLessThanOrEqual(6)
    expect(formatted.output.split("\n").length).toBeLessThanOrEqual(6)
    expect(formatted.output).toContain("first")
    expect(formatted.output).not.toContain("third")
    expect(formatted.metadata.output_truncated).toBe(true)
    expect(saved.rows()).toHaveLength(3)
  })

  test("retains a usable preview and reports spill failure without a result path", async () => {
    const formatted = await formatSqlResult(result([["readable-prefix " + "x".repeat(100_000)]]), {
      limit: 100,
      write: async () => {
        throw new Error("disk full")
      },
    })

    expect(formatted.output).toStartWith("Preview: 1 of 1 returned rows shown.")
    expect(formatted.output).toContain("readable-prefix")
    expect(formatted.output.toLowerCase()).toContain("spill failed")
    expect(formatted.output).not.toContain("rows saved to")
    expect(formatted.metadata.result_path).toBeUndefined()
    expect(formatted.metadata.output_truncated).toBe(true)
  })

  test("spills explicit tags for big integers, dates and bytes while leaving identical strings unchanged", async () => {
    const columns = [
      "same",
      "same",
      "nested",
      "buffer",
      "bytes",
      "bigint_string",
      "date",
      "date_string",
      "bytes_string",
    ]
    const iso = "2026-01-02T03:04:05.000Z"
    const rows = [
      [
        null,
        "NULL",
        { big: 9007199254740993n, list: [true, null, { text: "a\nb" }] },
        Buffer.from([0, 255]),
        new Uint8Array([1, 128]),
        "9007199254740993",
        new Date(iso),
        iso,
        "AP8=",
      ],
    ]
    const saved = spill()
    const formatted = await formatSqlResult(result(rows, columns, true), { limit: 1, write: saved.write })

    expect(formatted.metadata.result_path).toBe(resultPath)
    expect(formatted.output).toContain("Lossy JSONL text")
    expect(formatted.output).toContain("$bigint, $date (ISO), $bytes (base64) tags; strings unchanged")
    expect(saved.rows()).toEqual([
      {
        columns,
        values: [
          null,
          "NULL",
          { big: { $bigint: "9007199254740993" }, list: [true, null, { text: "a\nb" }] },
          { $bytes: "AP8=" },
          { $bytes: "AYA=" },
          "9007199254740993",
          { $date: iso },
          iso,
          "AP8=",
        ],
      },
    ])
  })

  test("rejects oversized spills before writing and still returns the bounded preview", async () => {
    const saved = spill()
    const formatted = await formatSqlResult(result([["x".repeat(SQL_MAX_SPILL_BYTES + 1)]]), {
      limit: 100,
      write: saved.write,
    })

    expect(saved.writes).toHaveLength(0)
    expect(formatted.output.toLowerCase()).toContain("spill failed")
    expect(formatted.metadata.result_path).toBeUndefined()
    expect(Buffer.byteLength(body(formatted.output), "utf8")).toBeLessThanOrEqual(SQL_MAX_PREVIEW_BYTES)
  })

  test("preserves nonfinite numbers and undefined instead of silently converting them to NULL", async () => {
    const saved = spill()
    await formatSqlResult(
      result(
        [[NaN, Infinity, -Infinity, -0, undefined, { missing: undefined }]],
        ["nan", "positive", "negative", "zero", "missing", "nested"],
        true,
      ),
      { limit: 1, write: saved.write },
    )
    expect(saved.rows()[0].values).toEqual([
      { $sql_type: "number", value: "NaN" },
      { $sql_type: "number", value: "Infinity" },
      { $sql_type: "number", value: "-Infinity" },
      { $sql_type: "number", value: "-0" },
      { $sql_type: "undefined" },
      { missing: { $sql_type: "undefined" } },
    ])
  })

  test("preflights oversized binary cells before Buffer.toJSON allocates a data array", async () => {
    const saved = spill()
    const cell = Buffer.alloc(SQL_MAX_SPILL_BYTES / 4 + 1)
    let serialized = false
    cell.toJSON = () => {
      serialized = true
      throw new Error("must not allocate the data array")
    }
    const formatted = await formatSqlResult(result([[cell]]), { limit: 100, write: saved.write })
    expect(serialized).toBe(false)
    expect(saved.writes).toHaveLength(0)
    expect(formatted.output).toContain("Spill failed")
    expect(formatted.metadata.output_truncated).toBe(true)
    expect(Buffer.byteLength(formatted.output, "utf8")).toBeLessThanOrEqual(SQL_MAX_PREVIEW_BYTES)
  })

  test("rejects a cyclic nested value as a spill failure without losing the preview", async () => {
    const value: Record<string, unknown> = { label: "value" }
    value.self = value
    const saved = spill()
    const formatted = await formatSqlResult(result([[value]], ["value"], true), { limit: 1, write: saved.write })
    expect(saved.writes).toHaveLength(0)
    expect(formatted.output).toStartWith("Preview: 1 of 1 returned rows shown.")
    expect(formatted.output).toContain("Spill failed")
    expect(formatted.metadata.result_path).toBeUndefined()
  })

  test("bounds array previews without converting the whole array to a string", async () => {
    const value = ["😀".repeat(20_000), "remaining element"]
    value.toString = () => {
      throw new Error("must not stringify the full array")
    }
    const saved = spill()
    const formatted = await formatSqlResult(result([[value]]), { limit: 100, write: saved.write })
    expect(formatted.metadata.output_truncated).toBe(true)
    expect(formatted.output).not.toContain("\uFFFD")
    expect(Buffer.byteLength(formatted.output, "utf8")).toBeLessThanOrEqual(SQL_MAX_PREVIEW_BYTES)
    expect(saved.rows()[0].values).toEqual([["😀".repeat(20_000), "remaining element"]])
  })

  test("includes a two-digit preview count and clipping status within the byte budget", async () => {
    const rows = [...Array.from({ length: 9 }, (_, i) => [i]), ["x".repeat(20_000)]]
    const saved = spill()
    const formatted = await formatSqlResult(result(rows), { limit: 100, maxBytes: 1024, write: saved.write })
    expect(formatted.metadata.preview_rows).toBe(10)
    expect(formatted.output).toContain("Output truncated: yes")
    expect(Buffer.byteLength(formatted.output, "utf8")).toBeLessThanOrEqual(1024)
  })
})

describe("empty-result hint", () => {
  const run = (rows: unknown[][], sql: string, columns = ["region"]) =>
    formatSqlResult(result(rows, columns), { limit: 100, sql, write: spill().write })

  test("fires for a 0-row result with a string-literal equality filter", async () => {
    const out = await run([], "SELECT * FROM sales WHERE region = 'North'")
    expect(out.output).toContain("(0 rows)")
    expect(out.output).toContain("Hint: 0 rows.")
    expect(out.output).toContain("SELECT DISTINCT")
  })

  test.each([{ rows: [] }, { rows: [["North"]] }])(
    "omits the optional hint when it would exceed a short-result budget (%j)",
    async ({ rows }) => {
      const formatted = await formatSqlResult(result(rows.map((row) => [...row])), {
        limit: 100,
        sql: "SELECT value FROM sales WHERE value = 'North'",
        maxBytes: 64,
        write: spill().write,
      })
      expect(formatted.output).not.toContain("Hint:")
      expect(Buffer.byteLength(formatted.output, "utf8")).toBeLessThanOrEqual(64)
      expect(formatted.metadata.output_truncated).toBe(false)
    },
  )

  test("fires for an IN list and for a result of one or two rows", async () => {
    expect((await run([], "select * from t where c in ('a', 'b')")).output).toContain("Hint: 0 rows.")
    const one = await run([["x"]], "SELECT region FROM t WHERE region = 'N'")
    expect(one.output).toContain("Hint: only 1 row(s).")
    expect(one.output).toContain("(1 rows)")
  })

  test("does not fire for scalar aggregates, unfiltered or non-literal empties, or larger results", async () => {
    expect((await run([[0]], "SELECT COUNT(*) FROM t WHERE region = 'N'", ["n"])).output).not.toContain("Hint")
    expect((await run([], "SELECT * FROM t WHERE id = 5")).output).toBe("(0 rows)")
    expect((await run([], "SELECT * FROM t")).output).toBe("(0 rows)")
    expect((await run([], "SELECT * FROM t WHERE id > 5 -- region = 'N'")).output).toBe("(0 rows)")
    expect((await run([["a"], ["b"], ["c"]], "SELECT * FROM t WHERE r = 'a'")).output).not.toContain("Hint")
  })

  test("is off when the statement is not provided", async () => {
    expect((await run([], undefined as any)).output).toBe("(0 rows)")
  })
})
