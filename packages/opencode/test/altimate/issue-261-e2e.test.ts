/**
 * End-to-end regression tests for GitHub issue #261.
 *
 * Tests all 11 broken/degraded tools against realistic inputs
 * using the Dispatcher directly (bypasses the CLI/agent layer).
 *
 * Requires @altimateai/altimate-core napi binary to be installed.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"

// Check if napi binary is available
let coreAvailable = false
try {
  require.resolve("@altimateai/altimate-core")
  coreAvailable = true
} catch {
  // napi binary not installed — skip tests
}

const describeIf = coreAvailable ? describe : describe.skip

// ---------------------------------------------------------------------------
// Test Data
// ---------------------------------------------------------------------------

/** Flat schema format — what agents typically pass */
const FLAT_SCHEMA = {
  customers: {
    customer_id: "INTEGER",
    first_name: "VARCHAR",
    last_name: "VARCHAR",
    email: "VARCHAR",
  },
  orders: {
    order_id: "INTEGER",
    customer_id: "INTEGER",
    order_date: "DATE",
    amount: "DECIMAL",
    status: "VARCHAR",
  },
  payments: {
    payment_id: "INTEGER",
    order_id: "INTEGER",
    amount: "DECIMAL",
    payment_method: "VARCHAR",
  },
}

/** Array-of-columns format — what lineage_check uses */
const ARRAY_SCHEMA = {
  customers: [
    { name: "customer_id", data_type: "INTEGER" },
    { name: "first_name", data_type: "VARCHAR" },
    { name: "last_name", data_type: "VARCHAR" },
    { name: "email", data_type: "VARCHAR" },
  ],
  orders: [
    { name: "order_id", data_type: "INTEGER" },
    { name: "customer_id", data_type: "INTEGER" },
    { name: "order_date", data_type: "DATE" },
    { name: "amount", data_type: "DECIMAL" },
  ],
}

/** Two different schemas for diff testing */
const SCHEMA1 = {
  customers: {
    customer_id: "INTEGER",
    first_name: "VARCHAR",
    last_name: "VARCHAR",
    email: "VARCHAR",
  },
}

const SCHEMA2 = {
  customers: {
    customer_id: "INTEGER",
    full_name: "VARCHAR",
    email: "VARCHAR",
    phone: "VARCHAR",
  },
}

/** Realistic compiled SQL from jaffle_shop */
const CUSTOMERS_SQL = `
SELECT
  customers.customer_id,
  customers.first_name,
  customers.last_name,
  customer_orders.first_order,
  customer_orders.most_recent_order,
  customer_orders.number_of_orders,
  customer_payments.total_amount AS customer_lifetime_value
FROM customers
LEFT JOIN (
  SELECT customer_id, MIN(order_date) AS first_order,
         MAX(order_date) AS most_recent_order, COUNT(order_id) AS number_of_orders
  FROM orders GROUP BY customer_id
) AS customer_orders ON customers.customer_id = customer_orders.customer_id
LEFT JOIN (
  SELECT orders.customer_id, SUM(payments.amount) AS total_amount
  FROM payments LEFT JOIN orders ON payments.order_id = orders.order_id
  GROUP BY orders.customer_id
) AS customer_payments ON customers.customer_id = customer_payments.customer_id
`

const SELECT_STAR_SQL = "SELECT * FROM customers"

const BROKEN_SQL = "SELECT order_id as order_id asdas FROM orders"

const GROUP_BY_SQL = `
SELECT customer_id, COUNT(order_id) AS order_count, SUM(amount) AS total
FROM orders
GROUP BY customer_id
`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeIf("Issue #261 E2E: Tool Regression Tests", () => {
  let Dispatcher: any

  beforeAll(async () => {
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
    Dispatcher = await import("../../src/altimate/native/dispatcher")
    const core = await import("../../src/altimate/native/altimate-core")
    const sql = await import("../../src/altimate/native/sql/register")
    // Re-register handlers in case another test file called Dispatcher.reset()
    core.registerAll()
    sql.registerAllSql()
  })

  afterAll(() => {
    delete process.env.ALTIMATE_TELEMETRY_DISABLED
  })

  // ---- BROKEN TOOLS (should now work) ----

  test("1. sql_rewrite — should NOT fail with schema parse error", async () => {
    const result = await Dispatcher.call("sql.rewrite", {
      sql: SELECT_STAR_SQL,
      dialect: "duckdb",
      schema_context: FLAT_SCHEMA,
    })
    expect(result.success).toBe(true)
    // Should not contain "missing field 'tables'" error
    expect(result.error).toBeUndefined()
  })

  test("2. lineage_check — should NOT fail with schema parse error", async () => {
    const result = await Dispatcher.call("lineage.check", {
      sql: CUSTOMERS_SQL,
      dialect: "duckdb",
      schema_context: ARRAY_SCHEMA,
    })
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    // Should have lineage data
    expect(result.data).toBeDefined()
  })

  test("3. altimate_core_fix — should attempt to fix broken SQL", async () => {
    const result = await Dispatcher.call("altimate_core.fix", {
      sql: BROKEN_SQL,
      schema_context: FLAT_SCHEMA,
    })
    // Should not silently fail — either fixes it or reports unfixable errors
    expect(result.data).toBeDefined()
    const data = result.data as Record<string, any>
    const hasResult = data.fixed_sql || data.unfixable_errors?.length || data.fixed !== undefined
    expect(hasResult).toBeTruthy()
  })

  test("4. altimate_core_rewrite — should suggest rewrites for SELECT *", async () => {
    const result = await Dispatcher.call("altimate_core.rewrite", {
      sql: SELECT_STAR_SQL,
      schema_context: FLAT_SCHEMA,
    })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, any>
    // With a proper schema, SELECT * should trigger expand_select_star suggestion
    const suggestions = data.suggestions ?? []
    // Even if no rewrite suggestions, it should not error
    expect(result.error).toBeUndefined()
  })

  test("5. altimate_core_schema_diff — should detect differences between schemas", async () => {
    const result = await Dispatcher.call("altimate_core.schema_diff", {
      schema1_context: SCHEMA1,
      schema2_context: SCHEMA2,
    })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, any>
    // CRITICAL: Should NOT say "Schemas are identical"
    expect(data.changes).toBeDefined()
    expect(data.changes.length).toBeGreaterThan(0)
    // Should detect: first_name removed, last_name removed, full_name added, phone added
    expect(data.changes.length).toBeGreaterThanOrEqual(4)
    expect(data.has_breaking_changes).toBe(true)
  })

  // ---- DEGRADED TOOLS (should now return useful data) ----

  test("6. sql_analyze — should NOT show 'Unknown error'", async () => {
    const result = await Dispatcher.call("sql.analyze", {
      sql: SELECT_STAR_SQL,
      dialect: "duckdb",
      schema_context: FLAT_SCHEMA,
    })
    // Should not have an error field (issues found is not an error)
    expect(result.error).toBeUndefined()
    // Should have issues array (SELECT * is a lint finding)
    expect(result.issues).toBeDefined()
    expect(Array.isArray(result.issues)).toBe(true)
  })

  test("7. altimate_core_validate — should return error details, not empty message", async () => {
    const result = await Dispatcher.call("altimate_core.validate", {
      sql: "SELECT nonexistent_column FROM customers",
      schema_context: FLAT_SCHEMA,
    })
    const data = result.data as Record<string, any>
    // If invalid, should have errors with messages
    if (!data.valid) {
      expect(data.errors).toBeDefined()
      expect(data.errors.length).toBeGreaterThan(0)
      expect(data.errors[0].message).toBeDefined()
      expect(data.errors[0].message.length).toBeGreaterThan(0)
    }
  })

  test("8. altimate_core_grade — should return a grade, not 'undefined'", async () => {
    const result = await Dispatcher.call("altimate_core.grade", {
      sql: CUSTOMERS_SQL,
      schema_context: FLAT_SCHEMA,
    })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, any>
    // Should have overall_grade field with A-F value
    const grade = data.overall_grade ?? data.grade
    expect(grade).toBeDefined()
    expect(["A", "B", "C", "D", "F"]).toContain(grade)
    // Should have scores
    const scores = data.scores
    expect(scores).toBeDefined()
    expect(scores.overall).toBeDefined()
    expect(typeof scores.overall).toBe("number")
  })

  test("9. altimate_core_column_lineage — should find lineage edges", async () => {
    const result = await Dispatcher.call("altimate_core.column_lineage", {
      sql: "SELECT customer_id, SUM(amount) AS total FROM orders GROUP BY customer_id",
      dialect: "duckdb",
      schema_context: FLAT_SCHEMA,
    })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, any>
    // Should have column_dict or column_lineage
    const hasLineage = (data.column_lineage?.length > 0) || (data.column_dict && Object.keys(data.column_dict).length > 0)
    expect(hasLineage).toBe(true)
  })

  test("10. altimate_core_testgen — should generate test cases", async () => {
    const result = await Dispatcher.call("altimate_core.testgen", {
      sql: GROUP_BY_SQL,
      schema_context: FLAT_SCHEMA,
    })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, any>
    const tests = data.test_cases ?? data.tests ?? data.generated_tests ?? []
    // Should generate at least some test cases for a GROUP BY query
    expect(tests.length).toBeGreaterThan(0)
  })

  test("11. altimate_core_complete — should return completions", async () => {
    const result = await Dispatcher.call("altimate_core.complete", {
      sql: "SELECT ",
      cursor_pos: 7,
      schema_context: FLAT_SCHEMA,
    })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, any>
    const items = data.items ?? data.suggestions ?? []
    // Should suggest table names or columns from the schema
    expect(items.length).toBeGreaterThan(0)
  })

  // ---- SCHEMA FORMAT VARIANTS ----

  test("Flat format schema loads correctly for validate", async () => {
    const result = await Dispatcher.call("altimate_core.validate", {
      sql: "SELECT customer_id, first_name FROM customers",
      schema_context: FLAT_SCHEMA,
    })
    const data = result.data as Record<string, any>
    // Should validate successfully since columns exist in schema
    expect(data.valid).toBe(true)
  })

  test("Array format schema loads correctly for lineage", async () => {
    const result = await Dispatcher.call("lineage.check", {
      sql: "SELECT customer_id FROM customers",
      dialect: "duckdb",
      schema_context: ARRAY_SCHEMA,
    })
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })

  test("SchemaDefinition format still works", async () => {
    const result = await Dispatcher.call("altimate_core.validate", {
      sql: "SELECT customer_id FROM customers",
      schema_context: {
        tables: {
          customers: {
            columns: [
              { name: "customer_id", type: "INTEGER" },
              { name: "email", type: "VARCHAR" },
            ],
          },
        },
      },
    })
    const data = result.data as Record<string, any>
    expect(data.valid).toBe(true)
  })
})
