/**
 * dbt_map_relations: maps the tables of a raw SQL query to ref() and source() calls.
 *
 * The first block pins what altimate-core's extractMetadata returns for quoted, upper-case and
 * qualified names: it keeps only the last name part (quotes removed, case kept) and merges tables
 * that share it, so the matching rules read the qualifiers back from the SQL text.
 */
import { describe, test, expect, afterEach } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Effect } from "effect"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { Dispatcher } from "../../src/altimate/native"
import { initTool } from "./tool-fixture"
import {
  DbtMapRelationsTool,
  manifestRelations,
  mapRelations,
  matchParts,
  scanTableReferences,
  splitQualified,
} from "../../src/altimate/tools/dbt-map-relations"

async function tablesOf(sql: string, dialect: string): Promise<string[]> {
  const result = await Dispatcher.call("altimate_core.metadata", { sql, dialect })
  expect(result.success).toBe(true)
  return ((result.data ?? {}) as { tables?: string[] }).tables ?? []
}

describe("altimate-core extractMetadata table names", () => {
  test("Snowflake: last name part only, quotes removed, case kept, one entry per bare name", async () => {
    expect(
      await tablesOf(
        'select * from RAW.JAFFLE.Customers c join "raw"."jaffle"."orders" o on 1=1 join analytics.stg_x x on 1=1',
        "snowflake",
      ),
    ).toEqual(["Customers", "orders", "stg_x"])
    expect(await tablesOf("select * from db.sch.orders o join other.orders o2 on 1=1", "snowflake")).toEqual(["orders"])
    expect(
      await tablesOf("select * from RAW.JAFFLE.CUSTOMERS a join raw.jaffle.customers b on 1=1", "snowflake"),
    ).toEqual(["CUSTOMERS", "customers"])
    expect(await tablesOf('select * from "My Schema"."My Table" t', "snowflake")).toEqual(["My Table"])
  })

  test("BigQuery: a single backtick path comes back whole, a split one by its last part", async () => {
    expect(
      await tablesOf(
        "select * from `proj.ds.Customers` a join `proj`.`ds`.`Orders` b on 1=1 join ds.x c on 1=1",
        "bigquery",
      ),
    ).toEqual(["Orders", "proj.ds.Customers", "x"])
    expect(await tablesOf("select * from proj-1.ds.Customers a", "bigquery")).toEqual(["Customers"])
  })

  test("Databricks: three-part and backticked names reduce to the last part", async () => {
    expect(
      await tablesOf(
        "select * from main.raw.Customers a join raw.orders b on 1=1 join `main`.`raw`.`items` c on 1=1",
        "databricks",
      ),
    ).toEqual(["Customers", "items", "orders"])
  })

  test("CTE names are not tables", async () => {
    expect(await tablesOf("with a as (select * from raw.customers) select * from a", "snowflake")).toEqual([
      "customers",
    ])
  })
})

describe("splitQualified", () => {
  test("splits on dots outside quotes", () => {
    expect(splitQualified('"RAW"."JAFFLE"."CUSTOMERS"')).toEqual(["RAW", "JAFFLE", "CUSTOMERS"])
    expect(splitQualified('"a.b"."c"')).toEqual(["a.b", "c"])
    expect(splitQualified("`proj`.`ds`.`t`")).toEqual(["proj", "ds", "t"])
    expect(splitQualified("[db].[dbo].[t]")).toEqual(["db", "dbo", "t"])
  })
  test("backtick dots split only when asked", () => {
    expect(splitQualified("`proj.ds.t`", true)).toEqual(["proj", "ds", "t"])
    expect(splitQualified("`proj.ds.t`")).toEqual(["proj.ds.t"])
  })
})

describe("scanTableReferences", () => {
  const raws = (sql: string, dialect = "snowflake") => scanTableReferences(sql, dialect).refs.map((r) => r.raw)

  test("reads qualified names from FROM, JOIN and comma lists, written as in the SQL", () => {
    const { refs } = scanTableReferences(
      'select * from raw.jaffle.customers c, "RAW"."JAFFLE"."orders" as o left join other.payments p on 1=1',
      "snowflake",
    )
    expect(refs.map((r) => r.raw)).toEqual(["raw.jaffle.customers", '"RAW"."JAFFLE"."orders"', "other.payments"])
    expect(refs[1].parts).toEqual(["RAW", "JAFFLE", "orders"])
  })
  test("ignores table functions, subqueries, comments and strings", () => {
    expect(
      raws(
        "select 'from fake.t' as s from table(flatten(x)) f join (select 1) q on 1=1 /* from c.d */ -- from e.f\n join real.t t on 1=1",
      ),
    ).toEqual(["real.t"])
  })
  test("reads hyphenated BigQuery project ids", () => {
    expect(scanTableReferences("select * from my-proj.ds.tbl", "bigquery").refs[0].parts).toEqual([
      "my-proj",
      "ds",
      "tbl",
    ])
  })
  test("whitespace or a comment around a dot does not drop the qualifier", () => {
    expect(raws("select * from db . right . orders")).toEqual(["db . right . orders"])
    expect(scanTableReferences("select * from other/*gap*/.marts.customers", "snowflake").refs[0].parts).toEqual([
      "other",
      "marts",
      "customers",
    ])
  })
  test("a table after a subquery or table function in a comma list is still read", () => {
    expect(raws("select * from (select 1) x, db.right.orders")).toEqual(["db.right.orders"])
    expect(raws("select * from table(generator(rowcount => 1)) x, db.right.orders")).toEqual(["db.right.orders"])
    expect(raws("select * from (select * from db.wrong.orders) x, db.right.orders")).toEqual([
      "db.wrong.orders",
      "db.right.orders",
    ])
  })
  test("brackets quote names for SQL Server dialects only; ClickHouse double quotes are identifiers", () => {
    expect(raws("select * from [db].[s].[t]", "tsql")).toEqual(["[db].[s].[t]"])
    expect(raws('select * from "db"."orders"', "clickhouse")).toEqual(['"db"."orders"'])
  })
  test("a hyphenated BigQuery project id is read after a comma and `insert into table` names its table", () => {
    expect(raws("select * from a, my-proj.ds.t", "bigquery")).toEqual(["a", "my-proj.ds.t"])
    expect(raws("insert into table db.t select 1", "databricks")).toEqual(["db.t"])
  })
  test("clause words inside quoted names, strings and dollar quotes are not clauses", () => {
    expect(raws('select "from orders", "join orders" as "using orders" from db.right.orders')).toEqual([
      "db.right.orders",
    ])
    expect(raws("select $$from orders $$ as s from db.right.orders")).toEqual(["db.right.orders"])
    expect(raws("select $q1$from orders $q1$ as s from db.right.orders", "postgres")).toEqual(["db.right.orders"])
    expect(raws('select "from orders", r"from orders " from db.right.orders', "bigquery")).toEqual(["db.right.orders"])
    expect(raws('select "from orders" from db.right.orders', "databricks")).toEqual(["db.right.orders"])
  })
  test("EXTRACT, TRIM and IS DISTINCT FROM are not table clauses", () => {
    expect(raws("select extract(year from d), trim(both 'x' from s) from t where a is distinct from orders")).toEqual([
      "t",
    ])
  })
  test("a backslash ends a string in dialects where it does not escape", () => {
    expect(raws("select 'C:\\' as p from db.right.orders", "postgres")).toEqual(["db.right.orders"])
    expect(raws("select 'it\\'s' as p from db.right.orders", "snowflake")).toEqual(["db.right.orders"])
  })
  test("CTE names are collected, and a table named like a CTE keeps its qualifiers", () => {
    const { refs, ctes } = scanTableReferences(
      "with orders as (select * from db.raw.orders), b(x) as materialized (select 1) select * from orders",
      "snowflake",
    )
    expect([...ctes.keys()]).toEqual(["orders", "b"])
    expect(refs.map((r) => r.raw)).toEqual(["db.raw.orders", "orders"])
  })
})

describe("matchParts", () => {
  const rel = ["RAW", "JAFFLE", "CUSTOMERS"]
  test("exact, case_insensitive, partial and no match", () => {
    expect(matchParts(["RAW", "JAFFLE", "CUSTOMERS"], rel)).toBe("exact")
    expect(matchParts(["raw", "jaffle", "customers"], rel)).toBe("case_insensitive")
    expect(matchParts(["jaffle", "customers"], rel)).toBe("partial")
    expect(matchParts(["customers"], rel)).toBe("partial")
    expect(matchParts(["other", "jaffle", "customers"], rel)).toBeNull()
    expect(matchParts(["x", "raw", "jaffle", "customers"], rel)).toBeNull()
  })
})

const MANIFEST = {
  metadata: { adapter_type: "snowflake", project_name: "shop" },
  nodes: {
    "model.shop.customers": {
      resource_type: "model",
      name: "customers",
      package_name: "shop",
      relation_name: '"ANALYTICS"."MARTS"."CUSTOMERS"',
      config: { materialized: "table" },
    },
    "model.shop.stg_orders": {
      resource_type: "model",
      name: "stg_orders",
      package_name: "shop",
      relation_name: '"ANALYTICS"."STAGING"."STG_ORDERS"',
      config: { materialized: "view" },
    },
    "model.shop.inlined": {
      resource_type: "model",
      name: "inlined",
      package_name: "shop",
      relation_name: null,
      config: { materialized: "ephemeral" },
    },
    "model.utils.date_spine": {
      resource_type: "model",
      name: "date_spine",
      package_name: "utils",
      relation_name: '"ANALYTICS"."UTILS"."DATE_SPINE"',
      config: { materialized: "table" },
    },
    "seed.shop.countries": {
      resource_type: "seed",
      name: "countries",
      package_name: "shop",
      relation_name: '"ANALYTICS"."SEEDS"."COUNTRIES"',
    },
    "test.shop.not_null": { resource_type: "test", name: "not_null", relation_name: '"X"."Y"."Z"' },
  },
  sources: {
    "source.shop.jaffle.customers": {
      resource_type: "source",
      source_name: "jaffle",
      name: "customers",
      relation_name: '"RAW"."JAFFLE"."CUSTOMERS"',
    },
    "source.shop.jaffle.payments": {
      resource_type: "source",
      source_name: "jaffle",
      name: "payments",
      relation_name: '"RAW"."JAFFLE"."PAYMENTS"',
    },
  },
}

describe("mapRelations", () => {
  const relations = manifestRelations(MANIFEST)
  const map = (sql: string, tables: string[], dialect = "snowflake") => mapRelations(tables, sql, relations, dialect)

  test("manifestRelations skips ephemeral models and non-relations, and names other packages' models", () => {
    const names = relations.map((r) => r.uniqueId).sort()
    expect(names).not.toContain("model.shop.inlined")
    expect(names).not.toContain("test.shop.not_null")
    expect(relations.find((r) => r.name === "date_spine")?.call).toBe("{{ ref('utils', 'date_spine') }}")
  })

  test("exact: every part written, same case", () => {
    const [row] = map('select * from "RAW"."JAFFLE"."PAYMENTS"', ["PAYMENTS"])
    expect(row.match).toBe("exact")
    expect(row.replaceWith).toBe("{{ source('jaffle', 'payments') }}")
    expect(row.raw).toBe('"RAW"."JAFFLE"."PAYMENTS"')
    expect(row.candidates).toHaveLength(1)
  })

  test("case_insensitive: every part written, different case", () => {
    const [row] = map("select * from raw.jaffle.payments", ["payments"])
    expect(row.match).toBe("case_insensitive")
    expect(row.replaceWith).toBe("{{ source('jaffle', 'payments') }}")
  })

  test("partial: a missing database or schema, a model preferred over a source of the same name", () => {
    const [row] = map("select * from customers", ["customers"])
    expect(row.match).toBe("partial")
    expect(row.replaceWith).toBe("{{ ref('customers') }}")
    expect(row.candidates.map((c) => c.kind)).toEqual(["model", "source"])
  })

  test("a written schema narrows the match to one relation", () => {
    const [row] = map("select * from jaffle.customers", ["customers"])
    expect(row.match).toBe("partial")
    expect(row.replaceWith).toBe("{{ source('jaffle', 'customers') }}")
    expect(row.candidates).toHaveLength(1)
  })

  test("a fully written name picks the source, not the model that shares its last part", () => {
    const [row] = map("select * from raw.jaffle.customers", ["customers"])
    expect(row.match).toBe("case_insensitive")
    expect(row.replaceWith).toBe("{{ source('jaffle', 'customers') }}")
  })

  test("a better match beats a preferred kind", () => {
    const [row] = map('select * from "RAW"."JAFFLE"."CUSTOMERS"', ["CUSTOMERS"])
    expect(row.match).toBe("exact")
    expect(row.replaceWith).toBe("{{ source('jaffle', 'customers') }}")
    expect(row.candidates).toHaveLength(1)
  })

  test("none: keeps the table as written, no candidates", () => {
    const [row] = map("select * from legacy.orders_v1", ["orders_v1"])
    expect(row).toEqual({ raw: "legacy.orders_v1", replaceWith: "legacy.orders_v1", match: "none", candidates: [] })
  })

  test("a seed is matched with ref()", () => {
    const [row] = map("select * from analytics.seeds.countries", ["countries"])
    expect(row.replaceWith).toBe("{{ ref('countries') }}")
    expect(row.candidates[0].kind).toBe("seed")
  })

  test("tables that share a last part in different schemas stay separate", () => {
    const rows = map("select * from raw.jaffle.customers a join analytics.marts.customers b on 1=1", ["customers"])
    expect(rows.map((r) => [r.raw, r.replaceWith, r.match])).toEqual([
      ["raw.jaffle.customers", "{{ source('jaffle', 'customers') }}", "case_insensitive"],
      ["analytics.marts.customers", "{{ ref('customers') }}", "case_insensitive"],
    ])
  })

  test("BigQuery: a backtick path in one piece is split into its parts", () => {
    const bq = manifestRelations({
      metadata: { adapter_type: "bigquery", project_name: "shop" },
      nodes: {},
      sources: {
        "source.shop.raw.orders": {
          resource_type: "source",
          source_name: "raw",
          name: "orders",
          relation_name: "`proj`.`ds`.`orders`",
        },
      },
    })
    const [row] = mapRelations(["proj.ds.orders"], "select * from `proj.ds.orders`", bq, "bigquery")
    expect(row.match).toBe("exact")
    expect(row.replaceWith).toBe("{{ source('raw', 'orders') }}")
  })

  test("a table the text scan does not find is matched by its bare name", () => {
    const [row] = map("select 1", ["stg_orders"])
    expect(row.match).toBe("partial")
    expect(row.replaceWith).toBe("{{ ref('stg_orders') }}")
  })

  test("a CTE named like a table is not mapped, and the physical table it reads keeps its mapping", () => {
    const sql = "with customers as (select * from raw.jaffle.customers) select * from customers"
    expect(map(sql, []).map((r) => [r.raw, r.match])).toEqual([["raw.jaffle.customers", "case_insensitive"]])
    expect(map(sql, ["customers"]).map((r) => [r.raw, r.match])).toEqual([["raw.jaffle.customers", "case_insensitive"]])
  })

  test("a table named like its own CTE, read inside that CTE, is the real table; a recursive CTE's own name is not", () => {
    expect(map("with orders as (select * from orders) select * from orders", []).map((r) => r.raw)).toEqual(["orders"])
    expect(
      map("with recursive customers as (select 1 union all select * from customers) select * from customers", []),
    ).toEqual([])
  })

  test("differently written forms of one table stay separate rows; an identical repeat does not", () => {
    const sql =
      'select * from raw.jaffle.payments a join "RAW"."JAFFLE"."PAYMENTS" b on 1=1 join raw.jaffle.payments c on 1=1'
    expect(map(sql, ["PAYMENTS"]).map((r) => r.raw)).toEqual(["raw.jaffle.payments", '"RAW"."JAFFLE"."PAYMENTS"'])
  })

  test("a versioned model is referenced by its version", () => {
    const versioned = manifestRelations({
      metadata: { project_name: "shop" },
      nodes: {
        "model.shop.orders.v1": {
          resource_type: "model",
          name: "orders",
          package_name: "shop",
          version: 1,
          relation_name: '"A"."B"."ORDERS_V1"',
          config: {},
        },
        "model.shop.orders.v2": {
          resource_type: "model",
          name: "orders",
          package_name: "shop",
          version: "2",
          relation_name: '"A"."B"."ORDERS"',
          config: {},
        },
        "model.pkg.dim.v3": {
          resource_type: "model",
          name: "dim",
          package_name: "pkg",
          version: 3,
          relation_name: '"A"."B"."DIM"',
          config: {},
        },
      },
    })
    const rows = mapRelations(
      ["ORDERS_V1", "ORDERS", "DIM"],
      'select * from "A"."B"."ORDERS_V1", "A"."B"."ORDERS", "A"."B"."DIM"',
      versioned,
      "snowflake",
    )
    expect(rows.map((r) => r.replaceWith)).toEqual([
      "{{ ref('orders', v=1) }}",
      "{{ ref('orders', v=\"2\") }}",
      "{{ ref('pkg', 'dim', v=3) }}",
    ])
  })

  test("a name altimate-core did not report is not a table", () => {
    expect(map("with customers as (select 1) select * from customers", [])).toEqual([])
  })
})

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_map_relations"),
  messageID: MessageID.make("msg_map_relations"),
  agent: "analyst",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
  extra: { forceReadOnly: true },
}

describe("dbt_map_relations tool", () => {
  let dirs: string[] = []
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs = []
  })
  function manifestPath(manifest: unknown = MANIFEST): string {
    const dir = mkdtempSync(join(tmpdir(), "map-relations-"))
    dirs.push(dir)
    const p = join(dir, "manifest.json")
    writeFileSync(p, JSON.stringify(manifest))
    return p
  }
  async function run(args: Record<string, unknown>) {
    const tool = await initTool(DbtMapRelationsTool)
    return tool.execute(args, ctx)
  }

  test("maps every table, takes the dialect from the manifest, returns rows in metadata", async () => {
    const result = await run({
      sql: 'select * from raw.jaffle.customers c join "ANALYTICS"."STAGING"."STG_ORDERS" o on 1=1 join legacy.thing t on 1=1 join payments p on 1=1',
      manifest_path: manifestPath(),
    })
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.dialect).toBe("snowflake")
    const rows = result.metadata.mappings as { raw: string; replaceWith: string; match: string }[]
    expect(rows.map((r) => [r.raw, r.match])).toEqual([
      ["raw.jaffle.customers", "case_insensitive"],
      ['"ANALYTICS"."STAGING"."STG_ORDERS"', "exact"],
      ["legacy.thing", "none"],
      ["payments", "partial"],
    ])
    expect(result.output.split("\n")[0]).toBe("none: legacy.thing -> no model or source")
    expect(result.title).toContain("1 unmatched")
  })

  test("a missing manifest is an error that names the path", async () => {
    const result = await run({ sql: "select * from t", manifest_path: "/nonexistent/manifest.json" })
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("/nonexistent/manifest.json")
  })

  test("without manifest_path the dbt project around the working directory supplies target/manifest.json", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "map-relations-project-")))
    dirs.push(dir)
    writeFileSync(join(dir, "dbt_project.yml"), "name: jaffle\n")
    mkdirSync(join(dir, "target"))
    writeFileSync(join(dir, "target", "manifest.json"), JSON.stringify(MANIFEST))
    const cwd = process.cwd()
    const home = process.env.HOME
    process.env.HOME = dir
    process.chdir(dir)
    try {
      const result = await run({ sql: "select * from legacy.thing" })
      expect(result.metadata.success).toBe(true)
      expect(result.metadata.manifest_path).toBe(join(dir, "target", "manifest.json"))
    } finally {
      process.chdir(cwd)
      if (home === undefined) delete process.env.HOME
      else process.env.HOME = home
    }
  })

  test("outside a dbt project, without manifest_path, the error says so", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "map-relations-bare-")))
    dirs.push(dir)
    const cwd = process.cwd()
    const home = process.env.HOME
    process.env.HOME = dir
    process.chdir(dir)
    try {
      const result = await run({ sql: "select * from t" })
      expect(result.metadata.success).toBe(false)
      expect(result.output).toBe("No dbt project found here. Run from a dbt project or pass manifest_path.")
    } finally {
      process.chdir(cwd)
      if (home === undefined) delete process.env.HOME
      else process.env.HOME = home
    }
  })

  test("with the real parser, a table a CTE shares its name with and a dot spaced out are both mapped", async () => {
    const result = await run({
      sql: "with customers as (select * from raw.jaffle.customers) select * from customers c join analytics . staging . stg_orders o on 1=1",
      manifest_path: manifestPath(),
    })
    const rows = result.metadata.mappings as { raw: string; match: string }[]
    expect(rows.map((r) => [r.raw, r.match])).toEqual([
      ["raw.jaffle.customers", "case_insensitive"],
      ["analytics . staging . stg_orders", "case_insensitive"],
    ])
  })

  test("SQL that does not parse is an error", async () => {
    const result = await run({ sql: "select * from {{ ref('x') }}", manifest_path: manifestPath() })
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("Could not read the tables")
  })

  test("SQL without tables returns no rows", async () => {
    const result = await run({ sql: "select 1", manifest_path: manifestPath() })
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.mappings).toEqual([])
    expect(result.output).toBe("No tables found in the SQL.")
  })
})
