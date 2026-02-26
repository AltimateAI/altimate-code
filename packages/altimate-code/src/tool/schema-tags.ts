import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

function formatTags(tagSummary: unknown, tags: unknown[]): string {
  const lines: string[] = []
  const arr = Array.isArray(tags) ? tags : []

  if (arr.length === 0) {
    return "No tags found."
  }

  // Group tags by tag name
  const grouped = new Map<string, Array<Record<string, unknown>>>()
  for (const t of arr) {
    const r = t as Record<string, unknown>
    const tagName = String(r.tag_name ?? r.name ?? "unknown")
    if (!grouped.has(tagName)) grouped.set(tagName, [])
    grouped.get(tagName)!.push(r)
  }

  lines.push("Tags by Name")
  lines.push("".padEnd(50, "="))

  for (const [tagName, entries] of grouped) {
    lines.push(`[${tagName}] (${entries.length} object${entries.length !== 1 ? "s" : ""})`)
    for (const entry of entries) {
      const objName = String(entry.object_name ?? entry.object ?? "-")
      const objType = entry.object_type ? ` (${entry.object_type})` : ""
      const tagValue = entry.tag_value !== undefined && entry.tag_value !== null ? ` = ${entry.tag_value}` : ""
      lines.push(`  - ${objName}${objType}${tagValue}`)
    }
    lines.push("")
  }

  if (tagSummary && typeof tagSummary === "object") {
    const summary = tagSummary as Record<string, unknown>
    const entries = Object.entries(summary)
    if (entries.length > 0) {
      lines.push("Tag Summary")
      lines.push("".padEnd(50, "-"))
      for (const [key, val] of entries) {
        lines.push(`  ${key}: ${val}`)
      }
    }
  }

  return lines.join("\n")
}

function formatTagsList(tags: unknown[]): string {
  const arr = Array.isArray(tags) ? tags : []
  if (arr.length === 0) return "No tags found."

  const lines: string[] = []
  lines.push("Available Tags")
  lines.push("".padEnd(50, "="))
  lines.push("Tag Name | Database | Schema | Usage Count")
  lines.push("---------|----------|--------|------------")

  for (const t of arr) {
    const r = t as Record<string, unknown>
    const name = String(r.tag_name ?? r.name ?? "unknown")
    const db = String(r.tag_database ?? r.database ?? "-")
    const schema = String(r.tag_schema ?? r.schema ?? "-")
    const count = r.usage_count ?? r.object_count ?? r.count ?? "-"
    lines.push(`${name} | ${db} | ${schema} | ${count}`)
  }

  return lines.join("\n")
}

export const SchemaTagsTool = Tool.define("schema_tags", {
  description:
    "Query metadata/governance tags on database objects. Shows tag names, values, and which objects they're applied to. Snowflake only (uses TAG_REFERENCES).",
  parameters: z.object({
    warehouse: z.string().describe("Warehouse connection name"),
    object_name: z.string().optional().describe("Filter to tags on a specific object (e.g., db.schema.table)"),
    tag_name: z.string().optional().describe("Filter to a specific tag name"),
    limit: z.number().optional().default(100).describe("Max results"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("schema.tags", {
        warehouse: args.warehouse,
        object_name: args.object_name,
        tag_name: args.tag_name,
        limit: args.limit,
      })

      if (!result.success) {
        return {
          title: "Tags: FAILED",
          metadata: { success: false, tag_count: 0 },
          output: `Failed to query tags: ${result.error ?? "Unknown error"}`,
        }
      }

      return {
        title: `Tags: ${result.tag_count} found`,
        metadata: { success: true, tag_count: result.tag_count },
        output: formatTags(result.tag_summary, result.tags as unknown[]),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Tags: ERROR",
        metadata: { success: false, tag_count: 0 },
        output: `Failed to query tags: ${msg}`,
      }
    }
  },
})

export const SchemaTagsListTool = Tool.define("schema_tags_list", {
  description: "List all available metadata tags in the warehouse with usage counts. Snowflake only.",
  parameters: z.object({
    warehouse: z.string().describe("Warehouse connection name"),
    limit: z.number().optional().default(50).describe("Max tags to return"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("schema.tags_list", {
        warehouse: args.warehouse,
        limit: args.limit,
      })

      if (!result.success) {
        return {
          title: "Tags List: FAILED",
          metadata: { success: false, tag_count: 0 },
          output: `Failed to list tags: ${result.error ?? "Unknown error"}`,
        }
      }

      return {
        title: `Tags List: ${result.tag_count} tags`,
        metadata: { success: true, tag_count: result.tag_count },
        output: formatTagsList(result.tags as unknown[]),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Tags List: ERROR",
        metadata: { success: false, tag_count: 0 },
        output: `Failed to list tags: ${msg}`,
      }
    }
  },
})
