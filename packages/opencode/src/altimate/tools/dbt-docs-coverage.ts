// altimate_change - new file
//
// How much of a model's output is documented: the output columns of its compiled SQL, set against
// the columns the manifest gives a description (what the YAML says), and whether the model itself
// has a description. Reads the manifest only, so it needs no warehouse and no dbt adapter.
import z from "zod"
import * as core from "@altimateai/altimate-core"
import { Tool } from "../../tool/tool"
import { loadRawManifest, findModel, detectDialect } from "../native/dbt/helpers"

export interface DocsCoverage {
  model: string
  unique_id: string
  has_description: boolean
  /** The model's output columns, as written in its compiled SQL (or the manifest's columns when the select list cannot be read as names). */
  output_columns: string[]
  /** Output columns that have a description. */
  documented: string[]
  /** Output columns without a description. */
  missing: string[]
  /** Percent of output columns with a description, 0 to 100, rounded to one decimal; 100 when there are no columns. */
  percent: number
  /** Where the column list came from: the compiled SQL's select list, or the manifest's columns when the select list cannot be read as names (`*`, an unnamed expression, a UNION). */
  source: "compiled_sql" | "manifest_columns"
}

const hasText = (value: unknown) => typeof value === "string" && value.trim().length > 0

/** Coverage of one manifest model node. Throws when the node has no compiled SQL, or when its select list cannot be read as column names and the manifest lists no columns; with manifest columns, those are counted instead (`source: "manifest_columns"`). */
export function docsCoverage(node: any, dialect: string | undefined): DocsCoverage {
  const yamlColumns: Record<string, any> = node.columns ?? {}
  const described = new Set<string>()
  const listed = new Set<string>()
  for (const [key, col] of Object.entries<any>(yamlColumns)) {
    const name = String(col?.name || key)
    listed.add(name)
    if (hasText(col?.description)) described.add(name)
  }

  const sql: string = node.compiled_code || node.compiled_sql || ""
  if (!sql.trim()) {
    throw new Error(`Model "${node.name}" has no compiled SQL in the manifest. Run \`dbt compile\` first.`)
  }
  let outputs: string[]
  let source: DocsCoverage["source"] = "compiled_sql"
  try {
    outputs = core.extractOutputColumns(sql, dialect)
  } catch {
    // A select list the engine cannot turn into names (a `*`, an expression with no alias, a UNION) has
    // no column list to count, so the manifest's own columns are the best list there is. The engine's
    // message is its own debug text and is not passed on.
    outputs = []
    source = "manifest_columns"
  }
  if (source === "manifest_columns") {
    outputs = Object.entries<any>(yamlColumns).map(([key, col]) => String(col?.name || key))
  }

  if (source === "manifest_columns" && outputs.length === 0) {
    throw new Error(
      `Model "${node.name}" has a select list that cannot be read as column names (a \`*\`, an expression with no alias or a UNION) and the manifest lists no columns for it, so its columns are not known. List them in its YAML or run \`dbt docs generate\`.`,
    )
  }

  const columns = [...new Set(outputs)]
  // Names that differ only by case are different columns when quoted, so they are matched as written;
  // any other name is matched ignoring case, as a warehouse folds an unquoted one.
  const byCase = new Map<string, number>()
  for (const c of columns) byCase.set(c.toLowerCase(), (byCase.get(c.toLowerCase()) ?? 0) + 1)
  const describedFolded = new Set([...described].map((c) => c.toLowerCase()))
  // A YAML entry with exactly this name speaks for the column, blank or not; only without one is the
  // name matched ignoring case.
  const isDocumented = (c: string) =>
    byCase.get(c.toLowerCase()) === 1 && !listed.has(c) ? describedFolded.has(c.toLowerCase()) : described.has(c)
  const documented = columns.filter(isDocumented)
  const missing = columns.filter((c) => !isDocumented(c))
  const percent = columns.length === 0 ? 100 : Math.round((documented.length / columns.length) * 1000) / 10
  return {
    model: node.name,
    unique_id: node.unique_id ?? "",
    has_description: hasText(node.description),
    output_columns: columns,
    documented,
    missing,
    percent,
    source,
  }
}

export const DbtDocsCoverageTool = Tool.define("dbt_docs_coverage", {
  description: [
    "Report how much of a dbt model's documentation is written: which output columns of its compiled",
    "SQL have no description in the project's YAML, and whether the model has a description.",
    "Reads target/manifest.json only; run `dbt compile` first so the manifest is current.",
    "",
    "Examples:",
    '- dbt_docs_coverage({ model: "stg_orders" })',
    '- dbt_docs_coverage({ model: "dim_customers", manifest_path: "target/manifest.json" })',
  ].join("\n"),
  parameters: z.object({
    model: z.string().describe("dbt model name or unique_id (e.g., 'stg_orders', 'model.shop.dim_customers')"),
    manifest_path: z.string().optional().default("target/manifest.json").describe("Path to dbt manifest.json file"),
  }),
  async execute(args, _ctx) {
    try {
      const manifest = loadRawManifest(args.manifest_path)
      if (!manifest) {
        return {
          title: "Docs coverage: NO MANIFEST",
          metadata: { success: false, error: `No manifest at ${args.manifest_path}` },
          output: `No manifest at ${args.manifest_path}. Run \`dbt compile\` first to generate it.`,
        }
      }
      const node = findModel(manifest.nodes ?? {}, args.model)
      if (!node) {
        return {
          title: "Docs coverage: MODEL NOT FOUND",
          metadata: { success: false, error: `Model "${args.model}" not found` },
          output: `Model "${args.model}" not found in the manifest at ${args.manifest_path}.`,
        }
      }
      const result = docsCoverage(node, detectDialect(manifest))
      const lines = [
        `${result.model}: ${result.documented.length} of ${result.output_columns.length} columns documented (${result.percent}%)`,
        `Model description: ${result.has_description ? "yes" : "missing"}`,
      ]
      if (result.missing.length > 0) lines.push(`Missing descriptions: ${result.missing.join(", ")}`)
      if (result.source === "manifest_columns")
        lines.push(
          "The model's select list cannot be read as column names (a `*`, an expression with no alias or a UNION), so only the columns the manifest lists are counted; a column the SQL adds beside them is not.",
        )
      return {
        title: `Docs coverage: ${result.model} ${result.percent}%`,
        metadata: { success: true, ...result },
        output: lines.join("\n"),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Docs coverage: ERROR",
        metadata: { success: false, error: msg },
        output: `Failed to read docs coverage: ${msg}`,
      }
    }
  },
})
