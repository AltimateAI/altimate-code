/**
 * Stress E2E tests for altimate-core tools.
 *
 * Covers: dialect matrix transpilation, fuzzy fix matching, large schema diffs,
 * SQL pattern variations, cursor-position completions, PII across tables,
 * term resolution, testgen feature coverage, and grading consistency.
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

const S = {
  employees: { emp_id: "INTEGER", first_name: "VARCHAR", last_name: "VARCHAR", dept_id: "INTEGER", salary: "DECIMAL", hire_date: "DATE", manager_id: "INTEGER", email: "VARCHAR" },
  departments: { dept_id: "INTEGER", dept_name: "VARCHAR", location: "VARCHAR", budget: "DECIMAL" },
  projects: { proj_id: "INTEGER", proj_name: "VARCHAR", dept_id: "INTEGER", start_date: "DATE", end_date: "DATE", budget: "DECIMAL" },
  assignments: { assign_id: "INTEGER", emp_id: "INTEGER", proj_id: "INTEGER", role: "VARCHAR", hours: "DECIMAL" },
  salaries: { id: "INTEGER", emp_id: "INTEGER", amount: "DECIMAL", effective_date: "DATE", end_date: "DATE" },
  audit_log: { log_id: "INTEGER", table_name: "VARCHAR", action: "VARCHAR", old_value: "TEXT", new_value: "TEXT", changed_by: "INTEGER", changed_at: "TIMESTAMP" },
  customers: { cust_id: "INTEGER", company_name: "VARCHAR", contact_email: "VARCHAR", phone: "VARCHAR", address: "TEXT", country: "VARCHAR", credit_limit: "DECIMAL" },
  invoices: { inv_id: "INTEGER", cust_id: "INTEGER", amount: "DECIMAL", status: "VARCHAR", due_date: "DATE", paid_date: "DATE" },
}

describeIf("altimate-core Stress E2E", () => {
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
  // Validate: advanced SQL patterns
  // =========================================================================

  describe("Validate: advanced SQL patterns", () => {
    const patterns = [
      { name: "recursive CTE", sql: `WITH RECURSIVE org AS (SELECT emp_id, manager_id, 1 AS lvl FROM employees WHERE manager_id IS NULL UNION ALL SELECT e.emp_id, e.manager_id, o.lvl+1 FROM employees e JOIN org o ON e.manager_id = o.emp_id) SELECT * FROM org` },
      { name: "INTERSECT and EXCEPT", sql: `SELECT emp_id FROM assignments WHERE proj_id = 1 INTERSECT SELECT emp_id FROM assignments WHERE proj_id = 2 EXCEPT SELECT emp_id FROM assignments WHERE role = 'observer'` },
      { name: "multi-level subquery", sql: `SELECT * FROM employees WHERE emp_id IN (SELECT emp_id FROM assignments WHERE proj_id IN (SELECT proj_id FROM projects WHERE budget > (SELECT AVG(budget) FROM projects)))` },
      { name: "multiple window funcs", sql: `SELECT emp_id, salary, RANK() OVER w, DENSE_RANK() OVER w, NTILE(4) OVER w FROM employees WINDOW w AS (ORDER BY salary DESC)` },
      { name: "CASE in ORDER BY", sql: `SELECT emp_id, first_name, salary FROM employees ORDER BY CASE WHEN salary > 100000 THEN 1 WHEN salary > 50000 THEN 2 ELSE 3 END` },
      { name: "UPDATE with subquery", sql: `UPDATE employees SET salary = salary * 1.1 WHERE dept_id IN (SELECT dept_id FROM departments WHERE location = 'NYC')` },
      { name: "UNION ALL", sql: `SELECT emp_id, first_name, 'emp' AS src FROM employees UNION ALL SELECT cust_id, company_name, 'cust' FROM customers` },
      { name: "multi-table join", sql: `SELECT e.first_name, d.dept_name, p.proj_name, a.hours FROM employees e JOIN departments d ON e.dept_id = d.dept_id JOIN assignments a ON e.emp_id = a.emp_id JOIN projects p ON a.proj_id = p.proj_id WHERE d.location = 'NYC' ORDER BY a.hours DESC LIMIT 20` },
      { name: "HAVING with subquery", sql: `SELECT dept_id, COUNT(*) AS cnt FROM employees GROUP BY dept_id HAVING COUNT(*) > (SELECT AVG(c) FROM (SELECT COUNT(*) AS c FROM employees GROUP BY dept_id) t)` },
      { name: "CASE WHEN with NULL", sql: `SELECT emp_id, CASE WHEN salary IS NULL THEN 'unknown' WHEN salary > 100000 THEN 'high' ELSE 'normal' END AS tier, COALESCE(manager_id, 0) AS mgr FROM employees` },
    ]
    for (const { name, sql } of patterns) {
      test(name, async () => {
        const r = await D.call("altimate_core.validate", { sql, schema_context: S })
        expect(r).toBeDefined()
        expect(r.data).toBeDefined()
      })
    }
  })

  // =========================================================================
  // Transpile: dialect matrix
  // =========================================================================

  describe("Transpile: dialect matrix", () => {
    const pairs = [
      ["snowflake", "postgres"], ["snowflake", "bigquery"], ["postgres", "mysql"],
      ["mysql", "postgres"], ["bigquery", "snowflake"], ["duckdb", "postgres"],
      ["redshift", "snowflake"], ["postgres", "duckdb"], ["snowflake", "databricks"],
      ["sqlite", "postgres"],
    ]
    for (const [from, to] of pairs) {
      test(`${from} → ${to}`, async () => {
        const r = await D.call("altimate_core.transpile", {
          sql: "SELECT COALESCE(a, b), COUNT(*) FROM t WHERE x > 0 GROUP BY 1",
          from_dialect: from, to_dialect: to,
        })
        expect(r).toBeDefined()
        const d = r.data as any
        const transpiled = Array.isArray(d.transpiled_sql) ? d.transpiled_sql[0] : d.transpiled_sql
        if (d.success !== false && transpiled) {
          expect(transpiled.length).toBeGreaterThan(0)
        }
      })
    }
  })

  // =========================================================================
  // Fix: fuzzy matching
  // =========================================================================

  describe("Fix: fuzzy matching", () => {
    const cases = [
      { name: "typo in table", sql: "SELECT emp_id FROM employes", match: "employees" },
      { name: "typo in column", sql: "SELECT fist_name FROM employees", match: "first_name" },
      { name: "missing underscore", sql: "SELECT empid FROM employees", match: "emp_id" },
      { name: "close match column", sql: "SELECT salry FROM employees", match: "salary" },
      { name: "preserves valid parts", sql: "SELECT emp_id, fist_name FROM employees WHERE dept_id = 1", match: "emp_id" },
      { name: "multiple errors", sql: "SELECT fist_name, lst_name FROM employes", match: "employees" },
      { name: "completely invalid", sql: "THIS IS NOT SQL AT ALL", match: null },
      { name: "valid SQL fast path", sql: "SELECT emp_id FROM employees", match: null },
    ]
    for (const { name, sql, match } of cases) {
      test(name, async () => {
        const r = await D.call("altimate_core.fix", { sql, schema_context: S })
        const d = r.data as any
        expect(d).toBeDefined()
        if (match && d.fixed && d.fixed_sql) {
          expect(d.fixed_sql.toLowerCase()).toContain(match)
        }
      })
    }
  })

  // =========================================================================
  // Grade: scoring consistency
  // =========================================================================

  describe("Grade: scoring consistency", () => {
    const queries = [
      { name: "perfect", sql: "SELECT emp_id, first_name FROM employees WHERE dept_id = 1 ORDER BY first_name LIMIT 10" },
      { name: "select star", sql: "SELECT * FROM employees" },
      { name: "cartesian", sql: "SELECT * FROM employees, departments" },
      { name: "complex clean", sql: `SELECT e.first_name, d.dept_name, COUNT(a.assign_id) AS cnt FROM employees e JOIN departments d ON e.dept_id = d.dept_id LEFT JOIN assignments a ON e.emp_id = a.emp_id WHERE e.salary > 50000 GROUP BY e.first_name, d.dept_name HAVING COUNT(a.assign_id) > 0 ORDER BY cnt DESC LIMIT 20` },
      { name: "deeply nested", sql: `SELECT * FROM (SELECT * FROM (SELECT * FROM (SELECT * FROM employees) t1) t2) t3` },
    ]
    for (const { name, sql } of queries) {
      test(`grade: ${name}`, async () => {
        const r = await D.call("altimate_core.grade", { sql, schema_context: S })
        const d = r.data as any
        expect(["A", "B", "C", "D", "F"]).toContain(d.overall_grade)
        expect(d.scores.overall).toBeGreaterThanOrEqual(0)
        expect(d.scores.overall).toBeLessThanOrEqual(1)
      })
    }

    test("clean > select_star", async () => {
      const r1 = await D.call("altimate_core.grade", { sql: "SELECT emp_id FROM employees WHERE dept_id = 1 LIMIT 10", schema_context: S })
      const r2 = await D.call("altimate_core.grade", { sql: "SELECT * FROM employees", schema_context: S })
      expect((r1.data as any).scores.overall).toBeGreaterThanOrEqual((r2.data as any).scores.overall)
    })
  })

  // =========================================================================
  // Testgen: feature coverage
  // =========================================================================

  describe("Testgen: feature coverage", () => {
    const cases = [
      "SELECT emp_id, salary FROM employees",
      "SELECT emp_id FROM employees WHERE salary > 50000",
      "SELECT dept_id, AVG(salary) AS avg_sal FROM employees GROUP BY dept_id",
      "SELECT dept_id, COUNT(*) AS cnt FROM employees GROUP BY dept_id HAVING COUNT(*) > 5",
      "SELECT e.first_name, d.dept_name FROM employees e JOIN departments d ON e.dept_id = d.dept_id",
      "SELECT emp_id, RANK() OVER (ORDER BY salary DESC) AS rnk FROM employees",
      "SELECT emp_id, CASE WHEN salary > 100000 THEN 'high' ELSE 'low' END AS tier FROM employees",
      "SELECT DISTINCT dept_id FROM employees",
    ]
    for (const sql of cases) {
      test(sql.substring(0, 50), async () => {
        const r = await D.call("altimate_core.testgen", { sql, schema_context: S })
        const tests = (r.data as any).test_cases ?? []
        expect(tests.length).toBeGreaterThan(0)
        for (const tc of tests) {
          expect(tc.name || tc.description).toBeTruthy()
          expect(tc.category).toBeDefined()
        }
      })
    }
  })

  // =========================================================================
  // Complete: cursor positions
  // =========================================================================

  describe("Complete: cursor positions", () => {
    test("after SELECT", async () => {
      const items = ((await D.call("altimate_core.complete", { sql: "SELECT ", cursor_pos: 7, schema_context: S })).data as any).items ?? []
      expect(items.length).toBeGreaterThan(0)
    })

    test("after FROM — all tables", async () => {
      const items = ((await D.call("altimate_core.complete", { sql: "SELECT * FROM ", cursor_pos: 14, schema_context: S })).data as any).items ?? []
      const labels = new Set(items.map((i: any) => i.label))
      for (const t of Object.keys(S)) expect(labels.has(t)).toBe(true)
    })

    test("after WHERE", async () => {
      const r = await D.call("altimate_core.complete", { sql: "SELECT * FROM employees WHERE ", cursor_pos: 30, schema_context: S })
      expect(((r.data as any).items ?? []).length).toBeGreaterThan(0)
    })

    test("after JOIN", async () => {
      const r = await D.call("altimate_core.complete", { sql: "SELECT * FROM employees JOIN ", cursor_pos: 29, schema_context: S })
      expect(((r.data as any).items ?? []).length).toBeGreaterThan(0)
    })

    test("after table alias dot", async () => {
      const items = ((await D.call("altimate_core.complete", { sql: "SELECT e. FROM employees e", cursor_pos: 9, schema_context: S })).data as any).items ?? []
      if (items.length > 0) {
        expect(items.some((i: any) => ["emp_id", "first_name", "salary"].includes(i.label))).toBe(true)
      }
    })

    test("partial table name", async () => {
      const items = ((await D.call("altimate_core.complete", { sql: "SELECT * FROM emp", cursor_pos: 17, schema_context: S })).data as any).items ?? []
      if (items.length > 0) expect(items.some((i: any) => i.label === "employees")).toBe(true)
    })
  })

  // =========================================================================
  // Column lineage: transformation tracing
  // =========================================================================

  describe("Column lineage: transformations", () => {
    test("through CONCAT", async () => {
      const d = (await D.call("altimate_core.column_lineage", { sql: "SELECT emp_id, first_name || ' ' || last_name AS full_name FROM employees", schema_context: S })).data as any
      expect(d.column_dict?.full_name).toBeDefined()
    })

    test("through arithmetic", async () => {
      const d = (await D.call("altimate_core.column_lineage", { sql: "SELECT emp_id, salary * 12 AS annual, salary * 0.3 AS tax FROM employees", schema_context: S })).data as any
      expect(Object.keys(d.column_dict).length).toBeGreaterThanOrEqual(3)
    })

    test("through multi-table join", async () => {
      const d = (await D.call("altimate_core.column_lineage", { sql: `SELECT e.first_name, d.dept_name, p.proj_name, a.hours FROM employees e JOIN departments d ON e.dept_id = d.dept_id JOIN assignments a ON e.emp_id = a.emp_id JOIN projects p ON a.proj_id = p.proj_id`, schema_context: S })).data as any
      expect(d.column_lineage?.length).toBeGreaterThanOrEqual(4)
    })

    test("through GROUP BY with aggregations", async () => {
      const d = (await D.call("altimate_core.column_lineage", { sql: `SELECT dept_id, COUNT(*) AS headcount, AVG(salary) AS avg_sal, MIN(hire_date) AS earliest FROM employees GROUP BY dept_id`, schema_context: S })).data as any
      expect(Object.keys(d.column_dict).length).toBeGreaterThanOrEqual(3)
    })

    test("through CTE chain", async () => {
      const d = (await D.call("altimate_core.column_lineage", { sql: `WITH step1 AS (SELECT dept_id, AVG(salary) AS avg_sal FROM employees GROUP BY dept_id), step2 AS (SELECT dept_id, avg_sal, RANK() OVER (ORDER BY avg_sal DESC) AS dept_rank FROM step1) SELECT s.dept_id, d.dept_name, s.avg_sal FROM step2 s JOIN departments d ON s.dept_id = d.dept_id`, schema_context: S })).data as any
      expect(d.column_dict).toBeDefined()
    })

    test("through window function", async () => {
      const d = (await D.call("altimate_core.column_lineage", { sql: `SELECT emp_id, salary, SUM(salary) OVER (PARTITION BY dept_id ORDER BY hire_date) AS running FROM employees`, schema_context: S })).data as any
      expect(d.column_dict).toBeDefined()
    })

    test("through UNION ALL", async () => {
      const r = await D.call("altimate_core.column_lineage", { sql: `SELECT emp_id AS id, first_name AS name FROM employees UNION ALL SELECT cust_id AS id, company_name AS name FROM customers`, schema_context: S })
      expect(r.success).toBe(true)
    })

    test("star expansion", async () => {
      const d = (await D.call("altimate_core.column_lineage", { sql: "SELECT * FROM departments", schema_context: S })).data as any
      expect(d.column_dict).toBeDefined()
    })
  })

  // =========================================================================
  // PII across tables
  // =========================================================================

  describe("PII across tables", () => {
    test("detects PII in employee columns", async () => {
      const cols = ((await D.call("altimate_core.classify_pii", { schema_context: S })).data as any).columns ?? []
      expect(cols.length).toBeGreaterThanOrEqual(3) // email, first_name, last_name, contact_email, phone, address
    })

    test("query accessing PII across JOIN", async () => {
      const d = (await D.call("altimate_core.query_pii", { sql: "SELECT e.email, c.contact_email, c.phone FROM employees e JOIN customers c ON e.emp_id = c.cust_id", schema_context: S })).data as any
      expect(d.accesses_pii).toBe(true)
      expect((d.pii_columns ?? []).length).toBeGreaterThanOrEqual(2)
    })
  })

  // =========================================================================
  // Resolve term
  // =========================================================================

  describe("Resolve term", () => {
    test("resolves 'salary'", async () => {
      expect(((await D.call("altimate_core.resolve_term", { term: "salary", schema_context: S })).data as any).matches?.length).toBeGreaterThan(0)
    })

    test("resolves 'budget' across tables", async () => {
      expect(((await D.call("altimate_core.resolve_term", { term: "budget", schema_context: S })).data as any).matches?.length).toBeGreaterThanOrEqual(2)
    })

    test("resolves 'email' across tables", async () => {
      expect(((await D.call("altimate_core.resolve_term", { term: "email", schema_context: S })).data as any).matches?.length).toBeGreaterThanOrEqual(2)
    })
  })

  // =========================================================================
  // Schema diff: mutation matrix
  // =========================================================================

  describe("Schema diff: mutations", () => {
    test("rename column (add+remove)", async () => {
      const d = (await D.call("altimate_core.schema_diff", { schema1_context: { t: { old_name: "VARCHAR" } }, schema2_context: { t: { new_name: "VARCHAR" } } })).data as any
      expect(d.changes.length).toBe(2)
    })

    test("100-column type changes", async () => {
      const c1: Record<string, string> = {}, c2: Record<string, string> = {}
      for (let i = 0; i < 100; i++) { c1[`c${i}`] = "VARCHAR"; c2[`c${i}`] = i < 50 ? "VARCHAR" : "INTEGER" }
      expect(((await D.call("altimate_core.schema_diff", { schema1_context: { big: c1 }, schema2_context: { big: c2 } })).data as any).changes.length).toBe(50)
    })

    test("full to empty", async () => {
      const d = (await D.call("altimate_core.schema_diff", { schema1_context: S, schema2_context: {} })).data as any
      expect(d.changes.filter((c: any) => c.type === "table_removed").length).toBe(Object.keys(S).length)
      expect(d.has_breaking_changes).toBe(true)
    })

    test("special chars in names", async () => {
      const d = (await D.call("altimate_core.schema_diff", { schema1_context: { "my-table": { "col-1": "INT" } }, schema2_context: { "my-table": { "col-1": "INT", "col-2": "VARCHAR" } } })).data as any
      expect(d.changes.length).toBe(1)
    })
  })

  // =========================================================================
  // Lint: anti-pattern matrix
  // =========================================================================

  describe("Lint: anti-pattern matrix", () => {
    test("SELECT * from join", async () => {
      const d = (await D.call("altimate_core.lint", { sql: "SELECT * FROM employees e JOIN departments d ON e.dept_id = d.dept_id", schema_context: S })).data as any
      expect(d.findings?.length).toBeGreaterThan(0)
    })

    test("function in WHERE", async () => {
      const r = await D.call("altimate_core.lint", { sql: "SELECT * FROM employees WHERE UPPER(first_name) = 'JOHN'", schema_context: S })
      expect(r).toBeDefined()
    })

    test("DISTINCT on large result", async () => {
      const r = await D.call("altimate_core.lint", { sql: "SELECT DISTINCT * FROM employees", schema_context: S })
      expect(r).toBeDefined()
    })

    test("implicit cross join", async () => {
      const r = await D.call("altimate_core.lint", { sql: "SELECT e.first_name, d.dept_name FROM employees e, departments d", schema_context: S })
      expect(r).toBeDefined()
    })
  })
})
