// altimate_change start — `altimate debug bundle`: one readable, redacted report to send to support
import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { effectCmd } from "../../effect-cmd"

export const BundleCommand = effectCmd({
  command: "bundle",
  // No project instance: starting one runs plugins, LSP and snapshots, which is exactly what may be hanging, and it
  // would write its own lines into the log this command reads.
  instance: false,
  describe: "write a diagnostic report (secrets, emails and your user name removed) to send to Altimate support",
  builder: (yargs) =>
    yargs
      .option("output", {
        alias: ["o"],
        describe: "where to write the report (default: altimate-debug-report-<time>.md in the current folder)",
        type: "string",
      })
      .option("network", {
        describe:
          "check that the Snowflake and Databricks warehouses, Altimate API, telemetry and model catalogue this install uses are reachable (--no-network: no network access at all)",
        type: "boolean",
        default: true,
      }),
  handler: Effect.fn("Cli.debug.bundle")(function* (args) {
    const { collect, redactContext } = yield* Effect.promise(() => import("@/altimate/debug/collect"))
    const { detectProblems, redact, renderReport } = yield* Effect.promise(() => import("@/altimate/debug/report"))
    process.stderr.write("Collecting diagnostics…\n")
    const facts = yield* Effect.promise(() => collect({ network: args.network !== false }))
    const findings = detectProblems(facts)
    // The whole report is redacted again: findings quote log text, which can carry paths and names.
    const report = redact(renderReport(facts, findings), redactContext())
    const stamp = facts.generatedAt.replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z")
    const file = path.resolve(args.output ?? `altimate-debug-report-${stamp}.md`)
    fs.writeFileSync(file, report, { mode: 0o600 })
    // `mode` only applies to a new file; an existing one keeps its permissions otherwise.
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // not a filesystem that supports it
    }
    const problems = findings.filter((f) => f.severity === "problem").length
    process.stdout.write(
      `Report written to ${file}\n` +
        `${problems} problem${problems === 1 ? "" : "s"} found. Please read the report before sending it; it lists what was removed.\n`,
    )
  }),
})
// altimate_change end
