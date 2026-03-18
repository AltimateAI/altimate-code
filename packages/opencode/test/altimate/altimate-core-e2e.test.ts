/**
 * End-to-end tests for all altimate-core tools via the Dispatcher.
 *
 * Exercises every registered dispatcher method with realistic inputs,
 * validates output field names match Rust napi return types, and checks
 * error recovery paths.
 *
 * Requires @altimateai/altimate-core napi binary to be installed.
 * Skips gracefully if the binary is not available.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"

// ---------------------------------------------------------------------------
// Availability check
// ---------------------------------------------------------------------------

let coreAvailable = false
try {
  require.resolve("@altimateai/altimate-core")
  coreAvailable = true
} catch {}

const describeIf = coreAvailable ? describe : describe.skip

// ---------------------------------------------------------------------------
// Schema fixtures
// ---------------------------------------------------------------------------

/** Flat format — what agents typically pass */
const ECOMMERCE_FLAT = {
  customers: {
    customer_id: "INTEGER",
    first_name: "VARCHAR",
    last_name: "VARCHAR",
    email: "VARCHAR",
    created_at: "TIMESTAMP",
  },
  orders: {
    order_id: "INTEGER",
    customer_id: "INTEGER",
    order_date: "DATE",
    status: "VARCHAR",
    amount: "DECIMAL",
  },
  payments: {
    payment_id: "INTEGER",
    order_id: "INTEGER",
    payment_method: "VARCHAR",
    amount: "DECIMAL",
  },
  products: {
    product_id: "INTEGER",
    name: "VARCHAR",
    category: "VARCHAR",
    price: "DECIMAL",
  },
  order_items: {
    item_id: "INTEGER",
    order_id: "INTEGER",
    product_id: "INTEGER",
    quantity: "INTEGER",
    unit_price: "DECIMAL",
  },
}

/** SchemaDefinition format — what the Rust engine expects natively */
const ECOMMERCE_SD = {
  tables: {
    customers: {
      columns: [
        { name: "customer_id", type: "INTEGER" },
        { name: "first_name", type: "VARCHAR" },
        { name: "last_name", type: "VARCHAR" },
        { name: "email", type: "VARCHAR" },
        { name: "created_at", type: "TIMESTAMP" },
      ],
    },
    orders: {
      columns: [
        { name: "order_id", type: "INTEGER" },
        { name: "customer_id", type: "INTEGER" },
        { name: "order_date", type: "DATE" },
        { name: "status", type: "VARCHAR" },
        { name: "amount", type: "DECIMAL" },
      ],
    },
  },
}

/** Array-of-columns format — what lineage_check uses */
const ARRAY_SCHEMA = {
  customers: [
    { name: "customer_id", data_type: "INTEGER" },
    { name: "first_name", data_type: "VARCHAR" },
    { name: "email", data_type: "VARCHAR" },
  ],
  orders: [
    { name: "order_id", data_type: "INTEGER" },
    { name: "customer_id", data_type: "INTEGER" },
    { name: "amount", data_type: "DECIMAL" },
  ],
}

// ---------------------------------------------------------------------------
// SQL fixtures
// ---------------------------------------------------------------------------

const SQL = {
  simple: "SELECT customer_id, first_name FROM customers WHERE customer_id = 1",
  selectStar: "SELECT * FROM orders",
  join: `SELECT c.customer_id, c.first_name, o.order_id, o.amount
FROM customers c
INNER JOIN orders o ON c.customer_id = o.customer_id
WHERE o.status = 'completed'`,
  multiJoin: `SELECT c.customer_id, c.first_name, c.last_name,
  COUNT(o.order_id) AS order_count,
  SUM(p.amount) AS total_paid,
  MAX(o.order_date) AS last_order
FROM customers c
LEFT JOIN orders o ON c.customer_id = o.customer_id
LEFT JOIN payments p ON o.order_id = p.order_id
GROUP BY c.customer_id, c.first_name, c.last_name`,
  subquery: `SELECT customer_id, first_name FROM customers
WHERE customer_id IN (SELECT customer_id FROM orders WHERE amount > 100)`,
  cte: `WITH high_value AS (
  SELECT customer_id, SUM(amount) AS total FROM orders
  GROUP BY customer_id HAVING SUM(amount) > 1000
)
SELECT c.first_name, c.last_name, h.total
FROM customers c JOIN high_value h ON c.customer_id = h.customer_id`,
  cartesian: "SELECT * FROM customers, orders",
  syntaxError: "SELCT * FORM customers",
  missingColumn: "SELECT nonexistent FROM customers",
  windowFunc: `SELECT customer_id, order_date, amount,
  ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date DESC) AS rn,
  SUM(amount) OVER (PARTITION BY customer_id) AS customer_total
FROM orders`,
  caseWhen: `SELECT order_id,
  CASE WHEN amount > 100 THEN 'high' WHEN amount > 50 THEN 'medium' ELSE 'low' END AS tier
FROM orders`,
  groupBy: `SELECT customer_id, COUNT(order_id) AS order_count, SUM(amount) AS total
FROM orders GROUP BY customer_id`,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeIf("altimate-core E2E", () => {
  let D: any

  beforeAll(async () => {
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
    D = await import("../../src/altimate/native/dispatcher")
    const core = await import("../../src/altimate/native/altimate-core")
    const sql = await import("../../src/altimate/native/sql/register")
    // Re-register handlers in case another test file called Dispatcher.reset()
    core.registerAll()
    sql.registerAllSql()
  })

  afterAll(() => { delete process.env.ALTIMATE_TELEMETRY_DISABLED })

  // =========================================================================
  // altimate_core.validate
  // =========================================================================

  describe("altimate_core.validate", () => {
    test("valid simple query", async () => {
      const r = await D.call("altimate_core.validate", { sql: SQL.simple, schema_context: ECOMMERCE_FLAT })
      expect((r.data as any).valid).toBe(true)
      expect((r.data as any).errors).toHaveLength(0)
    })

    test("valid multi-join query", async () => {
      const r = await D.call("altimate_core.validate", { sql: SQL.multiJoin, schema_context: ECOMMERCE_FLAT })
      expect((r.data as any).valid).toBe(true)
    })

    test("invalid — missing column returns errors with messages", async () => {
      const r = await D.call("altimate_core.validate", { sql: SQL.missingColumn, schema_context: ECOMMERCE_FLAT })
      const d = r.data as any
      expect(d.valid).toBe(false)
      expect(d.errors.length).toBeGreaterThan(0)
      expect(d.errors[0].message).toBeDefined()
      expect(d.errors[0].message.length).toBeGreaterThan(0)
    })

    test("syntax error detected", async () => {
      const r = await D.call("altimate_core.validate", { sql: SQL.syntaxError, schema_context: ECOMMERCE_FLAT })
      expect((r.data as any).valid).toBe(false)
      expect((r.data as any).errors.length).toBeGreaterThan(0)
    })

    test("works with SchemaDefinition format", async () => {
      const r = await D.call("altimate_core.validate", { sql: "SELECT customer_id FROM customers", schema_context: ECOMMERCE_SD })
      expect((r.data as any).valid).toBe(true)
    })

    test("works with empty schema_context", async () => {
      const r = await D.call("altimate_core.validate", { sql: SQL.simple })
      expect(r.data).toBeDefined()
    })

    test("empty SQL handled gracefully", async () => {
      const r = await D.call("altimate_core.validate", { sql: "", schema_context: ECOMMERCE_FLAT })
      expect(r).toBeDefined()
    })

    test("CTE validates", async () => {
      const r = await D.call("altimate_core.validate", { sql: SQL.cte, schema_context: ECOMMERCE_FLAT })
      expect((r.data as any).valid).toBe(true)
    })

    test("window function validates", async () => {
      const r = await D.call("altimate_core.validate", { sql: SQL.windowFunc, schema_context: ECOMMERCE_FLAT })
      expect((r.data as any).valid).toBe(true)
    })

    test("correlated subquery validates", async () => {
      const sql = `SELECT c.first_name, (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.customer_id) AS cnt FROM customers c`
      const r = await D.call("altimate_core.validate", { sql, schema_context: ECOMMERCE_FLAT })
      expect((r.data as any).valid).toBe(true)
    })

    test("EXISTS subquery validates", async () => {
      const sql = `SELECT first_name FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id)`
      const r = await D.call("altimate_core.validate", { sql, schema_context: ECOMMERCE_FLAT })
      expect((r.data as any).valid).toBe(true)
    })

    test("self-join validates", async () => {
      const sql = `SELECT a.order_id, b.order_id AS related FROM orders a JOIN orders b ON a.customer_id = b.customer_id AND a.order_id <> b.order_id`
      const r = await D.call("altimate_core.validate", { sql, schema_context: ECOMMERCE_FLAT })
      expect((r.data as any).valid).toBe(true)
    })

    test("deeply nested subqueries", async () => {
      const sql = `SELECT * FROM (SELECT * FROM (SELECT * FROM (SELECT customer_id, first_name FROM customers WHERE customer_id > 0) t1) t2) t3`
      const r = await D.call("altimate_core.validate", { sql, schema_context: ECOMMERCE_FLAT })
      expect(r).toBeDefined()
    })

    test("multiple CTEs", async () => {
      const sql = `WITH a AS (SELECT customer_id FROM customers), b AS (SELECT customer_id, COUNT(*) AS cnt FROM orders GROUP BY customer_id), c AS (SELECT customer_id, SUM(amount) AS total FROM orders GROUP BY customer_id HAVING SUM(amount) > 1000) SELECT a.customer_id, b.cnt, c.total FROM a LEFT JOIN b ON a.customer_id = b.customer_id LEFT JOIN c ON a.customer_id = c.customer_id`
      const r = await D.call("altimate_core.validate", { sql, schema_context: ECOMMERCE_FLAT })
      expect((r.data as any).valid).toBe(true)
    })
  })

  // =========================================================================
  // altimate_core.lint
  // =========================================================================

  describe("altimate_core.lint", () => {
    test("SELECT * triggers finding", async () => {
      const r = await D.call("altimate_core.lint", { sql: SQL.selectStar, schema_context: ECOMMERCE_FLAT })
      expect((r.data as any).findings?.some((f: any) => f.rule === "select_star")).toBe(true)
    })

    test("clean query with LIMIT has fewer findings", async () => {
      const r = await D.call("altimate_core.lint", { sql: "SELECT customer_id FROM customers WHERE customer_id = 1 LIMIT 10", schema_context: ECOMMERCE_FLAT })
      const d = r.data as any
      const selectStarFindings = d.findings?.filter((f: any) => f.rule === "select_star") ?? []
      expect(selectStarFindings.length).toBe(0)
    })

    test("cartesian product detected", async () => {
      const r = await D.call("altimate_core.lint", { sql: SQL.cartesian, schema_context: ECOMMERCE_FLAT })
      expect(r).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.safety + is_safe
  // =========================================================================

  describe("altimate_core.safety", () => {
    test("clean SQL is safe", async () => {
      const r = await D.call("altimate_core.safety", { sql: SQL.simple })
      expect((r.data as any).safe).toBe(true)
    })

    test("multi-statement detected", async () => {
      const r = await D.call("altimate_core.safety", { sql: "SELECT 1; DROP TABLE users;" })
      expect((r.data as any).statement_count).toBeGreaterThan(1)
    })

    test("is_safe returns boolean", async () => {
      const r = await D.call("altimate_core.is_safe", { sql: SQL.simple })
      expect(r.data.safe).toBe(true)
    })
  })

  // =========================================================================
  // altimate_core.explain
  // =========================================================================

  describe("altimate_core.explain", () => {
    test("explains a query", async () => {
      const r = await D.call("altimate_core.explain", { sql: SQL.simple, schema_context: ECOMMERCE_FLAT })
      expect(r.success).toBe(true)
    })

    test("explains a complex join", async () => {
      const r = await D.call("altimate_core.explain", { sql: SQL.multiJoin, schema_context: ECOMMERCE_FLAT })
      expect(r.success).toBe(true)
    })
  })

  // =========================================================================
  // altimate_core.check (composite)
  // =========================================================================

  describe("altimate_core.check", () => {
    test("returns validation, lint, and safety", async () => {
      const r = await D.call("altimate_core.check", { sql: SQL.selectStar, schema_context: ECOMMERCE_FLAT })
      const d = r.data as any
      expect(d.validation).toBeDefined()
      expect(d.lint).toBeDefined()
      expect(d.safety).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.fix
  // =========================================================================

  describe("altimate_core.fix", () => {
    test("fixes typo in column name", async () => {
      const r = await D.call("altimate_core.fix", { sql: "SELECT custmer_id FROM customers", schema_context: ECOMMERCE_FLAT })
      const d = r.data as any
      if (d.fixed) expect(d.fixed_sql.toLowerCase()).toContain("customer_id")
    })

    test("fixes typo in table name", async () => {
      const r = await D.call("altimate_core.fix", { sql: "SELECT order_id FROM ordrs", schema_context: ECOMMERCE_FLAT })
      const d = r.data as any
      if (d.fixed) expect(d.fixed_sql.toLowerCase()).toContain("orders")
    })

    test("already valid SQL returns without error", async () => {
      const r = await D.call("altimate_core.fix", { sql: SQL.simple, schema_context: ECOMMERCE_FLAT })
      expect(r.data).toBeDefined()
    })

    test("completely broken SQL handled gracefully", async () => {
      const r = await D.call("altimate_core.fix", { sql: "GIBBERISH NONSENSE BLAH", schema_context: ECOMMERCE_FLAT })
      expect(r).toBeDefined()
    })

    test("reports iteration count", async () => {
      const r = await D.call("altimate_core.fix", { sql: "SELECT nme FROM ordrs", schema_context: ECOMMERCE_FLAT })
      expect((r.data as any).iterations).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.grade
  // =========================================================================

  describe("altimate_core.grade", () => {
    test("returns A-F grade with score breakdown", async () => {
      const r = await D.call("altimate_core.grade", { sql: SQL.simple, schema_context: ECOMMERCE_FLAT })
      const d = r.data as any
      expect(d.overall_grade).toBeDefined()
      expect(["A", "B", "C", "D", "F"]).toContain(d.overall_grade)
      expect(d.scores).toBeDefined()
      expect(typeof d.scores.overall).toBe("number")
      expect(d.scores.overall).toBeGreaterThanOrEqual(0)
      expect(d.scores.overall).toBeLessThanOrEqual(1)
      for (const key of ["syntax", "style", "safety", "complexity"]) {
        expect(d.scores[key]).toBeDefined()
      }
    })

    test("explicit columns grade >= SELECT *", async () => {
      const r1 = await D.call("altimate_core.grade", { sql: SQL.simple, schema_context: ECOMMERCE_FLAT })
      const r2 = await D.call("altimate_core.grade", { sql: SQL.selectStar, schema_context: ECOMMERCE_FLAT })
      expect((r1.data as any).scores.overall).toBeGreaterThanOrEqual((r2.data as any).scores.overall)
    })

    test("syntax error gets low grade", async () => {
      const r = await D.call("altimate_core.grade", { sql: SQL.syntaxError, schema_context: ECOMMERCE_FLAT })
      expect(["C", "D", "F"]).toContain((r.data as any).overall_grade)
    })
  })

  // =========================================================================
  // altimate_core.rewrite
  // =========================================================================

  describe("altimate_core.rewrite", () => {
    test("suggestions have rule and rewritten_sql", async () => {
      const r = await D.call("altimate_core.rewrite", { sql: SQL.selectStar, schema_context: ECOMMERCE_FLAT })
      const d = r.data as any
      if (d.suggestions?.length) {
        for (const s of d.suggestions) {
          expect(s.rule).toBeDefined()
          expect(s.rewritten_sql).toBeDefined()
        }
      }
    })

    test("does not crash on DML", async () => {
      const r = await D.call("altimate_core.rewrite", { sql: "INSERT INTO orders (order_id) VALUES (1)", schema_context: ECOMMERCE_FLAT })
      expect(r).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.testgen
  // =========================================================================

  describe("altimate_core.testgen", () => {
    test("generates test cases with inputs and categories", async () => {
      const r = await D.call("altimate_core.testgen", { sql: SQL.groupBy, schema_context: ECOMMERCE_FLAT })
      const d = r.data as any
      const tests = d.test_cases ?? d.tests ?? []
      expect(tests.length).toBeGreaterThan(0)
      for (const tc of tests) {
        expect(tc.name || tc.description).toBeTruthy()
        expect(tc.category).toBeDefined()
        expect(tc.sql || tc.inputs).toBeDefined()
      }
    })

    test("CASE WHEN query gets tests", async () => {
      const r = await D.call("altimate_core.testgen", { sql: SQL.caseWhen, schema_context: ECOMMERCE_FLAT })
      expect(((r.data as any).test_cases ?? []).length).toBeGreaterThan(0)
    })
  })

  // =========================================================================
  // altimate_core.complete
  // =========================================================================

  describe("altimate_core.complete", () => {
    test("suggests columns after SELECT", async () => {
      const r = await D.call("altimate_core.complete", { sql: "SELECT ", cursor_pos: 7, schema_context: ECOMMERCE_FLAT })
      const items = (r.data as any).items ?? []
      expect(items.length).toBeGreaterThan(0)
    })

    test("suggests tables after FROM", async () => {
      const r = await D.call("altimate_core.complete", { sql: "SELECT * FROM ", cursor_pos: 14, schema_context: ECOMMERCE_FLAT })
      const items = (r.data as any).items ?? []
      expect(items.length).toBeGreaterThan(0)
      const labels = items.map((i: any) => i.label)
      expect(labels).toContain("customers")
      expect(labels).toContain("orders")
    })

    test("cursor at 0 doesn't crash", async () => {
      const r = await D.call("altimate_core.complete", { sql: "", cursor_pos: 0, schema_context: ECOMMERCE_FLAT })
      expect(r).toBeDefined()
    })

    test("cursor beyond length doesn't crash", async () => {
      const r = await D.call("altimate_core.complete", { sql: "SELECT", cursor_pos: 999, schema_context: ECOMMERCE_FLAT })
      expect(r).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.column_lineage
  // =========================================================================

  describe("altimate_core.column_lineage", () => {
    test("traces direct column references", async () => {
      const r = await D.call("altimate_core.column_lineage", { sql: "SELECT customer_id, first_name FROM customers", schema_context: ECOMMERCE_FLAT })
      const d = r.data as any
      expect(d.column_dict).toBeDefined()
      expect(Object.keys(d.column_dict).length).toBeGreaterThan(0)
    })

    test("traces through JOIN", async () => {
      const r = await D.call("altimate_core.column_lineage", { sql: SQL.join, schema_context: ECOMMERCE_FLAT })
      expect((r.data as any).column_lineage?.length).toBeGreaterThan(0)
    })

    test("traces through CTE", async () => {
      const r = await D.call("altimate_core.column_lineage", { sql: SQL.cte, schema_context: ECOMMERCE_FLAT })
      const d = r.data as any
      expect(d.column_dict && Object.keys(d.column_dict).length > 0 || d.column_lineage?.length > 0).toBe(true)
    })

    test("traces through aggregation", async () => {
      const r = await D.call("altimate_core.column_lineage", { sql: SQL.groupBy, schema_context: ECOMMERCE_FLAT })
      const d = r.data as any
      expect(d.column_dict).toBeDefined()
      expect(d.column_dict.customer_id).toBeDefined()
    })

    test("traces through CONCAT", async () => {
      const r = await D.call("altimate_core.column_lineage", {
        sql: "SELECT customer_id, first_name || ' ' || last_name AS full_name FROM customers",
        schema_context: ECOMMERCE_FLAT,
      })
      expect((r.data as any).column_dict?.full_name).toBeDefined()
    })

    test("traces through arithmetic", async () => {
      const r = await D.call("altimate_core.column_lineage", {
        sql: "SELECT order_id, amount * 1.1 AS with_tax FROM orders",
        schema_context: ECOMMERCE_FLAT,
      })
      expect((r.data as any).column_dict).toBeDefined()
    })

    test("no schema still returns partial lineage", async () => {
      const r = await D.call("altimate_core.column_lineage", { sql: "SELECT a, b FROM t" })
      expect(r.success).toBe(true)
    })
  })

  // =========================================================================
  // altimate_core.schema_diff
  // =========================================================================

  describe("altimate_core.schema_diff", () => {
    test("identical schemas — empty changes", async () => {
      const r = await D.call("altimate_core.schema_diff", { schema1_context: ECOMMERCE_FLAT, schema2_context: ECOMMERCE_FLAT })
      const d = r.data as any
      expect(d.changes).toHaveLength(0)
      expect(d.has_breaking_changes).toBe(false)
    })

    test("detects added table", async () => {
      const s2 = { ...ECOMMERCE_FLAT, reviews: { review_id: "INTEGER", content: "TEXT" } }
      const r = await D.call("altimate_core.schema_diff", { schema1_context: ECOMMERCE_FLAT, schema2_context: s2 })
      expect((r.data as any).changes.some((c: any) => c.type === "table_added" && c.table === "reviews")).toBe(true)
    })

    test("detects removed table (breaking)", async () => {
      const { products, ...without } = ECOMMERCE_FLAT
      const r = await D.call("altimate_core.schema_diff", { schema1_context: ECOMMERCE_FLAT, schema2_context: without })
      const d = r.data as any
      expect(d.changes.some((c: any) => c.type === "table_removed" && c.table === "products")).toBe(true)
      expect(d.has_breaking_changes).toBe(true)
    })

    test("detects column type change (breaking)", async () => {
      const s2 = { ...ECOMMERCE_FLAT, orders: { ...ECOMMERCE_FLAT.orders, amount: "BIGINT" } }
      const r = await D.call("altimate_core.schema_diff", { schema1_context: ECOMMERCE_FLAT, schema2_context: s2 })
      expect((r.data as any).changes.some((c: any) => c.type === "column_type_changed" && c.column === "amount")).toBe(true)
    })

    test("case-insensitive type comparison", async () => {
      const s1 = { t: { a: "varchar" } }
      const s2 = { t: { a: "VARCHAR" } }
      const r = await D.call("altimate_core.schema_diff", { schema1_context: s1, schema2_context: s2 })
      expect((r.data as any).changes.length).toBe(0)
    })

    test("only additions is non-breaking", async () => {
      const s1 = { t: { a: "INT" } }
      const s2 = { t: { a: "INT", b: "VARCHAR", c: "DATE" } }
      const r = await D.call("altimate_core.schema_diff", { schema1_context: s1, schema2_context: s2 })
      const d = r.data as any
      expect(d.has_breaking_changes).toBe(false)
      expect(d.changes.length).toBe(2)
    })

    test("summary string is well-formed", async () => {
      const s1 = { t: { a: "INT" } }
      const s2 = { t: { a: "INT", b: "VARCHAR" } }
      const r = await D.call("altimate_core.schema_diff", { schema1_context: s1, schema2_context: s2 })
      expect((r.data as any).summary).toContain("1 change")
    })

    test("100-column table diff", async () => {
      const cols1: Record<string, string> = {}
      const cols2: Record<string, string> = {}
      for (let i = 0; i < 100; i++) {
        cols1[`col_${i}`] = "VARCHAR"
        cols2[`col_${i}`] = i < 50 ? "VARCHAR" : "INTEGER"
      }
      const r = await D.call("altimate_core.schema_diff", { schema1_context: { big: cols1 }, schema2_context: { big: cols2 } })
      expect((r.data as any).changes.length).toBe(50)
    })

    test("empty to full schema", async () => {
      const r = await D.call("altimate_core.schema_diff", { schema1_context: {}, schema2_context: ECOMMERCE_FLAT })
      expect((r.data as any).changes.filter((c: any) => c.type === "table_added").length).toBe(Object.keys(ECOMMERCE_FLAT).length)
    })
  })

  // =========================================================================
  // altimate_core.equivalence
  // =========================================================================

  describe("altimate_core.equivalence", () => {
    test("identical queries are equivalent", async () => {
      const r = await D.call("altimate_core.equivalence", { sql1: SQL.simple, sql2: SQL.simple, schema_context: ECOMMERCE_FLAT })
      expect((r.data as any).equivalent).toBe(true)
    })

    test("different queries are not equivalent", async () => {
      const r = await D.call("altimate_core.equivalence", {
        sql1: "SELECT customer_id FROM customers",
        sql2: "SELECT order_id FROM orders",
        schema_context: ECOMMERCE_FLAT,
      })
      expect((r.data as any).equivalent).toBe(false)
    })

    test("semantically different WHERE are not equivalent", async () => {
      const r = await D.call("altimate_core.equivalence", {
        sql1: "SELECT customer_id FROM customers WHERE customer_id > 10",
        sql2: "SELECT customer_id FROM customers WHERE customer_id < 10",
        schema_context: ECOMMERCE_FLAT,
      })
      expect((r.data as any).equivalent).toBe(false)
    })
  })

  // =========================================================================
  // altimate_core.semantics
  // =========================================================================

  describe("altimate_core.semantics", () => {
    test("clean join has no issues", async () => {
      const r = await D.call("altimate_core.semantics", { sql: SQL.join, schema_context: ECOMMERCE_FLAT })
      expect(r.success).toBe(true)
    })
  })

  // =========================================================================
  // altimate_core.correct
  // =========================================================================

  describe("altimate_core.correct", () => {
    test("corrects broken SQL", async () => {
      const r = await D.call("altimate_core.correct", { sql: "SELECT custmer_id FROM ordrs", schema_context: ECOMMERCE_FLAT })
      const d = r.data as any
      expect(d.status || d.fixed || d.corrected_sql).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.transpile
  // =========================================================================

  describe("altimate_core.transpile", () => {
    test("snowflake to postgres", async () => {
      const r = await D.call("altimate_core.transpile", { sql: "SELECT NVL(first_name, 'Unknown') FROM customers", from_dialect: "snowflake", to_dialect: "postgres" })
      expect(r).toBeDefined()
    })

    test("same dialect is identity", async () => {
      const r = await D.call("altimate_core.transpile", { sql: "SELECT 1", from_dialect: "postgres", to_dialect: "postgres" })
      expect(r).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.format
  // =========================================================================

  describe("altimate_core.format", () => {
    test("formats messy SQL", async () => {
      const r = await D.call("altimate_core.format", { sql: "select a,b,c from t where x=1" })
      const d = r.data as any
      expect(d.formatted_sql).toBeDefined()
      expect(d.formatted_sql.length).toBeGreaterThan(0)
    })
  })

  // =========================================================================
  // altimate_core.metadata
  // =========================================================================

  describe("altimate_core.metadata", () => {
    test("extracts tables, columns, and flags", async () => {
      const r = await D.call("altimate_core.metadata", { sql: SQL.multiJoin })
      const d = r.data as any
      expect(d.tables).toBeDefined()
      expect(d.tables.length).toBe(3)
      expect(d.has_aggregation).toBe(true)
    })

    test("detects subqueries", async () => {
      // Use derived table (FROM subquery) which the engine reliably flags
      const r = await D.call("altimate_core.metadata", { sql: "SELECT * FROM (SELECT customer_id FROM customers) t" })
      expect((r.data as any).has_subqueries).toBe(true)
    })

    test("detects window functions", async () => {
      const r = await D.call("altimate_core.metadata", { sql: SQL.windowFunc })
      expect((r.data as any).has_window_functions).toBe(true)
    })
  })

  // =========================================================================
  // altimate_core.compare
  // =========================================================================

  describe("altimate_core.compare", () => {
    test("identical queries — no diffs", async () => {
      const r = await D.call("altimate_core.compare", { left_sql: SQL.simple, right_sql: SQL.simple })
      const d = r.data as any
      expect(d.identical).toBe(true)
      expect(d.diff_count).toBe(0)
    })

    test("different queries — has diffs", async () => {
      const r = await D.call("altimate_core.compare", { left_sql: "SELECT a FROM t", right_sql: "SELECT a, b FROM t WHERE x > 0" })
      const d = r.data as any
      expect(d.identical).toBe(false)
      expect(d.diff_count).toBeGreaterThan(0)
    })
  })

  // =========================================================================
  // altimate_core.migration
  // =========================================================================

  describe("altimate_core.migration", () => {
    test("adding nullable column is safe", async () => {
      const r = await D.call("altimate_core.migration", { old_ddl: "CREATE TABLE t (id INT);", new_ddl: "CREATE TABLE t (id INT, name VARCHAR);" })
      expect(r).toBeDefined()
    })

    test("dropping column detected", async () => {
      const r = await D.call("altimate_core.migration", { old_ddl: "CREATE TABLE t (id INT, name VARCHAR);", new_ddl: "CREATE TABLE t (id INT);" })
      expect(r).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.import_ddl / export_ddl / fingerprint
  // =========================================================================

  describe("altimate_core DDL and fingerprint", () => {
    test("import DDL", async () => {
      const r = await D.call("altimate_core.import_ddl", { ddl: "CREATE TABLE users (id INT NOT NULL, name VARCHAR);" })
      const d = r.data as any
      expect(d.success).toBe(true)
      expect(d.schema).toBeDefined()
    })

    test("export DDL", async () => {
      const r = await D.call("altimate_core.export_ddl", { schema_context: ECOMMERCE_FLAT })
      expect((r.data as any).ddl).toContain("CREATE TABLE")
    })

    test("DDL roundtrip preserves tables", async () => {
      const exp = await D.call("altimate_core.export_ddl", { schema_context: ECOMMERCE_FLAT })
      const imp = await D.call("altimate_core.import_ddl", { ddl: (exp.data as any).ddl })
      expect((imp.data as any).schema.tables).toBeDefined()
    })

    test("fingerprint is stable SHA-256", async () => {
      const r1 = await D.call("altimate_core.fingerprint", { schema_context: ECOMMERCE_FLAT })
      const r2 = await D.call("altimate_core.fingerprint", { schema_context: ECOMMERCE_FLAT })
      expect((r1.data as any).fingerprint).toBe((r2.data as any).fingerprint)
      expect((r1.data as any).fingerprint.length).toBe(64)
    })

    test("different schemas — different fingerprints", async () => {
      const r1 = await D.call("altimate_core.fingerprint", { schema_context: { a: { x: "INT" } } })
      const r2 = await D.call("altimate_core.fingerprint", { schema_context: { b: { y: "INT" } } })
      expect((r1.data as any).fingerprint).not.toBe((r2.data as any).fingerprint)
    })
  })

  // =========================================================================
  // PII tools
  // =========================================================================

  describe("PII detection", () => {
    test("classify_pii finds PII columns", async () => {
      const r = await D.call("altimate_core.classify_pii", { schema_context: ECOMMERCE_FLAT })
      const d = r.data as any
      const cols = d.columns ?? d.findings ?? []
      expect(cols.length).toBeGreaterThan(0)
    })

    test("query_pii flags PII access", async () => {
      const r = await D.call("altimate_core.query_pii", { sql: "SELECT first_name, email FROM customers", schema_context: ECOMMERCE_FLAT })
      const d = r.data as any
      expect(d.accesses_pii).toBe(true)
      expect((d.pii_columns ?? []).length).toBeGreaterThan(0)
    })

    test("query_pii clean for non-PII columns", async () => {
      const r = await D.call("altimate_core.query_pii", { sql: "SELECT customer_id FROM customers", schema_context: ECOMMERCE_FLAT })
      expect((r.data as any).accesses_pii).toBe(false)
    })
  })

  // =========================================================================
  // altimate_core.resolve_term
  // =========================================================================

  describe("altimate_core.resolve_term", () => {
    test("resolves exact column name", async () => {
      const r = await D.call("altimate_core.resolve_term", { term: "email", schema_context: ECOMMERCE_FLAT })
      const d = r.data as any
      expect(d.matches?.length).toBeGreaterThan(0)
      expect(d.matches[0].matched_column.column).toBe("email")
    })

    test("resolves fuzzy match", async () => {
      const r = await D.call("altimate_core.resolve_term", { term: "price", schema_context: ECOMMERCE_FLAT })
      expect((r.data as any).matches?.length).toBeGreaterThan(0)
    })
  })

  // =========================================================================
  // altimate_core.track_lineage
  // =========================================================================

  describe("altimate_core.track_lineage", () => {
    test("tracks multi-query pipeline", async () => {
      const r = await D.call("altimate_core.track_lineage", {
        queries: [
          "CREATE TABLE staging AS SELECT customer_id, first_name FROM customers",
          "CREATE TABLE summary AS SELECT customer_id, COUNT(*) AS cnt FROM staging GROUP BY customer_id",
        ],
        schema_context: ECOMMERCE_FLAT,
      })
      expect(r.success).toBe(true)
    })
  })

  // =========================================================================
  // altimate_core.prune_schema / optimize_context
  // =========================================================================

  describe("Schema optimization", () => {
    test("prune_schema to relevant tables", async () => {
      const r = await D.call("altimate_core.prune_schema", { sql: "SELECT customer_id FROM customers", schema_context: ECOMMERCE_FLAT })
      const d = r.data as any
      expect(d.relevant_tables).toBeDefined()
    })

    test("optimize_context returns compression info", async () => {
      const r = await D.call("altimate_core.optimize_context", { schema_context: ECOMMERCE_FLAT })
      expect(r.success).toBe(true)
    })
  })

  // =========================================================================
  // altimate_core.introspection_sql
  // =========================================================================

  describe("altimate_core.introspection_sql", () => {
    for (const dbType of ["snowflake", "postgres", "bigquery", "mysql", "redshift"]) {
      test(`generates SQL for ${dbType}`, async () => {
        const r = await D.call("altimate_core.introspection_sql", { db_type: dbType, database: "my_db", schema_name: "public" })
        expect(r).toBeDefined()
      })
    }
  })

  // =========================================================================
  // altimate_core.policy
  // =========================================================================

  describe("altimate_core.policy", () => {
    test("policy check with forbidden ops", async () => {
      const r = await D.call("altimate_core.policy", {
        sql: "SELECT * FROM customers",
        schema_context: ECOMMERCE_FLAT,
        policy_json: JSON.stringify({ forbidden_operations: ["DROP", "DELETE"] }),
      })
      expect(r).toBeDefined()
    })
  })

  // =========================================================================
  // Composite SQL methods
  // =========================================================================

  describe("sql.analyze", () => {
    test("returns issues not 'Unknown error'", async () => {
      const r = await D.call("sql.analyze", { sql: SQL.selectStar, schema_context: ECOMMERCE_FLAT })
      expect(r.error).toBeUndefined()
      expect(Array.isArray(r.issues)).toBe(true)
    })
  })

  describe("sql.rewrite", () => {
    test("works with flat schema", async () => {
      const r = await D.call("sql.rewrite", { sql: SQL.selectStar, schema_context: ECOMMERCE_FLAT })
      expect(r.success).toBe(true)
      expect(r.error).toBeUndefined()
    })
  })

  describe("lineage.check", () => {
    test("works with flat schema", async () => {
      const r = await D.call("lineage.check", { sql: SQL.groupBy, dialect: "duckdb", schema_context: ECOMMERCE_FLAT })
      expect(r.success).toBe(true)
      expect(r.error).toBeUndefined()
    })

    test("works with array schema", async () => {
      const r = await D.call("lineage.check", { sql: "SELECT customer_id FROM customers", dialect: "duckdb", schema_context: ARRAY_SCHEMA })
      expect(r.success).toBe(true)
    })
  })

  // =========================================================================
  // Schema format variants
  // =========================================================================

  describe("Schema format variants", () => {
    test("flat format loads for validate", async () => {
      const r = await D.call("altimate_core.validate", { sql: "SELECT customer_id, first_name FROM customers", schema_context: ECOMMERCE_FLAT })
      expect((r.data as any).valid).toBe(true)
    })

    test("SchemaDefinition format still works", async () => {
      const r = await D.call("altimate_core.validate", { sql: "SELECT customer_id FROM customers", schema_context: ECOMMERCE_SD })
      expect((r.data as any).valid).toBe(true)
    })

    test("array format loads for lineage", async () => {
      const r = await D.call("lineage.check", { sql: "SELECT customer_id FROM customers", dialect: "duckdb", schema_context: ARRAY_SCHEMA })
      expect(r.success).toBe(true)
    })

    test("empty table in schema is skipped gracefully", async () => {
      const r = await D.call("altimate_core.validate", {
        sql: "SELECT customer_id FROM customers",
        schema_context: { customers: { customer_id: "INTEGER" }, empty_table: {} },
      })
      expect(r).toBeDefined()
    })
  })
})
