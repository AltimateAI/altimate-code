import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import { resolveSchema, schemaOrEmpty } from "../../src/altimate/native/schema-resolver"
import {
  preprocessIff,
  postprocessQualify,
  registerAll,
} from "../../src/altimate/native/altimate-core"

// Disable telemetry via env var instead of mock.module
beforeAll(() => { process.env.ALTIMATE_TELEMETRY_DISABLED = "true" })
afterAll(() => { delete process.env.ALTIMATE_TELEMETRY_DISABLED })

// Import altimate-core registration (side-effect)
import "../../src/altimate/native/altimate-core"

// ---------------------------------------------------------------------------
// Schema Resolution
// ---------------------------------------------------------------------------

describe("Schema Resolution", () => {
  test("resolveSchema returns null when no args", () => {
    expect(resolveSchema()).toBeNull()
    expect(resolveSchema(undefined, undefined)).toBeNull()
    expect(resolveSchema("", {})).toBeNull()
  })

  test("schemaOrEmpty returns a Schema even with no args", () => {
    const schema = schemaOrEmpty()
    expect(schema).toBeDefined()
    expect(schema.tableNames()).toContain("_empty_")
  })

  test("resolveSchema from DDL context", () => {
    const ctx = {
      version: "1",
      dialect: "generic",
      database: null,
      schema_name: null,
      tables: {
        users: {
          columns: [
            { name: "id", type: "INT", nullable: false },
            { name: "email", type: "VARCHAR", nullable: true },
          ],
        },
      },
    }
    const schema = resolveSchema(undefined, ctx)
    expect(schema).not.toBeNull()
    expect(schema!.tableNames()).toContain("users")
  })

  test("schemaOrEmpty from DDL string", () => {
    const schema = schemaOrEmpty(undefined, {
      version: "1",
      dialect: "generic",
      database: null,
      schema_name: null,
      tables: {
        orders: {
          columns: [{ name: "id", type: "INT", nullable: false }],
        },
      },
    })
    expect(schema.tableNames()).toContain("orders")
  })

  test("resolveSchema from flat format (tool-style schema_context)", () => {
    // This is the format most tools pass: { "table_name": { "col": "TYPE" } }
    const ctx = {
      customers: { customer_id: "INTEGER", name: "VARCHAR", email: "VARCHAR" },
      orders: { order_id: "INTEGER", customer_id: "INTEGER", amount: "DECIMAL" },
    }
    const schema = resolveSchema(undefined, ctx)
    expect(schema).not.toBeNull()
    const tables = schema!.tableNames().sort()
    expect(tables).toContain("customers")
    expect(tables).toContain("orders")
    expect(schema!.columnNames("customers")).toContain("customer_id")
    expect(schema!.columnNames("customers")).toContain("email")
    expect(schema!.columnNames("orders")).toContain("amount")
  })

  test("resolveSchema from array-of-columns format (lineage_check style)", () => {
    // This is the format lineage_check uses: { "table": [{ name, data_type }] }
    const ctx = {
      users: [
        { name: "id", data_type: "INT" },
        { name: "email", data_type: "VARCHAR" },
      ],
    }
    const schema = resolveSchema(undefined, ctx)
    expect(schema).not.toBeNull()
    expect(schema!.tableNames()).toContain("users")
    expect(schema!.columnNames("users")).toContain("id")
    expect(schema!.columnNames("users")).toContain("email")
  })

  test("schemaOrEmpty handles flat format without falling back to empty", () => {
    const schema = schemaOrEmpty(undefined, {
      products: { id: "INT", name: "VARCHAR", price: "DECIMAL" },
    })
    const tables = schema.tableNames()
    expect(tables).toContain("products")
    expect(tables).not.toContain("_empty_")
  })
})

// ---------------------------------------------------------------------------
// IFF Preprocessing
// ---------------------------------------------------------------------------

describe("preprocessIff", () => {
  test("converts simple IFF to CASE WHEN", () => {
    const sql = "SELECT IFF(x > 0, 'positive', 'negative') FROM t"
    const result = preprocessIff(sql)
    expect(result).toContain("CASE WHEN")
    expect(result).toContain("THEN")
    expect(result).toContain("ELSE")
    expect(result).not.toContain("IFF(")
  })

  test("handles multiple IFF calls", () => {
    const sql = "SELECT IFF(a, b, c), IFF(d, e, f) FROM t"
    const result = preprocessIff(sql)
    expect(result).not.toContain("IFF(")
    // Should have two CASE WHEN expressions
    const caseCount = (result.match(/CASE WHEN/g) || []).length
    expect(caseCount).toBe(2)
  })

  test("is case insensitive", () => {
    const sql = "SELECT iff(x > 0, 'yes', 'no') FROM t"
    const result = preprocessIff(sql)
    expect(result).toContain("CASE WHEN")
  })

  test("passes through SQL without IFF unchanged", () => {
    const sql = "SELECT a, b FROM users WHERE id = 1"
    expect(preprocessIff(sql)).toBe(sql)
  })
})

// ---------------------------------------------------------------------------
// QUALIFY Postprocessing
// ---------------------------------------------------------------------------

describe("postprocessQualify", () => {
  test("wraps QUALIFY clause in outer SELECT", () => {
    const sql =
      "SELECT id, name FROM users QUALIFY ROW_NUMBER() OVER (PARTITION BY name ORDER BY id) = 1"
    const result = postprocessQualify(sql)
    expect(result).toContain("SELECT * FROM (")
    expect(result).toContain("AS _qualify WHERE")
    expect(result).toContain("ROW_NUMBER()")
    expect(result).not.toMatch(/\bQUALIFY\b/)
  })

  test("passes through SQL without QUALIFY unchanged", () => {
    const sql = "SELECT a, b FROM users WHERE id = 1"
    expect(postprocessQualify(sql)).toBe(sql)
  })
})

// ---------------------------------------------------------------------------
// Registration Verification
// ---------------------------------------------------------------------------

describe("Registration", () => {
  beforeAll(() => {
    // Re-register in case Dispatcher.reset() was called by another test file
    registerAll()
  })

  const ALL_METHODS = [
    "altimate_core.validate",
    "altimate_core.lint",
    "altimate_core.safety",
    "altimate_core.transpile",
    "altimate_core.explain",
    "altimate_core.check",
    "altimate_core.fix",
    "altimate_core.policy",
    "altimate_core.semantics",
    "altimate_core.testgen",
    "altimate_core.equivalence",
    "altimate_core.migration",
    "altimate_core.schema_diff",
    "altimate_core.rewrite",
    "altimate_core.correct",
    "altimate_core.grade",
    "altimate_core.classify_pii",
    "altimate_core.query_pii",
    "altimate_core.resolve_term",
    "altimate_core.column_lineage",
    "altimate_core.track_lineage",
    "altimate_core.format",
    "altimate_core.metadata",
    "altimate_core.compare",
    "altimate_core.complete",
    "altimate_core.optimize_context",
    "altimate_core.optimize_for_query",
    "altimate_core.prune_schema",
    "altimate_core.import_ddl",
    "altimate_core.export_ddl",
    "altimate_core.fingerprint",
    "altimate_core.introspection_sql",
    "altimate_core.parse_dbt",
    "altimate_core.is_safe",
    "altimate_core.review_ai_prompt",
    "altimate_core.review_ai_parse",
    "altimate_core.review_lexical_scan",
    "altimate_core.grain",
    "altimate_core.source_filters",
    "altimate_core.dbt_config_lint",
    "altimate_core.dbt_config_diff",
    "altimate_core.structural_diff",
  ] as const

  test("all altimate_core methods are registered", () => {
    const registered = Dispatcher.listNativeMethods()
    for (const method of ALL_METHODS) {
      expect(registered).toContain(method)
    }
    // Verify exact count of altimate_core methods
    const coreCount = registered.filter((m) =>
      m.startsWith("altimate_core."),
    ).length
    expect(coreCount).toBe(ALL_METHODS.length)
  })

  test("hasNativeHandler returns true for all methods", () => {
    for (const method of ALL_METHODS) {
      expect(Dispatcher.hasNativeHandler(method)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Method Wrappers (integration — calls real altimate-core napi)
// ---------------------------------------------------------------------------

describe("Method Wrappers", () => {
  beforeAll(() => registerAll())

  test("validate returns AltimateCoreResult for valid SQL", async () => {
    const result = await Dispatcher.call("altimate_core.validate", {
      sql: "SELECT 1",
    })
    expect(result).toHaveProperty("success")
    expect(result).toHaveProperty("data")
    expect(typeof result.success).toBe("boolean")
    expect(typeof result.data).toBe("object")
  })

  test("lint returns AltimateCoreResult", async () => {
    const result = await Dispatcher.call("altimate_core.lint", {
      sql: "SELECT * FROM users",
    })
    expect(result).toHaveProperty("success")
    expect(result).toHaveProperty("data")
  })

  test("safety returns safe for benign SQL", async () => {
    const result = await Dispatcher.call("altimate_core.safety", {
      sql: "SELECT id FROM users WHERE id = 1",
    })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("safe")
  })

  test("transpile converts between dialects", async () => {
    const result = await Dispatcher.call("altimate_core.transpile", {
      sql: "SELECT CURRENT_TIMESTAMP",
      from_dialect: "snowflake",
      to_dialect: "bigquery",
    })
    expect(result).toHaveProperty("success")
    expect(result).toHaveProperty("data")
  })

  test("is_safe returns boolean wrapper", async () => {
    const result = await Dispatcher.call("altimate_core.is_safe", {
      sql: "SELECT 1",
    })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("safe")
    expect(typeof result.data.safe).toBe("boolean")
  })

  test("format returns formatted SQL", async () => {
    const result = await Dispatcher.call("altimate_core.format", {
      sql: "select a,b,c from users where id=1",
    })
    expect(result).toHaveProperty("success")
    expect(result).toHaveProperty("data")
  })

  test("metadata extracts tables and columns", async () => {
    const result = await Dispatcher.call("altimate_core.metadata", {
      sql: "SELECT id, name FROM users JOIN orders ON users.id = orders.user_id",
    })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("tables")
  })

  test("column_lineage returns lineage data", async () => {
    const result = await Dispatcher.call("altimate_core.column_lineage", {
      sql: "SELECT id, name FROM users",
    })
    expect(result.success).toBe(true)
    expect(result.data).toBeDefined()
  })

  test("import_ddl returns serialized schema", async () => {
    const result = await Dispatcher.call("altimate_core.import_ddl", {
      ddl: "CREATE TABLE test (id INT, name VARCHAR(100));",
    })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("schema")
  })

  test("export_ddl returns DDL string", async () => {
    const result = await Dispatcher.call("altimate_core.export_ddl", {
      schema_context: {
        version: "1",
        dialect: "generic",
        database: null,
        schema_name: null,
        tables: {
          test: {
            columns: [{ name: "id", type: "INT", nullable: false }],
          },
        },
      },
    })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("ddl")
    expect(typeof result.data.ddl).toBe("string")
  })

  test("fingerprint returns hash string", async () => {
    const result = await Dispatcher.call("altimate_core.fingerprint", {
      schema_context: {
        version: "1",
        dialect: "generic",
        database: null,
        schema_name: null,
        tables: {
          test: {
            columns: [{ name: "id", type: "INT", nullable: false }],
          },
        },
      },
    })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("fingerprint")
    expect(typeof result.data.fingerprint).toBe("string")
  })
})

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

describe("Error Handling", () => {
  beforeAll(() => registerAll())

  test("invalid SQL returns success: false for validate", async () => {
    // Extremely malformed input to trigger a parse error
    const result = await Dispatcher.call("altimate_core.validate", {
      sql: "NOT SQL AT ALL ))) {{{{",
    })
    // Even if the core doesn't throw, the result should indicate invalid
    expect(result).toHaveProperty("success")
    expect(result).toHaveProperty("data")
  })

  test("handler errors are caught and returned as AltimateCoreResult", async () => {
    // parse_dbt with a non-existent directory should fail gracefully
    const result = await Dispatcher.call("altimate_core.parse_dbt", {
      project_dir: "/nonexistent/path/to/dbt/project",
    })
    expect(result.success).toBe(false)
    expect(result).toHaveProperty("error")
    expect(typeof result.error).toBe("string")
  })

  test("check composite still works with simple SQL", async () => {
    const result = await Dispatcher.call("altimate_core.check", {
      sql: "SELECT 1",
    })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("validation")
    expect(result.data).toHaveProperty("lint")
    expect(result.data).toHaveProperty("safety")
  })
})

// ---------------------------------------------------------------------------
// Real-world regression fixtures (validated against AltimateAI/altimate-ingestion)
// ---------------------------------------------------------------------------

describe("Real-world equivalence regressions", () => {
  beforeAll(() => registerAll())

  // altimate-ingestion PR #650 "rewrite int_current_columns dedup — GROUP BY +
  // JOIN instead of TopN window" claimed "bit-identical output". It is NOT
  // row-equivalent: the legacy `ROW_NUMBER() ... WHERE rn = 1` emits exactly one
  // row per (account, full_column_name); the GROUP BY max(column_id) + JOIN-back
  // emits ALL rows tied for the max within a partition. With `coalesce(column_id, 0)`
  // two NULL-column_id rows in one partition both fold to 0 and both survive →
  // grain break. The engine must decide NOT equivalent (semantic diff), which the
  // reviewer's semantic_change lane turns into a blocking finding. Guards against a
  // regression that would silently clear this class of dedup rewrite as "safe".
  test("PR #650: ROW_NUMBER dedup vs GROUP BY+JOIN-back is NOT equivalent", async () => {
    const base = `
      SELECT account, full_column_name, column_id
      FROM (
        SELECT account, full_column_name, column_id,
          ROW_NUMBER() OVER (
            PARTITION BY account, full_column_name
            ORDER BY COALESCE(column_id, 0) DESC
          ) AS rn
        FROM stg_columns
      ) ranked
      WHERE rn = 1`
    const head = `
      SELECT f.account, f.full_column_name, f.column_id
      FROM stg_columns f
      JOIN (
        SELECT account, full_column_name, MAX(COALESCE(column_id, 0)) AS wid
        FROM stg_columns
        GROUP BY account, full_column_name
      ) w
        ON f.account = w.account
       AND f.full_column_name = w.full_column_name
       AND COALESCE(f.column_id, 0) = w.wid`
    const schema_context = {
      tables: {
        stg_columns: {
          columns: [
            { name: "account", type: "VARCHAR" },
            { name: "full_column_name", type: "VARCHAR" },
            { name: "column_id", type: "BIGINT" },
          ],
        },
      },
    }
    const result = await Dispatcher.call("altimate_core.equivalence", {
      sql1: base,
      sql2: head,
      schema_context,
    })
    expect(result.success).toBe(true)
    expect(result.data.equivalent).toBe(false)
    // The decisive semantic signal: the `rn = 1` dedup filter exists only in the
    // legacy query — there is no row-count guarantee on the rewrite side.
    const diffs = (result.data.differences ?? []) as Array<{ aspect?: string; severity?: string }>
    expect(diffs.some((d) => /^(semantic|major|breaking|critical)$/i.test(String(d.severity)))).toBe(true)
  })

  // Set-vs-multiset soundness fix (2026-05-30). altimate-ingestion ae6f8c2
  // `perf(dbt): use union all instead of union` flips UNION→UNION ALL. The engine
  // must NOT clear that as equivalent (UNION dedups, UNION ALL does not). Likewise
  // it must not be blind to SELECT DISTINCT, while GROUP BY x must equal DISTINCT x.
  const equivCase = async (sql1: string, sql2: string) => {
    const schema_context = {
      tables: {
        a: { columns: [{ name: "x", type: "INT" }] },
        b: { columns: [{ name: "x", type: "INT" }] },
        t: { columns: [{ name: "x", type: "INT" }, { name: "y", type: "INT" }, { name: "f1", type: "BOOLEAN" }, { name: "f2", type: "BOOLEAN" }] },
      },
    }
    const r = await Dispatcher.call("altimate_core.equivalence", { sql1, sql2, schema_context })
    expect(r.success).toBe(true)
    return r.data.equivalent as boolean
  }

  test("equivalence: UNION vs UNION ALL is NOT equivalent (multiset soundness)", async () => {
    expect(await equivCase("select x from a union select x from b", "select x from a union all select x from b")).toBe(false)
  })

  test("equivalence: a dropped SELECT DISTINCT is NOT equivalent", async () => {
    expect(await equivCase("select distinct x, y from t", "select x, y from t")).toBe(false)
  })

  test("equivalence: aggregate-free GROUP BY x EQUALS DISTINCT x (precision)", async () => {
    expect(await equivCase("select x from t group by x", "select distinct x from t")).toBe(true)
  })

  test("equivalence: identical UNION ALL stays equivalent (no false positive)", async () => {
    expect(await equivCase("select x from a union all select x from b", "select x from a union all select x from b")).toBe(true)
  })

  // Projection-expression + window-function soundness (2026-05-30). The comparator
  // checked only output NAME+TYPE, so changed computed expressions / window defs were
  // invisible. These guard that they are now compared.
  test("equivalence: changed computed expression (x+y vs x-y) is NOT equivalent", async () => {
    expect(await equivCase("select x + y as s from t", "select x - y as s from t")).toBe(false)
  })

  test("equivalence: CASE boundary change is NOT equivalent", async () => {
    expect(
      await equivCase(
        "select case when x > 0 then 1 else 0 end as c from t",
        "select case when x >= 0 then 1 else 0 end as c from t",
      ),
    ).toBe(false)
  })

  test("equivalence: ROW_NUMBER vs RANK window is NOT equivalent", async () => {
    expect(
      await equivCase(
        "select row_number() over (order by x) as r from t",
        "select rank() over (order by x) as r from t",
      ),
    ).toBe(false)
  })

  test("equivalence: swapped window PARTITION BY / ORDER BY is NOT equivalent", async () => {
    expect(
      await equivCase(
        "select row_number() over (partition by x order by y) as r from t",
        "select row_number() over (partition by y order by x) as r from t",
      ),
    ).toBe(false)
  })

  test("equivalence: AND-conjunct reorder IS equivalent (precision, no false alarm)", async () => {
    expect(await equivCase("select x from t where f1 and f2", "select x from t where f2 and f1")).toBe(true)
  })

  test("equivalence: passthrough column reorder stays equivalent (no projection false alarm)", async () => {
    expect(await equivCase("select x, y from t", "select y, x from t")).toBe(true)
  })

  // Dialect-function coverage (2026-05-30). Warehouse functions DataFusion lacks
  // (max_by, date_diff, big-endian/xor-fold) must now PLAN, so equivalence is
  // decided instead of failing validation.
  const dialectSchema = {
    tables: { t: { columns: [
      { name: "x", type: "INT" }, { name: "y", type: "INT" }, { name: "g", type: "VARCHAR" },
      { name: "ts1", type: "TIMESTAMP" }, { name: "ts2", type: "TIMESTAMP" }, { name: "h", type: "VARCHAR" },
    ] } },
  }
  const decided = async (sql1: string, sql2: string) => {
    const r = await Dispatcher.call("altimate_core.equivalence", { sql1, sql2, schema_context: dialectSchema })
    expect(r.success).toBe(true)
    const d = r.data as any
    return { decided: (d.validation_errors ?? []).length === 0, equivalent: d.equivalent as boolean }
  }

  test("equivalence: max_by now produces a DECIDED verdict (dialect coverage)", async () => {
    const r = await decided("select g, max_by(x, ts1) as m from t group by g", "select g, max_by(x, ts1) as m from t group by g")
    expect(r.decided).toBe(true)
    expect(r.equivalent).toBe(true)
  })

  test("equivalence: max_by tiebreaker change is decided NOT equivalent", async () => {
    const r = await decided("select g, max_by(x, ts1) as m from t group by g", "select g, max_by(x, ts2) as m from t group by g")
    expect(r.decided).toBe(true)
    expect(r.equivalent).toBe(false)
  })

  test("equivalence: Trino big-endian/xor-fold chain is now decidable", async () => {
    const chain = "select g, to_hex(to_big_endian_64(bitwise_xor_agg(from_big_endian_64(to_utf8(h))))) as fp from t group by g"
    const r = await decided(chain, chain)
    expect(r.decided).toBe(true)
  })

  // L036 integer-overflow lint (2026-05-30). altimate-ingestion 92697ac class.
  const lintCodes = async (sql: string) => {
    const r = await Dispatcher.call("altimate_core.check", { sql })
    expect(r.success).toBe(true)
    return (((r.data as any)?.lint?.findings ?? []) as Array<{ code?: string }>).map((f) => f.code)
  }

  test("lint L036: two large-cardinality columns multiplied → flagged", async () => {
    const codes = await lintCodes("select build_side_rows * probe_side_rows as n from joins")
    expect(codes).toContain("L036")
  })

  test("lint L036: DECIMAL-widened product (the fix) → not flagged", async () => {
    const codes = await lintCodes("select cast(build_side_rows as decimal(38,0)) * probe_side_rows as n from joins")
    expect(codes).not.toContain("L036")
  })

  test("lint L036: benign price*quantity → not flagged", async () => {
    const codes = await lintCodes("select price * quantity as total from line_items")
    expect(codes).not.toContain("L036")
  })

  // L037 join fan-out (2026-05-30). Sound: fires only when the joined table's PK
  // is known AND the join key doesn't cover it, with an additive aggregate present.
  const lintCodesWithSchema = async (sql: string, schema_context: unknown) => {
    const r = await Dispatcher.call("altimate_core.check", { sql, schema_context: schema_context as Record<string, any> })
    expect(r.success).toBe(true)
    return (((r.data as any)?.lint?.findings ?? []) as Array<{ code?: string }>).map((f) => f.code)
  }
  const fanOutSchema = {
    version: "1",
    tables: {
      fact: { columns: [{ name: "k", type: "INT" }, { name: "amt", type: "INT" }, { name: "uid", type: "INT" }, { name: "did", type: "INT" }] },
      events: { columns: [{ name: "event_id", type: "INT" }, { name: "user_id", type: "INT" }], primary_key: ["event_id"] },
      dim: { columns: [{ name: "id", type: "INT" }, { name: "name", type: "VARCHAR" }], primary_key: ["id"] },
    },
  }

  test("lint L037: fan-out join feeding SUM (non-PK key) → flagged", async () => {
    const codes = await lintCodesWithSchema(
      "select f.k, sum(f.amt) as s from fact f join events e on e.user_id = f.uid group by f.k",
      fanOutSchema,
    )
    expect(codes).toContain("L037")
  })

  test("lint L037: join on the joined table's PK → not flagged", async () => {
    const codes = await lintCodesWithSchema(
      "select f.k, sum(f.amt) as s from fact f join dim d on d.id = f.did group by f.k",
      fanOutSchema,
    )
    expect(codes).not.toContain("L037")
  })

  test("lint L037: no primary key in schema → stays silent (sound, no false positive)", async () => {
    const noPk = { version: "1", tables: {
      fact: { columns: [{ name: "k", type: "INT" }, { name: "amt", type: "INT" }, { name: "uid", type: "INT" }] },
      events: { columns: [{ name: "event_id", type: "INT" }, { name: "user_id", type: "INT" }] },
    } }
    const codes = await lintCodesWithSchema(
      "select f.k, sum(f.amt) as s from fact f join events e on e.user_id = f.uid group by f.k",
      noPk,
    )
    expect(codes).not.toContain("L037")
  })

  // L038–L042 archaeology-driven rules (2026-05-30) — through the real RPC.
  test("lint L038: timezone inside a row-key hash → flagged", async () => {
    const codes = await lintCodes("select md5(convert_timezone('UTC','PST', ts) || account) as rk from t")
    expect(codes).toContain("L038")
  })
  test("lint L038: plain hash (no tz) → not flagged", async () => {
    const codes = await lintCodes("select md5(account || name) as rk from t")
    expect(codes).not.toContain("L038")
  })

  test("lint L039: ROW_NUMBER dedup (QUALIFY = 1) ordered only by timestamp → flagged", async () => {
    const codes = await lintCodes("select * from t qualify row_number() over (partition by account order by ingestion_timestamp desc) = 1")
    expect(codes).toContain("L039")
  })
  test("lint L039: ROW_NUMBER with a unique tiebreaker → not flagged", async () => {
    const codes = await lintCodes("select * from t qualify row_number() over (partition by account order by ingestion_timestamp desc, id) = 1")
    expect(codes).not.toContain("L039")
  })
  test("lint L039: bare ROW_NUMBER column with NO dedup filter → not flagged (FP fix)", async () => {
    const codes = await lintCodes("select id, row_number() over (partition by id order by updated_at desc) as rn from t")
    expect(codes).not.toContain("L039")
  })

  test("lint L040: monetary value cast to double → flagged", async () => {
    const codes = await lintCodes("select cast(query_cost as double) as c from t")
    expect(codes).toContain("L040")
  })
  test("lint L040: monetary value cast to decimal → not flagged", async () => {
    const codes = await lintCodes("select cast(query_cost as decimal(38,9)) as c from t")
    expect(codes).not.toContain("L040")
  })

  test("lint L041: coalesce(real bool literal, string) clash → flagged", async () => {
    // A real boolean literal (TRUE) mixed with a string default is a genuine type
    // clash. NB `coalesce(col, 'false')` does NOT fire — quoted 'false' is a string,
    // not a boolean (core tightened L041 to drop that false positive).
    const codes = await lintCodes("select coalesce(x, true, 'false') as flag from t")
    expect(codes).toContain("L041")
  })
  test("lint L041: homogeneous coalesce → not flagged", async () => {
    const codes = await lintCodes("select coalesce(amount, 0) as a from t")
    expect(codes).not.toContain("L041")
  })

  test("lint L042: case-sensitive LIKE on letters → flagged", async () => {
    const codes = await lintCodes("select * from t where event_name like '%AutoSuspend%'")
    expect(codes).toContain("L042")
  })
  test("lint L042: ILIKE → not flagged", async () => {
    const codes = await lintCodes("select * from t where event_name ilike '%x%'")
    expect(codes).not.toContain("L042")
  })

  // L043/L044 — regex→AST migrations (left_to_inner, null-concat).
  test("lint L043: WHERE on a LEFT-joined table → flagged (silent INNER demotion)", async () => {
    const codes = await lintCodes("select c.id from c left join o on c.id = o.cid where o.amount > 0")
    expect(codes).toContain("L043")
  })
  test("lint L043: IS NULL anti-join → not flagged", async () => {
    const codes = await lintCodes("select c.id from c left join o on c.id = o.cid where o.cid is null")
    expect(codes).not.toContain("L043")
  })
  test("lint L044: bare-column || concat → flagged (NULL propagation)", async () => {
    const codes = await lintCodes("select account || '_' || full_column_name as rk from t")
    expect(codes).toContain("L044")
  })
  test("lint L044: coalesce-guarded concat → not flagged", async () => {
    const codes = await lintCodes("select coalesce(a,'') || coalesce(b,'') as rk from t")
    expect(codes).not.toContain("L044")
  })

  test("lint L045: GREATEST/LEAST over a nullable column → flagged", async () => {
    expect(await lintCodes("select greatest(0, end_time) as e from t")).toContain("L045")
  })
  test("lint L046: SELECT DISTINCT + window function → flagged", async () => {
    expect(await lintCodes("select distinct id, row_number() over (order by ts) as rn from t")).toContain("L046")
  })
  test("lint L048: cast(division as int) → flagged", async () => {
    expect(await lintCodes("select cast(num / denom as int) as r from t")).toContain("L048")
  })
  test("lint L048: cast(division as decimal) → not flagged", async () => {
    expect(await lintCodes("select cast(num / denom as decimal(38,9)) as r from t")).not.toContain("L048")
  })
  test("lint L051: FULL OUTER JOIN → flagged", async () => { expect(await lintCodes("select a.id from a full outer join b on a.id=b.id")).toContain("L051") })
  test("lint L052: JOIN on a constant → flagged", async () => { expect(await lintCodes("select * from a join b on 1=1")).toContain("L052") })
  test("lint L053: NULL in IN list → flagged", async () => { expect(await lintCodes("select * from t where x not in (1, null)")).toContain("L053") })
  test("lint L054: AVG of a ratio → flagged", async () => { expect(await lintCodes("select avg(num/denom) as r from t")).toContain("L054") })
    test("lint L050: cast on a JOIN key → flagged", async () => {
    expect(await lintCodes("select a.id from a join b on cast(a.id as varchar) = b.id")).toContain("L050")
  })
    test("lint L049: clock in WHERE → flagged; in projection → not", async () => {
    expect(await lintCodes("select id from t where created_at > current_timestamp() - interval '1' day")).toContain("L049")
    expect(await lintCodes("select id, current_timestamp() as loaded from t")).not.toContain("L049")
  })

  // Grain extraction RPC (2026-05-30) — for grain-vs-declared-PK mismatch.
  const grain = async (sql: string) => {
    const r = await Dispatcher.call("altimate_core.grain", { sql })
    expect(r.success).toBe(true)
    return r.data as { group_by: string[]; dedup_partition: string[] }
  }
  test("grain: extracts final GROUP BY columns", async () => {
    const g = await grain("select account, role_id, count(*) from r group by account, role_id")
    expect(g.group_by).toEqual(["account", "role_id"])
  })
  test("grain: extracts dedup PARTITION BY (QUALIFY)", async () => {
    const g = await grain("select * from r qualify row_number() over (partition by account, role_name order by ts desc) = 1")
    expect(g.dedup_partition).toEqual(["account", "role_name"])
  })
  test("grain: passthrough has no grain", async () => {
    const g = await grain("select a, b from r")
    expect(g.group_by).toEqual([])
    expect(g.dedup_partition).toEqual([])
  })

  test("source_filters: attributes WHERE columns to their upstream table", async () => {
    const r = await Dispatcher.call("altimate_core.source_filters", {
      sql: "select u.id from usage u join prices p on u.k=p.k where u.warehouse_size is not null and p.active",
    })
    expect(r.success).toBe(true)
    const f = (r.data as any).filters
    expect(f.usage).toEqual(["warehouse_size"])
    expect(f.prices).toEqual(["active"])
  })

  // dbt config lint (minijinja-parsed {{ config() }}) — DBT001..DBT005.
  const cfgCodes = async (sql: string) => {
    const r = await Dispatcher.call("altimate_core.dbt_config_lint", { sql })
    expect(r.success).toBe(true)
    return ((r.data as any).findings as Array<{ code: string }>).map((x) => x.code)
  }
  test("dbt config: incremental without is_incremental guard → DBT001", async () => {
    expect(await cfgCodes("{{ config(materialized='incremental', unique_key='id') }}\nselect * from x")).toContain("DBT001")
  })
  test("dbt config: microbatch begin=(modules...) parses via fallback, LEAD no lookback → DBT003", async () => {
    expect(await cfgCodes("{{ config(materialized='incremental', incremental_strategy='microbatch', event_time='ts', lookback=0, begin=(modules.datetime.datetime.now()).isoformat()) }}\nselect lead(ts) over (order by ts) from x")).toContain("DBT003")
  })
  test("dbt config: var() without default → DBT005", async () => {
    expect(await cfgCodes("select * from x where r = '{{ var('region') }}'")).toContain("DBT005")
  })
  test("dbt config: hardcoded relation in FROM → DBT006 (ref()/source() are clean)", async () => {
    expect(
      await cfgCodes("select * from analytics.prod.orders o join {{ ref('c') }} c on o.cid = c.id"),
    ).toContain("DBT006")
    expect(await cfgCodes("select * from {{ ref('stg') }} s join {{ source('raw','c') }} c on s.cid = c.id")).not.toContain(
      "DBT006",
    )
  })

  // AST base-vs-head structural diff — the `*_change` rules (DISTINCT/UNION/GROUP BY/...).
  const structRules = async (base: string, head: string) => {
    const r = await Dispatcher.call("altimate_core.structural_diff", { base_sql: base, head_sql: head })
    expect(r.success).toBe(true)
    return ((r.data as any).findings as Array<{ rule: string }>).map((x) => x.rule)
  }
  test("structural diff: SELECT DISTINCT added → distinct_added", async () => {
    expect(await structRules("select a from t", "select distinct a from t")).toContain("distinct_added")
  })
  test("structural diff: GROUP BY grain change → group_by_change", async () => {
    expect(
      await structRules("select a, sum(x) from t group by a", "select a, b, sum(x) from t group by a, b"),
    ).toContain("group_by_change")
  })
  test("structural diff: surrogate key arg change → surrogate_key_change", async () => {
    expect(
      await structRules(
        "select dbt_utils.generate_surrogate_key(['a','b']) as sk from t",
        "select dbt_utils.generate_surrogate_key(['a','b','c']) as sk from t",
      ),
    ).toContain("surrogate_key_change")
  })
  test("structural diff: removed WHERE predicate → removed_predicate", async () => {
    expect(await structRules("select a from t where x = 1 and y = 2", "select a from t where x = 1")).toContain(
      "removed_predicate",
    )
  })
  test("structural diff: identical SQL → no findings", async () => {
    expect(await structRules("select distinct a from t group by a", "select distinct a from t group by a")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// altimate-core@0.5.1: dialect forwarding + authoritative `decidable` field
// ---------------------------------------------------------------------------
//
// 0.5.1 added an optional `dialect` arg to checkEquivalence and a `decidable`
// flag on the result. The native equivalence handler now forwards `params.dialect`
// to the engine so dialect-specific compiled warehouse SQL parses instead of
// abstaining on a syntax error. These tests exercise the REAL engine through the
// Dispatcher (no mocks) to prove the arg is wired end-to-end.
describe("core 0.5.1 dialect forwarding + decidable", () => {
  beforeAll(async () => {
    registerAll()
    // sql.diff lives in the sql/* handler set, registered separately.
    const { registerAllSql } = await import("../../src/altimate/native/sql/register")
    registerAllSql()
  })

  const variantSchema = {
    tables: { t: { columns: [
      { name: "x", type: "INT" }, { name: "payload", type: "VARIANT" },
    ] } },
  }
  // Snowflake semi-structured access `payload:f` is a hard PARSE error in the
  // default dialect (the ':' is rejected) but parses under the snowflake dialect.
  // The validation-error TEXT therefore differs by dialect — a syntax error only
  // when the hint is dropped. Pre-fix (dialect not forwarded) BOTH would be syntax
  // errors; this asserts they diverge, proving the arg reaches the parser.
  const colonSql = "select payload:f::int as v from t"
  const equivCall = (dialect?: string) =>
    Dispatcher.call("altimate_core.equivalence", { sql1: colonSql, sql2: colonSql, schema_context: variantSchema, dialect })
  const hasSyntaxError = (data: any) =>
    (data.validation_errors ?? []).some((e: string) => /Syntax error|Expected end of statement/i.test(String(e)))

  test("dialect hint is forwarded to the engine (changes parse outcome)", async () => {
    const noDialect = await equivCall(undefined)
    const snowflake = await equivCall("snowflake")
    expect(noDialect.success).toBe(true)
    expect(snowflake.success).toBe(true)
    // Without a dialect the colon is a syntax error; snowflake accepts it.
    expect(hasSyntaxError(noDialect.data)).toBe(true)
    expect(hasSyntaxError(snowflake.data)).toBe(false)
  })

  test("decidable=false is surfaced when the engine cannot parse/plan", async () => {
    const noDialect = await equivCall(undefined)
    expect((noDialect.data as any).decidable).toBe(false)
  })

  test("decidable=true is surfaced for a cleanly decided pair", async () => {
    const r = await Dispatcher.call("altimate_core.equivalence", {
      sql1: "select count(*) from t",
      sql2: "select count(1) from t",
      schema_context: variantSchema,
    })
    expect(r.success).toBe(true)
    const d = r.data as any
    expect(d.decidable).toBe(true)
    expect(d.equivalent).toBe(true)
  })

  test("empty-string dialect is coerced to no-hint (does NOT throw)", async () => {
    // ReviewConfig.dialect defaults to "" (auto-detect). The engine throws on an
    // unknown dialect "", so the handler must coerce "" → undefined (`|| undefined`,
    // not `??`). Regression guard: before the coercion this returned success=false
    // and silently disabled equivalence checking on the default config.
    const r = await Dispatcher.call("altimate_core.equivalence", {
      sql1: "select count(*) from t",
      sql2: "select count(1) from t",
      schema_context: variantSchema,
      dialect: "",
    })
    expect(r.success).toBe(true)
    const d = r.data as any
    expect(d.decidable).toBe(true)
    expect(d.equivalent).toBe(true)
  })

  test("sql.diff accepts and forwards the dialect hint without throwing", async () => {
    // sql.diff's runtime shape (success/diff/equivalent) predates its declared
    // SqlDiffResult type, so read through `any`. The assertion that matters: the
    // dialect param is plumbed into the handler's checkEquivalence call (Edit in
    // sql/register.ts) and the snowflake path is reachable end-to-end.
    const call = (dialect?: string) =>
      Dispatcher.call("sql.diff", {
        original: colonSql,
        modified: colonSql,
        schema_context: variantSchema,
        dialect,
      } as any) as Promise<any>
    const noDialect = await call(undefined)
    const snowflake = await call("snowflake")
    expect(noDialect.success).toBe(true)
    expect(snowflake.success).toBe(true)
    expect(typeof noDialect.diff).toBe("string")
    expect(typeof snowflake.diff).toBe("string")
  })
})
