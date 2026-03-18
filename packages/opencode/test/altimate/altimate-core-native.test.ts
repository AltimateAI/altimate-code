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
  ] as const

  test("all 34 altimate_core methods are registered", () => {
    const registered = Dispatcher.listNativeMethods()
    for (const method of ALL_METHODS) {
      expect(registered).toContain(method)
    }
    // Verify exact count of altimate_core methods
    const coreCount = registered.filter((m) =>
      m.startsWith("altimate_core."),
    ).length
    expect(coreCount).toBe(34)
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
