import z from "zod"
import path from "path"
import { Tool } from "../../tool/tool"
import { Instance } from "../../project/instance"
import { Dispatcher } from "../native"
import { formatFaultInjection, summarizeFaultInjection } from "../native/connections/fault-injection-report"

export const DbtFaultInjectionTool = Tool.define("dbt_fault_injection", {
  description: [
    "Find the upstream data faults a dbt project's own tests would miss.",
    "",
    "Corrupts one upstream relation at a time in a private copy of the database (duplicated rows, dropped rows,",
    "NULLs, values off by 100x, unseen categories, shifted dates, orphaned foreign keys), rebuilds every model",
    "downstream of it, and runs the project's tests. Reports the catch rate and, for each fault that slipped",
    "through (no test failed but downstream data changed), which downstream models changed and a dbt test that",
    "passes on the clean data and fails on the corrupted copy (a schema entry to paste, or a singular test file",
    "for resources a dbt package defines), or the reason no stable test exists. Deterministic: no model is involved.",
    "",
    "Use it when asked how good a dbt project's tests are, what a model's tests would miss, or which tests to add.",
    "Do not use it to check whether existing data is correct: findings are test gaps, not data errors.",
    "",
    "Cost: one `dbt build` of the whole project on the copy, then one `dbt run` of the downstream models plus",
    "one `dbt test` per fault, and three more per corrupted relation as a no-fault control. A 20-fault run takes",
    "minutes even on a small project. Keep `budget` small, or set `model` to focus on one relation.",
    "",
    "dbt runs on copies of the database and of the project, which are deleted when the run ends. A project that",
    "visibly reaches outside its database (attached databases, external materializations, hooks that ATTACH or",
    "COPY) is refused; what macros and Python models do is not inspected.",
    "DuckDB projects only for now; any other warehouse is refused before anything runs.",
  ].join("\n"),
  parameters: z.object({
    project_dir: z
      .string()
      .optional()
      .describe("dbt project root, the directory containing dbt_project.yml. Defaults to the working directory."),
    model: z
      .string()
      .optional()
      .describe(
        "Corrupt only this model, seed, snapshot or source, and check what its downstream tests catch. " +
          "Omit to spread the budget over every relation that has downstream models.",
      ),
    budget: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(20)
      .describe("Maximum number of faults to inject. Each one rebuilds the downstream models and runs their tests."),
    target: z.string().optional().describe("dbt target name. Defaults to the profile's default target."),
    profiles_dir: z.string().optional().describe("Directory containing profiles.yml. Defaults to dbt's lookup order."),
  }),
  async execute(args, ctx) {
    const projectDir = path.resolve(Instance.directory, args.project_dir ?? ".")
    // This runs dbt, which executes the project's own code. Ask as for any other command.
    const command = `dbt build --project-dir ${projectDir}`
    await ctx.ask({
      permission: "bash",
      patterns: [command],
      always: [command],
      metadata: { project_dir: projectDir, budget: args.budget, model: args.model },
    })

    try {
      const result = await Dispatcher.call("dbt.fault_injection", {
        project_dir: projectDir,
        model: args.model,
        budget: args.budget,
        target: args.target,
        profiles_dir: args.profiles_dir,
        signal: ctx.abort,
      })
      const summary = result.report?.summary
      return {
        title: `Fault injection: ${summarizeFaultInjection(result)}`,
        metadata: {
          success: result.success,
          ...(summary
            ? {
                executed: summary.executed as number,
                killed: summary.killed as number,
                slipped_through: summary.slipped_through as number,
                catch_rate: summary.catch_rate as number | null,
              }
            : {}),
          ...(result.error ? { error: result.error } : {}),
        },
        output: formatFaultInjection(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Fault injection: ERROR",
        metadata: { success: false, error: msg },
        output: `Fault injection failed: ${msg}`,
      }
    }
  },
})
