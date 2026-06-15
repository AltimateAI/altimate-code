import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import { isRecord, normalizeError } from "./response-normalization"
import { DE_SQL } from "../observability/de-attributes"

export const AltimateCoreColumnLineageTool = Tool.define("altimate_core_column_lineage", {
  description:
    "Trace schema-aware column lineage. Maps how columns flow through a query from source tables to output. Runs fully offline via the native engine — no API key or account required. Provide schema_context or schema_path for accurate table/column resolution.",
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

      // altimate_change start — trace augmentation: emit structured lineage on
      // the de.* metadata channel. Higher fidelity than the annotator's regex
      // extraction since it comes from altimate-core's real parser.
      //
      // Prefer structured `source_table`/`source_column` / `target_table`/
      // `target_column` fields when altimate-core supplies them — that
      // preserves quoted/case-sensitive identifiers. Fall back to splitting
      // a dotted endpoint string only when the structured fields are absent.
      const lineageAttrs: Record<string, unknown> = {}
      if (!isFailure) {
        const inputTables = new Set<string>()
        const outputs = new Set<string>()
        const colsRead = new Set<string>()
        const colsWritten = new Set<string>()

        const extractTable = (edge: Record<string, any>, side: "source" | "target"): string | undefined => {
          const direct = edge[`${side}_table`] ?? edge[`${side}Table`]
          if (typeof direct === "string" && direct) return direct
          if (typeof direct === "object" && direct !== null) {
            const obj = direct as Record<string, unknown>
            const t = obj.table ?? obj.name
            if (typeof t === "string" && t) return t
          }
          const endpoint = edge[side]
          if (typeof endpoint === "string" && endpoint.includes(".")) {
            // Strip the trailing column segment; preserve original case
            return endpoint.split(".").slice(0, -1).join(".") || undefined
          }
          return undefined
        }
        const extractColumn = (edge: Record<string, any>, side: "source" | "target"): string | undefined => {
          const direct = edge[`${side}_column`] ?? edge[`${side}Column`]
          if (typeof direct === "string" && direct) return direct
          const endpoint = edge[side]
          if (typeof endpoint === "string") {
            // Strip the table prefix when falling back to a dotted endpoint
            // string so this returns only the column — matching the structured
            // path above. Without this, `columns_read` would mix bare
            // column names (from `source_column`) with fully-qualified
            // strings (from `source` as fallback), breaking deduplication.
            const lastDot = endpoint.lastIndexOf(".")
            return lastDot >= 0 ? endpoint.slice(lastDot + 1) : endpoint
          }
          if (typeof endpoint === "object" && endpoint !== null) {
            const obj = endpoint as Record<string, unknown>
            const c = obj.column ?? obj.name
            if (typeof c === "string" && c) return c
          }
          return undefined
        }

        // Guard with Array.isArray — the `?? []` fallback only handles
        // null/undefined. If the dispatcher returns a non-array shape we
        // skip lineage extraction rather than throwing in the for-of.
        // Use unknown[] at the array boundary and narrow per element with
        // isRecord — Array.isArray only proves array, not array-of-records.
        const edges: unknown[] = Array.isArray(data.column_lineage) ? data.column_lineage : []
        for (const edge of edges) {
          if (!isRecord(edge)) continue
          const srcTable = extractTable(edge, "source")
          const tgtTable = extractTable(edge, "target")
          const srcCol = extractColumn(edge, "source")
          const tgtCol = extractColumn(edge, "target")
          if (srcTable) inputTables.add(srcTable)
          if (tgtTable) outputs.add(tgtTable)
          if (srcCol) colsRead.add(srcCol)
          if (tgtCol) colsWritten.add(tgtCol)
        }
        if (inputTables.size > 0) lineageAttrs[DE_SQL.LINEAGE_INPUT_TABLES] = [...inputTables].slice(0, 50)
        // Keep output_table scalar — Codex chunk-3 review #5: don't switch attribute
        // type to array when there are multiple outputs. Omit the attribute instead.
        if (outputs.size === 1) lineageAttrs[DE_SQL.LINEAGE_OUTPUT_TABLE] = [...outputs][0]
        if (colsRead.size > 0) lineageAttrs[DE_SQL.LINEAGE_COLUMNS_READ] = [...colsRead].slice(0, 100)
        if (colsWritten.size > 0) lineageAttrs[DE_SQL.LINEAGE_COLUMNS_WRITTEN] = [...colsWritten].slice(0, 100)
        if (args.dialect) lineageAttrs[DE_SQL.DIALECT] = args.dialect
      }
      // altimate_change end

      return {
        title: isFailure ? "Column Lineage: ERROR" : `Column Lineage: ${edgeCount} edge(s)`,
        metadata: {
          success: !isFailure,
          edge_count: edgeCount,
          ...(isFailure && { error: failureMessage }),
          ...lineageAttrs,
        },
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
