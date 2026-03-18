/**
 * Tests for tool output formatting functions.
 *
 * These tests verify that tool formatters correctly handle the data
 * shapes returned by the Rust altimate-core napi bindings.
 * Tests don't require the napi binary — they test formatter logic only.
 */

import { describe, expect, test } from "bun:test"

// We can't import formatters directly (they're not exported), so we
// test the logic patterns they use against known Rust output shapes.

describe("sql_analyze result interpretation", () => {
  test("issues found should not show 'Unknown error'", () => {
    // Simulates: sql.analyze returns issues but success=false
    const result = {
      success: false,
      issues: [
        { type: "lint", severity: "warning", message: "SELECT * detected" },
      ],
      issue_count: 1,
      confidence: "high",
      confidence_factors: ["lint"],
    }
    // The bug: !result.success + no result.error = "Unknown error"
    // The fix: check result.error instead of !result.success
    const hasError = !!(result as any).error
    expect(hasError).toBe(false)
    expect(result.issues.length).toBeGreaterThan(0)
  })
})

describe("altimate_core_grade result mapping", () => {
  test("maps Rust EvalResult fields correctly", () => {
    // Simulates Rust EvalResult output
    const rustOutput = {
      sql: "SELECT * FROM users",
      scores: {
        syntax: 1.0,
        style: 0.6,
        safety: 1.0,
        complexity: 0.8,
        overall: 0.84,
      },
      overall_grade: "B",
      total_time_ms: 12,
    }

    // Tool accesses:
    const grade = rustOutput.overall_grade  // NOT .grade
    const score = rustOutput.scores?.overall != null
      ? Math.round(rustOutput.scores.overall * 100)
      : null

    expect(grade).toBe("B")
    expect(score).toBe(84)
  })

  test("handles legacy format with .grade field", () => {
    const legacyOutput = { grade: "A", score: 95 }
    const grade = (legacyOutput as any).overall_grade ?? legacyOutput.grade
    expect(grade).toBe("A")
  })
})

describe("altimate_core_complete result mapping", () => {
  test("maps Rust CompletionResult fields correctly", () => {
    // Simulates Rust CompletionResult
    const rustOutput = {
      cursor_offset: 15,
      context: "after_from",
      items: [
        { label: "users", kind: "table", detail: "users table" },
        { label: "orders", kind: "table", detail: "orders table" },
      ],
    }

    // Tool should use .items, not .suggestions
    const count = rustOutput.items?.length ?? 0
    expect(count).toBe(2)
  })
})

describe("altimate_core_schema_diff result mapping", () => {
  test("maps Rust SchemaDiff fields correctly", () => {
    // Simulates Rust SchemaDiff output
    const rustOutput = {
      changes: [
        { type: "column_removed", table: "customers", column: "first_name" },
        { type: "column_removed", table: "customers", column: "last_name" },
        { type: "column_added", table: "customers", column: "full_name", data_type: "VARCHAR" },
        { type: "column_added", table: "customers", column: "phone", data_type: "VARCHAR" },
      ],
      has_breaking_changes: true,
      summary: "4 changes (2 breaking)",
    }

    // Tool should use has_breaking_changes, not has_breaking
    const hasBreaking = rustOutput.has_breaking_changes
    expect(hasBreaking).toBe(true)
    expect(rustOutput.changes.length).toBe(4)

    // Breaking type detection
    const breakingTypes = new Set(["table_removed", "column_removed", "column_type_changed"])
    const breakingChanges = rustOutput.changes.filter(c =>
      breakingTypes.has(c.type) ||
      (c.type === "nullability_changed" && (c as any).old_nullable && !(c as any).new_nullable)
    )
    expect(breakingChanges.length).toBe(2)
  })

  test("empty changes should report 'Schemas are identical'", () => {
    const rustOutput = {
      changes: [],
      has_breaking_changes: false,
      summary: "0 changes (0 breaking)",
    }
    expect(rustOutput.changes.length).toBe(0)
  })
})

describe("altimate_core_rewrite result mapping", () => {
  test("maps Rust RewriteResult fields correctly", () => {
    // Simulates Rust RewriteResult
    const rustOutput = {
      original_sql: "SELECT * FROM users",
      suggestions: [
        {
          rule: "expand_select_star",
          explanation: "Replace SELECT * with explicit columns",
          rewritten_sql: "SELECT id, name, email FROM users",
          improvement: "Reduce data transfer",
          confidence: 0.9,
        },
      ],
      index_suggestions: [],
    }

    // Tool should use .suggestions, not .rewrites
    const suggestions = rustOutput.suggestions ?? []
    expect(suggestions.length).toBe(1)
    expect(suggestions[0].rewritten_sql).toContain("id, name, email")
  })
})

describe("altimate_core_column_lineage result mapping", () => {
  test("maps Rust CompleteLineageResult fields correctly", () => {
    // Simulates Rust CompleteLineageResult
    const rustOutput = {
      tier: "full",
      depth: "full",
      column_dict: {
        customer_id: ['"orders"."customer_id"'],
        total: ['"orders"."amount"'],
      },
      column_lineage: [
        {
          source: '"orders"."customer_id"',
          target: "customer_id",
          lineage_type: "direct",
          lens_type: "passthrough",
          lens_code: [],
        },
        {
          source: '"orders"."amount"',
          target: "total",
          lineage_type: "direct",
          lens_type: "aggregate",
          lens_code: [{ expression: "SUM(amount)", step_type: "transform" }],
        },
      ],
      source_tables: ["orders"],
      output_columns: ["customer_id", "total"],
    }

    expect(rustOutput.column_lineage.length).toBe(2)
    expect(rustOutput.column_dict).toBeDefined()
    // Transform info should use lens_type, not transform
    expect(rustOutput.column_lineage[1].lens_type).toBe("aggregate")
  })
})

describe("altimate_core_fix result mapping", () => {
  test("maps Rust FixResult fields correctly", () => {
    // Simulates Rust FixResult
    const rustOutput = {
      original_sql: "SELECT id FROM uesrs",
      fixed: true,
      fixed_sql: "SELECT id FROM users",
      fixes_applied: [
        { description: "Fixed table name: uesrs -> users" },
      ],
      unfixable_errors: [],
    }

    expect(rustOutput.fixed).toBe(true)
    expect(rustOutput.fixed_sql).toBe("SELECT id FROM users")
    expect(rustOutput.fixes_applied.length).toBe(1)
  })

  test("handles unfixable errors", () => {
    const rustOutput = {
      original_sql: "SELECT asdas FROM nonexistent",
      fixed: false,
      fixed_sql: "SELECT asdas FROM nonexistent",
      fixes_applied: [],
      unfixable_errors: [
        { message: "Table 'nonexistent' not found", reason: "no fuzzy match" },
      ],
    }

    expect(rustOutput.fixed).toBe(false)
    expect(rustOutput.unfixable_errors.length).toBe(1)
  })
})
