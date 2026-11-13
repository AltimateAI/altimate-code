import fs from "fs"
import path from "path"
import z from "zod"
import { Tool } from "../../tool/tool"
import { dbtAdapterFor } from "./dbt-adapter-access"
import { findModel, loadRawManifest } from "../native/dbt/helpers"

/** The units dbt-bigquery's `format_bytes` writes, smallest first; each is 1024 times the one before. */
const UNITS = ["Bytes", "KiB", "MiB", "GiB", "TiB", "PiB"] as const

/**
 * The byte count in a dry run's `bytes_processed`, which dbt-bigquery formats as text ("4.2 TiB",
 * "512.0 Bytes"). The text carries one decimal, so a figure past a KiB is an approximation. Undefined
 * for anything else, so a changed format is reported, never read as a count.
 */
export function parseBytesProcessed(display: unknown): number | undefined {
  if (typeof display === "number") return Number.isFinite(display) && display >= 0 ? Math.round(display) : undefined
  if (typeof display !== "string") return undefined
  const match = /^\s*(\d+(?:\.\d+)?)\s*(Bytes|KiB|MiB|GiB|TiB|PiB)\s*$/i.exec(display)
  if (!match) return undefined
  const unit = UNITS.findIndex((u) => u.toLowerCase() === match[2].toLowerCase())
  return Math.round(Number(match[1]) * 1024 ** unit)
}

/** The SQL a model's file holds, as Power User reads it, or the manifest's copy when the file is gone. */
async function modelSource(model: string, root: string | undefined): Promise<{ sql?: string; name?: string; error?: string }> {
  const manifestPath = path.join(root ?? "", "target", "manifest.json")
  let node: any
  try {
    node = findModel(loadRawManifest(manifestPath)?.nodes ?? {}, model)
  } catch (e) {
    return { error: `couldn't read ${manifestPath}: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!node) return { error: `no model "${model}" in ${manifestPath}: run dbt parse or dbt compile first` }
  const file = root && node.original_file_path ? path.join(root, node.original_file_path) : undefined
  let sql: string | undefined
  try {
    if (file) sql = fs.readFileSync(file, "utf-8")
  } catch {}
  sql ??= typeof node.raw_code === "string" ? node.raw_code : undefined
  return sql?.trim() ? { sql, name: node.name } : { error: `model "${model}" has no SQL` }
}

function failure(title: string, message: string, extra: Record<string, unknown> = {}) {
  return { title: `dbt_cost_estimate: ${title}`, metadata: { success: false, error: message, ...extra }, output: message }
}

export const DbtCostEstimateTool = Tool.define("dbt_cost_estimate", {
  description:
    "Estimate the bytes a dbt model or a SQL query would scan, from a warehouse dry run. Only BigQuery has a dry run: any other warehouse answers `supported: false` and nothing is compiled. Starts the dbt adapter, so it needs write permission (`--allow-write` on `tool run`). Pass `model` (a model name; its file is compiled) or `sql` (may use Jinja).",
  parameters: z.object({
    model: z.string().optional().describe("Model name to compile and estimate"),
    sql: z.string().optional().describe("SQL (may use Jinja) to compile and estimate"),
  }),
  async execute(args, ctx) {
    if (!args.model && !args.sql) return failure("nothing to estimate", "Pass a model name or SQL.")
    const access = await dbtAdapterFor(ctx)
    if (!access.adapter) return failure("not available", `No estimate: ${access.reason}.`, { refusal: access.refusal })
    const adapter = access.adapter
    const type: string | undefined = adapter.getAdapterType?.()
    // Every dbt-integration refuses the dry run off BigQuery, so nothing is compiled there.
    if (type !== "bigquery") {
      const adapterName = type ?? "unknown"
      return {
        title: "dbt_cost_estimate: no estimate",
        metadata: { success: true, supported: false, adapter: adapterName },
        output: `No cost estimate: dry runs are only available on BigQuery (this project uses ${adapterName}).`,
      }
    }
    try {
      let query = args.sql
      let name = args.model
      if (!query) {
        const root = await (await import("../native/connections/register")).getDbtProjectRoot()
        const source = await modelSource(args.model!, root)
        if (!source.sql) return failure("model not found", source.error ?? "No SQL to estimate.", { adapter: type })
        query = source.sql
        name = source.name ?? name
      }
      ctx.abort.throwIfAborted()
      const compiled = await adapter.unsafeCompileQuery(query, name)
      ctx.abort.throwIfAborted()
      if (typeof compiled !== "string" || !compiled.trim()) {
        return failure("compile failed", "The query compiled to nothing.", { adapter: type })
      }
      const result = await adapter.validateSQLDryRun(compiled)
      ctx.abort.throwIfAborted()
      const display = result?.bytes_processed
      const bytes = parseBytesProcessed(display)
      if (bytes === undefined) {
        return failure("unreadable estimate", `The dry run returned an amount this tool can't read: ${JSON.stringify(display)}.`, {
          adapter: type,
        })
      }
      return {
        title: `dbt_cost_estimate: ${display}`,
        metadata: { success: true, supported: true, adapter: type, bytes, display: String(display), ...(name && { model: name }) },
        output: `${name ? `${name} ` : "The query "}would process ${display} (about ${bytes} bytes).`,
      }
    } catch (e) {
      if (ctx.abort.aborted) throw e
      return failure("dry run failed", e instanceof Error ? e.message : String(e), { adapter: type })
    }
  },
})
