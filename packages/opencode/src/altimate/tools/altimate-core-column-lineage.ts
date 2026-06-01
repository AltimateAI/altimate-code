import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import { isRecord, normalizeError } from "./response-normalization"

export const AltimateCoreColumnLineageTool = Tool.define("altimate_core_column_lineage", {
  description:
    "Trace schema-aware column lineage. Maps how columns flow through a query from source tables to output. Requires altimate_core.init() with API key. Provide schema_context or schema_path for accurate table/column resolution.",
  parameters: z.object({
    sql: z.string().describe("SQL query to trace lineage for"),
    dialect: z.string().optional().describe("SQL dialect (e.g. snowflake, bigquery)"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const rawResult = (await Dispatcher.call("altimate_core.column_lineage", {
        sql: args.sql,
        dialect: args.dialect ?? "",
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })) as unknown
      if (!isRecord(rawResult)) {
        return columnLineageError("Invalid column lineage response from dispatcher.")
      }

      const result = rawResult as Record<string, any>
      const data = (isRecord(result.data) ? result.data : result) as Record<string, any>
      const edgeCount = data.column_lineage?.length ?? 0
      const error = normalizeError(result.error) ?? normalizeError(data.error)
      const failureMessage = error?.trim() || "Column lineage failed."
      const isFailure = error !== undefined || result.success === false || data.success === false
      return {
        title: isFailure ? "Column Lineage: ERROR" : `Column Lineage: ${edgeCount} edge(s)`,
        metadata: { success: !isFailure, edge_count: edgeCount, ...(isFailure && { error: failureMessage }) },
        output: isFailure ? `Failed: ${failureMessage}` : formatColumnLineage(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return columnLineageError(msg)
    }
  },
})

function columnLineageError(msg: string) {
  return {
    title: "Column Lineage: ERROR",
    metadata: { success: false, edge_count: 0, error: msg },
    output: `Failed: ${msg}`,
  }
}

function formatColumnLineage(data: Record<string, any>): string {
  const dataError = normalizeError(data.error)
  if (dataError) return `Error: ${dataError}`
  if (!data.column_lineage?.length && !data.column_dict) return "No column lineage edges found."
  const lines: string[] = []

  // column_dict: output columns -> source columns mapping
  if (data.column_dict && Object.keys(data.column_dict).length > 0) {
    lines.push("Column Mappings:")
    for (const [target, sources] of Object.entries(data.column_dict)) {
      lines.push(`  ${target} ← ${formatLineageValue(sources)}`)
    }
    lines.push("")
  }

  if (data.column_lineage?.length) {
    lines.push("Lineage Edges:")
    for (const edge of data.column_lineage) {
      const source = formatLineageEndpoint(edge, "source")
      const target = formatLineageEndpoint(edge, "target")
      const transform = formatLineageValue(edge.lens_type ?? edge.transform_type ?? edge.transform ?? "")
      lines.push(`  ${source} → ${target}${transform ? ` (${transform})` : ""}`)
    }
  }

  return lines.length ? lines.join("\n") : "No column lineage edges found."
}

function formatLineageEndpoint(edge: Record<string, any>, side: "source" | "target"): string {
  if (edge[side] !== null && edge[side] !== undefined) return formatLineageValue(edge[side])

  const table = edge[`${side}_table`] ?? edge[`${side}Table`]
  const column = edge[`${side}_column`] ?? edge[`${side}Column`]
  if (table !== null && table !== undefined && column !== null && column !== undefined) {
    return `${formatLineageValue(table)}.${formatLineageValue(column)}`
  }
  return "?"
}

function formatLineageValue(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)

  if (Array.isArray(value)) {
    return value.map(formatLineageValue).filter(Boolean).join(", ")
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    const table = obj.source_table ?? obj.sourceTable ?? obj.target_table ?? obj.targetTable ?? obj.table
    const column = obj.source_column ?? obj.sourceColumn ?? obj.target_column ?? obj.targetColumn ?? obj.column ?? obj.name
    if (table !== null && table !== undefined && column !== null && column !== undefined) {
      return `${formatLineageValue(table)}.${formatLineageValue(column)}`
    }
    if (obj.source !== null && obj.source !== undefined) return formatLineageValue(obj.source)
    if (obj.target !== null && obj.target !== undefined) return formatLineageValue(obj.target)
    try {
      return JSON.stringify(value)
    } catch {
      return "unserializable object"
    }
  }

  return String(value)
}
