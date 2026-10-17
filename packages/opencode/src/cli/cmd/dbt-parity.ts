// altimate_change start — dbt-parity: run the engine's data parity plan for a
// model change over an existing warehouse connection and judge it.
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Dispatcher } from "../../altimate/native"
import * as Registry from "../../altimate/native/connections/registry"
import { warehouseTypeToDialect } from "../../altimate/native/connections/data-diff"
import path from "path"
import { findModel, loadManifest } from "./dbt-mart-helpers"
import { type Executor, formatParityText, normalizeParityPlan, runParityPlan } from "./dbt-parity-helpers"

/**
 * `altimate dbt-parity --model X --before <relation> --after <relation>`.
 *
 * The engine plans the checks (row counts, grain uniqueness, EXCEPT both ways,
 * per-column match rates, key-joined diff); this command runs them over a
 * warehouse connection and exits non-zero unless every check passes. Queries
 * returning ROW VALUES run only with an explicit `--sample-rows N`, because
 * those rows end up in the terminal (and in an agent's context).
 */
export const DbtParityCommand = cmd({
  command: "dbt-parity",
  describe: "prove a rebuilt dbt model returns the same data as before (runs the engine's parity plan)",
  builder: (yargs: Argv) =>
    yargs
      .option("model", { describe: "model name (or unique_id)", type: "string", demandOption: true })
      .option("before", { describe: "relation holding the model BEFORE the change", type: "string", demandOption: true })
      .option("after", { describe: "relation holding the model AFTER the change", type: "string", demandOption: true })
      .option("connection", { describe: "warehouse connection name (default: the first configured)", type: "string" })
      .option("columns", {
        describe: "comma-separated columns to compare (enables per-column match rates)",
        type: "string",
      })
      .option("sample-rows", {
        describe: "fetch up to N differing rows each way (row values — may contain PII; default 0 = none)",
        type: "number",
        default: 0,
      })
      .option("cwd", { describe: "dbt project directory (default: current dir)", type: "string" })
      .option("manifest", { describe: "path to dbt manifest.json", type: "string" })
      .option("json", { describe: "emit the full result as JSON", type: "boolean", default: false }),

  handler: async (args: {
    model: string
    before: string
    after: string
    connection?: string
    columns?: string
    "sample-rows"?: number
    cwd?: string
    manifest?: string
    json?: boolean
  }) => {
    const projectDir = path.resolve(args.cwd ?? process.cwd())
    const loaded = loadManifest(projectDir, args.manifest)
    if (!loaded.ok) return fatal(loaded.error)
    const model = findModel(loaded.manifest, args.model)
    if (!model) return fatal(`model not found (or ambiguous) in the manifest: ${args.model}`)

    const connection = args.connection ?? Registry.list().warehouses[0]?.name
    if (!connection)
      return fatal("no warehouse connection configured — add one (warehouse.add / ALTIMATE_CODE_CONN_<NAME>) or pass --connection")
    const type = Registry.getConfig(connection)?.type
    if (!type) return fatal(`connection "${connection}" not found`)
    const dialect = warehouseTypeToDialect(String(type))

    const sampleRows = Math.max(0, Math.floor(args["sample-rows"] ?? 0))
    const options: Record<string, unknown> = { dialect }
    if (sampleRows > 0) options.sample_rows = sampleRows
    const columns = (args.columns ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean)
    if (columns.length) options.columns = columns

    const res = await Dispatcher.call("altimate_core.dbt_parity_plan", {
      project_dir: projectDir,
      model: model.name ?? args.model,
      before: args.before,
      after: args.after,
      options_json: JSON.stringify(options),
    }).catch((e: unknown) => ({ success: false, data: {} as Record<string, unknown>, error: String(e) }))
    if (!res.success) return fatal(res.error ?? "altimate_core.dbt_parity_plan failed")
    const plan = normalizeParityPlan(res.data)
    if (!plan.tasks.length) return fatal("the engine returned a parity plan with no tasks")

    let connector: Awaited<ReturnType<typeof Registry.get>>
    try {
      connector = await Registry.get(connection)
    } catch (e) {
      return fatal(`cannot connect to "${connection}": ${e instanceof Error ? e.message : String(e)}`)
    }
    // Complete result sets: a driver-default LIMIT would turn a count into a
    // sample and make a mismatch look like a match.
    const exec: Executor = async (sql) => {
      const r = await connector.execute(sql, undefined, undefined, { noLimit: true })
      return {
        columns: r.columns,
        rows: r.rows.map((row: unknown[]) => row.map((v) => (v === null || v === undefined ? null : String(v)))),
      }
    }
    const result = await runParityPlan(plan, exec, { sampleRows })

    if (args.json) {
      process.stdout.write(JSON.stringify({ version: 1, connection, dialect, ...result }, null, 2) + "\n")
    } else {
      console.error(formatParityText(result, { sampleRows }))
    }
    if (result.verdict !== "match") process.exitCode = 1
  },
})

function fatal(msg: string): void {
  console.error(`Error: ${msg}`)
  process.exitCode = 1
}
// altimate_change end
