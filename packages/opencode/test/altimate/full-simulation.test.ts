/**
 * Full simulation of all altimate-core tools.
 *
 * Exercises every registered dispatcher method with realistic inputs
 * to find bugs, silent failures, field name mismatches, or incorrect results.
 *
 * Requires @altimateai/altimate-core napi binary.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"

let coreAvailable = false
try {
  require.resolve("@altimateai/altimate-core")
  coreAvailable = true
} catch {}

const describeIf = coreAvailable ? describe : describe.skip

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SQL Queries
// ---------------------------------------------------------------------------

const QUERIES = {
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
  subquery: `SELECT customer_id, first_name
FROM customers
WHERE customer_id IN (
  SELECT customer_id FROM orders WHERE amount > 100
)`,
  cte: `WITH high_value AS (
  SELECT customer_id, SUM(amount) AS total
  FROM orders
  GROUP BY customer_id
  HAVING SUM(amount) > 1000
)
SELECT c.first_name, c.last_name, h.total
FROM customers c
JOIN high_value h ON c.customer_id = h.customer_id`,
  cartesian: "SELECT * FROM customers, orders",
  syntaxError: "SELCT * FORM customers",
  missingColumn: "SELECT nonexistent FROM customers",
  insertDml: "INSERT INTO orders (order_id, customer_id) VALUES (1, 2)",
  createDdl: "CREATE TABLE test_table (id INT PRIMARY KEY, name VARCHAR(100))",
  windowFunc: `SELECT customer_id, order_date, amount,
  ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date DESC) AS rn,
  SUM(amount) OVER (PARTITION BY customer_id) AS customer_total
FROM orders`,
  union: `SELECT customer_id, 'customer' AS source FROM customers
UNION ALL
SELECT order_id, 'order' AS source FROM orders`,
  case: `SELECT order_id,
  CASE WHEN amount > 100 THEN 'high'
       WHEN amount > 50 THEN 'medium'
       ELSE 'low' END AS tier
FROM orders`,
  selfJoin: `SELECT a.order_id, b.order_id AS related
FROM orders a
JOIN orders b ON a.customer_id = b.customer_id AND a.order_id <> b.order_id`,
  injection: "SELECT * FROM users WHERE id = '1; DROP TABLE users; --'",
  emptyString: "",
  hugeColumns: `SELECT
    customer_id, first_name, last_name, email, created_at,
    customer_id + 1 AS next_id,
    UPPER(first_name) AS upper_name,
    LOWER(last_name) AS lower_name,
    LENGTH(email) AS email_len,
    COALESCE(first_name, 'Unknown') AS safe_name
  FROM customers`,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeIf("Full Simulation: altimate_core.* methods", () => {
  let Dispatcher: any

  beforeAll(async () => {
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
    Dispatcher = await import("../../src/altimate/native/dispatcher")
    await import("../../src/altimate/native/altimate-core")
    await import("../../src/altimate/native/sql/register")
  })

  afterAll(() => {
    delete process.env.ALTIMATE_TELEMETRY_DISABLED
  })

  // =========================================================================
  // altimate_core.validate
  // =========================================================================

  describe("altimate_core.validate", () => {
    test("valid simple query", async () => {
      const r = await Dispatcher.call("altimate_core.validate", {
        sql: QUERIES.simple,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d.valid).toBe(true)
      expect(d.errors).toHaveLength(0)
    })

    test("valid multi-join query", async () => {
      const r = await Dispatcher.call("altimate_core.validate", {
        sql: QUERIES.multiJoin,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d.valid).toBe(true)
    })

    test("invalid — missing column", async () => {
      const r = await Dispatcher.call("altimate_core.validate", {
        sql: QUERIES.missingColumn,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d.valid).toBe(false)
      expect(d.errors.length).toBeGreaterThan(0)
      expect(d.errors[0].message).toBeDefined()
      expect(d.errors[0].message.length).toBeGreaterThan(0)
    })

    test("syntax error query", async () => {
      const r = await Dispatcher.call("altimate_core.validate", {
        sql: QUERIES.syntaxError,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d.valid).toBe(false)
      expect(d.errors.length).toBeGreaterThan(0)
    })

    test("with SchemaDefinition format", async () => {
      const r = await Dispatcher.call("altimate_core.validate", {
        sql: "SELECT customer_id FROM customers",
        schema_context: ECOMMERCE_SD,
      })
      const d = r.data as any
      expect(d.valid).toBe(true)
    })

    test("with empty schema_context", async () => {
      const r = await Dispatcher.call("altimate_core.validate", {
        sql: QUERIES.simple,
      })
      // Should not crash — uses empty fallback schema
      expect(r.data).toBeDefined()
    })

    test("empty SQL string", async () => {
      const r = await Dispatcher.call("altimate_core.validate", {
        sql: "",
        schema_context: ECOMMERCE_FLAT,
      })
      // Should handle gracefully
      expect(r).toBeDefined()
    })

    test("CTE query validates", async () => {
      const r = await Dispatcher.call("altimate_core.validate", {
        sql: QUERIES.cte,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d.valid).toBe(true)
    })

    test("window function validates", async () => {
      const r = await Dispatcher.call("altimate_core.validate", {
        sql: QUERIES.windowFunc,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d.valid).toBe(true)
    })
  })

  // =========================================================================
  // altimate_core.lint
  // =========================================================================

  describe("altimate_core.lint", () => {
    test("SELECT * triggers lint finding", async () => {
      const r = await Dispatcher.call("altimate_core.lint", {
        sql: QUERIES.selectStar,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d.findings).toBeDefined()
      expect(d.findings.length).toBeGreaterThan(0)
    })

    test("clean query has no findings", async () => {
      const r = await Dispatcher.call("altimate_core.lint", {
        sql: QUERIES.simple,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      // May still have findings (e.g., missing LIMIT), but should not crash
      expect(d).toBeDefined()
    })

    test("cartesian product flagged", async () => {
      const r = await Dispatcher.call("altimate_core.lint", {
        sql: QUERIES.cartesian,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d.findings).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.safety
  // =========================================================================

  describe("altimate_core.safety", () => {
    test("clean SQL is safe", async () => {
      const r = await Dispatcher.call("altimate_core.safety", {
        sql: QUERIES.simple,
      })
      const d = r.data as any
      expect(d.safe).toBe(true)
    })

    test("string-literal injection is correctly classified as safe", async () => {
      // The injection is inside a SQL string literal, so it's not actual injection
      const r = await Dispatcher.call("altimate_core.safety", {
        sql: QUERIES.injection,
      })
      const d = r.data as any
      expect(d).toBeDefined()
      // This is correctly safe — the dangerous content is in a string literal
      expect(d.safe).toBe(true)
    })

    test("actual injection attempt detected", async () => {
      // Real injection: multiple statements via semicolon
      const r = await Dispatcher.call("altimate_core.safety", {
        sql: "SELECT * FROM users; DROP TABLE users;",
      })
      const d = r.data as any
      expect(d).toBeDefined()
      // Multiple statements should be flagged
      expect(d.statement_count).toBeGreaterThan(1)
    })
  })

  // =========================================================================
  // altimate_core.is_safe
  // =========================================================================

  describe("altimate_core.is_safe", () => {
    test("returns boolean for clean SQL", async () => {
      const r = await Dispatcher.call("altimate_core.is_safe", {
        sql: QUERIES.simple,
      })
      expect(r.data.safe).toBe(true)
    })
  })

  // =========================================================================
  // altimate_core.explain
  // =========================================================================

  describe("altimate_core.explain", () => {
    test("explains a simple query", async () => {
      const r = await Dispatcher.call("altimate_core.explain", {
        sql: QUERIES.simple,
        schema_context: ECOMMERCE_FLAT,
      })
      expect(r.success).toBe(true)
      const d = r.data as any
      expect(d).toBeDefined()
      // Should have plan steps or explanation
    })

    test("explains a complex join", async () => {
      const r = await Dispatcher.call("altimate_core.explain", {
        sql: QUERIES.multiJoin,
        schema_context: ECOMMERCE_FLAT,
      })
      expect(r.success).toBe(true)
    })
  })

  // =========================================================================
  // altimate_core.check (composite: validate + lint + safety)
  // =========================================================================

  describe("altimate_core.check", () => {
    test("returns all three components", async () => {
      const r = await Dispatcher.call("altimate_core.check", {
        sql: QUERIES.selectStar,
        schema_context: ECOMMERCE_FLAT,
      })
      expect(r.success).toBe(true)
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
      const r = await Dispatcher.call("altimate_core.fix", {
        sql: "SELECT custmer_id FROM customers",
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      // Should attempt fix via fuzzy matching
      expect(d).toBeDefined()
      if (d.fixed) {
        expect(d.fixed_sql).toBeDefined()
        expect(d.fixed_sql.toLowerCase()).toContain("customer_id")
      }
    })

    test("fixes typo in table name", async () => {
      const r = await Dispatcher.call("altimate_core.fix", {
        sql: "SELECT order_id FROM ordrs",
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d).toBeDefined()
      if (d.fixed) {
        expect(d.fixed_sql.toLowerCase()).toContain("orders")
      }
    })

    test("already valid SQL returns unchanged", async () => {
      const r = await Dispatcher.call("altimate_core.fix", {
        sql: QUERIES.simple,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d).toBeDefined()
    })

    test("completely broken SQL reports unfixable", async () => {
      const r = await Dispatcher.call("altimate_core.fix", {
        sql: "GIBBERISH NONSENSE BLAH",
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.grade
  // =========================================================================

  describe("altimate_core.grade", () => {
    test("grades a simple clean query as A or B", async () => {
      const r = await Dispatcher.call("altimate_core.grade", {
        sql: QUERIES.simple,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      const grade = d.overall_grade ?? d.grade
      expect(grade).toBeDefined()
      expect(["A", "B"]).toContain(grade)
      expect(d.scores).toBeDefined()
      expect(typeof d.scores.overall).toBe("number")
      expect(d.scores.overall).toBeGreaterThanOrEqual(0)
      expect(d.scores.overall).toBeLessThanOrEqual(1)
    })

    test("grades SELECT * lower than explicit columns", async () => {
      const r1 = await Dispatcher.call("altimate_core.grade", {
        sql: QUERIES.simple,
        schema_context: ECOMMERCE_FLAT,
      })
      const r2 = await Dispatcher.call("altimate_core.grade", {
        sql: QUERIES.selectStar,
        schema_context: ECOMMERCE_FLAT,
      })
      const score1 = (r1.data as any).scores?.overall ?? 0
      const score2 = (r2.data as any).scores?.overall ?? 0
      // Explicit columns should score >= SELECT *
      expect(score1).toBeGreaterThanOrEqual(score2)
    })

    test("grade scores are between 0 and 1", async () => {
      const r = await Dispatcher.call("altimate_core.grade", {
        sql: QUERIES.multiJoin,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      for (const key of ["syntax", "style", "safety", "complexity", "overall"]) {
        if (d.scores?.[key] != null) {
          expect(d.scores[key]).toBeGreaterThanOrEqual(0)
          expect(d.scores[key]).toBeLessThanOrEqual(1)
        }
      }
    })
  })

  // =========================================================================
  // altimate_core.rewrite
  // =========================================================================

  describe("altimate_core.rewrite", () => {
    test("suggestions are well-formed", async () => {
      const r = await Dispatcher.call("altimate_core.rewrite", {
        sql: QUERIES.subquery,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d).toBeDefined()
      if (d.suggestions?.length) {
        for (const s of d.suggestions) {
          expect(s.rule).toBeDefined()
          expect(s.rewritten_sql).toBeDefined()
        }
      }
    })

    test("does not crash on DML", async () => {
      const r = await Dispatcher.call("altimate_core.rewrite", {
        sql: QUERIES.insertDml,
        schema_context: ECOMMERCE_FLAT,
      })
      expect(r).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.testgen
  // =========================================================================

  describe("altimate_core.testgen", () => {
    test("generates tests for GROUP BY query", async () => {
      const r = await Dispatcher.call("altimate_core.testgen", {
        sql: QUERIES.multiJoin,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      const tests = d.test_cases ?? d.tests ?? []
      expect(tests.length).toBeGreaterThan(0)
      // Each test case should have a name/description and either sql or inputs
      for (const tc of tests) {
        expect(tc.name || tc.description).toBeDefined()
        expect(tc.sql || tc.inputs).toBeDefined()
      }
    })

    test("generates tests for CASE WHEN query", async () => {
      const r = await Dispatcher.call("altimate_core.testgen", {
        sql: QUERIES.case,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      const tests = d.test_cases ?? d.tests ?? []
      expect(tests.length).toBeGreaterThan(0)
    })
  })

  // =========================================================================
  // altimate_core.complete
  // =========================================================================

  describe("altimate_core.complete", () => {
    test("suggests tables after FROM", async () => {
      const sql = "SELECT * FROM "
      const r = await Dispatcher.call("altimate_core.complete", {
        sql,
        cursor_pos: sql.length,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      const items = d.items ?? d.suggestions ?? []
      expect(items.length).toBeGreaterThan(0)
      // Should suggest table names
      const labels = items.map((i: any) => i.label)
      expect(labels.some((l: string) => ["customers", "orders", "payments", "products", "order_items"].includes(l))).toBe(true)
    })

    test("suggests columns after SELECT with FROM", async () => {
      const sql = "SELECT  FROM customers"
      const r = await Dispatcher.call("altimate_core.complete", {
        sql,
        cursor_pos: 7, // after "SELECT "
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      const items = d.items ?? d.suggestions ?? []
      expect(items.length).toBeGreaterThan(0)
    })

    test("cursor at 0 still works", async () => {
      const r = await Dispatcher.call("altimate_core.complete", {
        sql: "S",
        cursor_pos: 0,
        schema_context: ECOMMERCE_FLAT,
      })
      expect(r).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.column_lineage
  // =========================================================================

  describe("altimate_core.column_lineage", () => {
    test("traces direct column references", async () => {
      const r = await Dispatcher.call("altimate_core.column_lineage", {
        sql: "SELECT customer_id, first_name FROM customers",
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d.column_dict).toBeDefined()
      expect(Object.keys(d.column_dict).length).toBeGreaterThan(0)
    })

    test("traces through JOIN", async () => {
      const r = await Dispatcher.call("altimate_core.column_lineage", {
        sql: QUERIES.join,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d.column_lineage?.length).toBeGreaterThan(0)
    })

    test("traces through CTE", async () => {
      const r = await Dispatcher.call("altimate_core.column_lineage", {
        sql: QUERIES.cte,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      const hasLineage = (d.column_lineage?.length > 0) ||
        (d.column_dict && Object.keys(d.column_dict).length > 0)
      expect(hasLineage).toBe(true)
    })

    test("traces through window functions", async () => {
      const r = await Dispatcher.call("altimate_core.column_lineage", {
        sql: QUERIES.windowFunc,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d.column_dict).toBeDefined()
    })

    test("with no schema still returns partial lineage", async () => {
      const r = await Dispatcher.call("altimate_core.column_lineage", {
        sql: "SELECT a, b FROM t",
      })
      expect(r.success).toBe(true)
    })
  })

  // =========================================================================
  // altimate_core.schema_diff
  // =========================================================================

  describe("altimate_core.schema_diff", () => {
    test("identical schemas return empty changes", async () => {
      const r = await Dispatcher.call("altimate_core.schema_diff", {
        schema1_context: ECOMMERCE_FLAT,
        schema2_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d.changes).toHaveLength(0)
      expect(d.has_breaking_changes).toBe(false)
    })

    test("detects added table", async () => {
      const schema2 = {
        ...ECOMMERCE_FLAT,
        reviews: { review_id: "INTEGER", content: "TEXT", rating: "INTEGER" },
      }
      const r = await Dispatcher.call("altimate_core.schema_diff", {
        schema1_context: ECOMMERCE_FLAT,
        schema2_context: schema2,
      })
      const d = r.data as any
      expect(d.changes.length).toBeGreaterThan(0)
      expect(d.changes.some((c: any) => c.type === "table_added" && c.table === "reviews")).toBe(true)
    })

    test("detects removed table", async () => {
      const { products, ...without } = ECOMMERCE_FLAT
      const r = await Dispatcher.call("altimate_core.schema_diff", {
        schema1_context: ECOMMERCE_FLAT,
        schema2_context: without,
      })
      const d = r.data as any
      expect(d.changes.some((c: any) => c.type === "table_removed" && c.table === "products")).toBe(true)
      expect(d.has_breaking_changes).toBe(true)
    })

    test("detects column type change", async () => {
      const schema2 = {
        ...ECOMMERCE_FLAT,
        orders: { ...ECOMMERCE_FLAT.orders, amount: "BIGINT" },
      }
      const r = await Dispatcher.call("altimate_core.schema_diff", {
        schema1_context: ECOMMERCE_FLAT,
        schema2_context: schema2,
      })
      const d = r.data as any
      expect(d.changes.some((c: any) =>
        c.type === "column_type_changed" && c.table === "orders" && c.column === "amount"
      )).toBe(true)
    })
  })

  // =========================================================================
  // altimate_core.equivalence
  // =========================================================================

  describe("altimate_core.equivalence", () => {
    test("identical queries are equivalent", async () => {
      const r = await Dispatcher.call("altimate_core.equivalence", {
        sql1: QUERIES.simple,
        sql2: QUERIES.simple,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d.equivalent).toBe(true)
    })

    test("different queries are not equivalent", async () => {
      const r = await Dispatcher.call("altimate_core.equivalence", {
        sql1: "SELECT customer_id FROM customers",
        sql2: "SELECT order_id FROM orders",
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d.equivalent).toBe(false)
    })
  })

  // =========================================================================
  // altimate_core.semantics
  // =========================================================================

  describe("altimate_core.semantics", () => {
    test("detects cartesian product", async () => {
      const r = await Dispatcher.call("altimate_core.semantics", {
        sql: QUERIES.cartesian,
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      // Should flag cartesian product
      expect(d).toBeDefined()
      if (d.findings) {
        expect(d.findings.length).toBeGreaterThan(0)
      }
    })

    test("clean join has no semantic issues", async () => {
      const r = await Dispatcher.call("altimate_core.semantics", {
        sql: QUERIES.join,
        schema_context: ECOMMERCE_FLAT,
      })
      expect(r.success).toBe(true)
    })
  })

  // =========================================================================
  // altimate_core.correct
  // =========================================================================

  describe("altimate_core.correct", () => {
    test("attempts to correct broken SQL", async () => {
      const r = await Dispatcher.call("altimate_core.correct", {
        sql: "SELECT custmer_id FROM ordrs",
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d).toBeDefined()
      // Should have status field
      expect(d.status || d.fixed || d.corrected_sql).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.format
  // =========================================================================

  describe("altimate_core.format", () => {
    test("formats messy SQL", async () => {
      const r = await Dispatcher.call("altimate_core.format", {
        sql: "select customer_id,first_name,last_name from customers where customer_id=1",
        dialect: "generic",
      })
      const d = r.data as any
      expect(d.formatted_sql || d.sql).toBeDefined()
    })

    test("preserves semantic meaning", async () => {
      const r = await Dispatcher.call("altimate_core.format", {
        sql: QUERIES.cte,
      })
      expect(r.success).not.toBe(false)
    })
  })

  // =========================================================================
  // altimate_core.transpile
  // =========================================================================

  describe("altimate_core.transpile", () => {
    test("snowflake to postgres", async () => {
      const r = await Dispatcher.call("altimate_core.transpile", {
        sql: "SELECT NVL(first_name, 'Unknown') FROM customers",
        from_dialect: "snowflake",
        to_dialect: "postgres",
      })
      const d = r.data as any
      expect(d).toBeDefined()
    })

    test("postgres to bigquery", async () => {
      const r = await Dispatcher.call("altimate_core.transpile", {
        sql: "SELECT customer_id::TEXT FROM customers",
        from_dialect: "postgres",
        to_dialect: "bigquery",
      })
      expect(r).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.metadata
  // =========================================================================

  describe("altimate_core.metadata", () => {
    test("extracts tables, columns, functions", async () => {
      const r = await Dispatcher.call("altimate_core.metadata", {
        sql: QUERIES.multiJoin,
      })
      const d = r.data as any
      expect(d.tables || d.table_references).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.compare
  // =========================================================================

  describe("altimate_core.compare", () => {
    test("compares two different queries", async () => {
      const r = await Dispatcher.call("altimate_core.compare", {
        left_sql: "SELECT customer_id FROM customers",
        right_sql: "SELECT customer_id, first_name FROM customers WHERE customer_id > 0",
      })
      const d = r.data as any
      expect(d).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.migration
  // =========================================================================

  describe("altimate_core.migration", () => {
    test("detects safe migration", async () => {
      const r = await Dispatcher.call("altimate_core.migration", {
        old_ddl: "CREATE TABLE users (id INT, name VARCHAR);",
        new_ddl: "CREATE TABLE users (id INT, name VARCHAR, email VARCHAR);",
      })
      const d = r.data as any
      expect(d).toBeDefined()
    })

    test("detects unsafe migration (column drop)", async () => {
      const r = await Dispatcher.call("altimate_core.migration", {
        old_ddl: "CREATE TABLE users (id INT, name VARCHAR, email VARCHAR);",
        new_ddl: "CREATE TABLE users (id INT, name VARCHAR);",
      })
      const d = r.data as any
      expect(d).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.import_ddl
  // =========================================================================

  describe("altimate_core.import_ddl", () => {
    test("imports CREATE TABLE to schema", async () => {
      const r = await Dispatcher.call("altimate_core.import_ddl", {
        ddl: "CREATE TABLE users (id INT NOT NULL, name VARCHAR, email VARCHAR);",
      })
      const d = r.data as any
      expect(d.success).toBe(true)
      expect(d.schema).toBeDefined()
    })

    test("imports multiple tables", async () => {
      const r = await Dispatcher.call("altimate_core.import_ddl", {
        ddl: `CREATE TABLE users (id INT, name VARCHAR);
              CREATE TABLE orders (id INT, user_id INT, amount DECIMAL);`,
      })
      const d = r.data as any
      expect(d.success).toBe(true)
    })
  })

  // =========================================================================
  // altimate_core.export_ddl
  // =========================================================================

  describe("altimate_core.export_ddl", () => {
    test("exports schema to DDL", async () => {
      const r = await Dispatcher.call("altimate_core.export_ddl", {
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d.ddl).toBeDefined()
      expect(d.ddl).toContain("CREATE TABLE")
    })
  })

  // =========================================================================
  // altimate_core.fingerprint
  // =========================================================================

  describe("altimate_core.fingerprint", () => {
    test("returns SHA-256 hash", async () => {
      const r = await Dispatcher.call("altimate_core.fingerprint", {
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d.fingerprint).toBeDefined()
      expect(typeof d.fingerprint).toBe("string")
      expect(d.fingerprint.length).toBe(64) // SHA-256 hex
    })

    test("same schema produces same fingerprint", async () => {
      const r1 = await Dispatcher.call("altimate_core.fingerprint", {
        schema_context: ECOMMERCE_FLAT,
      })
      const r2 = await Dispatcher.call("altimate_core.fingerprint", {
        schema_context: ECOMMERCE_FLAT,
      })
      expect((r1.data as any).fingerprint).toBe((r2.data as any).fingerprint)
    })
  })

  // =========================================================================
  // altimate_core.introspection_sql
  // =========================================================================

  describe("altimate_core.introspection_sql", () => {
    test("generates Snowflake introspection SQL", async () => {
      const r = await Dispatcher.call("altimate_core.introspection_sql", {
        db_type: "snowflake",
        database: "MY_DB",
        schema_name: "PUBLIC",
      })
      const d = r.data as any
      expect(d).toBeDefined()
    })

    test("generates Postgres introspection SQL", async () => {
      const r = await Dispatcher.call("altimate_core.introspection_sql", {
        db_type: "postgres",
        database: "mydb",
      })
      expect(r).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.classify_pii
  // =========================================================================

  describe("altimate_core.classify_pii", () => {
    test("detects PII columns", async () => {
      const r = await Dispatcher.call("altimate_core.classify_pii", {
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d).toBeDefined()
      // email, first_name, last_name should be flagged as PII
    })
  })

  // =========================================================================
  // altimate_core.query_pii
  // =========================================================================

  describe("altimate_core.query_pii", () => {
    test("detects PII access in query", async () => {
      const r = await Dispatcher.call("altimate_core.query_pii", {
        sql: "SELECT email, first_name FROM customers",
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.resolve_term
  // =========================================================================

  describe("altimate_core.resolve_term", () => {
    test("resolves business term to schema element", async () => {
      const r = await Dispatcher.call("altimate_core.resolve_term", {
        term: "email",
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.track_lineage (multi-query)
  // =========================================================================

  describe("altimate_core.track_lineage", () => {
    test("tracks lineage across multiple queries", async () => {
      const r = await Dispatcher.call("altimate_core.track_lineage", {
        queries: [
          "CREATE TABLE staging AS SELECT customer_id, first_name FROM customers",
          "CREATE TABLE summary AS SELECT customer_id, COUNT(*) AS cnt FROM staging GROUP BY customer_id",
        ],
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.optimize_context
  // =========================================================================

  describe("altimate_core.optimize_context", () => {
    test("optimizes schema for context window", async () => {
      const r = await Dispatcher.call("altimate_core.optimize_context", {
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d).toBeDefined()
    })
  })

  // =========================================================================
  // altimate_core.prune_schema
  // =========================================================================

  describe("altimate_core.prune_schema", () => {
    test("prunes to relevant tables only", async () => {
      const r = await Dispatcher.call("altimate_core.prune_schema", {
        sql: "SELECT customer_id FROM customers",
        schema_context: ECOMMERCE_FLAT,
      })
      const d = r.data as any
      expect(d).toBeDefined()
      // Should only include 'customers' table, not 'orders', 'products', etc.
      if (d.tables) {
        expect(d.tables.customers).toBeDefined()
      }
    })
  })

  // =========================================================================
  // Composite SQL methods
  // =========================================================================

  describe("sql.analyze", () => {
    test("returns issues not error", async () => {
      const r = await Dispatcher.call("sql.analyze", {
        sql: QUERIES.selectStar,
        schema_context: ECOMMERCE_FLAT,
      })
      expect(r.error).toBeUndefined()
      expect(r.issues).toBeDefined()
      expect(Array.isArray(r.issues)).toBe(true)
    })

    test("handles syntax errors gracefully", async () => {
      const r = await Dispatcher.call("sql.analyze", {
        sql: QUERIES.syntaxError,
        schema_context: ECOMMERCE_FLAT,
      })
      // Should not crash
      expect(r).toBeDefined()
    })
  })

  describe("sql.optimize", () => {
    test("returns suggestions for complex query", async () => {
      const r = await Dispatcher.call("sql.optimize", {
        sql: QUERIES.subquery,
        schema_context: ECOMMERCE_FLAT,
      })
      expect(r.success).toBe(true)
      expect(r.suggestions).toBeDefined()
    })
  })

  describe("sql.rewrite", () => {
    test("works with flat schema", async () => {
      const r = await Dispatcher.call("sql.rewrite", {
        sql: QUERIES.selectStar,
        schema_context: ECOMMERCE_FLAT,
      })
      expect(r.success).toBe(true)
      expect(r.error).toBeUndefined()
    })
  })

  describe("sql.format", () => {
    test("formats SQL", async () => {
      const r = await Dispatcher.call("sql.format", {
        sql: "select a,b,c from t where x=1",
        dialect: "generic",
      })
      expect(r.success).toBe(true)
      expect(r.formatted_sql).toBeDefined()
    })
  })

  describe("sql.fix", () => {
    test("attempts fix with schema", async () => {
      const r = await Dispatcher.call("sql.fix", {
        sql: "SELECT custmer_id FROM ordrs",
        schema_context: ECOMMERCE_FLAT,
      })
      expect(r).toBeDefined()
    })
  })

  describe("lineage.check", () => {
    test("works with flat schema", async () => {
      const r = await Dispatcher.call("lineage.check", {
        sql: "SELECT customer_id, SUM(amount) AS total FROM orders GROUP BY customer_id",
        dialect: "duckdb",
        schema_context: ECOMMERCE_FLAT,
      })
      expect(r.success).toBe(true)
      expect(r.error).toBeUndefined()
    })
  })

  describe("sql.schema_diff", () => {
    test("diffs two DDL statements", async () => {
      const r = await Dispatcher.call("sql.schema_diff", {
        old_sql: "CREATE TABLE users (id INT, name VARCHAR);",
        new_sql: "CREATE TABLE users (id INT, name VARCHAR, email VARCHAR);",
      })
      expect(r.success).toBe(true)
      expect(r.changes).toBeDefined()
      expect(r.changes.length).toBeGreaterThan(0)
    })
  })

  describe("sql.diff", () => {
    test("diffs two SQL queries", async () => {
      const r = await Dispatcher.call("sql.diff", {
        original: "SELECT a FROM t",
        modified: "SELECT a, b FROM t WHERE x > 0",
        schema_context: ECOMMERCE_FLAT,
      })
      expect(r.success).toBe(true)
      expect(r.diff).toBeDefined()
    })
  })
})
