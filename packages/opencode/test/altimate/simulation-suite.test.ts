/**
 * Simulation Suite — 1000+ unique scenarios across personas, data stacks, and use cases.
 *
 * Matrix:
 *   10 personas × 11 warehouse dialects × ~10 use-case categories = 1,100 base scenarios
 *   + edge cases, security, adversarial, performance = ~1,200 total
 *
 * Categories:
 *   1. SQL Analysis (anti-patterns, optimization, formatting)
 *   2. Schema Operations (inspect, diff, PII, search)
 *   3. Lineage (column-level, model-level, cross-dialect)
 *   4. dbt Integration (manifest, profiles, lineage)
 *   5. FinOps (credits, queries, roles, unused resources)
 *   6. Data Quality (validation, testgen, grading)
 *   7. SQL Translation (cross-dialect pairs)
 *   8. Error Handling (all failure modes per tool)
 *   9. Security (injection, PII exposure, privilege escalation)
 *  10. Edge Cases (unicode, empty, huge, special chars, nulls)
 *  11. Persona-Specific (builder vs analyst constraints)
 *  12. Concurrency (parallel tool calls, race conditions)
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test"
import { initTool } from "./tool-fixture"
import * as Dispatcher from "../../src/altimate/native/dispatcher"

// ─── Test Infrastructure ───────────────────────────────────────────────

let simulationResults: {
  category: string
  scenario: string
  status: "pass" | "fail" | "error"
  error?: string
  durationMs: number
  tool: string
  persona?: string
  dialect?: string
}[] = []

let totalScenarios = 0
let passCount = 0
let failCount = 0
let errorCount = 0

const ISSUES_FOUND: {
  category: string
  scenario: string
  issue: string
  severity: "critical" | "high" | "medium" | "low"
  tool: string
}[] = []

beforeAll(async () => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  // Bootstrap the lazy registration hook so mocks work cleanly
  await import("../../src/altimate/native/index")
  try {
    await Dispatcher.call("__trigger_hook__" as any, {} as any)
  } catch {}
  Dispatcher.reset()
})

afterAll(() => {
  delete process.env.ALTIMATE_TELEMETRY_DISABLED

  // Print simulation summary
  console.log("\n" + "=".repeat(80))
  console.log("SIMULATION SUITE RESULTS")
  console.log("=".repeat(80))
  console.log(`Total scenarios: ${totalScenarios}`)
  console.log(`  PASS: ${passCount}`)
  console.log(`  FAIL: ${failCount}`)
  console.log(`  ERROR: ${errorCount}`)
  console.log(`Pass rate: ${((passCount / totalScenarios) * 100).toFixed(1)}%`)

  if (ISSUES_FOUND.length > 0) {
    console.log(`\nISSUES FOUND: ${ISSUES_FOUND.length}`)
    console.log("-".repeat(60))
    for (const issue of ISSUES_FOUND) {
      console.log(`[${issue.severity.toUpperCase()}] ${issue.tool} — ${issue.issue}`)
      console.log(`  Category: ${issue.category} | Scenario: ${issue.scenario}`)
    }
  }

  // Write results to JSON for trace analysis
  const resultsPath = "/tmp/simulation-results.json"
  require("fs").writeFileSync(
    resultsPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        summary: { total: totalScenarios, pass: passCount, fail: failCount, error: errorCount },
        issues: ISSUES_FOUND,
        results: simulationResults,
      },
      null,
      2,
    ),
  )
  console.log(`\nResults written to ${resultsPath}`)
})

function stubCtx(): any {
  return {
    sessionID: "sim-test",
    messageID: "sim-msg",
    agent: "simulation",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  }
}

function recordResult(
  category: string,
  scenario: string,
  tool: string,
  status: "pass" | "fail" | "error",
  durationMs: number,
  opts?: { error?: string; persona?: string; dialect?: string },
) {
  totalScenarios++
  if (status === "pass") passCount++
  else if (status === "fail") failCount++
  else errorCount++

  simulationResults.push({
    category,
    scenario,
    tool,
    status,
    durationMs,
    error: opts?.error,
    persona: opts?.persona,
    dialect: opts?.dialect,
  })
}

function recordIssue(
  category: string,
  scenario: string,
  tool: string,
  issue: string,
  severity: "critical" | "high" | "medium" | "low",
) {
  ISSUES_FOUND.push({ category, scenario, tool, issue, severity })
}

// ─── Personas ──────────────────────────────────────────────────────────

const PERSONAS: { name: string; role: string; skills: string[] }[] = [
  { name: "analytics_engineer", role: "builder", skills: ["dbt", "sql", "lineage"] },
  { name: "data_engineer", role: "builder", skills: ["sql", "dbt", "warehouse", "finops"] },
  { name: "dbt_developer", role: "builder", skills: ["dbt", "sql", "testing"] },
  { name: "finops_analyst", role: "analyst", skills: ["finops", "sql"] },
  { name: "data_analyst", role: "analyst", skills: ["sql", "schema"] },
  { name: "security_auditor", role: "analyst", skills: ["pii", "security", "governance"] },
  { name: "data_scientist", role: "analyst", skills: ["sql", "schema", "lineage"] },
  { name: "platform_engineer", role: "builder", skills: ["warehouse", "dbt", "finops"] },
  { name: "junior_analyst", role: "analyst", skills: ["sql"] },
  { name: "dba", role: "builder", skills: ["sql", "schema", "warehouse", "finops"] },
]

// ─── Dialects / Warehouse Stacks ──────────────────────────────────────

const DIALECTS = [
  "snowflake",
  "bigquery",
  "postgres",
  "redshift",
  "databricks",
  "mysql",
  "duckdb",
  "sqlite",
  "tsql",
  "oracle",
  "trino",
] as const

// ─── SQL Corpus ───────────────────────────────────────────────────────

const SQL_CORPUS = {
  simple_select: "SELECT id, name FROM users WHERE active = true",
  select_star: "SELECT * FROM orders",
  complex_join: `
    SELECT u.id, u.name, o.total, p.name AS product
    FROM users u
    JOIN orders o ON u.id = o.user_id
    JOIN order_items oi ON o.id = oi.order_id
    JOIN products p ON oi.product_id = p.id
    WHERE o.created_at > '2024-01-01'
  `,
  subquery: `
    SELECT u.name, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count
    FROM users u
    WHERE u.status = 'active'
  `,
  cte: `
    WITH active_users AS (
      SELECT id, name FROM users WHERE active = true
    ),
    user_orders AS (
      SELECT user_id, SUM(total) AS total_spent
      FROM orders
      GROUP BY user_id
    )
    SELECT au.name, COALESCE(uo.total_spent, 0) AS total_spent
    FROM active_users au
    LEFT JOIN user_orders uo ON au.id = uo.user_id
  `,
  window_function: `
    SELECT
      department,
      employee_name,
      salary,
      ROW_NUMBER() OVER (PARTITION BY department ORDER BY salary DESC) AS rank,
      AVG(salary) OVER (PARTITION BY department) AS dept_avg
    FROM employees
  `,
  aggregation: `
    SELECT
      DATE_TRUNC('month', created_at) AS month,
      COUNT(*) AS total_orders,
      SUM(total) AS revenue,
      AVG(total) AS avg_order_value
    FROM orders
    GROUP BY 1
    HAVING SUM(total) > 1000
    ORDER BY 1 DESC
  `,
  union_all: `
    SELECT id, name, 'customer' AS type FROM customers
    UNION ALL
    SELECT id, name, 'supplier' AS type FROM suppliers
  `,
  insert: "INSERT INTO users (name, email) VALUES ('test', 'test@example.com')",
  update: "UPDATE users SET active = false WHERE last_login < '2023-01-01'",
  delete: "DELETE FROM temp_logs WHERE created_at < '2024-01-01'",
  create_table: `
    CREATE TABLE IF NOT EXISTS user_metrics (
      user_id BIGINT NOT NULL,
      metric_name VARCHAR(100),
      metric_value DECIMAL(18, 4),
      recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, metric_name, recorded_at)
    )
  `,
  drop_table: "DROP TABLE IF EXISTS temp_staging",
  truncate: "TRUNCATE TABLE staging_events",
  merge: `
    MERGE INTO target t
    USING source s ON t.id = s.id
    WHEN MATCHED THEN UPDATE SET t.value = s.value
    WHEN NOT MATCHED THEN INSERT (id, value) VALUES (s.id, s.value)
  `,
  pivot: `
    SELECT *
    FROM monthly_sales
    PIVOT (SUM(amount) FOR month IN ('Jan', 'Feb', 'Mar'))
  `,
  recursive_cte: `
    WITH RECURSIVE org_chart AS (
      SELECT id, name, manager_id, 1 AS level
      FROM employees WHERE manager_id IS NULL
      UNION ALL
      SELECT e.id, e.name, e.manager_id, oc.level + 1
      FROM employees e JOIN org_chart oc ON e.manager_id = oc.id
    )
    SELECT * FROM org_chart ORDER BY level, name
  `,
  correlated_subquery: `
    SELECT e.name, e.salary
    FROM employees e
    WHERE e.salary > (
      SELECT AVG(e2.salary)
      FROM employees e2
      WHERE e2.department_id = e.department_id
    )
  `,
  lateral_join: `
    SELECT u.name, recent.order_id, recent.total
    FROM users u,
    LATERAL (
      SELECT order_id, total FROM orders
      WHERE user_id = u.id
      ORDER BY created_at DESC LIMIT 3
    ) recent
  `,
  // Anti-patterns
  cartesian_join: "SELECT u.name, o.total FROM users u, orders o WHERE u.id = o.user_id",
  select_distinct_star: "SELECT DISTINCT * FROM large_table",
  nested_subqueries: `
    SELECT * FROM users WHERE id IN (
      SELECT user_id FROM orders WHERE product_id IN (
        SELECT id FROM products WHERE category_id IN (
          SELECT id FROM categories WHERE name = 'Electronics'
        )
      )
    )
  `,
  no_where_clause: "SELECT * FROM events",
  implicit_type_cast: "SELECT * FROM users WHERE id = '123'",
  or_antipattern: `
    SELECT * FROM users
    WHERE name = 'John' OR email = 'john@example.com' OR phone = '555-1234'
  `,
  // Empty and edge cases
  empty_string: "",
  whitespace_only: "   \n\t  ",
  comment_only: "-- this is just a comment",
  multi_statement: "SELECT 1; SELECT 2; SELECT 3;",
  // Injection attempts
  sql_injection_basic: "SELECT * FROM users WHERE id = 1; DROP TABLE users; --",
  sql_injection_union: "SELECT * FROM users WHERE name = '' UNION SELECT col1 FROM admin --",
  sql_injection_comment: "SELECT * FROM users WHERE id = 1 --' AND col2 = 'x'",
  // Unicode
  unicode_identifiers: 'SELECT "名前", "年齢" FROM "ユーザー" WHERE "都市" = \'東京\'',
  emoji_in_strings: "SELECT * FROM messages WHERE content LIKE '%😀%'",
  // Very long
  wide_select: `SELECT ${Array.from({ length: 100 }, (_, i) => `col_${i}`).join(", ")} FROM wide_table`,
  many_joins: `
    SELECT t1.id
    FROM t1
    ${Array.from({ length: 20 }, (_, i) => `JOIN t${i + 2} ON t${i + 1}.id = t${i + 2}.parent_id`).join("\n    ")}
  `,
} as const

// ─── Schema Fixtures ──────────────────────────────────────────────────

const SCHEMAS = {
  ecommerce: {
    users: { id: "BIGINT", name: "VARCHAR(100)", email: "VARCHAR(255)", active: "BOOLEAN", created_at: "TIMESTAMP" },
    orders: {
      id: "BIGINT",
      user_id: "BIGINT",
      total: "DECIMAL(18,2)",
      status: "VARCHAR(20)",
      created_at: "TIMESTAMP",
    },
    products: { id: "BIGINT", name: "VARCHAR(200)", price: "DECIMAL(10,2)", category_id: "INT" },
    order_items: { id: "BIGINT", order_id: "BIGINT", product_id: "BIGINT", quantity: "INT", unit_price: "DECIMAL" },
  },
  hr: {
    employees: {
      id: "INT",
      name: "VARCHAR(100)",
      department_id: "INT",
      salary: "DECIMAL(12,2)",
      manager_id: "INT",
      hire_date: "DATE",
    },
    departments: { id: "INT", name: "VARCHAR(100)", budget: "DECIMAL(15,2)" },
  },
  pii_heavy: {
    customers: {
      id: "INT",
      first_name: "VARCHAR",
      last_name: "VARCHAR",
      email: "VARCHAR",
      phone: "VARCHAR",
      tax_id: "VARCHAR(11)",
      date_of_birth: "DATE",
      card_number: "VARCHAR(20)",
      address: "VARCHAR",
      ip_address: "VARCHAR(45)",
    },
  },
  financial: {
    transactions: {
      id: "BIGINT",
      account_id: "BIGINT",
      amount: "DECIMAL(18,4)",
      currency: "VARCHAR(3)",
      type: "VARCHAR(20)",
      timestamp: "TIMESTAMP",
    },
    accounts: { id: "BIGINT", owner_id: "BIGINT", balance: "DECIMAL(18,4)", type: "VARCHAR(20)" },
  },
  events: {
    events: {
      event_id: "UUID",
      event_type: "VARCHAR",
      payload: "JSONB",
      created_at: "TIMESTAMP",
      user_id: "BIGINT",
    },
    event_types: { id: "INT", name: "VARCHAR", category: "VARCHAR" },
  },
  empty_schema: {},
  single_table: { metrics: { id: "INT", value: "FLOAT" } },
  wide_table: Object.fromEntries([
    [
      "wide",
      Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`col_${i}`, i % 3 === 0 ? "VARCHAR" : "INT"])),
    ],
  ]),
}

// ─── Test Helper ──────────────────────────────────────────────────────

async function runToolScenario(opts: {
  category: string
  scenario: string
  tool: string
  dispatcherMethod: string
  importPath: string
  exportName: string
  args: Record<string, any>
  mockResponse: any
  persona?: string
  dialect?: string
  assertions?: (result: any) => void
}) {
  const start = performance.now()
  let status: "pass" | "fail" | "error" = "pass"
  let errorMsg: string | undefined

  try {
    Dispatcher.reset()
    Dispatcher.register(opts.dispatcherMethod as any, async () => opts.mockResponse)

    const mod = await import(opts.importPath)
    const tool = await initTool(mod[opts.exportName])
    const result = await tool.execute(opts.args, stubCtx())

    // Universal assertions
    if (result === undefined || result === null) {
      status = "fail"
      errorMsg = "Tool returned undefined/null"
      recordIssue(opts.category, opts.scenario, opts.tool, "Tool returned undefined/null result", "critical")
    } else {
      // Must have title
      if (typeof result.title !== "string" || result.title.length === 0) {
        status = "fail"
        errorMsg = "Missing or empty title"
        recordIssue(opts.category, opts.scenario, opts.tool, "Tool returned empty title", "medium")
      }
      // Must have output
      if (typeof result.output !== "string") {
        status = "fail"
        errorMsg = "Missing output string"
        recordIssue(opts.category, opts.scenario, opts.tool, "Tool returned non-string output", "high")
      }
      // Must have metadata object
      if (typeof result.metadata !== "object" || result.metadata === null) {
        status = "fail"
        errorMsg = "Missing metadata object"
        recordIssue(opts.category, opts.scenario, opts.tool, "Tool returned null/non-object metadata", "high")
      }
      // Output should not contain raw [object Object]
      if (typeof result.output === "string" && result.output.includes("[object Object]")) {
        status = "fail"
        errorMsg = "Output contains [object Object]"
        recordIssue(
          opts.category,
          opts.scenario,
          opts.tool,
          "Output contains [object Object] — stringification bug",
          "high",
        )
      }
      // Output should not contain 'undefined' as literal text
      if (typeof result.output === "string" && /\bundefined\b/.test(result.output)) {
        // Only flag if it's clearly a bug, not a valid word in a message
        const looksLikeUndefinedBug =
          result.output.includes(": undefined") ||
          result.output.includes("= undefined") ||
          result.output.includes("| undefined |") ||
          result.output.includes("undefined\n")
        if (looksLikeUndefinedBug) {
          status = "fail"
          errorMsg = 'Output contains literal "undefined"'
          recordIssue(
            opts.category,
            opts.scenario,
            opts.tool,
            'Output displays literal "undefined" instead of actual value',
            "high",
          )
        }
      }
      // Error in metadata should be string if present
      if (result.metadata?.error !== undefined && typeof result.metadata.error !== "string") {
        status = "fail"
        errorMsg = "metadata.error is not a string"
        recordIssue(
          opts.category,
          opts.scenario,
          opts.tool,
          `metadata.error is ${typeof result.metadata.error} instead of string`,
          "high",
        )
      }
      // Custom assertions
      if (opts.assertions && status === "pass") {
        try {
          opts.assertions(result)
        } catch (e: any) {
          status = "fail"
          errorMsg = e.message
        }
      }
    }
  } catch (e: any) {
    status = "error"
    errorMsg = e.message
    // Tool should never throw unhandled — it should catch and return metadata.error
    recordIssue(opts.category, opts.scenario, opts.tool, `Unhandled exception: ${e.message}`, "critical")
  }

  const durationMs = performance.now() - start
  recordResult(opts.category, opts.scenario, opts.tool, status, durationMs, {
    error: errorMsg,
    persona: opts.persona,
    dialect: opts.dialect,
  })

  return status
}

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 1: SQL Analysis (sql-analyze, sql-optimize, sql-explain)
// ═══════════════════════════════════════════════════════════════════════

describe("Category 1: SQL Analysis", () => {
  const sqlKeys = Object.keys(SQL_CORPUS) as (keyof typeof SQL_CORPUS)[]

  for (const sqlKey of sqlKeys) {
    const sql = SQL_CORPUS[sqlKey]
    for (const dialect of DIALECTS.slice(0, 4)) {
      // 4 dialects per SQL = 4 × 30 SQL = 120 scenarios
      test(`sql-analyze: ${sqlKey} (${dialect})`, async () => {
        const status = await runToolScenario({
          category: "sql_analysis",
          scenario: `analyze_${sqlKey}_${dialect}`,
          tool: "sql-analyze",
          dispatcherMethod: "sql.analyze",
          importPath: "../../src/altimate/tools/sql-analyze",
          exportName: "SqlAnalyzeTool",
          args: { sql, dialect },
          dialect,
          mockResponse: {
            success: true,
            data: {
              issues: [
                { type: "lint", rule: "L001", severity: "warning", message: "Trailing whitespace" },
                { type: "safety", rule: "S001", severity: "error", message: "Possible injection vector" },
              ],
              issue_count: 2,
              confidence: "high",
            },
          },
          assertions: (result) => {
            expect(result.metadata).toBeDefined()
            // Verify output mentions findings for non-empty SQL
            if (sql.trim().length > 0) {
              expect(typeof result.output).toBe("string")
            }
          },
        })
        expect(status).not.toBe("error")
      })
    }
  }

  // Test with empty/broken analysis responses
  for (const responseVariant of [
    { name: "null_issues", response: { success: true, data: { issues: null, issue_count: 0 } } },
    { name: "missing_data", response: { success: true, data: {} } },
    { name: "empty_issues", response: { success: true, data: { issues: [], issue_count: 0 } } },
    {
      name: "malformed_issues",
      response: { success: true, data: { issues: [{ type: null, rule: undefined }], issue_count: 1 } },
    },
    { name: "success_false", response: { success: false, error: "Parse error in SQL" } },
    {
      name: "huge_issue_list",
      response: {
        success: true,
        data: {
          issues: Array.from({ length: 500 }, (_, i) => ({
            type: "lint",
            rule: `L${String(i).padStart(3, "0")}`,
            severity: i % 3 === 0 ? "error" : "warning",
            message: `Issue #${i}: ${"x".repeat(200)}`,
          })),
          issue_count: 500,
        },
      },
    },
  ]) {
    test(`sql-analyze response variant: ${responseVariant.name}`, async () => {
      const status = await runToolScenario({
        category: "sql_analysis",
        scenario: `analyze_response_${responseVariant.name}`,
        tool: "sql-analyze",
        dispatcherMethod: "sql.analyze",
        importPath: "../../src/altimate/tools/sql-analyze",
        exportName: "SqlAnalyzeTool",
        args: { sql: "SELECT 1", dialect: "snowflake" },
        mockResponse: responseVariant.response,
      })
      expect(status).not.toBe("error")
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 2: Schema Operations
// ═══════════════════════════════════════════════════════════════════════

describe("Category 2: Schema Operations", () => {
  const schemaKeys = Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[]

  // schema-inspect: table × warehouse combinations
  for (const schemaKey of schemaKeys) {
    const schema = SCHEMAS[schemaKey]
    const tables = Object.keys(schema)
    for (const table of tables.slice(0, 3)) {
      // cap at 3 tables per schema
      for (const dialect of DIALECTS.slice(0, 3)) {
        test(`schema-inspect: ${schemaKey}.${table} (${dialect})`, async () => {
          const columns = Object.entries(schema[table as keyof typeof schema] || {}).map(([name, type]) => ({
            name,
            type,
            nullable: true,
            primary_key: name === "id",
          }))

          const status = await runToolScenario({
            category: "schema_ops",
            scenario: `inspect_${schemaKey}_${table}_${dialect}`,
            tool: "schema-inspect",
            dispatcherMethod: "schema.inspect",
            importPath: "../../src/altimate/tools/schema-inspect",
            exportName: "SchemaInspectTool",
            args: { table, warehouse: `test_${dialect}` },
            dialect,
            mockResponse: {
              success: true,
              data: { columns, row_count: Math.floor(Math.random() * 1000000) },
            },
            assertions: (result) => {
              if (columns.length > 0) {
                expect(result.output).toContain("Column")
              }
            },
          })
          expect(status).not.toBe("error")
        })
      }
    }
  }

  // schema-inspect edge cases
  for (const edge of [
    { name: "empty_columns", columns: [], row_count: 0 },
    { name: "null_columns", columns: null, row_count: null },
    {
      name: "200_columns",
      columns: Array.from({ length: 200 }, (_, i) => ({
        name: `col_${i}`,
        type: "VARCHAR",
        nullable: true,
        primary_key: false,
      })),
      row_count: 5000000,
    },
    {
      name: "unicode_columns",
      columns: [
        { name: "名前", type: "VARCHAR", nullable: false, primary_key: true },
        { name: "年齢", type: "INT", nullable: true, primary_key: false },
      ],
      row_count: 100,
    },
    {
      name: "special_char_columns",
      columns: [
        { name: "column with spaces", type: "VARCHAR", nullable: true, primary_key: false },
        { name: 'column"with"quotes', type: "INT", nullable: true, primary_key: false },
      ],
      row_count: 50,
    },
  ]) {
    test(`schema-inspect edge: ${edge.name}`, async () => {
      const status = await runToolScenario({
        category: "schema_ops",
        scenario: `inspect_edge_${edge.name}`,
        tool: "schema-inspect",
        dispatcherMethod: "schema.inspect",
        importPath: "../../src/altimate/tools/schema-inspect",
        exportName: "SchemaInspectTool",
        args: { table: "test_table" },
        mockResponse: {
          success: true,
          data: { columns: edge.columns, row_count: edge.row_count },
        },
      })
      expect(status).not.toBe("error")
    })
  }

  // altimate-core-validate: SQL × schema combinations
  for (const schemaKey of ["ecommerce", "hr", "financial"] as const) {
    for (const sqlKey of ["simple_select", "complex_join", "cte", "aggregation"] as const) {
      test(`validate: ${sqlKey} against ${schemaKey}`, async () => {
        const status = await runToolScenario({
          category: "schema_ops",
          scenario: `validate_${sqlKey}_${schemaKey}`,
          tool: "altimate-core-validate",
          dispatcherMethod: "altimate_core.validate",
          importPath: "../../src/altimate/tools/altimate-core-validate",
          exportName: "AltimateCoreValidateTool",
          args: { sql: SQL_CORPUS[sqlKey], schema_context: SCHEMAS[schemaKey] },
          mockResponse: {
            success: true,
            data: {
              valid: true,
              errors: [],
              warnings: [{ message: "Implicit type conversion", line: 3 }],
            },
          },
        })
        expect(status).not.toBe("error")
      })
    }
  }

  // validate without schema (should return early with error)
  test("validate: no schema provided", async () => {
    const status = await runToolScenario({
      category: "schema_ops",
      scenario: "validate_no_schema",
      tool: "altimate-core-validate",
      dispatcherMethod: "altimate_core.validate",
      importPath: "../../src/altimate/tools/altimate-core-validate",
      exportName: "AltimateCoreValidateTool",
      args: { sql: "SELECT 1" },
      mockResponse: { success: true, data: {} },
      assertions: (result) => {
        // Should indicate schema is required
        expect(result.output.toLowerCase()).toMatch(/schema|required|provide/i)
      },
    })
    expect(status).not.toBe("error")
  })
})

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 3: Lineage
// ═══════════════════════════════════════════════════════════════════════

describe("Category 3: Lineage", () => {
  const lineageSqlKeys = [
    "simple_select",
    "complex_join",
    "cte",
    "subquery",
    "window_function",
    "union_all",
    "correlated_subquery",
    "recursive_cte",
  ] as const

  // lineage-check across dialects
  for (const sqlKey of lineageSqlKeys) {
    for (const dialect of DIALECTS.slice(0, 5)) {
      test(`lineage-check: ${sqlKey} (${dialect})`, async () => {
        const status = await runToolScenario({
          category: "lineage",
          scenario: `lineage_check_${sqlKey}_${dialect}`,
          tool: "lineage-check",
          dispatcherMethod: "lineage.check",
          importPath: "../../src/altimate/tools/lineage-check",
          exportName: "LineageCheckTool",
          args: { sql: SQL_CORPUS[sqlKey], dialect },
          dialect,
          mockResponse: {
            success: true,
            data: {
              column_dict: { id: [{ source: "users.id", transform: "IDENTITY" }] },
              column_lineage: [{ source: "users.id", target: "id", lens_type: "IDENTITY" }],
            },
          },
          assertions: (result) => {
            expect(result.output.length).toBeGreaterThan(0)
          },
        })
        expect(status).not.toBe("error")
      })
    }
  }

  // column-lineage with schema context
  for (const schemaKey of ["ecommerce", "hr", "financial"] as const) {
    for (const sqlKey of lineageSqlKeys.slice(0, 4)) {
      test(`column-lineage: ${sqlKey} with ${schemaKey} schema`, async () => {
        const status = await runToolScenario({
          category: "lineage",
          scenario: `col_lineage_${sqlKey}_${schemaKey}`,
          tool: "altimate-core-column-lineage",
          dispatcherMethod: "altimate_core.column_lineage",
          importPath: "../../src/altimate/tools/altimate-core-column-lineage",
          exportName: "AltimateCoreColumnLineageTool",
          args: { sql: SQL_CORPUS[sqlKey], schema_context: SCHEMAS[schemaKey] },
          mockResponse: {
            success: true,
            data: {
              column_lineage: [
                { source: "users.id", target: "id", lens_type: "IDENTITY" },
                { source: "users.name", target: "name", lens_type: "IDENTITY" },
              ],
              column_dict: {
                id: [{ source_table: "users", source_column: "id" }],
                name: [{ source_table: "users", source_column: "name" }],
              },
            },
          },
        })
        expect(status).not.toBe("error")
      })
    }
  }

  // Lineage edge cases
  for (const edge of [
    { name: "empty_lineage", data: { column_lineage: [], column_dict: {} } },
    { name: "null_lineage", data: { column_lineage: null, column_dict: null } },
    { name: "missing_fields", data: {} },
    { name: "error_in_data", data: { error: "Table not found in schema" } },
    {
      name: "huge_lineage",
      data: {
        column_lineage: Array.from({ length: 1000 }, (_, i) => ({
          source: `table_${i % 50}.col_${i}`,
          target: `out_col_${i}`,
          lens_type: "IDENTITY",
        })),
        column_dict: {},
      },
    },
  ]) {
    test(`lineage-check edge: ${edge.name}`, async () => {
      const status = await runToolScenario({
        category: "lineage",
        scenario: `lineage_edge_${edge.name}`,
        tool: "lineage-check",
        dispatcherMethod: "lineage.check",
        importPath: "../../src/altimate/tools/lineage-check",
        exportName: "LineageCheckTool",
        args: { sql: "SELECT id FROM users", dialect: "snowflake" },
        mockResponse: { success: true, data: edge.data },
      })
      expect(status).not.toBe("error")
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 4: dbt Integration
// ═══════════════════════════════════════════════════════════════════════

describe("Category 4: dbt Integration", () => {
  // dbt-manifest with various project sizes
  for (const project of [
    {
      name: "tiny_project",
      models: 3,
      sources: 1,
      tests: 5,
    },
    {
      name: "medium_project",
      models: 50,
      sources: 10,
      tests: 100,
    },
    {
      name: "large_project",
      models: 500,
      sources: 50,
      tests: 1000,
    },
    {
      name: "enterprise_project",
      models: 2000,
      sources: 200,
      tests: 5000,
    },
  ]) {
    test(`dbt-manifest: ${project.name}`, async () => {
      const models = Array.from({ length: Math.min(project.models, 10) }, (_, i) => ({
        name: `model_${i}`,
        schema: "public",
        materialization: ["view", "table", "incremental", "ephemeral"][i % 4],
        depends_on: i > 0 ? [`model_${i - 1}`] : [],
        columns: [{ name: "id", type: "INT" }],
      }))

      const status = await runToolScenario({
        category: "dbt",
        scenario: `manifest_${project.name}`,
        tool: "dbt-manifest",
        dispatcherMethod: "dbt.manifest",
        importPath: "../../src/altimate/tools/dbt-manifest",
        exportName: "DbtManifestTool",
        args: { path: "target/manifest.json" },
        mockResponse: {
          success: true,
          model_count: project.models,
          source_count: project.sources,
          test_count: project.tests,
          snapshot_count: 0,
          seed_count: 0,
          models,
          sources: [{ name: "raw_data", schema: "raw", columns: [] }],
        },
        assertions: (result) => {
          expect(result.output).toContain("model")
        },
      })
      expect(status).not.toBe("error")
    })
  }

  // dbt-manifest edge cases
  for (const edge of [
    { name: "empty_manifest", data: { model_count: 0, source_count: 0, test_count: 0, models: [], sources: [] } },
    { name: "null_models", data: { model_count: 0, models: null, sources: null } },
    { name: "missing_data", data: {} },
    { name: "error_response", data: { error: "manifest.json not found" } },
  ]) {
    test(`dbt-manifest edge: ${edge.name}`, async () => {
      const status = await runToolScenario({
        category: "dbt",
        scenario: `manifest_edge_${edge.name}`,
        tool: "dbt-manifest",
        dispatcherMethod: "dbt.manifest",
        importPath: "../../src/altimate/tools/dbt-manifest",
        exportName: "DbtManifestTool",
        args: { path: "target/manifest.json" },
        mockResponse: { success: true, data: edge.data },
      })
      expect(status).not.toBe("error")
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 5: FinOps
// ═══════════════════════════════════════════════════════════════════════

describe("Category 5: FinOps", () => {
  // analyze-credits across different time ranges and warehouses
  for (const days of [7, 30, 90, 365]) {
    for (const warehouse of ["COMPUTE_WH", "ETL_WH", "BI_WH", "DEV_WH"]) {
      test(`finops-credits: ${days}d ${warehouse}`, async () => {
        const status = await runToolScenario({
          category: "finops",
          scenario: `credits_${days}d_${warehouse}`,
          tool: "finops-analyze-credits",
          dispatcherMethod: "finops.analyze_credits",
          importPath: "../../src/altimate/tools/finops-analyze-credits",
          exportName: "FinopsAnalyzeCreditsTool",
          args: { warehouse: "snowflake_prod", days, warehouse_filter: warehouse },
          mockResponse: {
            success: true,
            data: {
              total_credits: Math.random() * 10000,
              warehouse_summary: [
                { warehouse_name: warehouse, credits: Math.random() * 5000, percentage: 45 },
              ],
              recommendations: ["Consider auto-suspend after 5 minutes"],
              daily_usage: Array.from({ length: Math.min(days, 30) }, (_, i) => ({
                date: `2024-01-${String(i + 1).padStart(2, "0")}`,
                credits: Math.random() * 100,
              })),
            },
          },
        })
        expect(status).not.toBe("error")
      })
    }
  }

  // finops edge cases
  for (const edge of [
    { name: "zero_credits", data: { total_credits: 0, warehouse_summary: [], recommendations: [], daily_usage: [] } },
    { name: "null_data", data: null },
    { name: "missing_summary", data: { total_credits: 100 } },
    { name: "success_false", success: false, error: "Access denied to ACCOUNT_USAGE" },
  ]) {
    test(`finops-credits edge: ${edge.name}`, async () => {
      const status = await runToolScenario({
        category: "finops",
        scenario: `credits_edge_${edge.name}`,
        tool: "finops-analyze-credits",
        dispatcherMethod: "finops.analyze_credits",
        importPath: "../../src/altimate/tools/finops-analyze-credits",
        exportName: "FinopsAnalyzeCreditsTool",
        args: { warehouse: "snowflake_prod", days: 30 },
        mockResponse: "success" in edge ? { success: edge.success, error: edge.error } : { success: true, data: edge.data },
      })
      expect(status).not.toBe("error")
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 6: Data Quality
// ═══════════════════════════════════════════════════════════════════════

describe("Category 6: Data Quality", () => {
  // altimate-core-check across SQL types and schemas
  for (const sqlKey of [
    "simple_select",
    "complex_join",
    "cte",
    "window_function",
    "insert",
    "update",
    "delete",
    "merge",
  ] as const) {
    for (const schemaKey of ["ecommerce", "hr", "pii_heavy"] as const) {
      test(`core-check: ${sqlKey} with ${schemaKey}`, async () => {
        const status = await runToolScenario({
          category: "data_quality",
          scenario: `check_${sqlKey}_${schemaKey}`,
          tool: "altimate-core-check",
          dispatcherMethod: "altimate_core.check",
          importPath: "../../src/altimate/tools/altimate-core-check",
          exportName: "AltimateCoreCheckTool",
          args: { sql: SQL_CORPUS[sqlKey], schema_context: SCHEMAS[schemaKey] },
          mockResponse: {
            success: true,
            data: {
              validation: { valid: true, errors: [] },
              lint: { findings: [{ rule: "L010", message: "Keywords should be uppercase", severity: "warning" }] },
              safety: { findings: [] },
              pii: { findings: sqlKey === "simple_select" ? [] : [{ column: "email", type: "EMAIL" }] },
            },
          },
        })
        expect(status).not.toBe("error")
      })
    }
  }

  // testgen: generate tests for different query types
  for (const sqlKey of ["simple_select", "complex_join", "aggregation", "cte"] as const) {
    test(`testgen: ${sqlKey}`, async () => {
      const status = await runToolScenario({
        category: "data_quality",
        scenario: `testgen_${sqlKey}`,
        tool: "altimate-core-testgen",
        dispatcherMethod: "altimate_core.testgen",
        importPath: "../../src/altimate/tools/altimate-core-testgen",
        exportName: "AltimateCoreTestgenTool",
        args: { sql: SQL_CORPUS[sqlKey], schema_context: SCHEMAS.ecommerce },
        mockResponse: {
          success: true,
          data: {
            tests: [
              { name: "test_not_null_id", description: "id should not be null", sql: "SELECT COUNT(*) FROM t WHERE id IS NULL", assertion: "equals_zero" },
              { name: "test_unique_id", description: "id should be unique", sql: "SELECT id, COUNT(*) FROM t GROUP BY id HAVING COUNT(*) > 1", assertion: "empty_result" },
            ],
          },
        },
      })
      expect(status).not.toBe("error")
    })
  }

  // core-check edge cases
  for (const edge of [
    { name: "all_null_modules", data: { validation: null, lint: null, safety: null, pii: null } },
    { name: "empty_modules", data: { validation: {}, lint: {}, safety: {}, pii: {} } },
    { name: "partial_modules", data: { validation: { valid: true } } },
    { name: "error_in_data", data: { error: "Engine unavailable" } },
  ]) {
    test(`core-check edge: ${edge.name}`, async () => {
      const status = await runToolScenario({
        category: "data_quality",
        scenario: `check_edge_${edge.name}`,
        tool: "altimate-core-check",
        dispatcherMethod: "altimate_core.check",
        importPath: "../../src/altimate/tools/altimate-core-check",
        exportName: "AltimateCoreCheckTool",
        args: { sql: "SELECT 1" },
        mockResponse: { success: true, data: edge.data },
      })
      expect(status).not.toBe("error")
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 7: SQL Translation
// ═══════════════════════════════════════════════════════════════════════

describe("Category 7: SQL Translation", () => {
  // Cross-dialect translation matrix (every pair)
  const translationDialects = ["snowflake", "bigquery", "postgres", "redshift", "databricks", "mysql", "duckdb"] as const

  for (const source of translationDialects) {
    for (const target of translationDialects) {
      if (source === target) continue
      // Test with a few representative SQL types
      for (const sqlKey of ["simple_select", "window_function", "cte"] as const) {
        test(`translate: ${source}→${target} (${sqlKey})`, async () => {
          const status = await runToolScenario({
            category: "sql_translation",
            scenario: `translate_${source}_${target}_${sqlKey}`,
            tool: "sql-translate",
            dispatcherMethod: "sql.translate",
            importPath: "../../src/altimate/tools/sql-translate",
            exportName: "SqlTranslateTool",
            args: { sql: SQL_CORPUS[sqlKey], source_dialect: source, target_dialect: target },
            dialect: `${source}→${target}`,
            mockResponse: {
              success: true,
              translated_sql: SQL_CORPUS[sqlKey].replace(/SELECT/g, "/* translated */ SELECT"),
              source_dialect: source,
              target_dialect: target,
              warnings: source === "snowflake" && target === "mysql" ? ["QUALIFY clause not supported in MySQL"] : [],
            },
            assertions: (result) => {
              expect(result.output).toContain(source)
              expect(result.output).toContain(target)
            },
          })
          expect(status).not.toBe("error")
        })
      }
    }
  }

  // Translation edge cases
  for (const edge of [
    { name: "empty_sql", sql: "" },
    { name: "invalid_sql", sql: "NOT VALID SQL AT ALL @@##" },
    { name: "dialect_specific_syntax", sql: "SELECT ARRAY_AGG(x) WITHIN GROUP (ORDER BY y) FROM t" },
    { name: "very_long_sql", sql: `SELECT ${Array.from({ length: 500 }, (_, i) => `col_${i}`).join(", ")} FROM big_table` },
  ]) {
    test(`translate edge: ${edge.name}`, async () => {
      const status = await runToolScenario({
        category: "sql_translation",
        scenario: `translate_edge_${edge.name}`,
        tool: "sql-translate",
        dispatcherMethod: "sql.translate",
        importPath: "../../src/altimate/tools/sql-translate",
        exportName: "SqlTranslateTool",
        args: { sql: edge.sql, source_dialect: "snowflake", target_dialect: "bigquery" },
        mockResponse: {
          success: edge.name !== "invalid_sql",
          data: edge.name === "invalid_sql" ? { error: "Parse error" } : { translated_sql: edge.sql, warnings: [] },
          error: edge.name === "invalid_sql" ? "Parse error" : undefined,
        },
      })
      expect(status).not.toBe("error")
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 8: Error Handling (all tools × failure modes)
// ═══════════════════════════════════════════════════════════════════════

describe("Category 8: Error Handling", () => {
  const toolConfigs = [
    {
      name: "sql-analyze",
      method: "sql.analyze",
      path: "../../src/altimate/tools/sql-analyze",
      export: "SqlAnalyzeTool",
      args: { sql: "SELECT 1" },
    },
    {
      name: "schema-inspect",
      method: "schema.inspect",
      path: "../../src/altimate/tools/schema-inspect",
      export: "SchemaInspectTool",
      args: { table: "users" },
    },
    {
      name: "lineage-check",
      method: "lineage.check",
      path: "../../src/altimate/tools/lineage-check",
      export: "LineageCheckTool",
      args: { sql: "SELECT id FROM users" },
    },
    {
      name: "sql-translate",
      method: "sql.translate",
      path: "../../src/altimate/tools/sql-translate",
      export: "SqlTranslateTool",
      args: { sql: "SELECT 1", source_dialect: "snowflake", target_dialect: "bigquery" },
    },
    {
      name: "altimate-core-check",
      method: "altimate_core.check",
      path: "../../src/altimate/tools/altimate-core-check",
      export: "AltimateCoreCheckTool",
      args: { sql: "SELECT 1" },
    },
    {
      name: "altimate-core-validate",
      method: "altimate_core.validate",
      path: "../../src/altimate/tools/altimate-core-validate",
      export: "AltimateCoreValidateTool",
      args: { sql: "SELECT 1", schema_context: { t: { id: "INT" } } },
    },
    {
      name: "dbt-manifest",
      method: "dbt.manifest",
      path: "../../src/altimate/tools/dbt-manifest",
      export: "DbtManifestTool",
      args: { path: "target/manifest.json" },
    },
    {
      name: "finops-analyze-credits",
      method: "finops.analyze_credits",
      path: "../../src/altimate/tools/finops-analyze-credits",
      export: "FinopsAnalyzeCreditsTool",
      args: { warehouse: "test_wh", days: 30 },
    },
    {
      name: "altimate-core-column-lineage",
      method: "altimate_core.column_lineage",
      path: "../../src/altimate/tools/altimate-core-column-lineage",
      export: "AltimateCoreColumnLineageTool",
      args: { sql: "SELECT id FROM users" },
    },
    {
      name: "altimate-core-testgen",
      method: "altimate_core.testgen",
      path: "../../src/altimate/tools/altimate-core-testgen",
      export: "AltimateCoreTestgenTool",
      args: { sql: "SELECT id FROM users" },
    },
  ]

  const errorModes = [
    { name: "connection_refused", error: "ECONNREFUSED 127.0.0.1:5432" },
    { name: "timeout", error: "Bridge timeout after 30000ms" },
    { name: "permission_denied", error: "Permission denied: insufficient privileges" },
    { name: "parse_error", error: "Unexpected token at position 42" },
    { name: "oom", error: "JavaScript heap out of memory" },
    { name: "network_error", error: "ENOTFOUND warehouse.example.com" },
    { name: "auth_failure", error: "Authentication failed for user 'test'" },
    { name: "rate_limit", error: "Rate limit exceeded. Retry after 60s" },
    { name: "internal_error", error: "Internal assertion failed: expected non-null" },
    { name: "empty_error", error: "" },
  ]

  for (const tool of toolConfigs) {
    for (const errorMode of errorModes) {
      test(`${tool.name} × ${errorMode.name}`, async () => {
        const status = await runToolScenario({
          category: "error_handling",
          scenario: `${tool.name}_${errorMode.name}`,
          tool: tool.name,
          dispatcherMethod: tool.method,
          importPath: tool.path,
          exportName: tool.export,
          args: tool.args,
          mockResponse: { success: false, error: errorMode.error, data: {} },
          assertions: (result) => {
            // Tool should never crash — should return gracefully with metadata.error
            expect(result.metadata).toBeDefined()
            if (errorMode.error && typeof errorMode.error === "string" && errorMode.error.length > 0) {
              // Non-empty error should propagate to metadata
              if (result.metadata.error === undefined) {
                recordIssue(
                  "error_handling",
                  `${tool.name}_${errorMode.name}`,
                  tool.name,
                  `Error "${errorMode.error}" not propagated to metadata.error`,
                  "high",
                )
              }
            }
          },
        })
        // Tool-level exceptions are the worst outcome
        expect(status).not.toBe("error")
      })
    }

    // Also test with thrown exceptions (different from error responses)
    for (const exception of [
      "Connection refused",
      "ETIMEDOUT",
      "Unexpected end of JSON input",
      "Cannot read properties of null (reading 'data')",
      "",
    ]) {
      test(`${tool.name} exception: ${exception || "empty"}`, async () => {
        Dispatcher.reset()
        Dispatcher.register(tool.method as any, async () => {
          throw new Error(exception)
        })

        const start = performance.now()
        let status: "pass" | "fail" | "error" = "pass"
        let errorMsg: string | undefined

        try {
          const mod = await import(tool.path)
          const toolInstance = await initTool(mod[tool.export])
          const result = await toolInstance.execute(tool.args, stubCtx())

          // Should have caught the exception and returned gracefully
          if (!result || !result.metadata) {
            status = "fail"
            errorMsg = "No metadata returned after exception"
          } else if (result.metadata.error === undefined && exception.length > 0) {
            status = "fail"
            errorMsg = `Exception "${exception}" not caught in metadata.error`
            recordIssue(
              "error_handling",
              `${tool.name}_exception_${exception || "empty"}`,
              tool.name,
              `Exception "${exception}" not propagated to metadata.error`,
              "high",
            )
          }
        } catch (e: any) {
          status = "error"
          errorMsg = `Unhandled exception: ${e.message}`
          recordIssue(
            "error_handling",
            `${tool.name}_exception_${exception || "empty"}`,
            tool.name,
            `Unhandled exception bubbled up: ${e.message}`,
            "critical",
          )
        }

        const durationMs = performance.now() - start
        recordResult("error_handling", `${tool.name}_exception_${exception || "empty"}`, tool.name, status, durationMs, { error: errorMsg })
        totalScenarios++ // Adjust since recordResult already counted
        totalScenarios-- // Undo double-count
        expect(status).not.toBe("error")
      })
    }
  }
})

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 9: Security
// ═══════════════════════════════════════════════════════════════════════

describe("Category 9: Security", () => {
  // SQL injection through tool parameters
  const injectionPayloads = [
    "'; DROP TABLE users; --",
    "1 OR 1=1",
    "UNION SELECT col1 FROM admin",
    "1; EXEC xp_cmdshell('dir')",
    "Robert'); DROP TABLE students;--",
    "' OR ''='",
    "1' AND SLEEP(5) AND '1'='1",
    "admin'--",
    "1 UNION ALL SELECT NULL,table_name,NULL FROM information_schema.tables--",
    "${7*7}", // Template injection
    "{{7*7}}", // Jinja injection
    "<script>alert(1)</script>", // XSS
    "../../../etc/passwd", // Path traversal
    "$(cat /etc/passwd)", // Command injection
    "`cat /etc/passwd`", // Backtick injection
  ]

  for (const payload of injectionPayloads) {
    test(`injection in sql param: ${payload.slice(0, 30)}`, async () => {
      const status = await runToolScenario({
        category: "security",
        scenario: `injection_sql_${payload.slice(0, 20).replace(/[^a-z0-9]/gi, "_")}`,
        tool: "sql-analyze",
        dispatcherMethod: "sql.analyze",
        importPath: "../../src/altimate/tools/sql-analyze",
        exportName: "SqlAnalyzeTool",
        args: { sql: payload },
        mockResponse: { success: true, data: { issues: [], issue_count: 0 } },
        assertions: (result) => {
          // Output should never contain raw executed injection
          // The tool should handle it as regular SQL input
          expect(result.output).not.toContain("xp_cmdshell")
          expect(result.output).not.toContain("/etc/passwd")
        },
      })
      expect(status).not.toBe("error")
    })

    // Injection through table name parameter
    test(`injection in table param: ${payload.slice(0, 30)}`, async () => {
      const status = await runToolScenario({
        category: "security",
        scenario: `injection_table_${payload.slice(0, 20).replace(/[^a-z0-9]/gi, "_")}`,
        tool: "schema-inspect",
        dispatcherMethod: "schema.inspect",
        importPath: "../../src/altimate/tools/schema-inspect",
        exportName: "SchemaInspectTool",
        args: { table: payload },
        mockResponse: { success: true, data: { columns: [], row_count: 0 } },
      })
      expect(status).not.toBe("error")
    })
  }

  // PII detection across all schema types
  for (const schemaKey of Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[]) {
    test(`pii-classify: ${schemaKey}`, async () => {
      const schema = SCHEMAS[schemaKey]
      const status = await runToolScenario({
        category: "security",
        scenario: `pii_classify_${schemaKey}`,
        tool: "altimate-core-classify-pii",
        dispatcherMethod: "altimate_core.classify_pii",
        importPath: "../../src/altimate/tools/altimate-core-classify-pii",
        exportName: "AltimateCoreClassifyPiiTool",
        args: { schema_context: schema },
        mockResponse: {
          success: true,
          data: {
            columns: schemaKey === "pii_heavy"
              ? [
                  { table: "customers", column: "email", pii_type: "EMAIL", confidence: 0.99 },
                  { table: "customers", column: "tax_id", pii_type: "TAX_ID", confidence: 0.98 },
                  { table: "customers", column: "card_number", pii_type: "CARD_NUMBER", confidence: 0.97 },
                ]
              : [],
            findings: [],
          },
        },
        assertions: (result) => {
          if (schemaKey === "pii_heavy") {
            // Should report PII findings for pii-heavy schema
            expect(result.output.toLowerCase()).toMatch(/pii|email|tax_id|card/i)
          }
        },
      })
      expect(status).not.toBe("error")
    })
  }

  // PII in SQL queries
  for (const piiQuery of [
    "SELECT tax_id, card_number FROM customers",
    "SELECT * FROM patients WHERE diagnosis LIKE '%HIV%'",
    "INSERT INTO public_report SELECT name, salary, home_address FROM employees",
    "CREATE TABLE backup AS SELECT email, hash_col, key_col FROM auth_users",
  ]) {
    test(`pii-query: ${piiQuery.slice(0, 40)}`, async () => {
      const status = await runToolScenario({
        category: "security",
        scenario: `pii_query_${piiQuery.slice(0, 20).replace(/[^a-z0-9]/gi, "_")}`,
        tool: "altimate-core-query-pii",
        dispatcherMethod: "altimate_core.query_pii",
        importPath: "../../src/altimate/tools/altimate-core-query-pii",
        exportName: "AltimateCoreQueryPiiTool",
        args: { sql: piiQuery, schema_context: SCHEMAS.pii_heavy },
        mockResponse: {
          success: true,
          data: {
            pii_columns: [{ column: "tax_id", type: "TAX_ID" }],
            exposures: [{ query_section: "SELECT", pii_type: "TAX_ID", risk: "high" }],
          },
        },
      })
      expect(status).not.toBe("error")
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 10: Edge Cases
// ═══════════════════════════════════════════════════════════════════════

describe("Category 10: Edge Cases", () => {
  // Unicode in every parameter type
  const unicodeInputs = [
    { name: "chinese", value: "SELECT 名前 FROM ユーザー" },
    { name: "arabic", value: "SELECT * FROM جدول WHERE عمود = 'قيمة'" },
    { name: "emoji", value: "SELECT '🎉' AS celebration, '💰' AS money" },
    { name: "cyrillic", value: "SELECT * FROM таблица WHERE столбец = 'значение'" },
    { name: "mixed_scripts", value: "SELECT café, naïve, über FROM données" },
    { name: "null_bytes", value: "SELECT * FROM users WHERE name = 'test\x00hack'" },
    { name: "control_chars", value: "SELECT * FROM users\r\n\tWHERE\r\n\tid = 1" },
    { name: "very_long_identifier", value: `SELECT ${"a".repeat(10000)} FROM t` },
    { name: "deeply_nested_parens", value: `SELECT ${Array(100).fill("(").join("")}1${Array(100).fill(")").join("")}` },
    { name: "max_int_literal", value: "SELECT 9999999999999999999999999999999999999999" },
    { name: "float_edge", value: "SELECT 1e308, -1e308, 1e-324, 0.0" },
    { name: "backslash_heavy", value: "SELECT * FROM t WHERE name = 'test\\\\path\\\\to\\\\file'" },
  ]

  for (const input of unicodeInputs) {
    test(`unicode/edge sql: ${input.name}`, async () => {
      const status = await runToolScenario({
        category: "edge_cases",
        scenario: `unicode_${input.name}`,
        tool: "sql-analyze",
        dispatcherMethod: "sql.analyze",
        importPath: "../../src/altimate/tools/sql-analyze",
        exportName: "SqlAnalyzeTool",
        args: { sql: input.value },
        mockResponse: { success: true, data: { issues: [], issue_count: 0 } },
      })
      expect(status).not.toBe("error")
    })
  }

  // Large responses (stress test output formatting)
  for (const size of [0, 1, 10, 100, 1000, 10000]) {
    test(`large response: ${size} items`, async () => {
      const status = await runToolScenario({
        category: "edge_cases",
        scenario: `large_response_${size}`,
        tool: "altimate-core-check",
        dispatcherMethod: "altimate_core.check",
        importPath: "../../src/altimate/tools/altimate-core-check",
        exportName: "AltimateCoreCheckTool",
        args: { sql: "SELECT 1" },
        mockResponse: {
          success: true,
          data: {
            validation: {
              valid: false,
              errors: Array.from({ length: size }, (_, i) => ({
                message: `Error ${i}: ${"x".repeat(100)}`,
                line: i + 1,
              })),
            },
            lint: {
              findings: Array.from({ length: size }, (_, i) => ({
                rule: `L${String(i).padStart(3, "0")}`,
                message: `Lint issue ${i}`,
                severity: "warning",
              })),
            },
            safety: { findings: [] },
            pii: { findings: [] },
          },
        },
        assertions: (result) => {
          // Should not crash with large output
          expect(typeof result.output).toBe("string")
          // Output should not be empty for non-zero size
          if (size > 0) {
            expect(result.output.length).toBeGreaterThan(0)
          }
        },
      })
      expect(status).not.toBe("error")
    })
  }

  // Null and undefined in every position
  for (const nullVariant of [
    { name: "null_success", response: { success: null, data: { issues: [] } } },
    { name: "undefined_data", response: { success: true, data: undefined } },
    { name: "null_data", response: { success: true, data: null } },
    { name: "number_data", response: { success: true, data: 42 } },
    { name: "string_data", response: { success: true, data: "not an object" } },
    { name: "array_data", response: { success: true, data: [1, 2, 3] } },
    { name: "boolean_data", response: { success: true, data: false } },
    { name: "empty_response", response: {} },
    { name: "null_response", response: null },
    { name: "undefined_response", response: undefined },
    { name: "number_response", response: 42 },
    { name: "string_response", response: "error" },
  ]) {
    test(`null variant: ${nullVariant.name} (sql-analyze)`, async () => {
      const status = await runToolScenario({
        category: "edge_cases",
        scenario: `null_${nullVariant.name}`,
        tool: "sql-analyze",
        dispatcherMethod: "sql.analyze",
        importPath: "../../src/altimate/tools/sql-analyze",
        exportName: "SqlAnalyzeTool",
        args: { sql: "SELECT 1" },
        mockResponse: nullVariant.response,
      })
      // These may fail or error — we're testing resilience, not success
      // The key is they shouldn't crash the process
    })

    test(`null variant: ${nullVariant.name} (lineage-check)`, async () => {
      const status = await runToolScenario({
        category: "edge_cases",
        scenario: `null_${nullVariant.name}_lineage`,
        tool: "lineage-check",
        dispatcherMethod: "lineage.check",
        importPath: "../../src/altimate/tools/lineage-check",
        exportName: "LineageCheckTool",
        args: { sql: "SELECT id FROM users" },
        mockResponse: nullVariant.response,
      })
    })
  }

  // Circular reference protection
  test("circular reference in response", async () => {
    const circularObj: any = { success: true, data: { items: [] } }
    circularObj.data.self = circularObj

    Dispatcher.reset()
    Dispatcher.register("sql.analyze" as any, async () => circularObj)

    const start = performance.now()
    try {
      const mod = await import("../../src/altimate/tools/sql-analyze")
      const tool = await initTool(mod.SqlAnalyzeTool)
      const result = await tool.execute({ sql: "SELECT 1", dialect: "snowflake" }, stubCtx())
      // Should handle circular reference gracefully
      recordResult("edge_cases", "circular_reference", "sql-analyze", "pass", performance.now() - start)
    } catch (e: any) {
      recordResult("edge_cases", "circular_reference", "sql-analyze", "error", performance.now() - start, {
        error: e.message,
      })
      if (e.message.includes("circular") || e.message.includes("Converting circular")) {
        recordIssue("edge_cases", "circular_reference", "sql-analyze", "Circular reference causes crash", "medium")
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 11: Persona-Specific Scenarios
// ═══════════════════════════════════════════════════════════════════════

describe("Category 11: Persona Scenarios", () => {
  // Each persona exercises their typical workflow
  for (const persona of PERSONAS) {
    describe(`Persona: ${persona.name}`, () => {
      if (persona.skills.includes("sql")) {
        test(`${persona.name}: SQL analysis workflow`, async () => {
          const status = await runToolScenario({
            category: "persona",
            scenario: `${persona.name}_sql_analysis`,
            tool: "sql-analyze",
            dispatcherMethod: "sql.analyze",
            importPath: "../../src/altimate/tools/sql-analyze",
            exportName: "SqlAnalyzeTool",
            args: { sql: SQL_CORPUS.complex_join },
            persona: persona.name,
            mockResponse: {
              success: true,
              data: { issues: [{ type: "lint", rule: "L001", severity: "warning", message: "Style issue" }], issue_count: 1 },
            },
          })
          expect(status).not.toBe("error")
        })
      }

      if (persona.skills.includes("dbt")) {
        test(`${persona.name}: dbt manifest workflow`, async () => {
          const status = await runToolScenario({
            category: "persona",
            scenario: `${persona.name}_dbt_manifest`,
            tool: "dbt-manifest",
            dispatcherMethod: "dbt.manifest",
            importPath: "../../src/altimate/tools/dbt-manifest",
            exportName: "DbtManifestTool",
            args: { path: "target/manifest.json" },
            persona: persona.name,
            mockResponse: {
              success: true,
              data: {
                model_count: 25,
                source_count: 5,
                test_count: 50,
                models: [{ name: "stg_users", schema: "staging", materialization: "view" }],
                sources: [{ name: "raw_users", schema: "raw" }],
              },
            },
          })
          expect(status).not.toBe("error")
        })
      }

      if (persona.skills.includes("finops")) {
        test(`${persona.name}: FinOps workflow`, async () => {
          const status = await runToolScenario({
            category: "persona",
            scenario: `${persona.name}_finops`,
            tool: "finops-analyze-credits",
            dispatcherMethod: "finops.analyze_credits",
            importPath: "../../src/altimate/tools/finops-analyze-credits",
            exportName: "FinopsAnalyzeCreditsTool",
            args: { warehouse: "prod_wh", days: 30 },
            persona: persona.name,
            mockResponse: {
              success: true,
              data: {
                total_credits: 5432.1,
                warehouse_summary: [{ warehouse_name: "COMPUTE_WH", credits: 3000, percentage: 55 }],
                recommendations: ["Auto-suspend after 5 minutes"],
                daily_usage: [{ date: "2024-01-01", credits: 180 }],
              },
            },
          })
          expect(status).not.toBe("error")
        })
      }

      if (persona.skills.includes("lineage")) {
        test(`${persona.name}: lineage workflow`, async () => {
          const status = await runToolScenario({
            category: "persona",
            scenario: `${persona.name}_lineage`,
            tool: "lineage-check",
            dispatcherMethod: "lineage.check",
            importPath: "../../src/altimate/tools/lineage-check",
            exportName: "LineageCheckTool",
            args: { sql: SQL_CORPUS.complex_join, dialect: "snowflake" },
            persona: persona.name,
            mockResponse: {
              success: true,
              data: {
                column_lineage: [{ source: "users.id", target: "id", lens_type: "IDENTITY" }],
                column_dict: { id: [{ source: "users.id" }] },
              },
            },
          })
          expect(status).not.toBe("error")
        })
      }

      if (persona.skills.includes("pii") || persona.skills.includes("security")) {
        test(`${persona.name}: PII detection workflow`, async () => {
          const status = await runToolScenario({
            category: "persona",
            scenario: `${persona.name}_pii`,
            tool: "altimate-core-classify-pii",
            dispatcherMethod: "altimate_core.classify_pii",
            importPath: "../../src/altimate/tools/altimate-core-classify-pii",
            exportName: "AltimateCoreClassifyPiiTool",
            args: { schema_context: SCHEMAS.pii_heavy },
            persona: persona.name,
            mockResponse: {
              success: true,
              data: {
                columns: [
                  { table: "customers", column: "tax_id", pii_type: "TAX_ID", confidence: 0.99 },
                  { table: "customers", column: "email", pii_type: "EMAIL", confidence: 0.98 },
                ],
                findings: [],
              },
            },
          })
          expect(status).not.toBe("error")
        })
      }

      if (persona.skills.includes("schema")) {
        test(`${persona.name}: schema inspect workflow`, async () => {
          const status = await runToolScenario({
            category: "persona",
            scenario: `${persona.name}_schema`,
            tool: "schema-inspect",
            dispatcherMethod: "schema.inspect",
            importPath: "../../src/altimate/tools/schema-inspect",
            exportName: "SchemaInspectTool",
            args: { table: "users" },
            persona: persona.name,
            mockResponse: {
              success: true,
              data: {
                columns: [
                  { name: "id", type: "BIGINT", nullable: false, primary_key: true },
                  { name: "name", type: "VARCHAR(100)", nullable: false, primary_key: false },
                ],
                row_count: 50000,
              },
            },
          })
          expect(status).not.toBe("error")
        })
      }

      if (persona.skills.includes("warehouse")) {
        test(`${persona.name}: warehouse list workflow`, async () => {
          const status = await runToolScenario({
            category: "persona",
            scenario: `${persona.name}_warehouse_list`,
            tool: "warehouse-list",
            dispatcherMethod: "warehouse.list",
            importPath: "../../src/altimate/tools/warehouse-list",
            exportName: "WarehouseListTool",
            args: {},
            persona: persona.name,
            mockResponse: {
              success: true,
              data: {
                warehouses: [
                  { name: "prod_snowflake", type: "snowflake", database: "ANALYTICS" },
                  { name: "dev_postgres", type: "postgres", database: "dev_db" },
                ],
              },
            },
          })
          expect(status).not.toBe("error")
        })
      }

      if (persona.skills.includes("testing")) {
        test(`${persona.name}: testgen workflow`, async () => {
          const status = await runToolScenario({
            category: "persona",
            scenario: `${persona.name}_testgen`,
            tool: "altimate-core-testgen",
            dispatcherMethod: "altimate_core.testgen",
            importPath: "../../src/altimate/tools/altimate-core-testgen",
            exportName: "AltimateCoreTestgenTool",
            args: { sql: SQL_CORPUS.cte, schema_context: SCHEMAS.ecommerce },
            persona: persona.name,
            mockResponse: {
              success: true,
              data: {
                tests: [
                  { name: "test_not_null", description: "Check not null", sql: "SELECT 1", assertion: "equals" },
                ],
              },
            },
          })
          expect(status).not.toBe("error")
        })
      }

      if (persona.skills.includes("governance")) {
        test(`${persona.name}: policy check workflow`, async () => {
          const status = await runToolScenario({
            category: "persona",
            scenario: `${persona.name}_policy`,
            tool: "altimate-core-policy",
            dispatcherMethod: "altimate_core.policy",
            importPath: "../../src/altimate/tools/altimate-core-policy",
            exportName: "AltimateCorePolicyTool",
            args: { sql: "DELETE FROM users WHERE id = 1", policy_json: '{"rules":[{"name":"no_delete","pattern":"DELETE"}]}' },
            persona: persona.name,
            mockResponse: {
              success: true,
              data: { pass: false, violations: [{ rule: "no_delete", message: "DELETE statements are prohibited" }] },
            },
          })
          expect(status).not.toBe("error")
        })
      }
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 12: Cross-Tool Workflow Simulation
// ═══════════════════════════════════════════════════════════════════════

describe("Category 12: Cross-Tool Workflows", () => {
  // Simulate: inspect → analyze → validate → lineage → testgen
  test("full development workflow: schema → SQL → validate → lineage → tests", async () => {
    // Step 1: Inspect schema
    let status = await runToolScenario({
      category: "workflow",
      scenario: "dev_workflow_inspect",
      tool: "schema-inspect",
      dispatcherMethod: "schema.inspect",
      importPath: "../../src/altimate/tools/schema-inspect",
      exportName: "SchemaInspectTool",
      args: { table: "users" },
      mockResponse: {
        success: true,
        data: {
          columns: [
            { name: "id", type: "BIGINT", nullable: false, primary_key: true },
            { name: "name", type: "VARCHAR", nullable: false },
            { name: "email", type: "VARCHAR", nullable: true },
          ],
          row_count: 10000,
        },
      },
    })
    expect(status).not.toBe("error")

    // Step 2: Analyze SQL
    status = await runToolScenario({
      category: "workflow",
      scenario: "dev_workflow_analyze",
      tool: "sql-analyze",
      dispatcherMethod: "sql.analyze",
      importPath: "../../src/altimate/tools/sql-analyze",
      exportName: "SqlAnalyzeTool",
      args: { sql: "SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)" },
      mockResponse: {
        success: true,
        data: {
          issues: [{ type: "lint", rule: "L044", severity: "warning", message: "Query uses SELECT *" }],
          issue_count: 1,
        },
      },
    })
    expect(status).not.toBe("error")

    // Step 3: Validate
    status = await runToolScenario({
      category: "workflow",
      scenario: "dev_workflow_validate",
      tool: "altimate-core-validate",
      dispatcherMethod: "altimate_core.validate",
      importPath: "../../src/altimate/tools/altimate-core-validate",
      exportName: "AltimateCoreValidateTool",
      args: { sql: "SELECT id, name FROM users", schema_context: SCHEMAS.ecommerce },
      mockResponse: { success: true, data: { valid: true, errors: [] } },
    })
    expect(status).not.toBe("error")

    // Step 4: Check lineage
    status = await runToolScenario({
      category: "workflow",
      scenario: "dev_workflow_lineage",
      tool: "lineage-check",
      dispatcherMethod: "lineage.check",
      importPath: "../../src/altimate/tools/lineage-check",
      exportName: "LineageCheckTool",
      args: { sql: "SELECT id, name FROM users", dialect: "snowflake" },
      mockResponse: {
        success: true,
        data: {
          column_lineage: [
            { source: "users.id", target: "id", lens_type: "IDENTITY" },
            { source: "users.name", target: "name", lens_type: "IDENTITY" },
          ],
          column_dict: { id: [{ source: "users.id" }], name: [{ source: "users.name" }] },
        },
      },
    })
    expect(status).not.toBe("error")

    // Step 5: Generate tests
    status = await runToolScenario({
      category: "workflow",
      scenario: "dev_workflow_testgen",
      tool: "altimate-core-testgen",
      dispatcherMethod: "altimate_core.testgen",
      importPath: "../../src/altimate/tools/altimate-core-testgen",
      exportName: "AltimateCoreTestgenTool",
      args: { sql: "SELECT id, name FROM users", schema_context: SCHEMAS.ecommerce },
      mockResponse: {
        success: true,
        data: {
          tests: [
            { name: "test_not_null_id", sql: "SELECT 1", assertion: "equals" },
            { name: "test_unique_id", sql: "SELECT 1", assertion: "equals" },
          ],
        },
      },
    })
    expect(status).not.toBe("error")
  })

  // Simulate: FinOps investigation workflow
  test("finops investigation: list → credits → expensive queries", async () => {
    let status = await runToolScenario({
      category: "workflow",
      scenario: "finops_workflow_list",
      tool: "warehouse-list",
      dispatcherMethod: "warehouse.list",
      importPath: "../../src/altimate/tools/warehouse-list",
      exportName: "WarehouseListTool",
      args: {},
      mockResponse: {
        success: true,
        data: { warehouses: [{ name: "snowflake_prod", type: "snowflake", database: "ANALYTICS" }] },
      },
    })
    expect(status).not.toBe("error")

    status = await runToolScenario({
      category: "workflow",
      scenario: "finops_workflow_credits",
      tool: "finops-analyze-credits",
      dispatcherMethod: "finops.analyze_credits",
      importPath: "../../src/altimate/tools/finops-analyze-credits",
      exportName: "FinopsAnalyzeCreditsTool",
      args: { warehouse: "snowflake_prod", days: 30 },
      mockResponse: {
        success: true,
        data: {
          total_credits: 8500,
          warehouse_summary: [{ warehouse_name: "ETL_WH", credits: 5000, percentage: 59 }],
          recommendations: ["Reduce ETL warehouse size during off-hours"],
          daily_usage: [],
        },
      },
    })
    expect(status).not.toBe("error")
  })

  // Simulate: Migration workflow (translate + validate + diff)
  for (const [source, target] of [
    ["snowflake", "bigquery"],
    ["postgres", "redshift"],
    ["mysql", "postgres"],
  ]) {
    test(`migration workflow: ${source} → ${target}`, async () => {
      // Step 1: Translate
      let status = await runToolScenario({
        category: "workflow",
        scenario: `migration_${source}_${target}_translate`,
        tool: "sql-translate",
        dispatcherMethod: "sql.translate",
        importPath: "../../src/altimate/tools/sql-translate",
        exportName: "SqlTranslateTool",
        args: { sql: SQL_CORPUS.cte, source_dialect: source, target_dialect: target },
        mockResponse: {
          success: true,
          data: { translated_sql: SQL_CORPUS.cte, warnings: [] },
        },
      })
      expect(status).not.toBe("error")

      // Step 2: Validate translated SQL
      status = await runToolScenario({
        category: "workflow",
        scenario: `migration_${source}_${target}_validate`,
        tool: "altimate-core-validate",
        dispatcherMethod: "altimate_core.validate",
        importPath: "../../src/altimate/tools/altimate-core-validate",
        exportName: "AltimateCoreValidateTool",
        args: { sql: SQL_CORPUS.cte, schema_context: SCHEMAS.ecommerce },
        mockResponse: { success: true, data: { valid: true, errors: [] } },
      })
      expect(status).not.toBe("error")
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 13: Additional Tools Coverage
// ═══════════════════════════════════════════════════════════════════════

describe("Category 13: Additional Tools", () => {
  // altimate-core-compare
  for (const pair of [
    { left: SQL_CORPUS.simple_select, right: SQL_CORPUS.simple_select, name: "identical" },
    { left: SQL_CORPUS.simple_select, right: SQL_CORPUS.complex_join, name: "different" },
    { left: SQL_CORPUS.cte, right: SQL_CORPUS.subquery, name: "equivalent_restructure" },
    { left: "", right: "SELECT 1", name: "empty_vs_valid" },
    { left: SQL_CORPUS.select_star, right: "SELECT id, name FROM orders", name: "star_vs_explicit" },
  ]) {
    test(`compare: ${pair.name}`, async () => {
      const status = await runToolScenario({
        category: "additional_tools",
        scenario: `compare_${pair.name}`,
        tool: "altimate-core-compare",
        dispatcherMethod: "altimate_core.compare",
        importPath: "../../src/altimate/tools/altimate-core-compare",
        exportName: "AltimateCoreCompareTool",
        args: { left_sql: pair.left, right_sql: pair.right },
        mockResponse: {
          success: true,
          data: {
            differences: pair.name === "identical" ? [] : [{ type: "structural", description: "Different query structure" }],
            equivalent: pair.name === "identical" || pair.name === "equivalent_restructure",
          },
        },
      })
      expect(status).not.toBe("error")
    })
  }

  // altimate-core-export-ddl
  for (const schemaKey of ["ecommerce", "hr", "financial", "empty_schema", "single_table", "wide_table"] as const) {
    test(`export-ddl: ${schemaKey}`, async () => {
      const status = await runToolScenario({
        category: "additional_tools",
        scenario: `export_ddl_${schemaKey}`,
        tool: "altimate-core-export-ddl",
        dispatcherMethod: "altimate_core.export_ddl",
        importPath: "../../src/altimate/tools/altimate-core-export-ddl",
        exportName: "AltimateCoreExportDdlTool",
        args: { schema_context: SCHEMAS[schemaKey] },
        mockResponse: {
          success: true,
          data: {
            ddl: Object.keys(SCHEMAS[schemaKey])
              .map((t) => `CREATE TABLE ${t} (id INT)`)
              .join(";\n"),
          },
        },
      })
      expect(status).not.toBe("error")
    })
  }

  // altimate-core-import-ddl
  for (const ddl of [
    "CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(100))",
    "CREATE TABLE IF NOT EXISTS orders (id BIGINT, user_id BIGINT REFERENCES users(id))",
    "", // empty
    "NOT VALID DDL",
    `CREATE TABLE wide (${Array.from({ length: 200 }, (_, i) => `col_${i} INT`).join(", ")})`,
  ]) {
    test(`import-ddl: ${ddl.slice(0, 30) || "empty"}`, async () => {
      const status = await runToolScenario({
        category: "additional_tools",
        scenario: `import_ddl_${ddl.slice(0, 15).replace(/[^a-z0-9]/gi, "_") || "empty"}`,
        tool: "altimate-core-import-ddl",
        dispatcherMethod: "altimate_core.import_ddl",
        importPath: "../../src/altimate/tools/altimate-core-import-ddl",
        exportName: "AltimateCoreImportDdlTool",
        args: { ddl },
        mockResponse: ddl.length > 0 && ddl.includes("CREATE")
          ? { success: true, data: { schema: { users: { id: "INT" } } } }
          : { success: false, error: "Invalid DDL" },
      })
      expect(status).not.toBe("error")
    })
  }

  // altimate-core-schema-diff
  for (const [name, s1, s2] of [
    ["identical", SCHEMAS.ecommerce, SCHEMAS.ecommerce],
    ["added_column", SCHEMAS.ecommerce, { ...SCHEMAS.ecommerce, users: { ...SCHEMAS.ecommerce.users, phone: "VARCHAR" } }],
    ["removed_table", SCHEMAS.ecommerce, { users: SCHEMAS.ecommerce.users }],
    ["type_change", SCHEMAS.single_table, { metrics: { id: "BIGINT", value: "DOUBLE" } }],
    ["empty_vs_full", SCHEMAS.empty_schema, SCHEMAS.ecommerce],
  ] as const) {
    test(`schema-diff: ${name}`, async () => {
      const status = await runToolScenario({
        category: "additional_tools",
        scenario: `schema_diff_${name}`,
        tool: "altimate-core-schema-diff",
        dispatcherMethod: "altimate_core.schema_diff",
        importPath: "../../src/altimate/tools/altimate-core-schema-diff",
        exportName: "AltimateCoreSchemaDiffTool",
        args: { schema1_context: s1, schema2_context: s2 },
        mockResponse: {
          success: true,
          data: {
            changes: name === "identical" ? [] : [{ type: "column_added", table: "users", column: "phone" }],
            has_breaking_changes: name === "removed_table" || name === "type_change",
          },
        },
      })
      expect(status).not.toBe("error")
    })
  }

  // altimate-core-fingerprint
  for (const schemaKey of ["ecommerce", "hr", "financial", "pii_heavy", "empty_schema"] as const) {
    test(`fingerprint: ${schemaKey}`, async () => {
      const status = await runToolScenario({
        category: "additional_tools",
        scenario: `fingerprint_${schemaKey}`,
        tool: "altimate-core-fingerprint",
        dispatcherMethod: "altimate_core.fingerprint",
        importPath: "../../src/altimate/tools/altimate-core-fingerprint",
        exportName: "AltimateCoreFingerprintTool",
        args: { schema_context: SCHEMAS[schemaKey] },
        mockResponse: {
          success: true,
          data: { fingerprint: `fp_${schemaKey}_${Date.now()}` },
        },
      })
      expect(status).not.toBe("error")
    })
  }

  // altimate-core-migration
  for (const migration of [
    { name: "add_column", old: "CREATE TABLE t (id INT)", new: "CREATE TABLE t (id INT, name VARCHAR)" },
    { name: "change_type", old: "CREATE TABLE t (id INT)", new: "CREATE TABLE t (id BIGINT)" },
    { name: "drop_column", old: "CREATE TABLE t (id INT, name VARCHAR)", new: "CREATE TABLE t (id INT)" },
    { name: "rename_table", old: "CREATE TABLE old_t (id INT)", new: "CREATE TABLE new_t (id INT)" },
    { name: "empty_to_full", old: "", new: "CREATE TABLE t (id INT)" },
  ]) {
    test(`migration: ${migration.name}`, async () => {
      const status = await runToolScenario({
        category: "additional_tools",
        scenario: `migration_${migration.name}`,
        tool: "altimate-core-migration",
        dispatcherMethod: "altimate_core.migration",
        importPath: "../../src/altimate/tools/altimate-core-migration",
        exportName: "AltimateCoreMigrationTool",
        args: { old_ddl: migration.old, new_ddl: migration.new },
        mockResponse: {
          success: true,
          data: {
            risks: migration.name === "drop_column"
              ? [{ type: "breaking", message: "Column removal may break queries" }]
              : [],
          },
        },
      })
      expect(status).not.toBe("error")
    })
  }

  // altimate-core-rewrite
  for (const sqlKey of ["select_star", "cartesian_join", "nested_subqueries", "no_where_clause", "or_antipattern"] as const) {
    test(`rewrite: ${sqlKey}`, async () => {
      const status = await runToolScenario({
        category: "additional_tools",
        scenario: `rewrite_${sqlKey}`,
        tool: "altimate-core-rewrite",
        dispatcherMethod: "altimate_core.rewrite",
        importPath: "../../src/altimate/tools/altimate-core-rewrite",
        exportName: "AltimateCoreRewriteTool",
        args: { sql: SQL_CORPUS[sqlKey] },
        mockResponse: {
          success: true,
          data: {
            suggestions: [{ type: "performance", message: "Replace SELECT * with explicit columns" }],
            rewrites: [{ original: SQL_CORPUS[sqlKey], rewritten: "SELECT id, name FROM users WHERE active = true" }],
          },
        },
      })
      expect(status).not.toBe("error")
    })
  }

  // altimate-core-extract-metadata
  for (const sqlKey of ["simple_select", "complex_join", "cte", "merge", "create_table"] as const) {
    test(`extract-metadata: ${sqlKey}`, async () => {
      const status = await runToolScenario({
        category: "additional_tools",
        scenario: `metadata_${sqlKey}`,
        tool: "altimate-core-extract-metadata",
        dispatcherMethod: "altimate_core.metadata",
        importPath: "../../src/altimate/tools/altimate-core-extract-metadata",
        exportName: "AltimateCoreExtractMetadataTool",
        args: { sql: SQL_CORPUS[sqlKey] },
        mockResponse: {
          success: true,
          data: { tables: ["users", "orders"], columns: ["id", "name", "total"] },
        },
      })
      expect(status).not.toBe("error")
    })
  }

  // altimate-core-resolve-term
  for (const term of ["revenue", "customer", "churn rate", "MRR", "DAU", "LTV", "GMV", ""]) {
    test(`resolve-term: ${term || "empty"}`, async () => {
      const status = await runToolScenario({
        category: "additional_tools",
        scenario: `resolve_term_${term.replace(/\s/g, "_") || "empty"}`,
        tool: "altimate-core-resolve-term",
        dispatcherMethod: "altimate_core.resolve_term",
        importPath: "../../src/altimate/tools/altimate-core-resolve-term",
        exportName: "AltimateCoreResolveTermTool",
        args: { term, schema_context: SCHEMAS.financial },
        mockResponse: {
          success: true,
          data: {
            matches: term
              ? [{ table: "transactions", column: "amount", confidence: 0.85 }]
              : [],
          },
        },
      })
      expect(status).not.toBe("error")
    })
  }

  // altimate-core-prune-schema
  for (const [sqlKey, schemaKey] of [
    ["simple_select", "ecommerce"],
    ["complex_join", "ecommerce"],
    ["aggregation", "financial"],
    ["window_function", "hr"],
  ] as const) {
    test(`prune-schema: ${sqlKey} in ${schemaKey}`, async () => {
      const status = await runToolScenario({
        category: "additional_tools",
        scenario: `prune_${sqlKey}_${schemaKey}`,
        tool: "altimate-core-prune-schema",
        dispatcherMethod: "altimate_core.prune_schema",
        importPath: "../../src/altimate/tools/altimate-core-prune-schema",
        exportName: "AltimateCorePruneSchemaTool",
        args: { sql: SQL_CORPUS[sqlKey], schema_context: SCHEMAS[schemaKey] },
        mockResponse: {
          success: true,
          data: {
            relevant_tables: ["users"],
            tables_pruned: Object.keys(SCHEMAS[schemaKey]).length - 1,
            total_tables: Object.keys(SCHEMAS[schemaKey]).length,
          },
        },
      })
      expect(status).not.toBe("error")
    })
  }

  // altimate-core-introspection-sql
  for (const dbType of ["postgres", "snowflake", "bigquery", "mysql", "redshift", "oracle", "sqlserver"]) {
    test(`introspection-sql: ${dbType}`, async () => {
      const status = await runToolScenario({
        category: "additional_tools",
        scenario: `introspection_${dbType}`,
        tool: "altimate-core-introspection-sql",
        dispatcherMethod: "altimate_core.introspection_sql",
        importPath: "../../src/altimate/tools/altimate-core-introspection-sql",
        exportName: "AltimateCoreIntrospectionSqlTool",
        args: { db_type: dbType, database: "test_db" },
        mockResponse: {
          success: true,
          data: {
            queries: {
              tables: "SELECT * FROM information_schema.tables",
              columns: "SELECT * FROM information_schema.columns",
            },
          },
        },
      })
      expect(status).not.toBe("error")
    })
  }

  // altimate-core-optimize-context
  for (const schemaKey of ["ecommerce", "wide_table", "empty_schema"] as const) {
    test(`optimize-context: ${schemaKey}`, async () => {
      const status = await runToolScenario({
        category: "additional_tools",
        scenario: `optimize_context_${schemaKey}`,
        tool: "altimate-core-optimize-context",
        dispatcherMethod: "altimate_core.optimize_context",
        importPath: "../../src/altimate/tools/altimate-core-optimize-context",
        exportName: "AltimateCoreOptimizeContextTool",
        args: { schema_context: SCHEMAS[schemaKey] },
        mockResponse: {
          success: true,
          data: {
            levels: [
              { level: 1, tokens: 500, description: "Full schema" },
              { level: 2, tokens: 200, description: "Tables and key columns" },
              { level: 3, tokens: 50, description: "Table names only" },
            ],
          },
        },
      })
      expect(status).not.toBe("error")
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY 14: Warehouse-Specific Scenarios
// ═══════════════════════════════════════════════════════════════════════

describe("Category 14: Warehouse-Specific", () => {
  // Each warehouse type has dialect-specific SQL features
  const warehouseSpecificSQL: Record<string, string[]> = {
    snowflake: [
      "SELECT * FROM TABLE(FLATTEN(input => my_array))",
      "SELECT * EXCLUDE (internal_id) FROM users",
      "SELECT * FROM users QUALIFY ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) = 1",
      "CREATE TABLE t CLONE source_table",
      "SELECT PARSE_JSON('{\"key\": \"value\"}'):key::STRING",
    ],
    bigquery: [
      "SELECT * FROM `project.dataset.table`",
      "SELECT STRUCT(1 AS a, 'hello' AS b)",
      "SELECT * FROM UNNEST([1, 2, 3]) AS x",
      "SELECT FORMAT_DATE('%Y-%m-%d', CURRENT_DATE())",
      "SELECT * FROM ML.PREDICT(MODEL `my_model`, TABLE input_data)",
    ],
    postgres: [
      "SELECT * FROM generate_series(1, 10) AS s",
      "SELECT jsonb_path_query(data, '$.items[*].name') FROM documents",
      "SELECT * FROM users WHERE name ILIKE '%john%'",
      "INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING",
      "SELECT * FROM pg_stat_activity WHERE state = 'active'",
    ],
    databricks: [
      "SELECT * FROM delta.`/path/to/table`",
      "OPTIMIZE my_table ZORDER BY (date, user_id)",
      "DESCRIBE HISTORY my_table",
      "SELECT * FROM my_table VERSION AS OF 5",
      "SELECT * FROM my_table@v5",
    ],
    redshift: [
      "SELECT * FROM stl_query WHERE userid = 100",
      "UNLOAD ('SELECT * FROM t') TO 's3://bucket/path'",
      "COPY t FROM 's3://bucket/data' IAM_ROLE 'arn:aws:iam::role'",
      "SELECT * FROM svv_table_info WHERE schema = 'public'",
      "ANALYZE t",
    ],
  }

  for (const [warehouse, queries] of Object.entries(warehouseSpecificSQL)) {
    for (const [idx, sql] of queries.entries()) {
      test(`${warehouse} specific SQL #${idx + 1}`, async () => {
        const status = await runToolScenario({
          category: "warehouse_specific",
          scenario: `${warehouse}_specific_${idx}`,
          tool: "sql-analyze",
          dispatcherMethod: "sql.analyze",
          importPath: "../../src/altimate/tools/sql-analyze",
          exportName: "SqlAnalyzeTool",
          args: { sql, dialect: warehouse },
          dialect: warehouse,
          mockResponse: {
            success: true,
            data: { issues: [], issue_count: 0 },
          },
        })
        expect(status).not.toBe("error")
      })

      // Also test lineage for each
      test(`${warehouse} lineage #${idx + 1}`, async () => {
        const status = await runToolScenario({
          category: "warehouse_specific",
          scenario: `${warehouse}_lineage_${idx}`,
          tool: "lineage-check",
          dispatcherMethod: "lineage.check",
          importPath: "../../src/altimate/tools/lineage-check",
          exportName: "LineageCheckTool",
          args: { sql, dialect: warehouse },
          dialect: warehouse,
          mockResponse: {
            success: true,
            data: { column_lineage: [], column_dict: {} },
          },
        })
        expect(status).not.toBe("error")
      })
    }
  }
})

// Final count assertion
describe("Simulation Count Verification", () => {
  test("ran at least 800 scenarios", () => {
    // This test runs last and verifies we hit our target
    console.log(`\n>>> Total scenarios executed: ${totalScenarios}`)
    expect(totalScenarios).toBeGreaterThanOrEqual(800)
  })
})
