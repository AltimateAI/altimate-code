// altimate_change start — dbt unit test generation tool
import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { DbtUnitTestGenResult } from "../native/types"

export const DbtUnitTestGenTool = Tool.define("dbt_unit_test_gen", {
  description:
    "Generate dbt unit tests for a model. Parses manifest to extract dependencies, analyzes SQL for testable logic (CASE/WHEN, NULLs, JOINs, window functions), generates type-correct mock inputs, and assembles complete YAML ready to paste into schema.yml. Requires a compiled manifest (run `dbt compile` first).",
  parameters: z.object({
    manifest_path: z
      .string()
      .describe("Path to compiled dbt manifest.json (e.g. target/manifest.json)"),
    model: z
      .string()
      .describe("Model name (e.g. 'fct_orders') or unique_id (e.g. 'model.project.fct_orders')"),
    dialect: z
      .string()
      .optional()
      .describe("SQL dialect override (auto-detected from manifest if omitted)"),
    max_scenarios: z
      .number()
      .optional()
      .describe("Maximum number of test scenarios to generate (default: 3)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("dbt.unit_test_gen", {
        manifest_path: args.manifest_path,
        model: args.model,
        dialect: args.dialect,
        max_scenarios: args.max_scenarios,
      })

      if (!result.success) {
        return {
          title: "Unit Test Gen: FAILED",
          metadata: {
            success: false,
            model_name: result.model_name,
            error: result.error,
          },
          output: `Failed to generate unit tests: ${result.error}`,
        }
      }

      return {
        title: `Unit Test Gen: ${result.tests.length} test(s) for ${result.model_name}`,
        metadata: {
          success: true,
          model_name: result.model_name,
          model_unique_id: result.model_unique_id,
          materialized: result.materialized,
          test_count: result.tests.length,
          dependency_count: result.dependency_count,
          anti_pattern_count: result.anti_patterns.length,
          warning_count: result.warnings.length,
        },
        output: formatOutput(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Unit Test Gen: ERROR",
        metadata: { success: false, error: msg },
        output: `Failed: ${msg}`,
      }
    }
  },
})

function formatOutput(result: DbtUnitTestGenResult): string {
  const lines: string[] = []

  // Summary
  lines.push("=== Unit Test Generation Summary ===")
  lines.push(`Model: ${result.model_name}`)
  if (result.context?.model_description) {
    lines.push(`Description: ${result.context.model_description}`)
  }
  if (result.materialized) lines.push(`Materialization: ${result.materialized}`)
  lines.push(`Upstream dependencies: ${result.dependency_count}`)
  lines.push(`Tests generated: ${result.tests.length}`)

  // Semantic context — helps the LLM refine test values
  if (result.context) {
    const ctx = result.context

    // Upstream dependency context with descriptions
    if (ctx.upstream.length > 0) {
      lines.push("")
      lines.push("=== Upstream Dependencies ===")
      for (const up of ctx.upstream) {
        lines.push(`\n${up.ref}`)
        if (up.description) lines.push(`  ${up.description}`)
        const described = up.columns.filter((c) => c.description)
        if (described.length > 0) {
          lines.push("  Columns:")
          for (const col of up.columns) {
            const desc = col.description ? ` — ${col.description}` : ""
            lines.push(`    ${col.name} (${col.data_type || "?"})${desc}`)
          }
        } else if (up.columns.length > 0) {
          lines.push(`  Columns: ${up.columns.map((c) => `${c.name} (${c.data_type || "?"})`).join(", ")}`)
        }
      }
    }

    // Column lineage — which inputs drive which outputs
    const lineageEntries = Object.entries(ctx.column_lineage)
    if (lineageEntries.length > 0) {
      lines.push("")
      lines.push("=== Column Lineage (output ← inputs) ===")
      for (const [outputCol, sources] of lineageEntries) {
        lines.push(`  ${outputCol} ← ${sources.join(", ")}`)
      }
    }

    // Output column descriptions
    const describedOutputs = ctx.output_columns.filter((c) => c.description)
    if (describedOutputs.length > 0) {
      lines.push("")
      lines.push("=== Output Columns ===")
      for (const col of ctx.output_columns) {
        const desc = col.description ? ` — ${col.description}` : ""
        lines.push(`  ${col.name} (${col.data_type || "?"})${desc}`)
      }
    }
  }

  // Warnings
  if (result.warnings.length > 0) {
    lines.push("")
    lines.push("=== Warnings ===")
    for (const w of result.warnings) {
      lines.push(`- ${w}`)
    }
  }

  // Anti-patterns that informed test generation
  if (result.anti_patterns.length > 0) {
    lines.push("")
    lines.push("=== Anti-patterns detected (edge cases generated) ===")
    for (const ap of result.anti_patterns) {
      lines.push(`- ${ap}`)
    }
  }

  // Test case descriptions
  lines.push("")
  lines.push("=== Generated Test Cases ===")
  for (const test of result.tests) {
    lines.push(`\n--- ${test.name} [${test.category}] ---`)
    lines.push(`  ${test.description}`)
    lines.push(`  Target: ${test.target_logic}`)
    lines.push(`  Inputs: ${test.given.length} upstream ref(s)`)
    lines.push(`  Expected rows: ${test.expect_rows.length}`)
    if (test.overrides) {
      if (test.overrides.macros) {
        lines.push(`  Macro overrides: ${JSON.stringify(test.overrides.macros)}`)
      }
      if (test.overrides.vars) {
        lines.push(`  Var overrides: ${JSON.stringify(test.overrides.vars)}`)
      }
    }
  }

  // YAML output
  lines.push("")
  lines.push("=== YAML (paste into schema.yml or _unit_tests.yml) ===")
  lines.push("")
  lines.push(result.yaml)

  // Next steps
  lines.push("")
  lines.push("=== Next Steps ===")
  lines.push("1. Review the generated YAML — adjust expected output values if needed")
  lines.push("2. The expected outputs are placeholder values based on column types")
  lines.push("3. For accurate expected outputs, run the model SQL against the mock data:")
  lines.push("   altimate-dbt test --model <name>")
  lines.push("4. If tests fail, use the error message to fix expected values")
  lines.push("5. Add the YAML to your schema.yml or a dedicated _unit_tests.yml file")

  return lines.join("\n")
}
// altimate_change end
