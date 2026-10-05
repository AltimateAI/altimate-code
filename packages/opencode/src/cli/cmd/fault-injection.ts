// altimate_change start — fault-injection: deterministic dbt test-gap CLI command (no LLM required)
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Dispatcher } from "../../altimate/native"
import { formatFaultInjection, formatRate } from "../../altimate/native/connections/fault-injection-report"
import type { DbtFaultInjectionProgress } from "../../altimate/native/types"

const EXIT_INTERRUPTED = 130

function progressLine(event: DbtFaultInjectionProgress): string {
  switch (event.kind) {
    case "stage":
      return event.message
    case "control":
      return `Control run (no fault): ${event.producer_id}`
    case "fault":
      return `Fault ${event.index}/${event.total}: ${event.fault_id}`
  }
}

export const FaultInjectionCommand = cmd({
  command: "fault-injection [project]",
  describe: "find the upstream data faults a dbt project's tests miss (deterministic, no LLM required)",
  builder: (yargs: Argv) =>
    yargs
      .positional("project", {
        describe: "dbt project directory (default: current directory)",
        type: "string",
      })
      .option("budget", {
        describe: "maximum number of faults to inject; each one rebuilds the downstream models and runs their tests",
        type: "number",
        default: 20,
      })
      .option("model", {
        describe: "corrupt only this model, seed, snapshot or source",
        type: "string",
      })
      .option("target", {
        describe: "dbt target name (default: the profile's default target)",
        type: "string",
      })
      .option("profiles-dir", {
        describe: "directory containing profiles.yml (default: dbt's lookup order)",
        type: "string",
      })
      .option("seed", {
        describe: "seed for the deterministic fault selection",
        type: "number",
      })
      .option("work-dir", {
        describe: "parent directory for the temporary database copies (default: the system temp directory)",
        type: "string",
      })
      .option("format", {
        describe: "output format",
        choices: ["text", "json"] as const,
        default: "text" as const,
      })
      .option("fail-under", {
        describe: "exit 1 if the catch rate is below this percentage (0-100)",
        type: "number",
      }),

  handler: async (args: {
    project?: string
    budget?: number
    model?: string
    target?: string
    "profiles-dir"?: string
    profilesDir?: string
    seed?: number
    "work-dir"?: string
    workDir?: string
    format?: "text" | "json"
    "fail-under"?: number
    failUnder?: number
  }) => {
    const budget = args.budget ?? 20
    if (!Number.isInteger(budget) || budget < 1) {
      console.error("Error: --budget must be a positive integer.")
      process.exitCode = 1
      return
    }
    const failUnder = args["fail-under"] ?? args.failUnder
    if (failUnder !== undefined && !(failUnder >= 0 && failUnder <= 100)) {
      console.error("Error: --fail-under must be a percentage between 0 and 100.")
      process.exitCode = 1
      return
    }

    if (args.seed !== undefined && !(Number.isSafeInteger(args.seed) && args.seed >= 0)) {
      console.error("Error: --seed must be a non-negative integer.")
      process.exitCode = 1
      return
    }

    // An interrupt aborts the run; the driver then stops dbt and removes its copies before
    // returning. A second one does not wait: process.exit runs the driver's exit hook, which
    // kills dbt and removes the work directory synchronously.
    const controller = new AbortController()
    const onSignal = () => {
      if (controller.signal.aborted) process.exit(EXIT_INTERRUPTED)
      console.error("Interrupted; stopping dbt and removing the work directory...")
      controller.abort()
    }
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]
    for (const name of signals) process.on(name, onSignal)

    try {
      const result = await Dispatcher.call("dbt.fault_injection", {
        project_dir: args.project,
        model: args.model,
        budget,
        target: args.target,
        profiles_dir: args["profiles-dir"] ?? args.profilesDir,
        seed: args.seed,
        work_dir: args["work-dir"] ?? args.workDir,
        signal: controller.signal,
        on_progress: (event) => console.error(progressLine(event)),
      })

      if (args.format === "json") {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n")
      } else if (result.success) {
        process.stdout.write(formatFaultInjection(result) + "\n")
      } else {
        console.error(formatFaultInjection(result))
      }

      // process.exitCode rather than process.exit(), so index.ts can flush telemetry.
      if (result.interrupted) {
        process.exitCode = EXIT_INTERRUPTED
      } else if (!result.success) {
        process.exitCode = 1
      } else if (failUnder !== undefined) {
        const rate = result.report?.summary?.catch_rate
        if (typeof rate !== "number") {
          // No fault was caught and none slipped through: nothing was measured, so the gate cannot pass.
          console.error(`There is no catch rate to compare with --fail-under ${failUnder}.`)
          process.exitCode = 1
        } else if (rate < failUnder / 100) {
          console.error(`Catch rate ${formatRate(rate)} is below --fail-under ${failUnder}.`)
          process.exitCode = 1
        }
      }
    } finally {
      for (const name of signals) process.removeListener(name, onSignal)
    }
  },
})
// altimate_change end
