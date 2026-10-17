import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { initTool } from "../tool-fixture"
import * as Dispatcher from "../../../src/altimate/native/dispatcher"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { registerAll } from "../../../src/altimate/native/connections/register"
import { SchemaInspectTool } from "../../../src/altimate/tools/schema-inspect"
import { createRequire } from "module"
import { buildProfileSql, profileDocuments, valueShape } from "../../../src/altimate/tools/schema-values"

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
  Registry.setConfigs({ w: { type: engine } })
  Dispatcher.register("warehouse.list" as any, async () => ({ warehouses: [{ name: "w", type: engine }] }))
  Dispatcher.register("schema.inspect" as any, async () => ({
    table: "t", schema_name: engine === "postgres" ? "public" : "main", columns: COLUMNS,
  }))
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
  Registry.reset()
  Dispatcher.reset()
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})

afterAll(() => {
  Registry.reset()
  registerAll()
})

function expectAppendix(output: string) {
  expect(output).toContain("Value samples:")
  expect(output).toContain("id: 60 distinct")
  expect(output).toContain("id: 60 distinct, unique in sample\n")
  expect(output).toMatch(/region: 4 distinct — (north|south|east|west) \(15\)(, (north|south|east|west) \(15\)){3}/)
  expect(output).toMatch(/customer_code: 60 distinct, unique in sample, e\.g\. "[^"]+", "[^"]+", "[^"]+", shape /)
  expect(output).toContain("shape ` A-9+` 40%, `A-9+` 40%, `a9+` 20%")
  expect(output).toContain("note: 1 distinct — x (30), 50% null")
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
      expect(calls[0]).toContain('FROM "main"."t"')
      expect(result.metadata.success).toBe(true)
    })

    test("whitespace and case variants stay visible in the listed values", async () => {
      const small = new Database(":memory:")
      small.run("CREATE TABLE t (id INTEGER, region TEXT, customer_code TEXT, note TEXT)")
      small.run("INSERT INTO t VALUES (1, 'a', 'C-00017', NULL), (2, 'a', 'c00018', NULL), (3, 'a', ' C-00019', NULL)")
      install("sqlite", async (sql) => small.query(sql).values() as unknown[][], [])
      const result = await inspect({})
      small.close()
      expect(result.output).toMatch(/customer_code: 3 distinct, unique in sample — .*" C-00019"/)
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
        expect(result.output).toContain("region: 1 distinct — left␟right (1)\n")
        expect(result.output).toContain('customer_code: 1 distinct — "" (1)\n')
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
      Dispatcher.register("warehouse.list" as any, async () => ({ warehouses: [{ name: "w", type: "snowflake" }] }))
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
        expect(calls[0]).toContain("array_agg(CAST(pn AS TEXT)")
        expect(calls[0]).toContain('FROM "main"."t"')
        await conn.execute("DELETE FROM t", 1000)
        await conn.execute("INSERT INTO t VALUES (1, 'left␟right', '', NULL)", 1000)
        const edgeValues = await inspect({})
        expect(edgeValues.output).toContain("region: 1 distinct — left␟right (1)\n")
        expect(edgeValues.output).toContain('customer_code: 1 distinct — "" (1)\n')
      } finally {
        await conn.close()
      }
    })
  })

  test("postgres uses array_agg and preserves quoted identifiers containing an aggregate name", async () => {
    const calls: string[] = []
    const column = "group_concat(value"
    install("postgres", async () => [[column, 1, 1, 1, ["1:left␟right"]]], calls)
    Dispatcher.register("schema.inspect" as any, async () => ({
      table: "t", schema_name: "sales", columns: [{ name: column, data_type: "TEXT", nullable: false }],
    }))
    const result = await inspect({ table: "sales.t" })
    expect(calls[0]).toContain("array_agg(CAST(pn AS TEXT)")
    expect(calls[0]).toContain('CAST("group_concat(value" AS TEXT)')
    expect(calls[0]).toContain("'group_concat(value' AS col")
    expect(calls[0]).toContain('FROM "sales"."t"')
    expect(result.output).toContain("group_concat(value: 1 distinct — left␟right (1)")
  })

  test.each(["postgres", "postgresql", "sqlite", "duckdb"])(
    "profiling protects PostgreSQL reads and preserves other connector options (%s)",
    async (type) => {
      Registry.setConfigs({ w: { type } })
      registerAll()
      Dispatcher.register("schema.inspect" as any, async () => ({
        table: "t", schema_name: "public", warehouse: "w", columns: COLUMNS,
      }))
      const execute = mock(async () => ({
        columns: ["col", "total", "nonnull", "ndistinct", "vals"],
        rows: [["region", 1, 1, 1, ["1:north"]]],
        row_count: 1,
        truncated: false,
      }))
      const get = spyOn(Registry, "get").mockResolvedValue({ execute } as any)
      try {
        const result = await inspect({ warehouse: "w" })
        expect(result.output).toContain("region: 1 distinct — north (1)")
        expect(execute).toHaveBeenCalledTimes(1)
        const [sql, limit, binds, options] = execute.mock.calls[0] as unknown as [string, number, unknown, Record<string, unknown>]
        expect(sql).toContain('FROM "public"."t"')
        expect(limit).toBe(41)
        expect(binds).toBeUndefined()
        expect(options.queryTimeoutMs).toBe(15_000)
        if (type === "postgres" || type === "postgresql") expect(options.readOnly).toBe(true)
        else expect(options).not.toHaveProperty("readOnly")
      } finally {
        get.mockRestore()
      }
    },
  )

  test("profiling is capped at 40 columns", () => {
    const cols = Array.from({ length: 60 }, (_, i) => ({ name: `c${i}`, data_type: "TEXT" }))
    expect(buildProfileSql('"t"', cols.slice(0, 40)).split("UNION ALL")).toHaveLength(40)
  })
})

const RICH_COLUMNS = ["id", "status", "cpc", "tag", "abstract", "title", "name"].map((name) => ({
  name,
  data_type: name === "id" ? "INTEGER" : "TEXT",
  nullable: true,
  primary_key: name === "id",
}))
const NAMES = Array.from({ length: 25 }, (_, i) => String.fromCharCode(65 + (i % 25)) + "ob".repeat(1 + (i % 3)) + "by")
const TITLE_FORMS = [(i: number) => `Alpha ${i}`, (i: number) => `alpha-${i}`, (i: number) => `A, b ${i}`, (i: number) => `A b c ${i}`,
  (i: number) => `Q(${i})`, (i: number) => `x_${i}_y`, (i: number) => `R${i}/${i}`, (i: number) => `N.${i}`]

/** 200 rows with skewed statuses, patent-like codes, a skewed tag, long abstracts and free-form titles. */
function richSeed(): string[] {
  const rows: string[] = []
  for (let i = 0; i < 200; i++) {
    const status = i < 120 ? "open" : i < 170 ? "closed" : "pending"
    const tag = i < 80 ? "alpha" : i < 120 ? "beta" : i < 140 ? "gamma" : `t${i}`
    const abstract = `This abstract describes item number ${i} in a rather long and detailed manner, so the field is clearly prose. ${"It keeps going with more explanatory sentences for the reader. ".repeat(3)}`
    rows.push(
      `INSERT INTO t VALUES (${i}, '${status}', 'H01M${i % 9}/${9000 + i}', '${tag}', '${abstract}', '${TITLE_FORMS[i % 8]!(i % 6)}', '${NAMES[i % 25]}')`,
    )
  }
  return ["CREATE TABLE t (id INTEGER, status TEXT, cpc TEXT, tag TEXT, abstract TEXT, title TEXT, name TEXT)", ...rows]
}

function expectRichProfile(output: string) {
  expect(output).toContain("id: 200 distinct, unique in sample\n")
  // ranked by frequency, not alphabetically
  expect(output).toContain("status: 3 distinct — open (120), closed (50), pending (30)\n")
  // collapsed run classes: H01M4/9066 -> A9+A9/9+
  expect(output).toContain("cpc: 200 distinct, unique in sample, e.g.")
  expect(output).toContain("shape `A9+A9/9+`")
  // high cardinality shows the most frequent values with counts
  expect(output).toContain('tag: 63 distinct, e.g. "alpha" (80), "beta" (40), "gamma" (20)')
  // long prose: one 160-character example, the rest clipped at 40, and no shape
  const abstract = output.split("\n").find((l) => l.startsWith("abstract:"))!
  expect(abstract).toContain("unique in sample")
  expect(abstract).not.toContain("shape")
  const quoted = abstract.match(/"[^"]*"/g)!
  expect(quoted[0]!.length - 2).toBe(161)
  expect(quoted[1]!.length - 2).toBe(41)
  // free-form text with many shapes and plain single-shape words get no shape
  expect(output.split("\n").find((l) => l.startsWith("title:"))).not.toContain("shape")
  expect(output.split("\n").find((l) => l.startsWith("name:"))).not.toContain("shape")
}

describe("schema_inspect richer value profiles", () => {
  const useRichSchema = () =>
    Dispatcher.register("schema.inspect" as any, async () => ({ table: "t", schema_name: "main", columns: RICH_COLUMNS }))

  test("sqlite: frequency order, uniqueness, shapes and long-text examples", async () => {
    const db = new Database(":memory:")
    try {
      richSeed().forEach((q) => db.run(q))
      const calls: string[] = []
      install("sqlite", async (sql) => db.query(sql).values() as unknown[][], calls)
      useRichSchema()
      const result = await inspect({})
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain("json_group_array(CAST(pn AS TEXT) || ':' || SUBSTR(pv, 1, 200))")
      expect(calls[0]).toContain("ORDER BY pn DESC, pv LIMIT 50")
      expectRichProfile(result.output)
    } finally {
      db.close()
    }
  })

  test("duckdb: same profile from a real engine", async () => {
    const { connect } = await import("../../../../drivers/src/duckdb")
    const dir = (await import("fs")).mkdtempSync((await import("os")).tmpdir() + "/schemavals-rich-")
    const conn = await connect({ type: "duckdb", path: dir + "/t.duckdb", create: true } as any)
    try {
      await conn.connect()
      for (const q of richSeed()) await conn.execute(q, 1000)
      const calls: string[] = []
      install("duckdb", async (sql) => (await conn.execute(sql, 1000)).rows as unknown[][], calls)
      useRichSchema()
      const result = await inspect({})
      expect(calls[0]).toContain("array_agg(CAST(pn AS TEXT) || ':' || SUBSTR(pv, 1, 200))")
      expectRichProfile(result.output)
    } finally {
      await conn.close()
    }
  })

  const LONG_COLUMNS = [{ name: "id", data_type: "INTEGER", nullable: true, primary_key: false }, { name: "body", data_type: "TEXT", nullable: true, primary_key: false }]
  const longSeed = () => [
    "CREATE TABLE t (id INTEGER, body TEXT)",
    ...Array.from({ length: 30 }, (_, i) => `INSERT INTO t VALUES (${i}, '${"p".repeat(200)}-${String(i).padStart(2, "0")}')`),
  ]
  const expectLongDistinct = (output: string) => {
    const line = output.split("\n").find((l) => l.startsWith("body:"))!
    expect(line).toStartWith("body: 30 distinct, unique in sample, e.g. ")
    expect(line).not.toMatch(/\(\d+\)/)
  }

  test("sqlite: long values sharing a 200-char prefix stay distinct", async () => {
    const db = new Database(":memory:")
    try {
      longSeed().forEach((q) => db.run(q))
      install("sqlite", async (sql) => db.query(sql).values() as unknown[][], [])
      Dispatcher.register("schema.inspect" as any, async () => ({ table: "t", schema_name: "main", columns: LONG_COLUMNS }))
      expectLongDistinct((await inspect({})).output)
    } finally {
      db.close()
    }
  })

  test("duckdb: long values sharing a 200-char prefix stay distinct", async () => {
    const { connect } = await import("../../../../drivers/src/duckdb")
    const dir = (await import("fs")).mkdtempSync((await import("os")).tmpdir() + "/schemavals-long-")
    const conn = await connect({ type: "duckdb", path: dir + "/t.duckdb", create: true } as any)
    try {
      await conn.connect()
      for (const q of longSeed()) await conn.execute(q, 1000)
      install("duckdb", async (sql) => (await conn.execute(sql, 1000)).rows as unknown[][], [])
      Dispatcher.register("schema.inspect" as any, async () => ({ table: "t", schema_name: "main", columns: LONG_COLUMNS }))
      expectLongDistinct((await inspect({})).output)
    } finally {
      await conn.close()
    }
  })

  test("postgres SQL uses standard aggregation and the same ranked subquery", () => {
    const sql = buildProfileSql('"public"."t"', [{ name: "status", data_type: "text" }], "postgres")
    expect(sql).toContain("array_agg(CAST(pn AS TEXT) || ':' || SUBSTR(pv, 1, 200))")
    expect(sql).toContain("GROUP BY CAST(\"status\" AS TEXT) ORDER BY pn DESC, pv LIMIT 50")
    expect(sql).toContain("SUBSTR(pv, 1, 200)")
    expect(sql).not.toContain("json_group_array")
    expect(sql).not.toMatch(/FILTER|WITHIN GROUP|STRING_AGG|GROUP_CONCAT/i)
  })

  test("a repeated key is not unique, and every-value-once is", async () => {
    const db = new Database(":memory:")
    try {
      db.run("CREATE TABLE t (id INTEGER, status TEXT, cpc TEXT, tag TEXT, abstract TEXT, title TEXT, name TEXT)")
      db.run("INSERT INTO t VALUES (1,'a','a','a','a','a','a'), (1,'b','b','b','b','b','b')")
      install("sqlite", async (sql) => db.query(sql).values() as unknown[][], [])
      useRichSchema()
      const result = await inspect({})
      expect(result.output).toContain("id: 1 distinct — 1 (2)")
      expect(result.output).toContain("status: 2 distinct, unique in sample — a, b")
    } finally {
      db.close()
    }
  })

  test("valueShape collapses runs of one class", () => {
    expect(valueShape("H01M4/9066")).toBe("A9+A9/9+")
    expect(valueShape("Hello, World 42")).toBe("Aa+, Aa+ 9+")
    expect(valueShape("ab-12")).toBe("a+-9+")
    expect(valueShape("")).toBe("")
  })
})

// Real BSON values: `bson` is a dependency of `mongodb`, which the drivers package owns.
const driversRequire = createRequire(new URL("../../../../drivers/package.json", import.meta.url))
const bson = createRequire(driversRequire.resolve("mongodb"))("bson") as any

describe("MongoDB value profile", () => {
  test("renders real BSON types, dotted keys, nested fields and unrenderable values", () => {
    const uuid = new bson.UUID("0f8fad5b-d9cb-469f-a165-70867728950e")
    const docs = Array.from({ length: 4 }, (_, i) => ({
      _id: new bson.ObjectId("65a1b2c3d4e5f60718293a4" + i),
      ref: i === 0 ? uuid : new bson.UUID(),
      price: bson.Decimal128.fromString("12.50"),
      big: bson.Long.fromString(`900719925474099${i}`),
      pattern: new bson.BSONRegExp("^ab+c", "i"),
      script: new bson.Code("function () { return 1 }"),
      stamp: new bson.Timestamp({ t: 1700000000, i: 7 }),
      created: new Date("2024-03-01T10:00:00Z"),
      raw: new bson.Binary(Buffer.from([1, 2, 3])),
      "a.b": i % 2 ? "x" : "y",
      address: { city: "Oslo", "x.y": i, geo: { lat: 1.5 } },
      items: [{ sku: "S1" }, { sku: i === 3 ? "S2" : "S1" }],
      min: new bson.MinKey(),
      tags: ["t"],
    }))
    const out = profileDocuments(docs)
    const line = (prefix: string) =>
      out.slice(out.indexOf("Value samples")).split("\n").find((l) => l.startsWith(prefix + ":"))
    expect(line("ref")).toBe(
      `ref: 4 distinct, unique in sample — ${docs.map((d) => d.ref.toString()).sort().join(", ")}`,
    )
    expect(line("ref")).toContain("0f8fad5b-d9cb-469f-a165-70867728950e")
    expect(line("ref")).not.toContain("NULL")
    expect(line("_id")).toBe("_id: 4 distinct, unique in sample — 65a1b2c3d4e5f60718293a40, 65a1b2c3d4e5f60718293a41, 65a1b2c3d4e5f60718293a42, 65a1b2c3d4e5f60718293a43")
    expect(line("price")).toBe("price: 1 distinct — 12.50 (4)")
    expect(line("big")).toBe(`big: 4 distinct, unique in sample — ${docs.map((d) => d.big.toString()).sort().join(", ")}`)
    expect(line("big")).toContain("9007199254740990, 9007199254740991")
    expect(docs[0]!.big.toString()).toMatch(/^\d{16}$/)
    expect(line("pattern")).toBe("pattern: 1 distinct — /^ab+c/i (4)")
    expect(line("script")).toBe("script: 1 distinct — function () { return 1 } (4)")
    expect(line("stamp")).toBe("stamp: 1 distinct — Timestamp(1700000000, 7) (4)")
    expect(line("created")).toBe("created: 1 distinct — 2024-03-01T10:00:00.000Z (4)")
    expect(line("min")).toBe("min: 1 distinct — MinKey (4)")
    expect(line("raw")).toBe("raw: values not profiled (binary)")
    // a real top-level key containing "." is found, and nested keys containing "." are too
    expect(line("a.b")).toBe("a.b: 2 distinct — x (2), y (2)")
    expect(line("address.x.y")).toBe("address.x.y: 4 distinct, unique in sample — 0, 1, 2, 3")
    expect(line("address.city")).toBe("address.city: 1 distinct — Oslo (4)")
    // MongoDB dot notation for array elements, with membership in the nested listing
    expect(line("items.sku")).toBe("items.sku: 2 distinct — S1 (7), S2 (1)")
    expect(out).toContain("Nested fields (sampled 4 docs):")
    expect(out).toContain("items.sku: string (array element)")
    expect(out).toContain("address.geo.lat: double")
    expect(out).not.toContain("[]")
    expect(out).not.toContain("[object")
    expect(line("tags")).toBeUndefined()
    expect(line("address")).toBeUndefined()
  })

  test("a path seen outside and then inside an array is an array element, never unique", () => {
    const docs = [{ tag: { id: "a" } }, { tag: [{ id: "b" }, { id: "c" }] }]
    const out = profileDocuments(docs)
    expect(out).toContain("tag.id: string (array element)")
    const line = out.slice(out.indexOf("Value samples")).split("\n").find((l) => l.startsWith("tag.id:"))!
    expect(line).not.toContain("unique in sample")
  })

  test("long values sharing a 200-char prefix stay distinct and unique", () => {
    const docs = Array.from({ length: 30 }, (_, i) => ({ body: `${"p".repeat(200)}-${String(i).padStart(2, "0")}` }))
    const line = profileDocuments(docs).split("\n").find((l) => l.startsWith("body:"))!
    expect(line).toStartWith("body: 30 distinct, unique in sample, e.g. ")
    expect(line).not.toMatch(/\(\d+\)/)
  })

  test("a field whose values are all null is NULL, one with unrenderable values is not", () => {
    const docs = [{ gone: null, blob: new bson.Binary(Buffer.from([1])) }, { gone: null }]
    const out = profileDocuments(docs)
    expect(out).toContain("gone: all NULL")
    expect(out).toContain("blob: values not profiled (binary)")
  })

  test("high-cardinality text shows frequent examples and a shape", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ code: i < 10 ? "ZZ-1" : `ab${i}-${100 + i}` }))
    const out = profileDocuments(many)
    expect(out).toContain('code: 21 distinct, e.g. "ZZ-1" (10),')
    expect(out).toContain("shape `a+9+-9+` 67%, `A+-9` 33%")
  })

  test("a 100-document sample is labelled approximate", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ k: i % 2 ? "a" : "b" }))
    const out = profileDocuments(many)
    expect(out).toContain("Value samples (first 100 documents):")
    expect(out).toContain("k: ~2 distinct — a (50), b (50)")
  })
})
