import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { SchemaInspectResult } from "../native/types"
// altimate_change start — progressive disclosure suggestions
import { PostConnectSuggestions } from "./post-connect-suggestions"
// altimate_change end
import { resolveInspectionTarget } from "../native/connections/inspection-target"
import { profileValues } from "./schema-values"
import { isRecord, normalizeError } from "./response-normalization"
import { validateTableName, validateWarehouseName } from "./input-validation"
// altimate_change start — workspace precedence
import * as Precedence from "../workspace/precedence"
// altimate_change end

export const SchemaInspectTool = Tool.define("schema_inspect", {
  description: "Inspect database schema — list columns, types, and constraints for a table.",
  parameters: z.object({
    table: z
      .string()
      .describe(
        "Table name (optionally schema-qualified, e.g. public.orders); a warehouse qualifier such as scratch.orders resolves to that warehouse's default schema when no such schema exists",
      ),
    schema_name: z.string().optional().describe("Schema name if not in table string"),
    warehouse: z.string().optional().describe("Warehouse connection name"),
    values: z
      .boolean()
      .optional()
      .describe(
        "Append sampled distinct values, null share and example values per column (default true). Use them to write filters that match the stored format.",
      ),
  }),
  async execute(args, ctx) {
    // Pre-flight validation outranks the redirect, as it does for `sql_explain`: bad
    // input is answered here rather than forwarded to the engine tool, and an empty
    // warehouse string is never read as "the default" by the routing decision.
    const inputError = validateTableName(args.table) ?? validateWarehouseName(args.warehouse)
    if (inputError) {
      return {
        title: "Schema: INVALID INPUT",
        metadata: {
          success: false,
          columnCount: 0,
          rowCount: undefined,
          error: inputError,
          error_class: "input_validation",
        },
        output: `Invalid input: ${inputError}`,
      }
    }
    // altimate_change start — workspace precedence
    let precedence: Precedence.Verdict = {}
    // Every failure exit goes through here, so a fail-open notice cannot be dropped by
    // one path being overlooked — three of the four exits below are errors, and the
    // marker is most needed on exactly those.
    const failed = (message: string) => Precedence.annotate(precedence, schemaError(message))
    // altimate_change end
    try {
      // Strict-schema callers send schema_name: "" for "not specified"; a blank qualifier
      // must mean the engine default, not a schema literally named "".
      const schemaName = args.schema_name?.trim() || undefined
      const target = await resolveInspectionTarget({
        table: args.table,
        schema_name: schemaName,
        warehouse: args.warehouse,
      })
      precedence = await Precedence.check(ctx.sessionID, "schema_inspect", target.warehouse)
      if (precedence.redirect) return precedence.redirect
      const result = (await Dispatcher.call("schema.inspect", {
        table: target.table,
        schema_name: target.schema_name,
        warehouse: target.warehouse,
      })) as unknown

      if (!isRecord(result)) {
        return failed("Invalid schema response from dispatcher.")
      }

      const responseError = normalizeError(result.error)
      if (result.success === false || responseError !== undefined) {
        return failed(responseError?.trim() || "Schema inspection failed.")
      }

      const schemaResult = (isRecord(result.data) ? result.data : result) as Partial<SchemaInspectResult>

      if (target.resolution) schemaResult.resolution = target.resolution

      // A table with no columns does not exist: the handler reports an empty column list as
      // success, which read as a valid empty schema (21 of 44 inspections in one evaluation run).
      if ((schemaResult.columns ?? []).length === 0) {
        const resolvedSchema = schemaResult.schema_name ?? schemaName
        const where = resolvedSchema ? ` in schema "${resolvedSchema}"` : ""
        return failed(
          `${schemaResult.resolution ? `${schemaResult.resolution}. ` : ""}` +
            `Table "${schemaResult.table ?? args.table}" was not found${where} on warehouse "${schemaResult.warehouse ?? args.warehouse ?? "default"}". ` +
            "Check the name and schema (information_schema.tables lists them), or pass schema_name explicitly." +
            (schemaResult.addressing_hint ? ` ${schemaResult.addressing_hint}` : ""),
        )
      }

      // altimate_change start — progressive disclosure suggestions
      let output = formatSchema(schemaResult)
      if (schemaResult.resolution) output = `${schemaResult.resolution}\n\n${output}`
      if (args.values !== false) {
        const resolvedTable = schemaResult.table ?? args.table
        const parts = resolvedTable.includes(".") ? resolvedTable.split(".") : [schemaResult.schema_name, resolvedTable]
        const ref = parts
          .filter((x): x is string => !!x)
          .map(quoteIdent)
          .join(".")
        const profile = await profileValues(
          {
            table: ref,
            columns: schemaResult.columns!,
            warehouse: schemaResult.warehouse ?? target.warehouse,
          },
          ctx,
        )
        if (profile) output += "\n\n" + profile
      }
      const suggestion = PostConnectSuggestions.getProgressiveSuggestion("schema_inspect")
      if (suggestion) {
        output += "\n\n" + suggestion
        PostConnectSuggestions.trackSuggestions({
          suggestionType: "progressive_disclosure",
          suggestionsShown: ["lineage_check"],
          warehouseType: args.warehouse ?? "unknown",
        })
      }
      // altimate_change end
      // altimate_change — attaches the fail-open notice when present; no-op otherwise.
      return Precedence.annotate(precedence, {
        title: `Schema: ${schemaResult.table ?? args.table}`,
        metadata: { success: true, columnCount: (schemaResult.columns ?? []).length, rowCount: schemaResult.row_count },
        output,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return failed(msg)
    }
  },
})

const quoteIdent = (id: string) => `"${id.replace(/"/g, '""')}"`

function schemaError(msg: string) {
  return {
    title: "Schema: ERROR",
    metadata: { success: false, columnCount: 0, rowCount: undefined, error: msg },
    output: `Failed to inspect schema: ${msg}\n\nEnsure the dispatcher is running and a warehouse connection is configured.`,
  }
}

function formatSchema(result: Partial<SchemaInspectResult>): string {
  const lines: string[] = []
  const table = result.table ?? "unknown"
  const qualified = result.schema_name ? `${result.schema_name}.${table}` : table
  lines.push(`Table: ${qualified}`)
  if (result.row_count !== null && result.row_count !== undefined) {
    lines.push(`Rows: ${result.row_count.toLocaleString()}`)
  }
  lines.push("")
  lines.push("Column | Type | Nullable | PK")
  lines.push("-------|------|----------|---")
  for (const col of result.columns ?? []) {
    lines.push(
      `${col.name} | ${col.data_type ?? "unknown"} | ${col.nullable ? "YES" : "NO"} | ${col.primary_key ? "YES" : ""}`,
    )
  }
  return lines.join("\n")
}
