import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

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
        output: JSON.stringify({ tag_summary: result.tag_summary, tags: result.tags }, null, 2),
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
        output: JSON.stringify(result.tags, null, 2),
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
