import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"

export const DbtRunTool = Tool.define("dbt_run", {
  description:
    "Run a dbt CLI command (run, test, build, compile, etc.). Executes dbt in the project directory and returns stdout/stderr.",
  parameters: z.object({
    command: z.string().optional().default("run").describe("dbt command to run (run, test, build, compile, seed, snapshot)"),
    select: z.string().optional().describe("dbt node selector (e.g. 'my_model', '+my_model', 'tag:daily')"),
    args: z.array(z.string()).optional().default([]).describe("Additional CLI arguments"),
    project_dir: z.string().optional().describe("Path to dbt project directory"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("dbt.run", {
        command: args.command,
        select: args.select,
        args: args.args,
        project_dir: args.project_dir,
      })

      const success = result.exit_code === 0
      const lines: string[] = []

      if (result.stdout) {
        lines.push(result.stdout)
      }
      if (result.stderr) {
        if (lines.length > 0) lines.push("")
        lines.push("--- stderr ---")
        lines.push(result.stderr)
      }

      return {
        title: `dbt ${args.command}: ${success ? "OK" : `FAIL (exit ${result.exit_code})`}`,
        metadata: { exit_code: result.exit_code, success },
        output: lines.join("\n") || "(no output)",
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: `dbt ${args.command}: ERROR`,
        metadata: { exit_code: 1, success: false },
        output: `Failed to run dbt: ${msg}\n\nEnsure dbt-core is installed and the Python bridge is running.`,
      }
    }
  },
})
