import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { initTool } from "../tool-fixture"
import * as Dispatcher from "../../../src/altimate/native/dispatcher"
import { SchemaInspectTool } from "../../../src/altimate/tools/schema-inspect"
import { buildProfileSql } from "../../../src/altimate/tools/schema-values"

const ctx = {
  sessionID: "test-session",
  messageID: "test-message",
  callID: "test-call",
  agent: "test",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
}

const COLUMNS = [
  { name: "id", data_type: "INTEGER", nullable: false, primary_key: true },
  { name: "region", data_type: "TEXT", nullable: true, primary_key: false },
  { name: "customer_code", data_type: "TEXT", nullable: true, primary_key: false },
  { name: "note", data_type: "TEXT", nullable: true, primary_key: false },
]

const SEED = (): string[] => {
  const regions = ["north", "south", "east", "west"]
  const codes = ["C-%d", "c%d", " C-%d"]
  const inserts: string[] = []
  for (let i = 1; i <= 60; i++) {
    inserts.push(
      `INSERT INTO t VALUES (${i}, '${regions[i % 4]}', '${codes[i % 3]!.replace("%d", String(i).padStart(5, "0"))}', ${i % 2 ? "NULL" : "'x'"})`,
    )
  }
  return ["CREATE TABLE t (id INTEGER, region TEXT, customer_code TEXT, note TEXT)", ...inserts]
}

function install(engine: "sqlite" | "duckdb" | "postgres", run: (sql: string) => Promise<unknown[][]>, calls: string[]) {
  Dispatcher.register("warehouse.list" as any, async () => ({ warehouses: [{ name: "w", type: engine }] }))
  Dispatcher.register("schema.inspect" as any, async () => ({ table: "t", schema_name: "public", columns: COLUMNS }))
  Dispatcher.register("sql.execute" as any, async (p: any) => {
    calls.push(p.sql)
    const rows = await run(p.sql)
    return { columns: [], rows, row_count: rows.length, truncated: false }
  })
}

async function inspect(args: Record<string, unknown>) {
  const tool = await initTool(SchemaInspectTool)
  return tool.execute({ table: "t", ...args } as any, ctx as any)
}

beforeEach(() => {
  Dispatcher.reset()
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})

function expectAppendix(output: string) {
  expect(output).toContain("Value samples:")
  expect(output).toContain("id: 60 distinct")
  expect(output).toMatch(/region: 4 distinct — (north|south|east|west)(, (north|south|east|west)){3}/)
  expect(output).toMatch(/customer_code: 60 distinct, e\.g\. "[^"]+", "[^"]+", "[^"]+"/)
  expect(output).toContain("note: 1 distinct — x, 50% null")
}

describe("schema_inspect value grounding", () => {
  describe("sqlite", () => {
    const db = new Database(":memory:")
    beforeAll(() => SEED().forEach((s) => db.run(s)))
    afterAll(() => db.close())
    const run = async (sql: string) => db.query(sql).values() as unknown[][]

    test("single-table inspect appends distinct values, examples and null share in one query", async () => {
      const calls: string[] = []
      install("sqlite", run, calls)
      const result = await inspect({})
      expectAppendix(result.output)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain("LIMIT 10000")
      expect(result.metadata.success).toBe(true)
    })

    test("whitespace and case variants stay visible in the listed values", async () => {
      const small = new Database(":memory:")
      small.run("CREATE TABLE t (id INTEGER, region TEXT, customer_code TEXT, note TEXT)")
      small.run("INSERT INTO t VALUES (1, 'a', 'C-00017', NULL), (2, 'a', 'c00018', NULL), (3, 'a', ' C-00019', NULL)")
      install("sqlite", async (sql) => small.query(sql).values() as unknown[][], [])
      const result = await inspect({})
      small.close()
      expect(result.output).toMatch(/customer_code: 3 distinct — .*" C-00019"/)
      expect(result.output).toContain("c00018")
      expect(result.output).toContain("note: all NULL")
    })

    test("delimiter characters stay inside values and empty-string-only columns retain their sample", async () => {
      const small = new Database(":memory:")
      try {
        small.run("CREATE TABLE t (id INTEGER, region TEXT, customer_code TEXT, note TEXT)")
        small.run("INSERT INTO t VALUES (1, 'left␟right', '', NULL)")
        install("sqlite", async (sql) => small.query(sql).values() as unknown[][], [])
        const result = await inspect({})
        expect(result.output).toContain("region: 1 distinct — left␟right\n")
        expect(result.output).toContain('customer_code: 1 distinct — ""\n')
      } finally {
        small.close()
      }
    })

    test("values:false skips profiling", async () => {
      const calls: string[] = []
      install("sqlite", run, calls)
      const result = await inspect({ values: false })
      expect(calls).toHaveLength(0)
      expect(result.output).not.toContain("Value samples")
    })

    test("a profiling failure degrades to a note and keeps the column list", async () => {
      install("sqlite", async () => {
        throw new Error("boom\nsecond line")
      }, [])
      const result = await inspect({})
      expect(result.metadata.success).toBe(true)
      expect(result.output).toContain("Column | Type")
      expect(result.output).toContain("Value samples unavailable: boom")
      expect(result.output).not.toContain("second line")
    })

    test.each([false, true])("a dispatcher error response is visible (wrapped: %s)", async (wrapped) => {
      install("sqlite", run, [])
      Dispatcher.register("sql.execute" as any, async () => {
        const response = { rows: [], error: "query timed out\nconnection restarted" }
        return wrapped ? { data: response } : response
      })
      const result = await inspect({})
      expect(result.metadata.success).toBe(true)
      expect(result.output).toContain("Column | Type")
      expect(result.output).toContain("Value samples unavailable: query timed out")
      expect(result.output).not.toContain("connection restarted")
    })

    test("unsupported engines are skipped with a note", async () => {
      const calls: string[] = []
      install("sqlite", run, calls)
      Dispatcher.register("warehouse.list" as any, async () => ({ warehouses: [{ name: "w", type: "mongodb" }] }))
      const result = await inspect({})
      expect(calls).toHaveLength(0)
      expect(result.output).toContain("Value samples skipped")
    })
  })

  describe("duckdb", () => {
    test("single-table inspect against a real duckdb", async () => {
      const { connect } = await import("../../../../drivers/src/duckdb")
      const dir = (await import("fs")).mkdtempSync((await import("os")).tmpdir() + "/schemavals-")
      const conn = await connect({ type: "duckdb", path: dir + "/t.duckdb", create: true } as any)
      try {
        await conn.connect()
        for (const s of SEED()) await conn.execute(s, 1000)
        const run = async (sql: string) => (await conn.execute(sql, 1000)).rows as unknown[][]
        const calls: string[] = []
        install("duckdb", run, calls)
        const result = await inspect({})
        expectAppendix(result.output)
        expect(calls).toHaveLength(1)
        expect(calls[0]).toContain("array_agg(v)")
        await conn.execute("DELETE FROM t", 1000)
        await conn.execute("INSERT INTO t VALUES (1, 'left␟right', '', NULL)", 1000)
        const edgeValues = await inspect({})
        expect(edgeValues.output).toContain("region: 1 distinct — left␟right\n")
        expect(edgeValues.output).toContain('customer_code: 1 distinct — ""\n')
      } finally {
        await conn.close()
      }
    })
  })

  test("postgres uses array_agg and preserves quoted identifiers containing an aggregate name", async () => {
    const calls: string[] = []
    const column = "group_concat(value"
    install("postgres", async () => [[column, 1, 1, 1, ["left␟right"]]], calls)
    Dispatcher.register("schema.inspect" as any, async () => ({
      table: "t", schema_name: "sales", columns: [{ name: column, data_type: "TEXT", nullable: false }],
    }))
    const result = await inspect({ table: "sales.t" })
    expect(calls[0]).toContain("array_agg(v)")
    expect(calls[0]).toContain('CAST("group_concat(value" AS TEXT)')
    expect(calls[0]).toContain("'group_concat(value' AS col")
    expect(calls[0]).toContain('FROM "sales"."t"')
    expect(result.output).toContain("group_concat(value: 1 distinct — left␟right")
  })

  test("profiling is capped at 40 columns", () => {
    const cols = Array.from({ length: 60 }, (_, i) => ({ name: `c${i}`, data_type: "TEXT" }))
    expect(buildProfileSql('"t"', cols.slice(0, 40)).split("UNION ALL")).toHaveLength(40)
  })
})
