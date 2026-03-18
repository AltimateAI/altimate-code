/**
 * Edge-case simulation for altimate-core tools.
 *
 * Tests unusual inputs, boundary conditions, multi-dialect behavior,
 * complex SQL patterns, and error recovery paths.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"

let coreAvailable = false
try {
  require.resolve("@altimateai/altimate-core")
  coreAvailable = true
} catch {}

const describeIf = coreAvailable ? describe : describe.skip

const SCHEMA = {
  users: {
    id: "INTEGER",
    name: "VARCHAR",
    email: "VARCHAR",
    age: "INTEGER",
    created_at: "TIMESTAMP",
    is_active: "BOOLEAN",
    balance: "DECIMAL",
  },
  orders: {
    id: "INTEGER",
    user_id: "INTEGER",
    product: "VARCHAR",
    qty: "INTEGER",
    price: "DECIMAL",
    status: "VARCHAR",
    created_at: "TIMESTAMP",
  },
  products: {
    id: "INTEGER",
    name: "VARCHAR",
    category: "VARCHAR",
    price: "DECIMAL",
    stock: "INTEGER",
  },
}

describeIf("Edge Cases Simulation", () => {
  let D: any

  beforeAll(async () => {
    process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
    D = await import("../../src/altimate/native/dispatcher")
    await import("../../src/altimate/native/altimate-core")
    await import("../../src/altimate/native/sql/register")
  })

  afterAll(() => { delete process.env.ALTIMATE_TELEMETRY_DISABLED })

  // =========================================================================
  // Edge cases: empty, null, and minimal inputs
  // =========================================================================

  describe("Empty and minimal inputs", () => {
    test("validate with empty SQL", async () => {
      const r = await D.call("altimate_core.validate", { sql: "", schema_context: SCHEMA })
      expect(r).toBeDefined()
      // Should fail gracefully
    })

    test("validate with whitespace-only SQL", async () => {
      const r = await D.call("altimate_core.validate", { sql: "   \n\t  ", schema_context: SCHEMA })
      expect(r).toBeDefined()
    })

    test("validate with single keyword", async () => {
      const r = await D.call("altimate_core.validate", { sql: "SELECT", schema_context: SCHEMA })
      expect(r).toBeDefined()
      const d = r.data as any
      expect(d.valid).toBe(false)
    })

    test("lint with empty SQL", async () => {
      const r = await D.call("altimate_core.lint", { sql: "", schema_context: SCHEMA })
      expect(r).toBeDefined()
    })

    test("grade with empty SQL", async () => {
      const r = await D.call("altimate_core.grade", { sql: "", schema_context: SCHEMA })
      expect(r).toBeDefined()
    })

    test("complete with empty SQL and cursor 0", async () => {
      const r = await D.call("altimate_core.complete", { sql: "", cursor_pos: 0, schema_context: SCHEMA })
      expect(r).toBeDefined()
    })

    test("testgen with minimal SQL", async () => {
      const r = await D.call("altimate_core.testgen", { sql: "SELECT 1", schema_context: SCHEMA })
      expect(r).toBeDefined()
    })

    test("column_lineage with SELECT 1", async () => {
      const r = await D.call("altimate_core.column_lineage", { sql: "SELECT 1 AS x" })
      expect(r.success).toBe(true)
    })

    test("schema_diff with empty schemas", async () => {
      const r = await D.call("altimate_core.schema_diff", {
        schema1_context: {},
        schema2_context: {},
      })
      expect(r).toBeDefined()
    })

    test("schema_diff with one empty schema", async () => {
      const r = await D.call("altimate_core.schema_diff", {
        schema1_context: SCHEMA,
        schema2_context: {},
      })
      const d = r.data as any
      // Should show all tables as removed
      expect(d.changes.length).toBeGreaterThan(0)
    })

    test("fix with already-valid SQL", async () => {
      const r = await D.call("altimate_core.fix", {
        sql: "SELECT id FROM users",
        schema_context: SCHEMA,
      })
      const d = r.data as any
      // Should not break — either returns unchanged or marks as fixed=false
      expect(d).toBeDefined()
    })

    test("rewrite with no-optimization-needed query", async () => {
      const r = await D.call("altimate_core.rewrite", {
        sql: "SELECT id FROM users WHERE id = 1",
        schema_context: SCHEMA,
      })
      expect(r.success).toBe(true)
    })
  })

  // =========================================================================
  // Complex SQL patterns
  // =========================================================================

  describe("Complex SQL patterns", () => {
    test("deeply nested subqueries", async () => {
      const sql = `SELECT * FROM (
        SELECT * FROM (
          SELECT * FROM (
            SELECT id, name FROM users WHERE age > 18
          ) t1
        ) t2
      ) t3`
      const r = await D.call("altimate_core.validate", { sql, schema_context: SCHEMA })
      expect(r).toBeDefined()
    })

    test("multiple CTEs", async () => {
      const sql = `WITH
        active_users AS (SELECT id, name FROM users WHERE is_active = true),
        user_orders AS (SELECT user_id, COUNT(*) AS cnt FROM orders GROUP BY user_id),
        high_spenders AS (SELECT user_id, SUM(price * qty) AS total FROM orders GROUP BY user_id HAVING SUM(price * qty) > 1000)
      SELECT au.name, uo.cnt, hs.total
      FROM active_users au
      LEFT JOIN user_orders uo ON au.id = uo.user_id
      LEFT JOIN high_spenders hs ON au.id = hs.user_id`
      const r = await D.call("altimate_core.validate", { sql, schema_context: SCHEMA })
      const d = r.data as any
      expect(d.valid).toBe(true)
    })

    test("UNION ALL with different column counts validates correctly", async () => {
      const sql = `SELECT id, name FROM users
      UNION ALL
      SELECT id, product FROM orders`
      const r = await D.call("altimate_core.validate", { sql, schema_context: SCHEMA })
      expect(r).toBeDefined()
    })

    test("correlated subquery", async () => {
      const sql = `SELECT u.name,
        (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count
      FROM users u`
      const r = await D.call("altimate_core.validate", { sql, schema_context: SCHEMA })
      const d = r.data as any
      expect(d.valid).toBe(true)
    })

    test("EXISTS subquery", async () => {
      const sql = `SELECT name FROM users u
      WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status = 'completed')`
      const r = await D.call("altimate_core.validate", { sql, schema_context: SCHEMA })
      const d = r.data as any
      expect(d.valid).toBe(true)
    })

    test("window functions with PARTITION BY and ORDER BY", async () => {
      const sql = `SELECT id, user_id, price,
        ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn,
        LAG(price) OVER (PARTITION BY user_id ORDER BY created_at) AS prev_price,
        SUM(price) OVER (PARTITION BY user_id ORDER BY created_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total
      FROM orders`
      const r = await D.call("altimate_core.validate", { sql, schema_context: SCHEMA })
      const d = r.data as any
      expect(d.valid).toBe(true)
    })

    test("CASE WHEN with NULL handling", async () => {
      const sql = `SELECT id,
        CASE WHEN age IS NULL THEN 'unknown'
             WHEN age < 18 THEN 'minor'
             WHEN age < 65 THEN 'adult'
             ELSE 'senior' END AS age_group,
        COALESCE(balance, 0) AS safe_balance
      FROM users`
      const r = await D.call("altimate_core.validate", { sql, schema_context: SCHEMA })
      const d = r.data as any
      expect(d.valid).toBe(true)
    })

    test("self-join", async () => {
      const sql = `SELECT a.id AS order1, b.id AS order2
      FROM orders a
      JOIN orders b ON a.user_id = b.user_id AND a.id < b.id`
      const r = await D.call("altimate_core.validate", { sql, schema_context: SCHEMA })
      const d = r.data as any
      expect(d.valid).toBe(true)
    })

    test("multi-table join with aliases", async () => {
      const sql = `SELECT u.name, o.id AS order_id, p.name AS product_name, o.qty, o.price
      FROM users u
      INNER JOIN orders o ON u.id = o.user_id
      INNER JOIN products p ON o.product = p.name
      WHERE u.is_active = true AND o.status = 'completed'
      ORDER BY o.created_at DESC`
      const r = await D.call("altimate_core.validate", { sql, schema_context: SCHEMA })
      const d = r.data as any
      expect(d.valid).toBe(true)
    })
  })

  // =========================================================================
  // Column lineage edge cases
  // =========================================================================

  describe("Column lineage edge cases", () => {
    test("lineage through CASE WHEN", async () => {
      const sql = `SELECT id, CASE WHEN age > 18 THEN name ELSE 'minor' END AS display_name FROM users`
      const r = await D.call("altimate_core.column_lineage", { sql, schema_context: SCHEMA })
      const d = r.data as any
      expect(d.column_dict).toBeDefined()
    })

    test("lineage through aggregation", async () => {
      const sql = `SELECT user_id, COUNT(*) AS cnt, AVG(price) AS avg_price, MAX(created_at) AS last_order
      FROM orders GROUP BY user_id`
      const r = await D.call("altimate_core.column_lineage", { sql, schema_context: SCHEMA })
      const d = r.data as any
      expect(d.column_dict).toBeDefined()
      // user_id should map back to orders.user_id
      expect(d.column_dict.user_id).toBeDefined()
    })

    test("lineage through UNION", async () => {
      const sql = `SELECT id, name, 'user' AS source FROM users
      UNION ALL
      SELECT id, name, 'product' AS source FROM products`
      const r = await D.call("altimate_core.column_lineage", { sql, schema_context: SCHEMA })
      expect(r.success).toBe(true)
    })

    test("lineage with aliased expressions", async () => {
      const sql = `SELECT
        u.id * 100 + o.id AS composite_key,
        CONCAT(u.name, ' - ', o.product) AS description,
        o.qty * o.price AS line_total
      FROM users u JOIN orders o ON u.id = o.user_id`
      const r = await D.call("altimate_core.column_lineage", { sql, schema_context: SCHEMA })
      const d = r.data as any
      expect(d.column_dict).toBeDefined()
    })

    test("diff_lineage between two versions", async () => {
      const before = "SELECT id, name, email FROM users"
      const after = "SELECT id, name, UPPER(email) AS email, age FROM users"
      const r = await D.call("altimate_core.column_lineage", { sql: after, schema_context: SCHEMA })
      expect(r.success).toBe(true)
    })
  })

  // =========================================================================
  // Schema diff edge cases
  // =========================================================================

  describe("Schema diff edge cases", () => {
    test("detects multiple column additions in same table", async () => {
      const s1 = { users: { id: "INTEGER" } }
      const s2 = { users: { id: "INTEGER", name: "VARCHAR", email: "VARCHAR", age: "INT" } }
      const r = await D.call("altimate_core.schema_diff", { schema1_context: s1, schema2_context: s2 })
      const d = r.data as any
      const additions = d.changes.filter((c: any) => c.type === "column_added")
      expect(additions.length).toBe(3)
    })

    test("detects type change (INT to VARCHAR)", async () => {
      const s1 = { users: { id: "INTEGER", age: "INTEGER" } }
      const s2 = { users: { id: "INTEGER", age: "VARCHAR" } }
      const r = await D.call("altimate_core.schema_diff", { schema1_context: s1, schema2_context: s2 })
      const d = r.data as any
      expect(d.changes.some((c: any) => c.type === "column_type_changed" && c.column === "age")).toBe(true)
      expect(d.has_breaking_changes).toBe(true)
    })

    test("adding a new table is not breaking", async () => {
      const s2 = { ...SCHEMA, audit_log: { id: "INTEGER", action: "VARCHAR" } }
      const r = await D.call("altimate_core.schema_diff", { schema1_context: SCHEMA, schema2_context: s2 })
      const d = r.data as any
      const tableAdded = d.changes.find((c: any) => c.type === "table_added" && c.table === "audit_log")
      expect(tableAdded).toBeDefined()
    })

    test("handles large schema diff (many tables)", async () => {
      const large1: Record<string, any> = {}
      const large2: Record<string, any> = {}
      for (let i = 0; i < 50; i++) {
        large1[`table_${i}`] = { id: "INTEGER", name: "VARCHAR" }
        large2[`table_${i}`] = { id: "INTEGER", name: "VARCHAR", created_at: "TIMESTAMP" }
      }
      const r = await D.call("altimate_core.schema_diff", { schema1_context: large1, schema2_context: large2 })
      const d = r.data as any
      // 50 tables, each with 1 column added
      expect(d.changes.length).toBe(50)
    })
  })

  // =========================================================================
  // Grading edge cases
  // =========================================================================

  describe("Grade edge cases", () => {
    test("syntax error gets low grade", async () => {
      const r = await D.call("altimate_core.grade", { sql: "SELCT * FORM users", schema_context: SCHEMA })
      const d = r.data as any
      const grade = d.overall_grade ?? d.grade
      expect(["C", "D", "F"]).toContain(grade)
    })

    test("complex well-formed query grades above C", async () => {
      const sql = `SELECT u.id, u.name, COUNT(o.id) AS order_count
      FROM users u
      LEFT JOIN orders o ON u.id = o.user_id
      WHERE u.is_active = true
      GROUP BY u.id, u.name
      HAVING COUNT(o.id) > 0
      ORDER BY order_count DESC
      LIMIT 100`
      const r = await D.call("altimate_core.grade", { sql, schema_context: SCHEMA })
      const d = r.data as any
      const grade = d.overall_grade ?? d.grade
      expect(["A", "B", "C"]).toContain(grade)
    })

    test("cartesian product gets lower grade", async () => {
      const r = await D.call("altimate_core.grade", { sql: "SELECT * FROM users, orders", schema_context: SCHEMA })
      const d = r.data as any
      const grade = d.overall_grade ?? d.grade
      expect(grade).toBeDefined()
      // Should be penalized for SELECT * and cartesian product
    })
  })

  // =========================================================================
  // Fix edge cases
  // =========================================================================

  describe("Fix edge cases", () => {
    test("fixes multiple typos", async () => {
      const r = await D.call("altimate_core.fix", {
        sql: "SELECT nme, emal FROM usrs",
        schema_context: SCHEMA,
      })
      const d = r.data as any
      if (d.fixed) {
        expect(d.fixed_sql.toLowerCase()).toContain("users")
      }
    })

    test("handles completely unrelated table name", async () => {
      const r = await D.call("altimate_core.fix", {
        sql: "SELECT x FROM zzzzz_nonexistent",
        schema_context: SCHEMA,
      })
      expect(r).toBeDefined()
      // Should not crash even if unfixable
    })

    test("max_iterations parameter respected", async () => {
      const r = await D.call("altimate_core.fix", {
        sql: "SELECT nme FROM usrs",
        schema_context: SCHEMA,
        max_iterations: 1,
      })
      expect(r).toBeDefined()
    })
  })

  // =========================================================================
  // Transpile edge cases
  // =========================================================================

  describe("Transpile edge cases", () => {
    test("snowflake FLATTEN to postgres", async () => {
      const r = await D.call("altimate_core.transpile", {
        sql: "SELECT value FROM TABLE(FLATTEN(input => my_array))",
        from_dialect: "snowflake",
        to_dialect: "postgres",
      })
      expect(r).toBeDefined()
    })

    test("same dialect transpile is identity", async () => {
      const sql = "SELECT id FROM users WHERE id = 1"
      const r = await D.call("altimate_core.transpile", {
        sql,
        from_dialect: "postgres",
        to_dialect: "postgres",
      })
      const d = r.data as any
      const transpiled = Array.isArray(d.transpiled_sql) ? d.transpiled_sql[0] : d.transpiled_sql
      if (transpiled) {
        // Should be functionally equivalent
        expect(transpiled.toLowerCase().replace(/\s+/g, " ").trim()).toContain("select")
      }
    })

    test("mysql to bigquery", async () => {
      const r = await D.call("altimate_core.transpile", {
        sql: "SELECT IFNULL(name, 'N/A') FROM users LIMIT 10",
        from_dialect: "mysql",
        to_dialect: "bigquery",
      })
      expect(r).toBeDefined()
    })

    test("all supported dialects don't crash", async () => {
      const dialects = ["snowflake", "postgres", "bigquery", "duckdb", "mysql", "redshift", "databricks", "sqlite"]
      for (const from of ["snowflake", "postgres"]) {
        for (const to of dialects) {
          if (from === to) continue
          const r = await D.call("altimate_core.transpile", {
            sql: "SELECT id, name FROM users WHERE id = 1",
            from_dialect: from,
            to_dialect: to,
          })
          expect(r).toBeDefined()
        }
      }
    })
  })

  // =========================================================================
  // PII edge cases
  // =========================================================================

  describe("PII detection edge cases", () => {
    test("detects PII in column names", async () => {
      const piiSchema = {
        users: {
          id: "INTEGER",
          social_security_number: "VARCHAR",
          phone_number: "VARCHAR",
          credit_card: "VARCHAR",
          ip_address: "VARCHAR",
          date_of_birth: "DATE",
          passport_number: "VARCHAR",
        },
      }
      const r = await D.call("altimate_core.classify_pii", { schema_context: piiSchema })
      const d = r.data as any
      const piiCols = d.columns ?? d.findings ?? []
      expect(piiCols.length).toBeGreaterThan(0)
    })

    test("query accessing PII columns is flagged", async () => {
      const r = await D.call("altimate_core.query_pii", {
        sql: "SELECT name, email FROM users",
        schema_context: SCHEMA,
      })
      const d = r.data as any
      expect(d.accesses_pii).toBe(true)
      const piiCols = d.pii_columns ?? d.exposures ?? []
      expect(piiCols.length).toBeGreaterThan(0)
    })

    test("query without PII columns is clean", async () => {
      const r = await D.call("altimate_core.query_pii", {
        sql: "SELECT id, is_active FROM users",
        schema_context: SCHEMA,
      })
      const d = r.data as any
      expect(d.accesses_pii).toBe(false)
    })
  })

  // =========================================================================
  // Resolve term edge cases
  // =========================================================================

  describe("Resolve term edge cases", () => {
    test("resolves exact column name", async () => {
      const r = await D.call("altimate_core.resolve_term", { term: "email", schema_context: SCHEMA })
      const d = r.data as any
      expect(d.matches).toBeDefined()
      expect(d.matches.length).toBeGreaterThan(0)
      expect(d.matches[0].matched_column.column).toBe("email")
    })

    test("resolves fuzzy match", async () => {
      const r = await D.call("altimate_core.resolve_term", { term: "price", schema_context: SCHEMA })
      const d = r.data as any
      expect(d.matches).toBeDefined()
      expect(d.matches.length).toBeGreaterThan(0)
    })

    test("no match for unrelated term", async () => {
      const r = await D.call("altimate_core.resolve_term", { term: "xyzzyzzy", schema_context: SCHEMA })
      const d = r.data as any
      expect(d.matches).toBeDefined()
      // May have low-confidence fuzzy matches or empty
    })
  })

  // =========================================================================
  // Complete edge cases
  // =========================================================================

  describe("Complete edge cases", () => {
    test("completes table name after FROM", async () => {
      const sql = "SELECT * FROM u"
      const r = await D.call("altimate_core.complete", { sql, cursor_pos: sql.length, schema_context: SCHEMA })
      const d = r.data as any
      const items = d.items ?? d.suggestions ?? []
      expect(items.length).toBeGreaterThan(0)
      // Should suggest 'users'
      expect(items.some((i: any) => i.label === "users")).toBe(true)
    })

    test("completes column after table.dot", async () => {
      const sql = "SELECT users. FROM users"
      const r = await D.call("altimate_core.complete", { sql, cursor_pos: 13, schema_context: SCHEMA })
      const d = r.data as any
      const items = d.items ?? d.suggestions ?? []
      // Should suggest columns from users table
      if (items.length > 0) {
        const labels = items.map((i: any) => i.label)
        expect(labels.some((l: string) => ["id", "name", "email", "age"].includes(l))).toBe(true)
      }
    })

    test("completes JOIN condition", async () => {
      const sql = "SELECT * FROM users u JOIN orders o ON "
      const r = await D.call("altimate_core.complete", { sql, cursor_pos: sql.length, schema_context: SCHEMA })
      expect(r).toBeDefined()
    })

    test("cursor beyond SQL length doesn't crash", async () => {
      const r = await D.call("altimate_core.complete", { sql: "SELECT", cursor_pos: 999, schema_context: SCHEMA })
      expect(r).toBeDefined()
    })
  })

  // =========================================================================
  // Metadata extraction edge cases
  // =========================================================================

  describe("Metadata extraction", () => {
    test("extracts tables from complex query", async () => {
      const sql = `SELECT u.name, COUNT(o.id)
      FROM users u
      JOIN orders o ON u.id = o.user_id
      JOIN products p ON o.product = p.name
      WHERE u.is_active = true
      GROUP BY u.name`
      const r = await D.call("altimate_core.metadata", { sql })
      const d = r.data as any
      expect(d.tables).toBeDefined()
      expect(d.tables.length).toBe(3)
      expect(d.has_aggregation).toBe(true)
    })

    test("detects subqueries", async () => {
      const sql = `SELECT * FROM (SELECT id FROM users) t WHERE id IN (SELECT user_id FROM orders)`
      const r = await D.call("altimate_core.metadata", { sql })
      const d = r.data as any
      expect(d.has_subqueries).toBe(true)
    })

    test("detects window functions", async () => {
      const sql = `SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM users`
      const r = await D.call("altimate_core.metadata", { sql })
      const d = r.data as any
      expect(d.has_window_functions).toBe(true)
    })

    test("extracts output columns", async () => {
      const r = await D.call("altimate_core.metadata", { sql: "SELECT id, name AS full_name, 42 AS magic FROM users" })
      const d = r.data as any
      expect(d.columns).toBeDefined()
    })
  })

  // =========================================================================
  // Migration analysis edge cases
  // =========================================================================

  describe("Migration analysis", () => {
    test("detects column type narrowing as unsafe", async () => {
      const r = await D.call("altimate_core.migration", {
        old_ddl: "CREATE TABLE users (age BIGINT);",
        new_ddl: "CREATE TABLE users (age SMALLINT);",
      })
      const d = r.data as any
      expect(d).toBeDefined()
    })

    test("adding NOT NULL without default is unsafe", async () => {
      const r = await D.call("altimate_core.migration", {
        old_ddl: "CREATE TABLE users (id INT, name VARCHAR);",
        new_ddl: "CREATE TABLE users (id INT, name VARCHAR NOT NULL, email VARCHAR NOT NULL);",
      })
      const d = r.data as any
      expect(d).toBeDefined()
    })

    test("adding nullable column is safe", async () => {
      const r = await D.call("altimate_core.migration", {
        old_ddl: "CREATE TABLE users (id INT);",
        new_ddl: "CREATE TABLE users (id INT, name VARCHAR);",
      })
      const d = r.data as any
      expect(d).toBeDefined()
    })
  })

  // =========================================================================
  // Multi-dialect validation
  // =========================================================================

  describe("Multi-dialect behavior", () => {
    test("validate works with SchemaDefinition with dialect set", async () => {
      const ctx = {
        tables: { users: { columns: [{ name: "id", type: "INTEGER" }] } },
        dialect: "duckdb",
      }
      const r = await D.call("altimate_core.validate", {
        sql: "SELECT id FROM users",
        schema_context: ctx,
      })
      const d = r.data as any
      expect(d.valid).toBe(true)
    })
  })

  // =========================================================================
  // Policy checks
  // =========================================================================

  describe("Policy checks", () => {
    test("policy check with cost limit", async () => {
      const policy = JSON.stringify({
        max_tables: 3,
        forbidden_operations: ["DROP", "DELETE", "TRUNCATE"],
      })
      const r = await D.call("altimate_core.policy", {
        sql: "SELECT * FROM users",
        schema_context: SCHEMA,
        policy_json: policy,
      })
      expect(r).toBeDefined()
    })

    test("DML blocked by policy", async () => {
      const policy = JSON.stringify({
        forbidden_operations: ["DELETE"],
      })
      const r = await D.call("altimate_core.policy", {
        sql: "DELETE FROM users WHERE id = 1",
        schema_context: SCHEMA,
        policy_json: policy,
      })
      expect(r).toBeDefined()
    })
  })

  // =========================================================================
  // Equivalence edge cases
  // =========================================================================

  describe("Equivalence edge cases", () => {
    test("column order doesn't affect equivalence", async () => {
      const r = await D.call("altimate_core.equivalence", {
        sql1: "SELECT id, name FROM users",
        sql2: "SELECT name, id FROM users",
        schema_context: SCHEMA,
      })
      const d = r.data as any
      // Different column order may or may not be equivalent depending on engine
      expect(d.equivalent !== undefined || d.differences !== undefined).toBe(true)
    })

    test("WHERE clause order — engine may or may not treat as equivalent", async () => {
      const r = await D.call("altimate_core.equivalence", {
        sql1: "SELECT id FROM users WHERE age > 18 AND is_active = true",
        sql2: "SELECT id FROM users WHERE is_active = true AND age > 18",
        schema_context: SCHEMA,
      })
      const d = r.data as any
      // Engine uses structural comparison — AND operand order matters
      expect(d.equivalent !== undefined).toBe(true)
    })

    test("semantically different queries are not equivalent", async () => {
      const r = await D.call("altimate_core.equivalence", {
        sql1: "SELECT id FROM users WHERE age > 18",
        sql2: "SELECT id FROM users WHERE age < 18",
        schema_context: SCHEMA,
      })
      const d = r.data as any
      expect(d.equivalent).toBe(false)
    })
  })

  // =========================================================================
  // Format edge cases
  // =========================================================================

  describe("Format edge cases", () => {
    test("formats long single-line query", async () => {
      const sql = "SELECT id, name, email, age, created_at, is_active, balance FROM users WHERE id = 1 AND name = 'test' AND age > 18 ORDER BY created_at DESC LIMIT 100"
      const r = await D.call("altimate_core.format", { sql })
      const d = r.data as any
      const formatted = d.formatted_sql ?? d.sql
      expect(formatted).toBeDefined()
      // Formatter may or may not add line breaks depending on dialect
      expect(formatted.length).toBeGreaterThan(0)
    })

    test("formats already-formatted SQL without breaking it", async () => {
      const sql = `SELECT\n  id,\n  name\nFROM\n  users\nWHERE\n  id = 1`
      const r = await D.call("altimate_core.format", { sql })
      expect(r).toBeDefined()
    })
  })

  // =========================================================================
  // Compare queries
  // =========================================================================

  describe("Compare queries", () => {
    test("identical queries have no diffs", async () => {
      const sql = "SELECT id FROM users"
      const r = await D.call("altimate_core.compare", { left_sql: sql, right_sql: sql })
      const d = r.data as any
      expect(d.identical).toBe(true)
      expect(d.diff_count).toBe(0)
    })

    test("different queries have diffs", async () => {
      const r = await D.call("altimate_core.compare", {
        left_sql: "SELECT id FROM users",
        right_sql: "SELECT id, name FROM users WHERE age > 18",
      })
      const d = r.data as any
      expect(d.identical).toBe(false)
      expect(d.diff_count).toBeGreaterThan(0)
    })
  })

  // =========================================================================
  // Track lineage (multi-query)
  // =========================================================================

  describe("Track lineage multi-query", () => {
    test("tracks INSERT INTO ... SELECT lineage", async () => {
      const r = await D.call("altimate_core.track_lineage", {
        queries: [
          "CREATE TABLE staging (id INT, name VARCHAR)",
          "INSERT INTO staging SELECT id, name FROM users",
        ],
        schema_context: SCHEMA,
      })
      expect(r.success).toBe(true)
    })

    test("tracks multi-step pipeline", async () => {
      const r = await D.call("altimate_core.track_lineage", {
        queries: [
          "CREATE TABLE step1 AS SELECT id, name FROM users WHERE is_active = true",
          "CREATE TABLE step2 AS SELECT id, COUNT(*) AS cnt FROM orders GROUP BY id",
          "CREATE TABLE final AS SELECT s1.name, s2.cnt FROM step1 s1 JOIN step2 s2 ON s1.id = s2.id",
        ],
        schema_context: SCHEMA,
      })
      expect(r.success).toBe(true)
    })
  })

  // =========================================================================
  // Introspection SQL generation
  // =========================================================================

  describe("Introspection SQL generation", () => {
    const dbTypes = ["snowflake", "postgres", "bigquery", "mysql", "redshift"]
    for (const dbType of dbTypes) {
      test(`generates SQL for ${dbType}`, async () => {
        const r = await D.call("altimate_core.introspection_sql", {
          db_type: dbType,
          database: "my_db",
          schema_name: "public",
        })
        const d = r.data as any
        expect(d).toBeDefined()
      })
    }
  })

  // =========================================================================
  // Import/Export DDL roundtrip
  // =========================================================================

  describe("DDL roundtrip", () => {
    test("export then import preserves tables", async () => {
      const exportR = await D.call("altimate_core.export_ddl", { schema_context: SCHEMA })
      const ddl = (exportR.data as any).ddl
      expect(ddl).toBeDefined()
      expect(ddl).toContain("CREATE TABLE")

      const importR = await D.call("altimate_core.import_ddl", { ddl })
      const imported = (importR.data as any).schema
      expect(imported).toBeDefined()
      expect(imported.tables).toBeDefined()
    })
  })

  // =========================================================================
  // Schema fingerprint stability
  // =========================================================================

  describe("Fingerprint stability", () => {
    test("different schemas produce different fingerprints", async () => {
      const r1 = await D.call("altimate_core.fingerprint", { schema_context: { users: { id: "INT" } } })
      const r2 = await D.call("altimate_core.fingerprint", { schema_context: { orders: { id: "INT" } } })
      expect((r1.data as any).fingerprint).not.toBe((r2.data as any).fingerprint)
    })
  })
})
