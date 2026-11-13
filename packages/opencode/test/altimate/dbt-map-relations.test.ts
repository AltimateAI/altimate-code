/**
 * dbt_map_relations: maps the tables of a raw SQL query to ref() and source() calls.
 *
 * The first block pins what altimate-core's extractMetadata returns for quoted, upper-case and
 * qualified names: it keeps only the last name part (quotes removed, case kept) and merges tables
 * that share it, so the matching rules read the qualifiers back from the SQL text.
 */
import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
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
  test("reads qualified names from FROM, JOIN and comma lists, written as in the SQL", () => {
    const refs = scanTableReferences(
      'select * from raw.jaffle.customers c, "RAW"."JAFFLE"."orders" as o left join other.payments p on 1=1',
      false,
    )
    expect(refs.map((r) => r.raw)).toEqual(["raw.jaffle.customers", '"RAW"."JAFFLE"."orders"', "other.payments"])
    expect(refs[1].parts).toEqual(["RAW", "JAFFLE", "orders"])
  })
  test("ignores table functions, subqueries, comments and strings", () => {
    const refs = scanTableReferences(
      "select 'from fake.t' as s from table(flatten(x)) f join (select 1) q on 1=1 /* from c.d */ -- from e.f\n join real.t t on 1=1",
      false,
    )
    expect(refs.map((r) => r.raw)).toEqual(["real.t"])
  })
  test("reads hyphenated BigQuery project ids", () => {
    expect(scanTableReferences("select * from my-proj.ds.tbl", true)[0].parts).toEqual(["my-proj", "ds", "tbl"])
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
