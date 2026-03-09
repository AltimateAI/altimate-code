import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"

export const AltimateCoreTestgenTool = Tool.define("altimate_core_testgen", {
  description:
    "Generate automated SQL test cases using the Rust-based altimate-core engine. Produces boundary value tests, NULL handling tests, edge cases, and expected result assertions for a given SQL query.",
  parameters: z.object({
    sql: z.string().describe("SQL query to generate tests for"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("altimate_core.testgen", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      const tests = data.tests ?? data.test_cases ?? data.generated_tests ?? []
      const testCount = tests.length
      return {
        title: `TestGen: ${testCount} test(s) generated`,
        metadata: { success: result.success, test_count: testCount },
        output: formatTestgen(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "TestGen: ERROR", metadata: { success: false, test_count: 0 }, output: `Failed: ${msg}` }
    }
  },
})

function formatTestgen(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  const tests = data.tests ?? data.test_cases ?? data.generated_tests ?? []
  if (!tests.length) return "No test cases generated."
  const lines: string[] = [`Generated ${tests.length} test case(s):\n`]
  for (const test of tests) {
    lines.push(`--- ${test.name ?? test.description ?? "Test"} ---`)
    if (test.sql) lines.push(test.sql)
    if (test.assertion) lines.push(`  Assert: ${test.assertion}`)
    if (test.category) lines.push(`  Category: ${test.category}`)
    lines.push("")
  }
  return lines.join("\n")
}
