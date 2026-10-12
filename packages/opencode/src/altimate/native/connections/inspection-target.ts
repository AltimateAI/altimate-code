// altimate_change start — resolve schema aliases before applying workspace routing
import * as Registry from "./registry"
import type { SchemaInspectParams } from "../types"

export function defaultInspectionSchema(warehouse: string): string | undefined {
  const config = Registry.getConfig(warehouse)
  const type = Registry.canonicalType(config?.type)
  const configured = type === "bigquery" ? config?.dataset : type === "mysql" ? config?.database : config?.schema
  if (typeof configured === "string" && configured) return configured
  if (type === "duckdb" || type === "sqlite") return "main"
  if (type === "postgres" || type === "redshift") return "public"
  return undefined
}

export async function resolveInspectionTarget(params: SchemaInspectParams) {
  const warehouse = params.warehouse ?? Registry.list().warehouses[0]?.name
  const schema_name = params.schema_name?.trim() || undefined
  const original = { ...params, warehouse, schema_name, resolution: undefined as string | undefined }
  const qualifier = params.table.includes(".") ? params.table.slice(0, params.table.indexOf(".")) : undefined
  const alias = schema_name ?? qualifier
  if (params.warehouse !== undefined || !alias || !Registry.list().warehouses.some((w) => w.name === alias))
    return original
  if (!warehouse) return original
  // Real schemas take precedence over an equally named connection. This only opens
  // the original target; the resolved target is opened after its routing check.
  const schemas = await (await Registry.get(warehouse)).listSchemas()
  if (schemas.includes(alias)) return original
  const schema = defaultInspectionSchema(alias)
  if (!schema)
    throw new Error(`Default schema for warehouse "${alias}" is not configured. Pass schema_name explicitly.`)
  return {
    ...original,
    warehouse: alias,
    schema_name: schema,
    table: qualifier === alias ? params.table.slice(alias.length + 1) : params.table,
    resolution: `Resolved "${alias}" as the ${alias} warehouse (schema ${schema})`,
  }
}
// altimate_change end
