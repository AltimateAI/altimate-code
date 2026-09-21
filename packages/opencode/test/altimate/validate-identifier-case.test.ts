// Regression for #1333: `altimate_core_validate` against warehouse metadata.
//
// The engine compares an UNQUOTED identifier in lowercase and a QUOTED one exactly;
// Snowflake metadata comes back UPPERCASE. A correct query therefore failed with
// ColumnNotFound (the engine's own DidYouMean pointed at the same column in uppercase,
// confidence 1), and with no schema at all the tool reported TableNotFound although its
// description promises existence checks are skipped.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

// Both source modules import `@altimateai/altimate-core` statically, so they are loaded
// lazily: a static import here would fail the whole file where the napi binding cannot
// load, and the skip guard below would never run. (bot review)
const hasCore = (() => {
  try {
    require.resolve("@altimateai/altimate-core")
    return true
  } catch {
    return false
  }
})()
const describeIf = hasCore ? describe : describe.skip

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

describeIf("foldIdentifierCase", () => {
  let foldIdentifierCase: typeof import("../../src/altimate/native/schema-resolver").foldIdentifierCase
  let foldQuotedIdentifierCase: typeof import("../../src/altimate/native/schema-resolver").foldQuotedIdentifierCase
  let normalizeSchemaContext: typeof import("../../src/altimate/native/schema-resolver").normalizeSchemaContext
  let schemaProvided: typeof import("../../src/altimate/native/schema-resolver").schemaProvided
  beforeAll(async () => {
    ;({ foldIdentifierCase, foldQuotedIdentifierCase, normalizeSchemaContext, schemaProvided } = await import(
      "../../src/altimate/native/schema-resolver"
    ))
  })

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

  test("normalizeSchemaContext folds table keys and column names in both input shapes when asked, and not otherwise", () => {
    expect(Object.keys(JSON.parse(normalizeSchemaContext(UPPER)).tables)).toEqual(Object.keys(UPPER))
    const fromDefinition = JSON.parse(normalizeSchemaContext(UPPER, { fold: true }))
    expect(Object.keys(fromDefinition.tables)).toEqual(["tpch_analytics.public_reporting.rpt_monthly_sales_by_region"])
    expect(fromDefinition.tables["tpch_analytics.public_reporting.rpt_monthly_sales_by_region"].columns.map((c: any) => c.name)).toEqual([
      "order_month",
      "customer_region",
      "net_revenue",
    ])
    const fromFlat = JSON.parse(normalizeSchemaContext({ ORDERS: { ORDER_ID: "NUMBER", "Mixed_Col": "VARCHAR" } }, { fold: true }))
    expect(fromFlat.tables.orders.columns.map((c: any) => c.name)).toEqual(["order_id", "Mixed_Col"])
  })

  test("a fold that would collide with an entry the schema already has keeps the name as written", () => {
    // Metadata with both `ORDERS` and `orders`: distinct warehouse objects, and folding one
    // onto the other would drop its columns. Both survive, the uppercase one unfolded.
    const tables = JSON.parse(
      normalizeSchemaContext({ tables: { ORDERS: { columns: [{ name: "A", type: "INT" }] }, orders: { columns: [{ name: "b", type: "INT" }] } } }, { fold: true }),
    ).tables
    expect(Object.keys(tables).sort()).toEqual(["ORDERS", "orders"])
    expect(tables.ORDERS.columns[0].name).toBe("a")
    // Same rule inside a table: `FOO` and `foo` columns both stay.
    const cols = JSON.parse(
      normalizeSchemaContext({ t: { columns: [{ name: "FOO", type: "INT" }, { name: "foo", type: "INT" }, { name: "BAR", type: "INT" }] } }, { fold: true }),
    ).tables.t.columns.map((c: any) => c.name)
    expect(cols).toEqual(["FOO", "foo", "bar"])
  })

  test("a table named __PROTO__ is an entry in the folded schema, not a prototype write", () => {
    const def = JSON.parse(normalizeSchemaContext({ __PROTO__: { ID: "INT" } }, { fold: true }))
    expect(Object.keys(def.tables)).toEqual(["__proto__"])
    expect(def.tables.__proto__.columns).toEqual([{ name: "id", type: "INT" }])
  })

  test("foldQuotedIdentifierCase lowercases quoted all-uppercase identifiers and nothing else", () => {
    const sql = `select "ORDER_MONTH", "Mixed_Col", "ORDER", 'lit "KEEP"', x -- "NOPE"\n, /* "NOT" */ "A1$" from "ORDERS" where n = 'it''s "OK"'`
    expect(foldQuotedIdentifierCase(sql)).toBe(
      `select "order_month", "Mixed_Col", "order", 'lit "KEEP"', x -- "NOPE"\n, /* "NOT" */ "a1$" from "orders" where n = 'it''s "OK"'`,
    )
    expect(foldQuotedIdentifierCase(sql)).toHaveLength(sql.length)
  })

  test("the lexer's other spans: backticks, doubled quotes, dotted names, dollar quoting, E-strings", () => {
    // codex on #1343. BigQuery/Databricks backticks fold like double quotes.
    expect(foldQuotedIdentifierCase("select `ORDER_MONTH` from `DS.ORDERS`")).toBe("select `order_month` from `ds.orders`")
    // A doubled quote inside the name is not a plain identifier: kept as written.
    expect(foldQuotedIdentifierCase('select "A""B" from t')).toBe('select "A""B" from t')
    // A dotted quoted name folds as one identifier (metadata `A.B` folds to `a.b`).
    expect(foldQuotedIdentifierCase('select x from "TPCH.PUBLIC.ORDERS"')).toBe('select x from "tpch.public.orders"')
    // Dollar-quoted bodies are opaque, including quotes and comment markers inside them.
    const dollar = `select $$ "KEEP" -- "KEEP" $$, $t$ 'x' "KEEP" $t$, "FOLD" from t`
    expect(foldQuotedIdentifierCase(dollar)).toBe(`select $$ "KEEP" -- "KEEP" $$, $t$ 'x' "KEEP" $t$, "fold" from t`)
    // E'…' strings honour backslash escapes: the escaped quote does not end the string.
    expect(foldQuotedIdentifierCase(`select E'it\\'s "KEEP"', "FOLD" from t`)).toBe(`select E'it\\'s "KEEP"', "fold" from t`)
  })

  test("schemaProvided counts a schema_path, and a schema_context only when it normalises to a table", () => {
    expect(schemaProvided("/some/schema.json")).toBe(true)
    expect(schemaProvided(undefined, UPPER)).toBe(true)
    expect(schemaProvided(undefined, {})).toBe(false)
    expect(schemaProvided(undefined, { tables: {} })).toBe(false)
    expect(schemaProvided(undefined, { users: {} })).toBe(false)
    expect(schemaProvided("", undefined)).toBe(false)
  })
})

describeIf("isExistenceError", () => {
  let isExistenceError: typeof import("../../src/altimate/native/altimate-core").isExistenceError
  beforeAll(async () => {
    ;({ isExistenceError } = await import("../../src/altimate/native/altimate-core"))
  })

  test("recognises the engine's table/column-not-found by code or kind, and nothing else", () => {
    expect(isExistenceError({ code: "E001", kind: { type: "TableNotFound" } })).toBe(true)
    expect(isExistenceError({ code: "E002", kind: { type: "ColumnNotFound" } })).toBe(true)
    expect(isExistenceError({ kind: { type: "ColumnNotFound" } })).toBe(true)
    expect(isExistenceError({ code: "E001" })).toBe(true) // code alone, no kind
    expect(isExistenceError({ code: "E003", kind: { type: "SyntaxError" } })).toBe(false)
    expect(isExistenceError(null)).toBe(false)
    expect(isExistenceError("E001")).toBe(false)
  })
})

describeIf("altimate_core.validate through the dispatcher (#1333)", () => {
  let D: any
  const telemetry = process.env.ALTIMATE_TELEMETRY_DISABLED
  beforeAll(async () => {
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
    D = await import("../../src/altimate/native/dispatcher")
    const core = await import("../../src/altimate/native/altimate-core")
    core.registerAll()
  })
  afterAll(() => {
    if (telemetry === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
    else process.env.ALTIMATE_TELEMETRY_DISABLED = telemetry
    // The handlers went into the process-global dispatcher; leave it as found.
    D.reset()
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

  test("a quoted all-uppercase reference — dbt quote_columns style — validates against uppercase metadata", async () => {
    const quoted = `select "CUSTOMER_REGION", sum("NET_REVENUE") as net_revenue
from "TPCH_ANALYTICS"."PUBLIC_REPORTING"."RPT_MONTHLY_SALES_BY_REGION" where "ORDER_MONTH" >= '1997-01-01' group by 1`
    const r = await D.call("altimate_core.validate", { sql: quoted, schema_context: UPPER })
    expect(r.data.errors).toEqual([])
    expect(r.data.valid).toBe(true)
    // A quoted mixed-case name is the exact-match case and still has to be exact.
    const mixed = await D.call("altimate_core.validate", {
      sql: `select "Customer_Region" from TPCH_ANALYTICS.PUBLIC_REPORTING.RPT_MONTHLY_SALES_BY_REGION`,
      schema_context: UPPER,
    })
    expect(mixed.data.valid).toBe(false)
  })

  test("a schema_context with no tables is treated as no schema", async () => {
    for (const schema_context of [{ tables: {} }, { users: {} }]) {
      const r = await D.call("altimate_core.validate", { sql: SQL, schema_context })
      expect(r.data.errors).toEqual([])
      expect(r.data.valid).toBe(true)
    }
  })

  test("the other SQL-plus-schema handlers get the folded pair too, not only validate", async () => {
    // codex on #1343: a folded schema against unfolded SQL is the mismatch the fold
    // exists to remove. `lint` and `rewrite` resolve the same quoted references.
    const quoted = `select "CUSTOMER_REGION" from "TPCH_ANALYTICS"."PUBLIC_REPORTING"."RPT_MONTHLY_SALES_BY_REGION"`
    const lint = await D.call("altimate_core.lint", { sql: quoted, schema_context: UPPER })
    expect(lint.success).toBe(true)
    const lineage = await D.call("altimate_core.column_lineage", { sql: quoted, schema_context: UPPER })
    expect(lineage.success).toBe(true)
    const out = JSON.stringify(lineage.data).toLowerCase()
    expect(out).toContain("customer_region")
  })

  test("a JSON schema_path is folded like an inline context; a DDL file is left alone", async () => {
    const dir = await import("node:fs/promises").then(async (fs) => {
      const d = await fs.mkdtemp((await import("node:os")).tmpdir() + "/schema-case-")
      await fs.writeFile(d + "/schema.json", JSON.stringify(UPPER))
      await fs.writeFile(d + "/schema.sql", "CREATE TABLE orders (order_month DATE);")
      return d
    })
    const fromJson = await D.call("altimate_core.validate", { sql: SQL, schema_path: dir + "/schema.json" })
    expect(fromJson.data.errors).toEqual([])
    expect(fromJson.data.valid).toBe(true)
    const fromDdl = await D.call("altimate_core.validate", { sql: "select order_month from orders", schema_path: dir + "/schema.sql" })
    expect(fromDdl.data.valid).toBe(true)
  })

  test("schema-only operations see the names as written, not folded", async () => {
    const r = await D.call("altimate_core.schema_diff", {
      schema1_context: UPPER,
      schema2_context: { ...UPPER, EXTRA_TABLE: { columns: [{ name: "ID", type: "NUMBER" }] } },
    })
    expect(r.success).toBe(true)
    const text = JSON.stringify(r.data)
    expect(text).toContain("EXTRA_TABLE")
    expect(text).not.toContain("extra_table")
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

describeIf("the altimate_core_validate tool follows the handler", () => {
  let tool: any
  const telemetry = process.env.ALTIMATE_TELEMETRY_DISABLED
  beforeAll(async () => {
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
    const core = await import("../../src/altimate/native/altimate-core")
    core.registerAll()
    const { initTool } = await import("./tool-fixture")
    const { AltimateCoreValidateTool } = await import("../../src/altimate/tools/altimate-core-validate")
    tool = await initTool(AltimateCoreValidateTool)
  })
  afterAll(async () => {
    if (telemetry === undefined) delete process.env.ALTIMATE_TELEMETRY_DISABLED
    else process.env.ALTIMATE_TELEMETRY_DISABLED = telemetry
    const D = await import("../../src/altimate/native/dispatcher")
    D.reset()
  })
  const ctx = () => ({ sessionID: "s", messageID: "m", agent: "build", abort: new AbortController().signal, messages: [], metadata: () => {} })

  test("a table-less schema_context is reported as no schema, not as a full validation", async () => {
    // codex on #1343: the tool decided `has_schema` on its own and said "VALID" as if
    // existence had been checked.
    const r = await tool.execute({ sql: SQL, schema_context: { tables: {} } }, ctx())
    expect(r.metadata.has_schema).toBe(false)
    expect(r.title).toContain("(no schema)")
  })

  test("a schema file that cannot be loaded is an engine failure, not a valid result", async () => {
    const r = await tool.execute({ sql: SQL, schema_path: "/nonexistent/schema.json" }, ctx())
    expect(r.metadata.success).toBe(false)
    expect(r.title).toBe("Validate: ERROR")
  })
})
