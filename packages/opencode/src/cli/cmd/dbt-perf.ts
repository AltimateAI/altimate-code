// altimate_change start — dbt-perf: deterministic dbt performance analysis CLI
// command (no LLM required). Sibling of `altimate check`: one engine call, one
// normalization pass, one renderer, an exit code.
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Dispatcher } from "../../altimate/native"
import { existsSync, readFileSync, statSync } from "fs"
import path from "path"
import {
  type PerfSeverity,
  type PerfSortOrder,
  buildPerfOptions,
  filterPerfBySeverity,
  sortPerfFindings,
  formatPerfText,
  normalizePerfReport,
  perfPass,
} from "./dbt-perf-helpers"

/**
 * `altimate dbt-perf` — whole-project dbt performance analysis.
 *
 * Deterministic and offline: it reads the dbt manifest (and the compiled SQL
 * next to it, when present) and runs the engine's perf rule set. No model
 * calls, no warehouse connection, no cost.
 *
 * Scope note: this is a PROJECT command, like `altimate review --all` and
 * unlike `altimate review`. It does not look at a diff.
 */
export const DbtPerfCommand = cmd({
  command: "dbt-perf",
  describe: "analyze a dbt project for performance problems (deterministic, no LLM)",
  builder: (yargs: Argv) =>
    yargs
      .option("cwd", {
        describe: "dbt project directory (default: current dir)",
        type: "string",
      })
      .option("manifest", {
        describe: "path to dbt manifest.json (default: <cwd>/target/manifest.json)",
        type: "string",
      })
      .option("format", {
        describe: "output format",
        choices: ["json", "text"] as const,
        default: "text" as const,
      })
      .option("severity", {
        describe: "minimum severity to report",
        choices: ["info", "warning", "error"] as const,
        default: "info" as const,
      })
      .option("fail-on", {
        describe: "exit 1 if findings at this level or above are found (computed before --severity)",
        choices: ["none", "warning", "error"] as const,
        default: "none" as const,
      })
      .option("run-results", {
        describe: "dbt run_results.json — measured execution time per model (enables cost-ranked rules)",
        type: "string",
      })
      .option("trino-profile", {
        describe: "Trino build profile JSON (peak memory, bytes read per model)",
        type: "string",
      })
      .option("sinks", {
        describe: "sink map JSON: which loaders / served tables read each mart column beyond the dbt graph",
        type: "string",
      })
      .option("exposure-sinks", {
        describe:
          "without --sinks, derive the sink map from exposures' meta.sink (--no-exposure-sinks: loaders unknown)",
        type: "boolean",
        default: true,
      })
      .option("experimental", {
        describe: "also run rules held out of the default report",
        type: "boolean",
        default: false,
      })
      .option("sort", {
        describe: "finding order: grouped by rule, or most expensive first (needs --run-results or --trino-profile)",
        choices: ["rule", "cost"] as const,
        default: "rule" as const,
      }),

  handler: async (args: {
    cwd?: string
    manifest?: string
    format?: "json" | "text"
    severity?: PerfSeverity
    "fail-on"?: "none" | "warning" | "error"
    failOn?: "none" | "warning" | "error"
    "run-results"?: string
    "trino-profile"?: string
    sinks?: string
    "exposure-sinks"?: boolean
    experimental?: boolean
    sort?: PerfSortOrder
  }) => {
    const startTime = Date.now()
    const projectDir = path.resolve(args.cwd ?? process.cwd())

    // Resolve the manifest. An explicit --manifest must exist — silently
    // falling back to the project scan would analyze something the caller
    // didn't ask for. Without the flag, the conventional path is used when it
    // is there, and otherwise the project directory is handed to the engine so
    // it can locate its own inputs.
    let manifestPath: string | undefined
    if (args.manifest) {
      manifestPath = path.resolve(args.manifest)
      if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
        console.error(`Error: manifest not found: ${manifestPath}`)
        process.exitCode = 1
        return
      }
    } else {
      const conventional = path.join(projectDir, "target", "manifest.json")
      if (existsSync(conventional)) manifestPath = conventional
    }

    let manifestJson: string | undefined
    if (manifestPath) {
      try {
        manifestJson = readFileSync(manifestPath, "utf-8")
      } catch (e) {
        console.error(`Error reading manifest ${manifestPath}: ${e instanceof Error ? e.message : String(e)}`)
        process.exitCode = 1
        return
      }
    }

    // Optional inputs: each must exist. The engine also rejects an unreadable
    // path, but checking here names the flag the user got wrong.
    const inputPaths: Record<string, string | undefined> = {
      "--run-results": args["run-results"],
      "--trino-profile": args["trino-profile"],
      "--sinks": args.sinks,
    }
    const resolved: Record<string, string | undefined> = {}
    for (const [flag, p] of Object.entries(inputPaths)) {
      if (!p) continue
      const abs = path.resolve(p)
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        console.error(`Error: ${flag} file not found: ${abs}`)
        process.exitCode = 1
        return
      }
      resolved[flag] = abs
    }
    const options = buildPerfOptions({
      runResults: resolved["--run-results"],
      trinoProfile: resolved["--trino-profile"],
      sinks: resolved["--sinks"],
      experimental: args.experimental,
      exposureSinks: args["exposure-sinks"],
    })

    let result
    try {
      result = await Dispatcher.call("altimate_core.dbt_perf", {
        project_dir: projectDir,
        manifest_json: manifestJson,
        options_json: Object.keys(options).length ? JSON.stringify(options) : undefined,
      })
    } catch (e) {
      // Dispatcher-level failure (registration, native load). Fatal: unlike
      // `check`, there is no per-file result to degrade into.
      console.error(`Error: dbt-perf failed: ${e instanceof Error ? e.message : String(e)}`)
      process.exitCode = 1
      return
    }
    if (!result.success) {
      // Carries the "you need a newer altimate-core, here is how to build it"
      // message when the binding is missing (native/altimate-core.ts).
      console.error(`Error: ${result.error ?? "altimate_core.dbt_perf failed"}`)
      process.exitCode = 1
      return
    }

    const report = normalizePerfReport(result.data)
    const failOn = args["fail-on"] ?? args.failOn ?? "none"
    // Pass/fail on the UNFILTERED findings: --severity controls display only.
    const pass = perfPass(report.findings, failOn)
    const minSeverity: PerfSeverity = args.severity ?? "info"
    const sort: PerfSortOrder = args.sort ?? "rule"
    const shown = sortPerfFindings(filterPerfBySeverity(report.findings, minSeverity), sort)
    if (sort === "cost" && !report.summary.had_run_results && !report.summary.had_trino_profile)
      console.error(
        "Note: --sort cost without --run-results or --trino-profile has no measured cost to sort on; engine order kept.",
      )

    if (args.format === "json") {
      process.stdout.write(
        JSON.stringify(
          {
            version: 1,
            project_dir: projectDir,
            manifest: manifestPath,
            inputs: options,
            sort,
            findings: shown,
            skipped_rules: report.skipped_rules,
            summary: { ...report.summary, findings_shown: shown.length, pass },
          },
          null,
          2,
        ) + "\n",
      )
    } else {
      console.error(
        formatPerfText({
          findings: shown,
          allFindings: report.findings,
          skippedRules: report.skipped_rules,
          summary: report.summary,
          pass,
          minSeverity,
          sort,
        }),
      )
      console.error(`Completed in ${Date.now() - startTime}ms`)
    }

    // process.exitCode, not process.exit(): index.ts's finally block still has
    // to run Telemetry.shutdown().
    if (!pass) process.exitCode = 1
  },
})
// altimate_change end
