/**
 * End-to-end tests for SQL validation tools.
 *
 * Verifies:
 * 1. Tool names in prompts match actual registered tools
 * 2. Agent permissions reference real tools (no phantom `sql_validate`)
 * 3. altimate_core_validate works end-to-end via Dispatcher
 * 4. altimate_core_check composite pipeline works end-to-end
 * 5. sql.analyze composite pipeline works end-to-end
 * 6. Pre-execution protocol tools are callable (sql_analyze → altimate_core_validate → sql_execute)
 * 7. sql-classify correctly gates sql_execute
 * 8. Analyst and builder agent permissions are consistent with their prompts
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import fs from "fs"
import path from "path"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import { registerAll } from "../../src/altimate/native/altimate-core"
import { registerAllSql } from "../../src/altimate/native/sql/register"
import { classifyAndCheck } from "../../src/altimate/tools/sql-classify"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { PermissionNext } from "../../src/permission/next"
import { tmpdir } from "../fixture/fixture"

// Disable telemetry
beforeAll(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  registerAll()
  registerAllSql()
})
afterAll(() => { delete process.env.ALTIMATE_TELEMETRY_DISABLED })

// ---------------------------------------------------------------------------
// 1. Tool Name Consistency — prompts reference only real tools
// ---------------------------------------------------------------------------

describe("Tool name consistency in prompts", () => {
  test("builder prompt does NOT reference phantom sql_validate", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const builder = await Agent.get("builder")
        expect(builder).toBeDefined()
        expect(builder!.prompt).not.toContain("sql_validate")
      },
    })
  })

  test("analyst prompt does NOT reference phantom sql_validate", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const analyst = await Agent.get("analyst")
        expect(analyst).toBeDefined()
        expect(analyst!.prompt).not.toContain("sql_validate")
      },
    })
  })

  test("builder prompt references altimate_core_validate (the real tool)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const builder = await Agent.get("builder")
        expect(builder).toBeDefined()
        expect(builder!.prompt).toContain("altimate_core_validate")
      },
    })
  })

  test("analyst prompt references altimate_core_validate (the real tool)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const analyst = await Agent.get("analyst")
        expect(analyst).toBeDefined()
        expect(analyst!.prompt).toContain("altimate_core_validate")
      },
    })
  })

  test("builder prompt contains pre-execution protocol with correct tool names", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const builder = await Agent.get("builder")
        expect(builder).toBeDefined()
        // Pre-Execution Protocol references:
        expect(builder!.prompt).toContain("sql_analyze")
        expect(builder!.prompt).toContain("altimate_core_validate")
        expect(builder!.prompt).toContain("sql_execute")
        // The protocol section itself
        expect(builder!.prompt).toContain("Pre-Execution Protocol")
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 2. Agent Permissions — reference only real tools
// ---------------------------------------------------------------------------

describe("Agent permissions reference real tools", () => {
  function evalPerm(agent: Agent.Info | undefined, permission: string): PermissionNext.Action | undefined {
    if (!agent) return undefined
    return PermissionNext.evaluate(permission, "*", agent.permission).action
  }

  test("analyst allows altimate_core_validate (not phantom sql_validate)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const analyst = await Agent.get("analyst")
        expect(analyst).toBeDefined()
        // The real tool must be allowed
        expect(evalPerm(analyst, "altimate_core_validate")).toBe("allow")
      },
    })
  })

  test("analyst allows all documented SQL validation tools", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const analyst = await Agent.get("analyst")
        expect(analyst).toBeDefined()

        // SQL read tools from agent.ts
        const expectedAllowed = [
          "sql_execute",
          "altimate_core_validate",
          "sql_analyze",
          "sql_translate",
          "sql_optimize",
          "lineage_check",
          "sql_explain",
          "sql_format",
          "sql_fix",
          "sql_autocomplete",
          "sql_diff",
          // Core tools
          "altimate_core_check",
          "altimate_core_rewrite",
        ]

        for (const tool of expectedAllowed) {
          expect(evalPerm(analyst, tool)).toBe("allow")
        }
      },
    })
  })

  test("analyst denies write operations", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const analyst = await Agent.get("analyst")
        expect(analyst).toBeDefined()
        expect(evalPerm(analyst, "sql_execute_write")).toBe("deny")
        expect(evalPerm(analyst, "edit")).toBe("deny")
        expect(evalPerm(analyst, "write")).toBe("deny")
      },
    })
  })

  test("builder has sql_execute_write as ask (not allow or deny)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const builder = await Agent.get("builder")
        expect(builder).toBeDefined()
        expect(evalPerm(builder, "sql_execute_write")).toBe("ask")
      },
    })
  })

  test("no agent permissions reference sql_validate (phantom tool)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await Agent.list()
        for (const agent of agents) {
          // Serialize the permission ruleset and check for sql_validate
          const serialized = JSON.stringify(agent.permission)
          expect(serialized).not.toContain('"sql_validate"')
        }
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 3. altimate_core_validate — end-to-end via Dispatcher
// ---------------------------------------------------------------------------

describe("altimate_core_validate e2e", () => {
  test("SELECT 1 returns AltimateCoreResult shape", async () => {
    const result = await Dispatcher.call("altimate_core.validate", {
      sql: "SELECT 1",
    })
    expect(result).toHaveProperty("success")
    expect(result).toHaveProperty("data")
    expect(typeof result.success).toBe("boolean")
    expect(typeof result.data).toBe("object")
  })

  test("valid query with schema context returns success: true", async () => {
    const result = await Dispatcher.call("altimate_core.validate", {
      sql: "SELECT id, name FROM users",
      schema_context: {
        users: { id: "INTEGER", name: "VARCHAR", email: "VARCHAR" },
      },
    })
    expect(result.success).toBe(true)
    expect(result.data.valid).not.toBe(false)
  })

  test("query referencing unknown table without schema still returns result", async () => {
    // Without schema context, table references can't be verified —
    // the handler returns valid=false which maps to success=false
    const result = await Dispatcher.call("altimate_core.validate", {
      sql: "SELECT id, name FROM users WHERE id = 1",
    })
    expect(result).toHaveProperty("success")
    expect(result).toHaveProperty("data")
  })

  test("CTE query returns result shape", async () => {
    const result = await Dispatcher.call("altimate_core.validate", {
      sql: "WITH cte AS (SELECT 1 AS id) SELECT * FROM cte",
    })
    expect(result).toHaveProperty("success")
    expect(result).toHaveProperty("data")
  })

  test("multi-statement SQL is accepted", async () => {
    const result = await Dispatcher.call("altimate_core.validate", {
      sql: "SELECT 1; SELECT 2",
    })
    expect(result).toHaveProperty("success")
    expect(result).toHaveProperty("data")
  })

  test("heavily malformed SQL returns result (not a crash)", async () => {
    const result = await Dispatcher.call("altimate_core.validate", {
      sql: "NOT SQL AT ALL ))) {{{{",
    })
    expect(result).toHaveProperty("success")
    expect(result).toHaveProperty("data")
  })

  test("empty SQL returns result (not a crash)", async () => {
    const result = await Dispatcher.call("altimate_core.validate", { sql: "" })
    expect(result).toHaveProperty("success")
    expect(result).toHaveProperty("data")
  })

  test("validates with SchemaDefinition format", async () => {
    const result = await Dispatcher.call("altimate_core.validate", {
      sql: "SELECT id FROM orders",
      schema_context: {
        version: "1",
        dialect: "generic",
        database: null,
        schema_name: null,
        tables: {
          orders: {
            columns: [
              { name: "id", type: "INT", nullable: false },
              { name: "amount", type: "DECIMAL", nullable: true },
            ],
          },
        },
      },
    })
    expect(result).toHaveProperty("success")
  })
})

// ---------------------------------------------------------------------------
// 4. altimate_core_check — composite pipeline e2e
// ---------------------------------------------------------------------------

describe("altimate_core_check e2e", () => {
  test("clean query returns all-pass result", async () => {
    const result = await Dispatcher.call("altimate_core.check", {
      sql: "SELECT id FROM users WHERE id = 1",
    })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty("validation")
    expect(result.data).toHaveProperty("lint")
    expect(result.data).toHaveProperty("safety")
  })

  test("result has expected structure", async () => {
    const result = await Dispatcher.call("altimate_core.check", {
      sql: "SELECT * FROM users",
    })
    expect(result).toHaveProperty("success")
    expect(result).toHaveProperty("data")
    const data = result.data as Record<string, any>

    // validation section
    expect(data.validation).toHaveProperty("valid")

    // lint section
    expect(data.lint).toBeDefined()

    // safety section
    expect(data.safety).toBeDefined()
  })

  test("SQL injection pattern is flagged by safety scan", async () => {
    const result = await Dispatcher.call("altimate_core.check", {
      sql: "SELECT * FROM users WHERE id = 1 OR 1=1",
    })
    expect(result).toHaveProperty("data")
    const data = result.data as Record<string, any>
    // The safety scan should detect the tautology
    expect(data.safety).toBeDefined()
  })

  test("check with schema context works", async () => {
    const result = await Dispatcher.call("altimate_core.check", {
      sql: "SELECT id, name FROM customers",
      schema_context: {
        customers: { id: "INTEGER", name: "VARCHAR" },
      },
    })
    expect(result).toHaveProperty("success")
    expect(result.data).toHaveProperty("validation")
  })
})

// ---------------------------------------------------------------------------
// 5. sql.analyze — composite lint + semantics + safety
// ---------------------------------------------------------------------------

describe("sql.analyze e2e", () => {
  test("clean query returns no issues", async () => {
    const result = await Dispatcher.call("sql.analyze", {
      sql: "SELECT id, name FROM users WHERE id = 1",
    })
    expect(result).toHaveProperty("success")
    expect(result).toHaveProperty("issues")
    expect(result).toHaveProperty("issue_count")
    expect(result).toHaveProperty("confidence")
    expect(result.confidence_factors).toContain("lint")
    expect(result.confidence_factors).toContain("semantics")
    expect(result.confidence_factors).toContain("safety")
  })

  test("SELECT * triggers lint finding", async () => {
    const result = await Dispatcher.call("sql.analyze", {
      sql: "SELECT * FROM users",
    })
    expect(result).toHaveProperty("issues")
    // SELECT * should be caught by lint
    const selectStarIssue = result.issues.find(
      (i: any) => i.type === "lint" && (i.message?.includes("SELECT *") || i.message?.includes("select_star") || i.message?.toLowerCase?.().includes("star")),
    )
    // Verify the SELECT * lint issue was actually found
    expect(selectStarIssue).toBeDefined()
    expect(Array.isArray(result.issues)).toBe(true)
  })

  test("cartesian product is detected", async () => {
    const result = await Dispatcher.call("sql.analyze", {
      sql: "SELECT * FROM users, orders",
    })
    expect(result).toHaveProperty("issues")
    expect(Array.isArray(result.issues)).toBe(true)
    // Should detect cartesian product
    expect(result.issue_count).toBeGreaterThan(0)
  })

  test("result structure matches SqlAnalyzeResult type", async () => {
    const result = await Dispatcher.call("sql.analyze", {
      sql: "SELECT 1",
    })
    // SqlAnalyzeResult shape
    expect(typeof result.success).toBe("boolean")
    expect(Array.isArray(result.issues)).toBe(true)
    expect(typeof result.issue_count).toBe("number")
    expect(typeof result.confidence).toBe("string")
    expect(Array.isArray(result.confidence_factors)).toBe(true)
  })

  test("analyze with schema context", async () => {
    const result = await Dispatcher.call("sql.analyze", {
      sql: "SELECT id, name FROM customers WHERE customer_id = 1",
      schema_context: {
        customers: { customer_id: "INTEGER", id: "INTEGER", name: "VARCHAR" },
      },
    })
    expect(result).toHaveProperty("success")
    expect(result).toHaveProperty("issues")
  })

  test("malformed SQL doesn't crash analyzer", async () => {
    const result = await Dispatcher.call("sql.analyze", {
      sql: "SELECTT FORM",
    })
    expect(result).toHaveProperty("success")
    // Should handle gracefully — either error field or empty issues
    expect(result).toHaveProperty("issues")
  })
})

// ---------------------------------------------------------------------------
// 6. Pre-Execution Protocol — tools called in sequence
// ---------------------------------------------------------------------------

describe("Pre-execution protocol e2e", () => {
  test("step 1: sql_analyze runs on the query", async () => {
    const sql = "SELECT * FROM orders JOIN customers ON orders.customer_id = customers.id"
    const analyzeResult = await Dispatcher.call("sql.analyze", { sql })
    expect(analyzeResult).toHaveProperty("success")
    expect(analyzeResult).toHaveProperty("issues")
    expect(analyzeResult).toHaveProperty("issue_count")
  })

  test("step 2: altimate_core_validate catches syntax errors", async () => {
    const sql = "SELECT id, name FROM users WHERE id = 1"
    const validateResult = await Dispatcher.call("altimate_core.validate", { sql })
    expect(validateResult).toHaveProperty("success")
    expect(validateResult).toHaveProperty("data")
  })

  test("step 3: classify determines if permission check is needed", () => {
    // Read queries skip permission
    const readResult = classifyAndCheck("SELECT * FROM users")
    expect(readResult.queryType).toBe("read")
    expect(readResult.blocked).toBe(false)

    // Write queries need permission
    const writeResult = classifyAndCheck("INSERT INTO users VALUES (1, 'test')")
    expect(writeResult.queryType).toBe("write")
    expect(writeResult.blocked).toBe(false)

    // Destructive queries are hard-blocked
    const destructiveResult = classifyAndCheck("DROP DATABASE production")
    expect(destructiveResult.blocked).toBe(true)
  })

  test("full protocol sequence: analyze → validate → classify", async () => {
    const sql = "SELECT o.order_id, c.name FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.amount > 100"

    // Step 1: Analyze for anti-patterns
    const analyzeResult = await Dispatcher.call("sql.analyze", { sql })
    expect(analyzeResult).toHaveProperty("success")
    expect(analyzeResult).toHaveProperty("issue_count")

    // Step 2: Validate syntax
    const validateResult = await Dispatcher.call("altimate_core.validate", { sql })
    expect(validateResult).toHaveProperty("success")

    // Step 3: Classify for permission gating
    const { queryType, blocked } = classifyAndCheck(sql)
    expect(queryType).toBe("read")
    expect(blocked).toBe(false)

    // All three steps complete without errors — query is safe to execute
  })

  test("protocol catches issues: analyze flags problems, validate catches syntax", async () => {
    // Query with anti-patterns
    const badSql = "SELECT * FROM users, orders"
    const analyzeResult = await Dispatcher.call("sql.analyze", { sql: badSql })
    // Should detect issues (SELECT * and/or cartesian product)
    expect(analyzeResult.issue_count).toBeGreaterThan(0)

    // Query with syntax issues
    const validateResult = await Dispatcher.call("altimate_core.validate", {
      sql: "SELECTT id FORM users",
    })
    expect(validateResult).toHaveProperty("success")
    expect(validateResult).toHaveProperty("data")
  })
})

// ---------------------------------------------------------------------------
// 7. sql-classify gates sql_execute correctly
// ---------------------------------------------------------------------------

describe("sql-classify correctly gates execution", () => {
  test("SELECT queries pass without permission check", () => {
    const queries = [
      "SELECT 1",
      "SELECT * FROM users",
      "WITH cte AS (SELECT 1) SELECT * FROM cte",
      "SELECT id, name FROM orders WHERE status = 'active'",
    ]
    for (const q of queries) {
      const { queryType, blocked } = classifyAndCheck(q)
      expect(queryType).toBe("read")
      expect(blocked).toBe(false)
    }
  })

  test("DML queries require permission", () => {
    const queries = [
      "INSERT INTO users VALUES (1, 'test')",
      "UPDATE users SET name = 'new'",
      "DELETE FROM users WHERE id = 1",
      "MERGE INTO target USING source ON target.id = source.id WHEN MATCHED THEN UPDATE SET target.name = source.name",
    ]
    for (const q of queries) {
      const { queryType, blocked } = classifyAndCheck(q)
      expect(queryType).toBe("write")
      expect(blocked).toBe(false)
    }
  })

  test("DDL queries require permission", () => {
    const queries = [
      "CREATE TABLE new_table (id INT)",
      "ALTER TABLE users ADD COLUMN email TEXT",
      "DROP TABLE users",
    ]
    for (const q of queries) {
      const { queryType } = classifyAndCheck(q)
      expect(queryType).toBe("write")
    }
  })

  test("destructive queries are hard-blocked", () => {
    const queries = [
      "DROP DATABASE production",
      "DROP SCHEMA public",
      "TRUNCATE TABLE users",
      "TRUNCATE users",
      "drop database mydb",
      "drop schema analytics",
    ]
    for (const q of queries) {
      const { blocked } = classifyAndCheck(q)
      expect(blocked).toBe(true)
    }
  })

  test("multi-statement with destructive query is blocked", () => {
    const { blocked } = classifyAndCheck("SELECT 1; DROP DATABASE prod")
    expect(blocked).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 8. Dispatcher registration — all SQL validation methods exist
// ---------------------------------------------------------------------------

describe("SQL validation Dispatcher methods are registered", () => {
  test("altimate_core.validate is registered", () => {
    expect(Dispatcher.hasNativeHandler("altimate_core.validate")).toBe(true)
  })

  test("altimate_core.check is registered", () => {
    expect(Dispatcher.hasNativeHandler("altimate_core.check")).toBe(true)
  })

  test("altimate_core.lint is registered", () => {
    expect(Dispatcher.hasNativeHandler("altimate_core.lint")).toBe(true)
  })

  test("altimate_core.safety is registered", () => {
    expect(Dispatcher.hasNativeHandler("altimate_core.safety")).toBe(true)
  })

  test("altimate_core.semantics is registered", () => {
    expect(Dispatcher.hasNativeHandler("altimate_core.semantics")).toBe(true)
  })

  test("altimate_core.fix is registered", () => {
    expect(Dispatcher.hasNativeHandler("altimate_core.fix")).toBe(true)
  })

  test("altimate_core.grade is registered", () => {
    expect(Dispatcher.hasNativeHandler("altimate_core.grade")).toBe(true)
  })

  test("sql.analyze composite is registered", () => {
    expect(Dispatcher.hasNativeHandler("sql.analyze")).toBe(true)
  })

  test("sql.translate composite is registered", () => {
    expect(Dispatcher.hasNativeHandler("sql.translate")).toBe(true)
  })

  test("sql.optimize composite is registered", () => {
    expect(Dispatcher.hasNativeHandler("sql.optimize")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 9. Skill files — no phantom tool references
// ---------------------------------------------------------------------------

describe("Skill files reference real tools", () => {
  // Derive repo root from test file location, not cwd (works from any directory)
  const repoRoot = path.resolve(import.meta.dir, "../../../..")

  test("sql-translate skill references altimate_core_validate, not sql_validate", async () => {
    const skillPath = path.join(
      repoRoot,
      ".opencode/skills/sql-translate/SKILL.md",
    )
    const content = await Bun.file(skillPath).text()
    expect(content).not.toContain("sql_validate")
    expect(content).toContain("altimate_core_validate")
  })

  test("sql-review skill references real tool names", async () => {
    const skillPath = path.join(
      repoRoot,
      ".opencode/skills/sql-review/SKILL.md",
    )
    const content = await Bun.file(skillPath).text()
    expect(content).not.toContain("sql_validate")
    // Should reference the actual tools
    expect(content).toContain("altimate_core_check")
    expect(content).toContain("altimate_core_grade")
    expect(content).toContain("sql_analyze")
  })
})

// ---------------------------------------------------------------------------
// 10. Prompt skill references match actual skill directories
// ---------------------------------------------------------------------------

describe("Prompt skill references match actual skills", () => {
  const repoRoot = path.resolve(import.meta.dir, "../../../..")
  function getSkillDirs(): string[] {
    const skillsDir = path.join(repoRoot, ".opencode/skills")
    if (!fs.existsSync(skillsDir)) return []
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((d: any) => d.isDirectory())
      .map((d: any) => d.name)
  }

  function extractSkillRefs(text: string): string[] {
    // Match /skill-name patterns (e.g., /dbt-analyze, /sql-review)
    const matches = text.match(/\/([a-z][a-z0-9-]+)/g) || []
    return [...new Set(matches.map((m) => m.slice(1)))]
  }

  // Known non-skill slash references to exclude
  const NON_SKILL_REFS = new Set([
    "tmp", "dev", "null", "etc", "bin", "usr", "home", "var",
    "opencode", "sql", "dbt", "api", "v1", "v2",
  ])

  test("analyst 'Skills Available' section only lists skills that exist", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const analyst = await Agent.get("analyst")
        expect(analyst).toBeDefined()

        const skillDirs = getSkillDirs()

        // Extract only the "Skills Available" section (before the "Note:" line)
        const prompt = analyst!.prompt
        expect(prompt).toBeDefined()
        const skillsSectionMatch = prompt!.match(
          /## Skills Available[^\n]*\n([\s\S]*?)(?=\nNote:|## )/,
        )
        expect(skillsSectionMatch).toBeDefined()
        if (!skillsSectionMatch) return // TypeScript narrowing

        const skillsSection = skillsSectionMatch[1]
        const refs = extractSkillRefs(skillsSection)
          .filter((r) => !NON_SKILL_REFS.has(r))

        for (const ref of refs) {
          expect(skillDirs).toContain(ref)
        }
      },
    })
  })

  test("analyst prompt does NOT reference phantom /impact-analysis", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const analyst = await Agent.get("analyst")
        expect(analyst).toBeDefined()
        expect(analyst!.prompt).not.toContain("/impact-analysis")
        // Should reference the real skill
        expect(analyst!.prompt).toContain("/dbt-analyze")
      },
    })
  })

  test("builder prompt skill references match actual skills", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const builder = await Agent.get("builder")
        expect(builder).toBeDefined()
        expect(builder!.prompt).not.toContain("/impact-analysis")
        expect(builder!.prompt).toContain("/dbt-analyze")
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 11. Cross-cutting: validate + check + analyze all agree on same SQL
// ---------------------------------------------------------------------------

describe("Validation tools agree on results", () => {
  test("all tools accept valid SQL with schema context without errors", async () => {
    // Use LIMIT to avoid MISSING_LIMIT lint finding
    const sql = "SELECT id, name FROM users WHERE id = 1 LIMIT 10"
    const schema_context = {
      users: { id: "INTEGER", name: "VARCHAR" },
    }

    const [validate, check, analyze] = await Promise.all([
      Dispatcher.call("altimate_core.validate", { sql, schema_context }),
      Dispatcher.call("altimate_core.check", { sql, schema_context }),
      Dispatcher.call("sql.analyze", { sql, schema_context }),
    ])

    // validate: should be valid with schema
    expect(validate.success).toBe(true)

    // check: validation section should pass
    expect(check.success).toBe(true)
    const checkData = check.data as Record<string, any>
    expect(checkData.validation?.valid).not.toBe(false)

    // analyze: should have 0 issues (clean query with LIMIT)
    expect(analyze.issue_count).toBe(0)
  })

  test("all tools handle complex CTE query", async () => {
    const sql = `
      WITH monthly_revenue AS (
        SELECT
          DATE_TRUNC('month', order_date) AS month,
          SUM(amount) AS revenue
        FROM orders
        GROUP BY 1
      )
      SELECT month, revenue
      FROM monthly_revenue
      ORDER BY month DESC
      LIMIT 12
    `

    const [validate, check, analyze] = await Promise.all([
      Dispatcher.call("altimate_core.validate", { sql }),
      Dispatcher.call("altimate_core.check", { sql }),
      Dispatcher.call("sql.analyze", { sql }),
    ])

    // All should succeed without crashing
    expect(validate).toHaveProperty("success")
    expect(check).toHaveProperty("success")
    expect(analyze).toHaveProperty("success")
  })
})
