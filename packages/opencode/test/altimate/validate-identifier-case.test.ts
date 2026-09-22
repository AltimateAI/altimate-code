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
    // `require`, not `require.resolve`: index.js loads the platform binding and throws
    // when none loads, which is the case the guard exists for. (bot review)
    require("@altimateai/altimate-core")
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
  let prepareSql: typeof import("../../src/altimate/native/schema-resolver").prepareSql
  beforeAll(async () => {
    ;({ foldIdentifierCase, foldQuotedIdentifierCase, normalizeSchemaContext, schemaProvided, prepareSql } = await import(
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
    // An identifier containing `$` is not the start of a dollar-quoted string.
    expect(foldQuotedIdentifierCase('select foo$t$ + "ORDERS" + bar$t$ from t')).toBe('select foo$t$ + "orders" + bar$t$ from t')
    // E'…' strings honour backslash escapes: the escaped quote does not end the string.
    expect(foldQuotedIdentifierCase(`select E'it\\'s "KEEP"', "FOLD" from t`)).toBe(`select E'it\\'s "KEEP"', "fold" from t`)
  })

  test("prepareSql folds only quoted names the schema holds, and its foldSql matches", () => {
    // On MySQL/BigQuery/SQLite `"SHIPPED"` is a string literal; a query's values must
    // not change under validation. (bot review)
    const sql = `select "ORDER_MONTH", "NET_REVENUE" from "RPT_MONTHLY_SALES_BY_REGION" where "CUSTOMER_REGION" = "SHIPPED"`
    const prepared = prepareSql(sql, undefined, UPPER)
    expect(prepared.sql).toBe(
      `select "order_month", "net_revenue" from "rpt_monthly_sales_by_region" where "customer_region" = "SHIPPED"`,
    )
    expect(prepared.foldSql(`select "ORDER_MONTH" where x = "SHIPPED"`)).toBe(`select "order_month" where x = "SHIPPED"`)
    // No schema: nothing is folded, and the sibling fold is the identity.
    const bare = prepareSql(sql, undefined, undefined)
    expect(bare.sql).toBe(sql)
    expect(bare.hasSchema).toBe(false)
    expect(bare.foldSql(sql)).toBe(sql)
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
    // exists to remove. `lint` and `column_lineage` resolve the same quoted references.
    const quoted = `select "CUSTOMER_REGION" from "TPCH_ANALYTICS"."PUBLIC_REPORTING"."RPT_MONTHLY_SALES_BY_REGION"`
    const lint = await D.call("altimate_core.lint", { sql: quoted, schema_context: UPPER })
    expect(lint.success).toBe(true)
    const lineage = await D.call("altimate_core.column_lineage", { sql: quoted, schema_context: UPPER })
    expect(lineage.success).toBe(true)
    const out = JSON.stringify(lineage.data).toLowerCase()
    expect(out).toContain("customer_region")
  })

  test("a JSON schema_path is folded like an inline context; a DDL file is left alone, base SQL included", async () => {
    const fs = await import("node:fs/promises")
    const dir = await fs.mkdtemp((await import("node:os")).tmpdir() + "/schema-case-")
    try {
      await fs.writeFile(dir + "/schema.json", JSON.stringify(UPPER))
      await fs.writeFile(dir + "/schema.sql", 'CREATE TABLE orders (order_month DATE, "STATUS" VARCHAR);')
      const fromJson = await D.call("altimate_core.validate", { sql: SQL, schema_path: dir + "/schema.json" })
      expect(fromJson.data.errors).toEqual([])
      expect(fromJson.data.valid).toBe(true)
      const fromDdl = await D.call("altimate_core.validate", { sql: "select order_month from orders", schema_path: dir + "/schema.sql" })
      expect(fromDdl.data.valid).toBe(true)
      // The sibling fold follows the schema's preparation: identity for a DDL file, so a
      // base query's quoted name is compared as written. (bot review)
      const { prepareSql } = await import("../../src/altimate/native/schema-resolver")
      expect(prepareSql('select "STATUS" from orders', dir + "/schema.sql").foldSql('select "STATUS" from orders')).toBe(
        'select "STATUS" from orders',
      )
      expect(prepareSql("select 1", dir + "/schema.json").foldSql('select "ORDER_MONTH" from t')).toBe('select "order_month" from t')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("the sql.* and lineage.check handlers prepare the pair too", async () => {
    // Unquoted lowercase references: against the UNFOLDED uppercase metadata the
    // engine resolves the table by its lowercased key but reports it in the
    // metadata's spelling; against the folded pair everything is lowercase. The
    // assertion is on the raw output, so an unfolded resolver fails it. (bot review)
    const low = `select customer_region from TPCH_ANALYTICS.PUBLIC_REPORTING.RPT_MONTHLY_SALES_BY_REGION`
    const { registerAllSql } = await import("../../src/altimate/native/sql/register")
    registerAllSql()
    const lineage = await D.call("lineage.check", { sql: low, schema_context: UPPER })
    expect(lineage.success).toBe(true)
    const source = lineage.data.column_lineage[0].source
    expect(source).toContain('"tpch_analytics"."public_reporting"."rpt_monthly_sales_by_region"."customer_region"')
    expect(source).not.toContain("TPCH_ANALYTICS")
    const analyze = await D.call("sql.analyze", { sql: low, schema_context: UPPER })
    expect(analyze.success).toBe(true)
    expect(JSON.stringify(analyze.issues)).not.toMatch(/not found/i)
  })

  test("generated SQL comes back in the caller's spelling, and the diff is rendered from the raw inputs", async () => {
    // The fold is a comparison form against folded metadata, not a spelling a
    // case-sensitive warehouse accepts: `"ORDER_MONTH"` must not come back as
    // `"order_month"` in a rewrite, a fix, or an optimisation. (bot review)
    const quoted = `select "CUSTOMER_REGION", sum("NET_REVENUE") as net_revenue from "TPCH_ANALYTICS"."PUBLIC_REPORTING"."RPT_MONTHLY_SALES_BY_REGION" where "ORDER_MONTH" >= '1997-01-01' group by 1`
    const { registerAllSql } = await import("../../src/altimate/native/sql/register")
    registerAllSql()
    for (const [method, params] of [
      ["sql.optimize", { sql: quoted, schema_context: UPPER }],
      ["sql.rewrite", { sql: quoted, schema_context: UPPER }],
      ["sql.fix", { sql: quoted, schema_context: UPPER }],
      ["altimate_core.rewrite", { sql: quoted, schema_context: UPPER }],
      ["altimate_core.fix", { sql: quoted, schema_context: UPPER }],
      ["altimate_core.correct", { sql: quoted, schema_context: UPPER }],
    ] as const) {
      const r = await D.call(method as never, params as never)
      // A handler that errored would pass the spelling checks vacuously. `sql.fix` reports
      // `success: false` with a `fixed_sql` when there was nothing to fix, so the guard
      // is "the handler ran and returned SQL", not `success` alone.
      expect(r.success === true || typeof r.fixed_sql === "string", method).toBe(true)
      expect(JSON.stringify(r), method).not.toContain("native handler")
      const text = JSON.stringify(r)
      expect(text, method).not.toMatch(/"\\"(order_month|customer_region|net_revenue|rpt_monthly_sales_by_region)\\""/)
      expect(text, method).not.toContain('\\"order_month\\"')
    }
    // sql.diff: a case-only edit is a visible diff line. (What the equivalence check
    // says about a quoted-lowercase spelling is the tradeoff documented on
    // `foldIdentifierCase` — not asserted here either way.)
    const diff = await D.call("sql.diff", {
      original: `select "ORDER_MONTH" from "TPCH_ANALYTICS"."PUBLIC_REPORTING"."RPT_MONTHLY_SALES_BY_REGION"`,
      modified: `select "order_month" from "TPCH_ANALYTICS"."PUBLIC_REPORTING"."RPT_MONTHLY_SALES_BY_REGION"`,
      schema_context: UPPER,
    } as never)
    expect(diff.success).toBe(true)
    expect(diff.diff).toContain('- select "ORDER_MONTH"')
    expect(diff.diff).toContain('+ select "order_month"')
  })

  test("a JSON schema file with zero tables is no schema, not an engine failure", async () => {
    const fs = await import("node:fs/promises")
    const dir = await fs.mkdtemp((await import("node:os")).tmpdir() + "/schema-empty-")
    try {
      await fs.writeFile(dir + "/empty.json", JSON.stringify({ tables: {} }))
      const r = await D.call("altimate_core.validate", { sql: SQL, schema_path: dir + "/empty.json" })
      expect(r.success).toBe(true)
      expect(r.data.has_schema).toBe(false)
      expect(r.data.valid).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
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

  test("lowercase metadata (Postgres, DuckDB) is a warehouse where uppercase means quoted: the SQL is not folded", async () => {
    // Release-review P0 (v0.12.2): against `shipped_date` held as written, a quoted
    // `"SHIPPED_DATE"` is a different identifier on Postgres, and the query fails there.
    // The v0.12.2-beta.1 fold turned that into `valid: true`.
    const PG = { orders: { columns: [{ name: "shipped_date", type: "DATE" }] } }
    const r = await D.call("altimate_core.validate", { sql: `select "SHIPPED_DATE" from orders`, schema_context: PG })
    expect(r.data.valid).toBe(false)
    expect(r.data.errors.some((e: any) => e.kind?.type === "ColumnNotFound")).toBe(true)
    // …while the lowercase reference is, of course, fine.
    const ok = await D.call("altimate_core.validate", { sql: `select shipped_date from orders`, schema_context: PG })
    expect(ok.data.valid).toBe(true)
    // Mixed metadata: only the names the schema folded are folded in the SQL.
    const MIXED = { orders: { columns: [{ name: "shipped_date", type: "DATE" }, { name: "ORDER_MONTH", type: "DATE" }] } }
    const { prepareSql } = await import("../../src/altimate/native/schema-resolver")
    expect(prepareSql(`select "ORDER_MONTH", "SHIPPED_DATE" from orders`, undefined, MIXED).sql).toBe(
      `select "order_month", "SHIPPED_DATE" from orders`,
    )
    // A name the fold KEPT because its folded form already existed is not folded in
    // the SQL either: `"ORDERS"` must not bind to the sibling `orders`, nor `"ID"` to `id`.
    const COLLIDING = {
      tables: {
        ORDERS: { columns: [{ name: "ID", type: "INT" }, { name: "id", type: "INT" }, { name: "AMOUNT", type: "INT" }] },
        orders: { columns: [{ name: "x", type: "INT" }] },
      },
    }
    expect(prepareSql(`select "ID", "AMOUNT" from "ORDERS"`, undefined, COLLIDING).sql).toBe(
      `select "ID", "amount" from "ORDERS"`,
    )
    // A column name's dots are not qualifiers: `"A"` must not fold via a column `A.B`.
    const DOTTED = { t: { columns: [{ name: "A.B", type: "INT" }, { name: "a", type: "INT" }] } }
    expect(prepareSql(`select "A", "A.B" from t`, undefined, DOTTED).sql).toBe(`select "A", "a.b" from t`)
  })

  test("PINNED LIMITATION: a quoted-lowercase reference to a folded uppercase name is not caught", async () => {
    // Snowflake stores an unquoted-created column as ORDER_MONTH; a query writing
    // `"order_month"` (quoted, lowercase) refers to a different identifier there and fails
    // at the warehouse. After the fold the metadata holds `order_month`, which the quoted
    // token matches exactly, so the tool reports it valid — a false negative the schema
    // shape cannot avoid (it carries no quote identity). Pinned so a change in either
    // direction is a deliberate one. (release review)
    const r = await D.call("altimate_core.validate", {
      sql: `select "order_month" from TPCH_ANALYTICS.PUBLIC_REPORTING.RPT_MONTHLY_SALES_BY_REGION`,
      schema_context: UPPER,
    })
    expect(r.data.valid).toBe(true)
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
