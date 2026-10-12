/**
 * `scratch` warehouse + `sql_materialize`: a data-plane bridge for cross-engine joins.
 *
 * Real engines throughout: two SQLite files as the "foreign" sources and the real session-scoped
 * DuckDB scratch database; only telemetry is switched off.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import type { Connector } from "@altimateai/drivers"
import { QueryTimeoutError } from "@altimateai/drivers/types"
import { createHash } from "node:crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { initTool } from "./tool-fixture"
import * as Registry from "../../src/altimate/native/connections/registry"
import { closeScratch, getScratch, withScratchSession } from "../../src/altimate/native/connections/scratch"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import { registerAll } from "../../src/altimate/native/connections/register"
import { SqlMaterializeTool, materialize } from "../../src/altimate/tools/sql-materialize"
import { SqlExecuteTool } from "../../src/altimate/tools/sql-execute"

const ctx = {
  sessionID: "test-session",
  messageID: "test-message",
  callID: "test-call",
  agent: "test",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
}

let dir = ""
let ordersDb = ""
let customersDb = ""
let prevTelemetry: string | undefined

beforeAll(() => {
  prevTelemetry = process.env.ALTIMATE_TELEMETRY_DISABLED
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  registerAll()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sql-materialize-"))
  ordersDb = path.join(dir, "orders.sqlite")
  customersDb = path.join(dir, "customers.sqlite")

  const o = new Database(ordersDb)
  o.run("CREATE TABLE orders (id INTEGER, customer_id INTEGER, amount REAL, note TEXT, paid INTEGER)")
  o.run(
    "INSERT INTO orders VALUES (1, 10, 5.5, 'first', 1), (2, 11, 7, NULL, 0), (3, 10, 1.25, 'third', 1), (4, 99, 3, 'orphan', 1)",
  )
  o.close()

  const c = new Database(customersDb)
  c.run("CREATE TABLE customers (customer_id INTEGER, name TEXT)")
  c.run("INSERT INTO customers VALUES (10, 'Ada'), (11, 'Bob'), (12, 'Cy')")
  c.close()
})

afterAll(async () => {
  await closeScratch()
  fs.rmSync(dir, { recursive: true, force: true })
  if (prevTelemetry === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
  else process.env.ALTIMATE_TELEMETRY_DISABLED = prevTelemetry
})

beforeEach(async () => {
  Registry.setConfigs({
    ordersdb: { type: "sqlite", path: ordersDb },
    customersdb: { type: "sqlite", path: customersDb },
  })
  await closeScratch() // each test starts with an empty scratch database
})

afterEach(async () => {
  await Registry.closeAll()
})

async function scratchSql(query: string) {
  const r = await Dispatcher.call("sql.execute", { sql: query, warehouse: "scratch", limit: 1000 })
  expect((r as any).error).toBeUndefined()
  return r
}

function fakePostgres(execute: Connector["execute"]) {
  Registry.setConfigs({ pg_source: { type: "postgres" } })
  const real = Registry.get.bind(Registry)
  return spyOn(Registry, "get").mockImplementation(async (name: string) =>
    name === "pg_source" ? ({ execute } as Connector) : real(name),
  )
}

describe("scratch warehouse", () => {
  test("is listed after the real warehouses, so the default warehouse is unchanged", () => {
    const { warehouses } = Registry.list()
    expect(warehouses.map((w) => w.name)).toEqual(["ordersdb", "customersdb", "scratch"])
    const s = warehouses[2]
    expect(s.type).toBe("duckdb")
    expect(s.database).toBe("session-scoped, ephemeral")
  })

  test("is not listed when nothing is configured (no spurious default warehouse)", () => {
    Registry.setConfigs({})
    expect(Registry.list().warehouses).toEqual([])
  })

  test("resolves through the unchanged sql.execute path and is queryable", async () => {
    const r = await scratchSql("SELECT 41 + 1 AS answer")
    expect(r.rows).toEqual([[42]])
    expect(Registry.getConfig("scratch")?.type).toBe("duckdb")
  })

  test("cannot be re-registered or removed", async () => {
    expect((await Registry.add("scratch", { type: "sqlite", path: ordersDb })).success).toBe(false)
    expect((await Registry.remove("scratch")).success).toBe(false)
  })

  test("is isolated per process: a fresh process starts empty", async () => {
    await materialize({ source_warehouse: "ordersdb", sql: "SELECT * FROM orders", target_table: "iso_t" })
    const here = await scratchSql("SELECT count(*) FROM information_schema.tables WHERE table_name = 'iso_t'")
    expect(Number(here.rows[0][0])).toBe(1)

    const script = `
      import { getScratch } from "./src/altimate/native/connections/scratch"
      const c = await getScratch()
      const r = await c.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = 'iso_t'")
      console.log("COUNT=" + String(r.rows[0][0]))
      process.exit(0)
    `
    const proc = Bun.spawnSync(["bun", "-e", script], { cwd: path.resolve(__dirname, "../.."), env: process.env })
    expect(proc.stdout.toString()).toContain("COUNT=0")
  })
})

describe("sql_materialize", () => {
  test("materializes from two SQLite files and joins them in scratch via sql_execute", async () => {
    const tool = await initTool(SqlMaterializeTool)
    const a = await tool.execute(
      { source_warehouse: "ordersdb", sql: "SELECT id, customer_id, amount FROM orders", target_table: "orders" },
      ctx as any,
    )
    expect(a.metadata.error).toBeUndefined()
    expect(a.metadata.rowCount).toBe(4)
    expect(a.output).toContain("scratch.orders: 4 rows")
    expect(a.output).toContain("SELECT id, customer_id, amount FROM orders")
    expect(a.output).toContain('sql_execute(warehouse: "scratch"')

    const b = await tool.execute(
      { source_warehouse: "customersdb", sql: "SELECT customer_id, name FROM customers", target_table: "customers" },
      ctx as any,
    )
    expect(b.metadata.rowCount).toBe(3)

    const exec = await initTool(SqlExecuteTool)
    const joined = await exec.execute(
      {
        warehouse: "scratch",
        query:
          "SELECT c.name, sum(o.amount) AS total FROM orders o JOIN scratch.customers c USING (customer_id) GROUP BY c.name ORDER BY c.name",
        limit: 100,
      },
      ctx as any,
    )
    expect(joined.title).not.toContain("ERROR")
    expect(joined.output).toContain("Ada | 6.75")
    expect(joined.output).toContain("Bob | 7")
    expect(joined.output).not.toContain("Cy")
  })

  test("stores every row beyond the default 1000-row display limit", async () => {
    const big = path.join(dir, "big.sqlite")
    const db = new Database(big)
    db.run("CREATE TABLE t (n INTEGER)")
    db.run(
      "WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 5000) INSERT INTO t SELECT n FROM s",
    )
    db.close()
    Registry.setConfigs({ bigdb: { type: "sqlite", path: big } })
    const r = await materialize({ source_warehouse: "bigdb", sql: "SELECT n FROM t", target_table: "big_t" })
    expect(r.rows).toBe(5000)
    const count = await scratchSql("SELECT count(*), sum(n) FROM big_t")
    expect(Number(count.rows[0][0])).toBe(5000)
    expect(Number(count.rows[0][1])).toBe(12_502_500)
  })

  test("type mapping: NULL, big ints, booleans, timestamps, nested JSON, doubles", async () => {
    const r = await materialize({
      source_warehouse: "scratch",
      sql: `SELECT * FROM (VALUES
        (1, 9223372036854775807::BIGINT, TRUE,  TIMESTAMP '2024-05-06 07:08:09.123', {'a': 1, 'b': [1, 2]}, 1.5, 'it''s'),
        (2, NULL,                          NULL,  NULL,                                NULL,                 2,   NULL)
      ) AS v(id, big, flag, ts, nested, dbl, txt)`,
      target_table: "typed",
    })
    const types = Object.fromEntries(r.columns.map((c) => [c.name, c.type]))
    expect(types).toEqual({
      id: "BIGINT",
      big: "BIGINT",
      flag: "BOOLEAN",
      ts: "TIMESTAMP",
      nested: "VARCHAR",
      dbl: "DOUBLE",
      txt: "VARCHAR",
    })
    const rows = (await scratchSql("SELECT big::VARCHAR, flag, ts::VARCHAR, nested, dbl, txt FROM typed ORDER BY id"))
      .rows
    expect(rows[0][0]).toBe("9223372036854775807")
    expect(rows[0][1]).toBe(true)
    expect(rows[0][2]).toBe("2024-05-06 07:08:09.123")
    expect(JSON.parse(rows[0][3])).toEqual({ a: 1, b: [1, 2] })
    expect(rows[0][4]).toBe(1.5)
    expect(rows[0][5]).toBe("it's")
    expect(rows[1]).toEqual([null, null, null, null, 2, null])
  })

  test("SQLite source: ints stay BIGINT, reals DOUBLE, NULLs survive", async () => {
    const r = await materialize({
      source_warehouse: "ordersdb",
      sql: "SELECT id, amount, note FROM orders ORDER BY id",
      target_table: "o",
    })
    expect(r.columns.map((c) => c.type)).toEqual(["BIGINT", "DOUBLE", "VARCHAR"])
    const rows = (await scratchSql("SELECT note FROM o WHERE id = 2")).rows
    expect(rows).toEqual([[null]])
  })

  test("mode semantics: create refuses an existing table, replace overwrites, append adds", async () => {
    const base = { source_warehouse: "ordersdb", sql: "SELECT id FROM orders WHERE id <= 2", target_table: "m" }
    await materialize(base)
    await expect(materialize(base)).rejects.toThrow(/already exists/)

    const appended = await materialize({ ...base, sql: "SELECT id FROM orders WHERE id > 2", mode: "append" })
    expect(appended.rows).toBe(2)
    expect(appended.total_rows).toBe(4)

    const replaced = await materialize({ ...base, sql: "SELECT id FROM orders WHERE id = 1", mode: "replace" })
    expect(replaced.total_rows).toBe(1)
    expect(Number((await scratchSql("SELECT count(*) FROM m")).rows[0][0])).toBe(1)

    // append to a missing table creates it
    const fresh = await materialize({ ...base, target_table: "m2", mode: "append" })
    expect(fresh.total_rows).toBe(2)
  })

  test("concurrent materializations to different tables both commit", async () => {
    const results = await Promise.all(
      ["parallel_a", "parallel_b"].map((target_table) =>
        materialize({ source_warehouse: "ordersdb", sql: "SELECT id FROM orders", target_table }),
      ),
    )
    expect(results.map((r) => r.total_rows)).toEqual([4, 4])
    expect(
      (await scratchSql("SELECT count(*) FROM parallel_a UNION ALL SELECT count(*) FROM parallel_b")).rows.map((r) =>
        Number(r[0]),
      ),
    ).toEqual([4, 4])
  })

  test("concurrent create of the same table has exactly one winner", async () => {
    const results = await Promise.allSettled(
      [1, 2].map((id) =>
        materialize({ source_warehouse: "ordersdb", sql: `SELECT ${id} AS id`, target_table: "one_winner" }),
      ),
    )
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult
    expect(failed.reason.message).toMatch(/already exists/)
    expect((await scratchSql("SELECT count(*) FROM one_winner")).rows.map((r) => Number(r[0]))).toEqual([1])
  })

  test("append with an incompatible column fails and leaves the table untouched", async () => {
    await materialize({ source_warehouse: "ordersdb", sql: "SELECT id FROM orders", target_table: "keep" })
    await expect(
      materialize({
        source_warehouse: "ordersdb",
        sql: "SELECT id, note FROM orders",
        target_table: "keep",
        mode: "append",
      }),
    ).rejects.toThrow(/no column/)
    expect(Number((await scratchSql("SELECT count(*) FROM keep")).rows[0][0])).toBe(4)
  })

  test("rejects unsafe target_table identifiers", async () => {
    for (const bad of ["a b", "x;DROP TABLE y", 'q"q', "main.t", "1abc", "", "a".repeat(64), "other.schema.t"]) {
      await expect(materialize({ source_warehouse: "ordersdb", sql: "SELECT 1", target_table: bad })).rejects.toThrow(
        /Invalid target_table/,
      )
    }
  })

  test("refuses a non-read source query and does not run it", async () => {
    for (const sql of [
      "INSERT INTO orders VALUES (9, 9, 9, 'x', 1)",
      "DELETE FROM orders",
      "DROP TABLE orders",
      "SELECT 1; DELETE FROM orders",
    ]) {
      await expect(materialize({ source_warehouse: "ordersdb", sql, target_table: "nope" })).rejects.toThrow(
        /only reads/,
      )
    }
    const db = new Database(ordersDb, { readonly: true })
    expect((db.query("SELECT count(*) AS n FROM orders").get() as any).n).toBe(4)
    db.close()
  })

  for (const source_warehouse of ["ordersdb", "scratch", "pg_source"]) {
    test(`${source_warehouse}: refuses read-shaped writes before execution, preserving the source file`, async () => {
      Registry.setConfigs({
        ordersdb: { type: "sqlite", path: ordersDb },
        pg_source: { type: "postgres" },
      })
      const hash = () => createHash("sha256").update(fs.readFileSync(ordersDb)).digest("hex")
      const before = hash()
      const execute = spyOn(await getScratch(), "execute")
      const get = spyOn(Registry, "get").mockResolvedValue({ execute } as any)
      try {
        for (const sql of [
          "WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d",
          "SELECT 1 INTO new_table",
          "SELECT nextval('my_seq')",
          "SELECT lo_unlink(123)",
        ]) {
          await expect(materialize({ source_warehouse, sql, target_table: "refused" })).rejects.toThrow(/only reads/)
        }
        expect(get).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
        expect(hash()).toBe(before)
      } finally {
        get.mockRestore()
        execute.mockRestore()
      }
    })
  }

  test("preserves NUL-bearing text distinctly from text without a NUL", async () => {
    const result = await materialize({
      source_warehouse: "scratch",
      sql: "SELECT 'a' || chr(0) || 'b' AS note UNION ALL SELECT 'ab' AS note",
      target_table: "nul_text",
    })
    expect(result.rows).toBe(2)
    const rows = (await scratchSql("SELECT note FROM nul_text ORDER BY note")).rows
    expect(rows).toEqual([["a\0b"], ["ab"]])
    expect(Number((await scratchSql("SELECT count(DISTINCT note) FROM nul_text")).rows[0][0])).toBe(2)
  })

  test("Postgres sources run as a bounded derived table and refuse modifying forms lexically", async () => {
    Registry.setConfigs({ pg_source: { type: "postgres" } })
    const seen: string[] = []
    const fakeSource = {
      execute: async (sql: string) => {
        seen.push(sql)
        return { columns: ["n"], rows: [[1]], row_count: 1, truncated: false }
      },
    }
    const real = Registry.get.bind(Registry)
    const get = spyOn(Registry, "get").mockImplementation(async (name: string) =>
      name === "pg_source" ? (fakeSource as any) : real(name),
    )
    try {
      const r = await materialize({ source_warehouse: "pg_source", sql: "SELECT 1 AS n", target_table: "pg_ok" })
      expect(r.rows).toBe(1)
      // The statement reaches Postgres wrapped as a derived table: a data-modifying CTE or
      // SELECT INTO inside it is rejected by the server itself.
      expect(seen).toHaveLength(3)
      expect(seen[0]).toMatch(
        /^SELECT count\(\*\) FROM \(SELECT 1 AS __one FROM \(\s*SELECT 1 AS n\s*\) AS __m LIMIT 2000001\) AS __c$/,
      )
      expect(seen[1]).toMatch(/\) AS __sql_materialize_source LIMIT 1000$/)
      expect(seen[2]).toMatch(/^SELECT \* FROM \(\s*SELECT 1 AS n\s*\) AS __sql_materialize_source LIMIT \d+$/)
      for (const sql of [
        "WITH d AS (DELETE FROM accounts RETURNING *) SELECT * FROM d",
        "SELECT 1 INTO new_table",
        "SELECT nextval('my_seq')",
      ]) {
        await expect(materialize({ source_warehouse: "pg_source", sql, target_table: "pg_bad" })).rejects.toThrow(
          /only reads/,
        )
      }
      expect(seen).toHaveLength(3)
    } finally {
      get.mockRestore()
    }
  })

  test("a conflicting configured scratch destination refuses materialization", async () => {
    Registry.setConfigs({
      ordersdb: { type: "sqlite", path: ordersDb },
      scratch: { type: "postgres", database: "user_data" },
    })
    const source = await Registry.get("ordersdb")
    const execute = spyOn(source, "execute")
    try {
      await expect(
        materialize({ source_warehouse: "ordersdb", sql: "SELECT id FROM orders", target_table: "conflict" }),
      ).rejects.toThrow(/reserved.*scratch/)
      expect(execute).not.toHaveBeenCalled()
    } finally {
      execute.mockRestore()
    }
  })

  test("the tool reports a refusal as an error result, not a throw", async () => {
    const tool = await initTool(SqlMaterializeTool)
    const r = await tool.execute(
      { source_warehouse: "ordersdb", sql: "DELETE FROM orders", target_table: "t" },
      ctx as any,
    )
    expect(r.title).toContain("ERROR")
    expect(r.output).toContain("only reads")
  })

  test("row cap exceeded fails cleanly and creates nothing", async () => {
    await expect(
      materialize({ source_warehouse: "ordersdb", sql: "SELECT * FROM orders", target_table: "capped", max_rows: 3 }),
    ).rejects.toThrow(/row cap of 3/)
    const t = await scratchSql("SELECT count(*) FROM information_schema.tables WHERE table_name = 'capped'")
    expect(Number(t.rows[0][0])).toBe(0)
  })

  test("preflight counts only cap + 1 rows and refuses overflow before sampling", async () => {
    const seen: string[] = []
    const get = fakePostgres(async (sql) => {
      seen.push(sql)
      if (/^SELECT count\(\*\)/i.test(sql)) {
        return { columns: ["count"], rows: [["4"]], row_count: 1, truncated: false }
      }
      throw new Error("Sampling and extraction must not run")
    })
    try {
      await expect(
        materialize({
          source_warehouse: "pg_source",
          sql: "SELECT description FROM languages",
          target_table: "large",
          max_rows: 3,
        }),
      ).rejects.toThrow(/more than 3 rows.*row cap of 3/)
      expect(seen).toEqual([
        "SELECT count(*) FROM (SELECT 1 AS __one FROM (\nSELECT description FROM languages\n) AS __m LIMIT 4) AS __c",
      ])
      expect(
        Number(
          (await scratchSql("SELECT count(*) FROM information_schema.tables WHERE table_name = 'large'")).rows[0][0],
        ),
      ).toBe(0)
    } finally {
      get.mockRestore()
    }
  })

  test("preflight refuses wide rows above max_bytes before extraction", async () => {
    const seen: string[] = []
    const get = fakePostgres(async (sql) => {
      seen.push(sql)
      if (/^SELECT count\(\*\)/i.test(sql)) {
        return { columns: ["count"], rows: [[20]], row_count: 1, truncated: false }
      }
      if (sql.endsWith("LIMIT 1000")) {
        return { columns: ["description"], rows: [["x".repeat(1024)]], row_count: 1, truncated: false }
      }
      throw new Error("Extraction must not run")
    })
    try {
      const tool = await initTool(SqlMaterializeTool)
      const result = await tool.execute(
        {
          source_warehouse: "pg_source",
          sql: "SELECT description FROM languages",
          target_table: "wide",
          max_rows: 30,
          max_bytes: 1024,
        },
        ctx as any,
      )
      expect(result.title).toContain("ERROR")
      expect(result.output).toContain("20 rows")
      expect(result.output).toContain("max_bytes")
      expect(result.output).toContain("20.08 KiB")
      expect(result.output).toContain("1.00 KiB bound")
      expect(seen).toHaveLength(2)
      expect(seen[0]).toBe(
        "SELECT count(*) FROM (SELECT 1 AS __one FROM (\nSELECT description FROM languages\n) AS __m LIMIT 31) AS __c",
      )
      expect(seen[1]).toMatch(/LIMIT 1000$/)
    } finally {
      get.mockRestore()
    }
  })

  for (const { type, countSql } of [
    {
      type: "oracle",
      countSql: "SELECT count(*) FROM (SELECT 1 AS __one FROM (\nSELECT n FROM numbers\n) __m WHERE ROWNUM <= 4) __c",
    },
    {
      type: "sqlserver",
      countSql: "SELECT count(*) FROM (SELECT TOP (4) 1 AS __one FROM (\nSELECT n FROM numbers\n) AS __m) AS __c",
    },
  ]) {
    test(`preflight uses a bounded count for ${type} before refusing overflow`, async () => {
      const seen: string[] = []
      const get = fakePostgres(async (sql) => {
        seen.push(sql)
        return { columns: ["count"], rows: [[4]], row_count: 1, truncated: false }
      })
      Registry.setConfigs({ pg_source: { type } })
      try {
        await expect(
          materialize({ source_warehouse: "pg_source", sql: "SELECT n FROM numbers", target_table: "large", max_rows: 3 }),
        ).rejects.toThrow(/more than 3 rows.*row cap of 3/)
        expect(seen).toEqual([countSql])
      } finally {
        get.mockRestore()
      }
    })
  }

  test("failed count clamps the extraction to 200,000 rows and reports the fallback", async () => {
    const seen: { sql: string; limit: number | undefined }[] = []
    const get = fakePostgres(async (sql, limit) => {
      seen.push({ sql, limit })
      if (/^SELECT count\(\*\)/i.test(sql)) throw new Error("count subqueries are unsupported")
      return { columns: ["description"], rows: [["kept"]], row_count: 1, truncated: false }
    })
    try {
      const tool = await initTool(SqlMaterializeTool)
      const result = await tool.execute(
        { source_warehouse: "pg_source", sql: "SELECT description FROM languages", target_table: "fallback" },
        ctx as any,
      )
      expect(result.metadata.error).toBeUndefined()
      expect(result.metadata.rowCount).toBe(1)
      expect(result.output).toMatch(/pre.?flight|count/i)
      expect(result.output).toContain("200,000")
      expect(seen).toHaveLength(2)
      expect(seen[1].limit).toBe(200_001)
      expect(seen[1].sql).toMatch(/LIMIT 200001$/)
      expect((await withScratchSession(ctx.sessionID, () => scratchSql("SELECT description FROM fallback"))).rows).toEqual([["kept"]])
    } finally {
      get.mockRestore()
    }
  })

  for (const { name, max_bytes, count, width, bound } of [
    { name: "default 256 MiB budget", max_bytes: undefined, count: 300_000, width: 1024, bound: "256.00 MiB" },
    { name: "hard 2 GiB ceiling", max_bytes: 4 * 1024 ** 3, count: 1_000_000, width: 4096, bound: "2.0 GiB" },
  ]) {
    test(`preflight applies the ${name} below the row cap`, async () => {
      const previous = process.env.ALTIMATE_SCRATCH_MAX_BYTES
      delete process.env.ALTIMATE_SCRATCH_MAX_BYTES
      const seen: string[] = []
      const get = fakePostgres(async (sql) => {
        seen.push(sql)
        if (/^SELECT count\(\*\)/i.test(sql)) {
          return { columns: ["count"], rows: [[count]], row_count: 1, truncated: false }
        }
        if (sql.endsWith("LIMIT 1000")) {
          return { columns: ["description"], rows: [["x".repeat(width)]], row_count: 1, truncated: false }
        }
        throw new Error("Extraction must not run")
      })
      try {
        await expect(
          materialize({
            source_warehouse: "pg_source",
            sql: "SELECT description FROM languages",
            target_table: "byte_ceiling",
            max_bytes,
          }),
        ).rejects.toThrow(`${bound} bound`)
        expect(seen).toHaveLength(2)
        expect(seen[0]).toMatch(/^SELECT count\(\*\)/)
        expect(seen[1]).toMatch(/LIMIT 1000$/)
      } finally {
        get.mockRestore()
        if (previous === undefined) delete process.env.ALTIMATE_SCRATCH_MAX_BYTES
        else process.env.ALTIMATE_SCRATCH_MAX_BYTES = previous
      }
    })
  }

  test("the tool rejects max_bytes above the hard 2 GiB ceiling before querying", async () => {
    const seen: string[] = []
    const get = fakePostgres(async (sql) => {
      seen.push(sql)
      throw new Error("No query should run")
    })
    try {
      const tool = await initTool(SqlMaterializeTool)
      await expect(
        tool.execute(
          {
            source_warehouse: "pg_source",
            sql: "SELECT 1 AS n",
            target_table: "invalid_cap",
            max_bytes: 2 * 1024 ** 3 + 1,
          },
          ctx as any,
        ),
      ).rejects.toThrow(/invalid arguments|SchemaError|Expected/i)
      expect(seen).toHaveLength(0)
    } finally {
      get.mockRestore()
    }
  })

  test("failed count keeps a smaller row cap and includes the fallback warning on refusal", async () => {
    const seen: { sql: string; limit: number | undefined }[] = []
    const get = fakePostgres(async (sql, limit) => {
      seen.push({ sql, limit })
      if (/^SELECT count\(\*\)/i.test(sql)) throw new Error("count subqueries are unsupported")
      return { columns: ["n"], rows: [[1], [2], [3], [4]], row_count: 4, truncated: false }
    })
    try {
      const tool = await initTool(SqlMaterializeTool)
      const result = await tool.execute(
        { source_warehouse: "pg_source", sql: "SELECT n FROM numbers", target_table: "fallback_small", max_rows: 3 },
        ctx as any,
      )
      expect(result.title).toContain("ERROR")
      expect(result.output).toContain("row cap of 3")
      expect(result.output).toMatch(/pre.?flight/i)
      expect(result.output).toContain("count subqueries are unsupported")
      expect(seen).toHaveLength(2)
      expect(seen[1].limit).toBe(4)
      expect(seen[1].sql).toMatch(/LIMIT 4$/)
    } finally {
      get.mockRestore()
    }
  })

  test("small materialization with both caps preserves rows in the real scratch engine", async () => {
    const result = await materialize({
      source_warehouse: "ordersdb",
      sql: "SELECT id, note FROM orders ORDER BY id",
      target_table: "small",
      max_rows: 4,
      max_bytes: 256,
    })
    expect(result.rows).toBe(4)
    expect((await scratchSql("SELECT id, note FROM small ORDER BY id")).rows).toEqual([
      [1n, "first"],
      [2n, null],
      [3n, "third"],
      [4n, "orphan"],
    ])
  })

  test("passes the source deadline to count, sample and extraction", async () => {
    const seen: { sql: string; timeout: number | undefined }[] = []
    const get = fakePostgres(async (sql, _limit, _binds, options) => {
      seen.push({ sql, timeout: options?.queryTimeoutMs })
      return { columns: ["n"], rows: [[1]], row_count: 1, truncated: false }
    })
    try {
      await materialize({
        source_warehouse: "pg_source",
        sql: "SELECT 1 AS n",
        target_table: "deadline",
        query_timeout_ms: 4321,
      })
      expect(seen).toHaveLength(3)
      expect(seen[0].sql).toMatch(/^SELECT count\(\*\)/)
      expect(seen[1].sql).toMatch(/LIMIT 1000$/)
      expect(seen.map((query) => query.timeout)).toEqual([4321, 4321, 4321])
    } finally {
      get.mockRestore()
    }
  })

  test("a preflight timeout stops before sampling or extraction", async () => {
    const seen: string[] = []
    const get = fakePostgres(async (sql) => {
      seen.push(sql)
      throw new QueryTimeoutError({ engine: "postgres", timeoutMs: 4321, cancelled: true })
    })
    try {
      await expect(
        materialize({
          source_warehouse: "pg_source",
          sql: "SELECT description FROM languages",
          target_table: "timed_out",
          query_timeout_ms: 4321,
        }),
      ).rejects.toBeInstanceOf(QueryTimeoutError)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatch(/^SELECT count\(\*\)/)
    } finally {
      get.mockRestore()
    }
  })

  test("a truncated extraction is refused even when the preflight count is below the cap", async () => {
    const get = fakePostgres(async (sql) => ({
      columns: ["n"],
      rows: [[1]],
      row_count: 1,
      truncated: !/^SELECT count\(\*\)/i.test(sql) && !sql.endsWith("LIMIT 1000"),
    }))
    try {
      await expect(
        materialize({ source_warehouse: "pg_source", sql: "SELECT 1 AS n", target_table: "truncated", max_rows: 3 }),
      ).rejects.toThrow(/row cap of 3/)
    } finally {
      get.mockRestore()
    }
  })

  test("the byte backstop refuses an extraction wider than the preflight sample", async () => {
    const seen: string[] = []
    const get = fakePostgres(async (sql) => {
      seen.push(sql)
      if (/^SELECT count\(\*\)/i.test(sql)) {
        return { columns: ["count"], rows: [[1]], row_count: 1, truncated: false }
      }
      return {
        columns: ["description"],
        rows: [[sql.endsWith("LIMIT 1000") ? "x" : "x".repeat(128)]],
        row_count: 1,
        truncated: false,
      }
    })
    try {
      await expect(
        materialize({
          source_warehouse: "pg_source",
          sql: "SELECT description FROM languages",
          target_table: "underestimated",
          max_bytes: 32,
        }),
      ).rejects.toThrow(/32 bytes bound/)
      expect(seen).toHaveLength(3)
    } finally {
      get.mockRestore()
    }
  })

  test("bounds the source fetch to cap + 1 when rows increase after preflight and passes the deadline", async () => {
    const source = await Registry.get("ordersdb")
    const original = source.execute.bind(source)
    const fetched: number[] = []
    const execute = spyOn(source, "execute").mockImplementation(async (sql, limit, binds, options) => {
      expect(options?.noLimit).not.toBe(true)
      expect(options?.queryTimeoutMs).toBe(4321)
      if (/^SELECT count\(\*\)/i.test(sql)) {
        return { columns: ["count"], rows: [[2]], row_count: 1, truncated: false }
      }
      if (sql.endsWith("LIMIT 1000")) return original(sql, limit, binds, options)
      expect(limit).toBe(3)
      expect(sql).toMatch(/\) AS __sql_materialize_source LIMIT 3$/)
      const result = await original(sql, limit, binds, options)
      fetched.push(result.rows.length)
      return result
    })
    try {
      for (const sql of [
        "SELECT id FROM orders LIMIT 99999",
        "WITH x AS (SELECT id FROM orders LIMIT 99999) SELECT * FROM x; -- trailing comment",
        "SELECT id, 'LIMIT' AS label FROM orders",
      ]) {
        await expect(
          materialize({
            source_warehouse: "ordersdb",
            sql,
            target_table: "bounded",
            max_rows: 2,
            query_timeout_ms: 4321,
          }),
        ).rejects.toThrow(/row cap of 2/)
      }
      expect(fetched).toEqual([3, 3, 3])
    } finally {
      execute.mockRestore()
    }
  })

  test("a fake source fetch observes the sentinel bound and omitted common deadline", async () => {
    const source = await Registry.get("ordersdb")
    let fetched = 0
    const execute = spyOn(source, "execute").mockImplementation(async (sql, limit, _binds, options) => {
      expect(options?.noLimit).not.toBe(true)
      expect(options).toHaveProperty("queryTimeoutMs", undefined)
      if (/^SELECT count\(\*\)/i.test(sql)) {
        return { columns: ["count"], rows: [[3]], row_count: 1, truncated: false }
      }
      if (sql.endsWith("LIMIT 1000")) {
        return { columns: ["id"], rows: [[0]], row_count: 1, truncated: false }
      }
      expect(limit).toBe(4)
      const rows = Array.from({ length: Math.min(100, limit!) }, (_, n) => [n])
      fetched = rows.length
      return { columns: ["id"], rows, row_count: rows.length, truncated: false }
    })
    try {
      await expect(
        materialize({
          source_warehouse: "ordersdb",
          sql: "SELECT id FROM orders",
          target_table: "fake_bound",
          max_rows: 3,
        }),
      ).rejects.toThrow(/row cap of 3/)
      expect(fetched).toBe(4)
    } finally {
      execute.mockRestore()
    }
  })

  test("byte bound exceeded fails cleanly", async () => {
    await expect(
      materialize({ source_warehouse: "ordersdb", sql: "SELECT * FROM orders", target_table: "fat", max_bytes: 10 }),
    ).rejects.toThrow(/10 bytes bound/)
  })

  test("unknown source warehouse is reported", async () => {
    const tool = await initTool(SqlMaterializeTool)
    const r = await tool.execute({ source_warehouse: "nowhere", sql: "SELECT 1", target_table: "t" }, ctx as any)
    expect(r.title).toContain("ERROR")
    expect(r.output).toContain("not found")
  })

  test("a zero-row result with no columns reports without creating a table", async () => {
    const tool = await initTool(SqlMaterializeTool)
    const r = await tool.execute(
      { source_warehouse: "ordersdb", sql: "SELECT * FROM orders WHERE id < 0", target_table: "empty_t" },
      ctx as any,
    )
    expect(r.metadata.materialized).toBe(false)
    expect(r.output).toContain("0 rows")
  })

  test("derives a table from scratch itself", async () => {
    await materialize({ source_warehouse: "ordersdb", sql: "SELECT id, amount FROM orders", target_table: "base" })
    const r = await materialize({
      source_warehouse: "scratch",
      sql: "SELECT id FROM base WHERE amount > 3",
      target_table: "derived",
    })
    expect(r.rows).toBe(2)
  })

  test("MongoDB sources accept only read commands", async () => {
    Registry.setConfigs({ mongo1: { type: "mongodb", host: "localhost" } })
    await expect(
      materialize({
        source_warehouse: "mongo1",
        sql: '{"command":"dropCollection","collection":"c"}',
        target_table: "m",
      }),
    ).rejects.toThrow(/not allowed/)
    await expect(materialize({ source_warehouse: "mongo1", sql: "SELECT 1", target_table: "m" })).rejects.toThrow(
      /JSON command/,
    )
  })

  test("a failed source query creates nothing", async () => {
    const tool = await initTool(SqlMaterializeTool)
    const r = await tool.execute(
      { source_warehouse: "ordersdb", sql: "SELECT * FROM no_such_table", target_table: "t" },
      ctx as any,
    )
    expect(r.title).toContain("ERROR")
  })
})
