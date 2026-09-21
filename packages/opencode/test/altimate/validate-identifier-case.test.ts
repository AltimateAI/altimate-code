// Regression for #1333: `altimate_core_validate` against warehouse metadata.
//
// The engine compares an UNQUOTED identifier in lowercase and a QUOTED one exactly;
// Snowflake metadata comes back UPPERCASE. A correct query therefore failed with
// ColumnNotFound (the engine's own DidYouMean pointed at the same column in uppercase,
// confidence 1), and with no schema at all the tool reported TableNotFound although its
// description promises existence checks are skipped.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { foldIdentifierCase, normalizeSchemaContext } from "../../src/altimate/native/schema-resolver"
import { isExistenceError } from "../../src/altimate/native/altimate-core"

const SQL = `select customer_region, sum(net_revenue) as net_revenue
from TPCH_ANALYTICS.PUBLIC_REPORTING.RPT_MONTHLY_SALES_BY_REGION
where order_month >= '1997-01-01' group by 1`

// Exactly what `schema_inspect` / `snowflake_get_table_stats` return on Snowflake.
const UPPER = {
  "TPCH_ANALYTICS.PUBLIC_REPORTING.RPT_MONTHLY_SALES_BY_REGION": {
    columns: [
      { name: "ORDER_MONTH", type: "DATE" },
      { name: "CUSTOMER_REGION", type: "VARCHAR" },
      { name: "NET_REVENUE", type: "NUMBER" },
    ],
  },
}

describe("foldIdentifierCase", () => {
  test("an all-uppercase name (created unquoted) folds to the engine's lowercase form", () => {
    expect(foldIdentifierCase("ORDER_MONTH")).toBe("order_month")
    expect(foldIdentifierCase("TPCH_ANALYTICS.PUBLIC_REPORTING.RPT_MONTHLY_SALES_BY_REGION")).toBe(
      "tpch_analytics.public_reporting.rpt_monthly_sales_by_region",
    )
  })

  test("a mixed-case name (created quoted, referenced quoted) is kept exact; lowercase is untouched", () => {
    expect(foldIdentifierCase("Customer_Region")).toBe("Customer_Region")
    expect(foldIdentifierCase("customer_region")).toBe("customer_region")
    expect(foldIdentifierCase("ORDER_2024")).toBe("order_2024") // digits do not make it mixed-case
    expect(foldIdentifierCase("")).toBe("")
  })

  test("normalizeSchemaContext folds table keys and column names in both input shapes", () => {
    const fromDefinition = JSON.parse(normalizeSchemaContext(UPPER))
    expect(Object.keys(fromDefinition.tables)).toEqual(["tpch_analytics.public_reporting.rpt_monthly_sales_by_region"])
    expect(fromDefinition.tables["tpch_analytics.public_reporting.rpt_monthly_sales_by_region"].columns.map((c: any) => c.name)).toEqual([
      "order_month",
      "customer_region",
      "net_revenue",
    ])
    const fromFlat = JSON.parse(normalizeSchemaContext({ ORDERS: { ORDER_ID: "NUMBER", "Mixed_Col": "VARCHAR" } }))
    expect(fromFlat.tables.orders.columns.map((c: any) => c.name)).toEqual(["order_id", "Mixed_Col"])
  })
})

describe("isExistenceError", () => {
  test("recognises the engine's table/column-not-found by code or kind, and nothing else", () => {
    expect(isExistenceError({ code: "E001", kind: { type: "TableNotFound" } })).toBe(true)
    expect(isExistenceError({ code: "E002", kind: { type: "ColumnNotFound" } })).toBe(true)
    expect(isExistenceError({ kind: { type: "ColumnNotFound" } })).toBe(true)
    expect(isExistenceError({ code: "E003", kind: { type: "SyntaxError" } })).toBe(false)
    expect(isExistenceError(null)).toBe(false)
    expect(isExistenceError("E001")).toBe(false)
  })
})

const hasCore = await import("@altimateai/altimate-core").then(() => true).catch(() => false)
const describeIf = hasCore ? describe : describe.skip

describeIf("altimate_core.validate through the dispatcher (#1333)", () => {
  let D: any
  beforeAll(async () => {
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
    D = await import("../../src/altimate/native/dispatcher")
    const core = await import("../../src/altimate/native/altimate-core")
    core.registerAll()
  })
  afterAll(() => {
    delete process.env.ALTIMATE_TELEMETRY_DISABLED
  })

  test("a lowercase Snowflake query validates against UPPERCASE metadata", async () => {
    const r = await D.call("altimate_core.validate", { sql: SQL, schema_context: UPPER })
    expect(r.data.valid).toBe(true)
    expect(r.data.errors).toEqual([])
  })

  test("the same query in uppercase validates too", async () => {
    const r = await D.call("altimate_core.validate", { sql: SQL.toUpperCase(), schema_context: UPPER })
    expect(r.data.valid).toBe(true)
  })

  test("a genuinely missing column is still reported against uppercase metadata", async () => {
    const r = await D.call("altimate_core.validate", {
      sql: SQL.replace("customer_region", "customer_reggion"),
      schema_context: UPPER,
    })
    expect(r.data.valid).toBe(false)
    expect(r.data.errors.some((e: any) => e.kind?.type === "ColumnNotFound")).toBe(true)
  })

  test("with no schema, existence findings are dropped and a correct query is valid", async () => {
    const r = await D.call("altimate_core.validate", { sql: SQL, schema_path: "", schema_context: {} })
    expect(r.data.valid).toBe(true)
    expect(r.data.errors).toEqual([])
  })

  test("with no schema, a syntax error is still reported", async () => {
    const r = await D.call("altimate_core.validate", { sql: "selec x fro t", schema_context: {} })
    expect(r.data.valid).toBe(false)
    expect(r.data.errors.length).toBeGreaterThan(0)
    expect(r.data.errors.every((e: any) => !["TableNotFound", "ColumnNotFound"].includes(e.kind?.type))).toBe(true)
  })
})
