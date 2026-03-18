import { describe, test, expect, mock, beforeEach } from "bun:test"

// We test the parsing logic by mocking execFile
const mockExecFile = mock((cmd: string, args: string[], opts: any, cb: Function) => {
  cb(null, "", "")
})

mock.module("child_process", () => ({
  execFile: mockExecFile,
}))

// Import after mocking
const { execDbtShow, execDbtCompile, execDbtCompileInline, execDbtLs } = await import(
  "../src/dbt-cli"
)

// ---------------------------------------------------------------------------
// execDbtShow
// ---------------------------------------------------------------------------
describe("execDbtShow", () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  // --- Tier 1: known field paths ---

  test("Tier 1: parses data.preview (dbt 1.7-1.9 format)", async () => {
    const jsonLines = [
      JSON.stringify({ info: { msg: "Running..." } }),
      JSON.stringify({ data: { sql: "SELECT 1 AS n" } }),
      JSON.stringify({ data: { preview: '[{"n": 1}]' } }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtShow("SELECT 1 AS n")
    expect(result.columnNames).toEqual(["n"])
    expect(result.data).toEqual([{ n: 1 }])
    expect(result.compiledSql).toBe("SELECT 1 AS n")
  })

  test("Tier 1: parses data.rows (alternative format)", async () => {
    const jsonLines = [
      JSON.stringify({ data: { rows: [{ name: "Alice" }, { name: "Bob" }] } }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtShow("SELECT name FROM users")
    expect(result.columnNames).toEqual(["name"])
    expect(result.data).toEqual([{ name: "Alice" }, { name: "Bob" }])
  })

  test("Tier 1: parses result.preview (hypothetical future format)", async () => {
    const jsonLines = [
      JSON.stringify({ result: { preview: [{ id: 42 }], sql: "SELECT 42" } }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtShow("SELECT 42 AS id")
    expect(result.columnNames).toEqual(["id"])
    expect(result.data).toEqual([{ id: 42 }])
  })

  test("Tier 1: passes --limit flag when provided", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      expect(args).toContain("--limit")
      expect(args).toContain("10")
      cb(null, JSON.stringify({ data: { preview: '[{"n": 1}]' } }), "")
    })

    const result = await execDbtShow("SELECT 1", 10)
    expect(result.data).toEqual([{ n: 1 }])
  })

  // --- Tier 2: heuristic deep scan ---

  test("Tier 2: finds row data nested in unknown structure", async () => {
    // Simulates a future dbt version with a completely different JSON shape
    const jsonLines = [
      JSON.stringify({
        level: "info",
        msg: "show done",
        payload: {
          query_results: [{ amount: 100 }, { amount: 200 }],
        },
      }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtShow("SELECT amount FROM orders")
    expect(result.columnNames).toEqual(["amount"])
    expect(result.data).toEqual([{ amount: 100 }, { amount: 200 }])
  })

  test("Tier 2: finds JSON string of rows nested deeply", async () => {
    const jsonLines = [
      JSON.stringify({
        event: {
          output: JSON.stringify([{ x: 1 }, { x: 2 }]),
        },
      }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtShow("SELECT x FROM t")
    expect(result.columnNames).toEqual(["x"])
    expect(result.data).toEqual([{ x: 1 }, { x: 2 }])
  })

  // --- Tier 3: plain text fallback ---

  test("Tier 3: parses ASCII table when JSON fails", async () => {
    let callCount = 0
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      callCount++
      if (callCount === 1) {
        // JSON attempt fails (no preview data)
        cb(null, JSON.stringify({ info: { msg: "done" } }), "")
      } else {
        // Plain text ASCII table
        cb(
          null,
          [
            "| id | name  |",
            "| -- | ----- |",
            "| 1  | Alice |",
            "| 2  | Bob   |",
          ].join("\n"),
          "",
        )
      }
    })

    const result = await execDbtShow("SELECT id, name FROM users")
    expect(result.columnNames).toEqual(["id", "name"])
    expect(result.data).toEqual([
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
    ])
  })

  test("Tier 3: throws with helpful message when all tiers fail", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, "some unparseable output", "")
    })

    await expect(execDbtShow("SELECT 1")).rejects.toThrow("Could not parse dbt show output in any format")
  })
})

// ---------------------------------------------------------------------------
// execDbtCompile
// ---------------------------------------------------------------------------
describe("execDbtCompile", () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  test("Tier 1: parses data.compiled (dbt 1.7-1.9)", async () => {
    const jsonLines = [
      JSON.stringify({ info: { msg: "Compiling..." } }),
      JSON.stringify({ data: { compiled: "SELECT id FROM raw_orders" } }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtCompile("orders")
    expect(result.sql).toBe("SELECT id FROM raw_orders")
  })

  test("Tier 1: parses data.compiled_code (newer dbt)", async () => {
    const jsonLines = [
      JSON.stringify({ data: { compiled_code: "SELECT * FROM stg_orders" } }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtCompile("orders")
    expect(result.sql).toBe("SELECT * FROM stg_orders")
  })

  test("Tier 1: parses result.node.compiled_code", async () => {
    const jsonLines = [
      JSON.stringify({ result: { node: { compiled_code: "SELECT 1" } } }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtCompile("my_model")
    expect(result.sql).toBe("SELECT 1")
  })

  test("Tier 1: parses data.compiled_sql", async () => {
    const jsonLines = [
      JSON.stringify({ data: { compiled_sql: "SELECT 1 FROM foo" } }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtCompile("foo")
    expect(result.sql).toBe("SELECT 1 FROM foo")
  })

  // --- Tier 2: heuristic ---

  test("Tier 2: finds SQL in unknown nested structure", async () => {
    const jsonLines = [
      JSON.stringify({
        event: {
          compilation_result: "SELECT id, name FROM public.customers WHERE active = true",
        },
      }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtCompile("customers")
    expect(result.sql).toBe("SELECT id, name FROM public.customers WHERE active = true")
  })

  // --- Tier 3: plain text ---

  test("Tier 3: falls back to plain text output", async () => {
    let callCount = 0
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      callCount++
      if (callCount === 1) {
        cb(null, JSON.stringify({ info: { msg: "done" } }), "")
      } else {
        cb(null, "SELECT * FROM final_model", "")
      }
    })

    const result = await execDbtCompile("my_model")
    expect(result.sql).toBe("SELECT * FROM final_model")
  })
})

// ---------------------------------------------------------------------------
// execDbtCompileInline
// ---------------------------------------------------------------------------
describe("execDbtCompileInline", () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  test("compiles inline SQL", async () => {
    const jsonLines = [
      JSON.stringify({ data: { compiled: "SELECT id, name FROM raw.customers" } }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtCompileInline("SELECT * FROM {{ ref('customers') }}")
    expect(result.sql).toBe("SELECT id, name FROM raw.customers")
  })
})

// ---------------------------------------------------------------------------
// execDbtLs
// ---------------------------------------------------------------------------
describe("execDbtLs", () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  test("JSON format: lists children models", async () => {
    const jsonLines = [
      JSON.stringify({ name: "orders", unique_id: "model.jaffle.orders" }),
      JSON.stringify({ name: "customers", unique_id: "model.jaffle.customers" }),
      JSON.stringify({ name: "revenue", unique_id: "model.jaffle.revenue" }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      expect(args).toContain("--select")
      expect(args[args.indexOf("--select") + 1]).toBe("orders+")
      cb(null, jsonLines, "")
    })

    const result = await execDbtLs("orders", "children")
    expect(result.find((r: any) => r.table === "orders")).toBeUndefined()
    expect(result.find((r: any) => r.table === "customers")).toBeTruthy()
    expect(result.find((r: any) => r.table === "revenue")).toBeTruthy()
  })

  test("JSON format: lists parent models", async () => {
    const jsonLines = [
      JSON.stringify({ name: "stg_orders", unique_id: "model.jaffle.stg_orders" }),
      JSON.stringify({ name: "stg_payments", unique_id: "model.jaffle.stg_payments" }),
      JSON.stringify({ name: "orders", unique_id: "model.jaffle.orders" }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      expect(args[args.indexOf("--select") + 1]).toBe("+orders")
      cb(null, jsonLines, "")
    })

    const result = await execDbtLs("orders", "parents")
    expect(result.find((r: any) => r.table === "orders")).toBeUndefined()
    expect(result.find((r: any) => r.table === "stg_orders")).toBeTruthy()
  })

  test("plain text fallback: parses unique_id lines", async () => {
    let callCount = 0
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      callCount++
      if (callCount === 1) {
        // JSON fails
        cb(new Error("--output json not supported"), "", "")
      } else {
        // Plain text: one unique_id per line
        cb(
          null,
          "model.jaffle.stg_orders\nmodel.jaffle.stg_payments\nmodel.jaffle.orders\n",
          "",
        )
      }
    })

    const result = await execDbtLs("orders", "parents")
    expect(result.find((r: any) => r.table === "orders")).toBeUndefined()
    expect(result.find((r: any) => r.table === "stg_orders")).toBeTruthy()
    expect(result.find((r: any) => r.table === "stg_payments")).toBeTruthy()
  })

  test("handles empty output", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, "", "")
    })

    const result = await execDbtLs("isolated_model", "children")
    expect(result).toEqual([])
  })
})
