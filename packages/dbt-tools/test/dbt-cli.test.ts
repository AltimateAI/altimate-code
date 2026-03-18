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

describe("execDbtShow", () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  test("parses dbt show output with data.preview (dbt 1.7+ format)", async () => {
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

  test("parses dbt show output with data.rows (alternative format)", async () => {
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

  test("passes --limit flag when provided", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      expect(args).toContain("--limit")
      expect(args).toContain("10")
      cb(null, JSON.stringify({ data: { preview: "[]" } }), "")
    })

    await execDbtShow("SELECT 1", 10)
  })

  test("throws on unparseable output", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, JSON.stringify({ info: { msg: "no preview data here" } }), "")
    })

    await expect(execDbtShow("SELECT 1")).rejects.toThrow("Could not parse dbt show output")
  })
})

describe("execDbtCompile", () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  test("parses data.compiled format", async () => {
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

  test("parses data.compiled_code format (newer dbt)", async () => {
    const jsonLines = [
      JSON.stringify({ data: { compiled_code: "SELECT * FROM stg_orders" } }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtCompile("orders")
    expect(result.sql).toBe("SELECT * FROM stg_orders")
  })

  test("parses result.node.compiled_code format", async () => {
    const jsonLines = [
      JSON.stringify({ result: { node: { compiled_code: "SELECT 1" } } }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtCompile("my_model")
    expect(result.sql).toBe("SELECT 1")
  })

  test("falls back to plain text output", async () => {
    let callCount = 0
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      callCount++
      if (callCount === 1) {
        // JSON attempt returns no matching lines
        cb(null, JSON.stringify({ info: { msg: "done" } }), "")
      } else {
        // Plain text fallback
        cb(null, "SELECT * FROM final_model", "")
      }
    })

    const result = await execDbtCompile("my_model")
    expect(result.sql).toBe("SELECT * FROM final_model")
  })
})

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

describe("execDbtLs", () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  test("lists children models", async () => {
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
    // Should exclude the model itself
    expect(result.find((r: any) => r.table === "orders")).toBeUndefined()
    expect(result.find((r: any) => r.table === "customers")).toBeTruthy()
    expect(result.find((r: any) => r.table === "revenue")).toBeTruthy()
  })

  test("lists parent models", async () => {
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

  test("handles empty output", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, "", "")
    })

    const result = await execDbtLs("isolated_model", "children")
    expect(result).toEqual([])
  })
})
