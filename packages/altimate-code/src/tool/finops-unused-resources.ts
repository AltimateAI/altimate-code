import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

function formatUnusedResources(
  summary: Record<string, unknown>,
  unusedTables: unknown[],
  idleWarehouses: unknown[],
): string {
  const lines: string[] = []
  const tableCount = Number(summary.unused_table_count ?? 0)
  const warehouseCount = Number(summary.idle_warehouse_count ?? 0)

  lines.push("Unused Resources Summary")
  lines.push("".padEnd(50, "="))
  lines.push(`Unused tables: ${tableCount}`)
  lines.push(`Idle warehouses: ${warehouseCount}`)
  if (summary.potential_savings !== undefined) {
    lines.push(`Estimated potential savings: ${summary.potential_savings} credits`)
  }
  lines.push("")

  const tables = Array.isArray(unusedTables) ? unusedTables : []
  if (tables.length > 0) {
    lines.push("Unused Tables")
    lines.push("".padEnd(50, "-"))
    for (const t of tables) {
      const r = t as Record<string, unknown>
      const name = String(r.table_name ?? r.name ?? "unknown")
      const schema = r.table_schema ?? r.schema ?? ""
      const db = r.table_catalog ?? r.database ?? ""
      const fullName = [db, schema, name].filter(Boolean).join(".")
      const lastAccess = r.last_accessed ?? r.last_access_date ?? "never"
      const rowCount = r.row_count !== undefined ? ` (${r.row_count} rows)` : ""
      lines.push(`- ${fullName} | Last accessed: ${lastAccess}${rowCount}`)
    }
    lines.push("")
  }

  const warehouses = Array.isArray(idleWarehouses) ? idleWarehouses : []
  if (warehouses.length > 0) {
    lines.push("Idle Warehouses")
    lines.push("".padEnd(50, "-"))
    for (const w of warehouses) {
      const r = w as Record<string, unknown>
      const name = String(r.warehouse_name ?? r.name ?? "unknown")
      const daysIdle = r.days_idle ?? r.idle_days ?? "unknown"
      const size = r.warehouse_size ?? r.size ?? ""
      const sizeStr = size ? ` (size: ${size})` : ""
      lines.push(`- ${name} | Days idle: ${daysIdle}${sizeStr}`)
    }
  }

  if (tables.length === 0 && warehouses.length === 0) {
    lines.push("No unused resources found - all resources are active.")
  }

  return lines.join("\n")
}

export const FinopsUnusedResourcesTool = Tool.define("finops_unused_resources", {
  description:
    "Find unused tables and idle warehouses to reduce costs. Identifies stale tables not accessed recently and warehouses with no query activity. Snowflake only.",
  parameters: z.object({
    warehouse: z.string().describe("Warehouse connection name"),
    days: z.number().optional().default(30).describe("Days of inactivity threshold"),
    limit: z.number().optional().default(50).describe("Max resources to return"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("finops.unused_resources", {
        warehouse: args.warehouse,
        days: args.days,
        limit: args.limit,
      })

      if (!result.success) {
        return {
          title: "Unused Resources: FAILED",
          metadata: { success: false, unused_count: 0 },
          output: `Failed to find unused resources: ${result.error ?? "Unknown error"}`,
        }
      }

      const summary = result.summary as Record<string, unknown>
      const total = ((summary.unused_table_count as number) ?? 0) + ((summary.idle_warehouse_count as number) ?? 0)

      return {
        title: `Unused Resources: ${total} found`,
        metadata: { success: true, unused_count: total },
        output: formatUnusedResources(
          summary,
          result.unused_tables as unknown[],
          result.idle_warehouses as unknown[],
        ),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Unused Resources: ERROR",
        metadata: { success: false, unused_count: 0 },
        output: `Failed to find unused resources: ${msg}`,
      }
    }
  },
})
