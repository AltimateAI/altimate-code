import z from "zod"
import { Tool } from "../../tool/tool"
import { MemoryStore } from "../store"
import { MEMORY_MAX_BLOCK_SIZE, MEMORY_MAX_BLOCKS_PER_SCOPE } from "../types"

export const MemoryWriteTool = Tool.define("memory_write", {
  description: `Create or update a persistent memory block. Use this to save information worth remembering across sessions — warehouse configurations, naming conventions, team preferences, data model notes, or past analysis decisions. Each block is a Markdown file persisted to disk. Max ${MEMORY_MAX_BLOCK_SIZE} chars per block, ${MEMORY_MAX_BLOCKS_PER_SCOPE} blocks per scope.`,
  parameters: z.object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9_-]*$/)
      .describe(
        "Unique identifier for this memory block (lowercase, hyphens/underscores). Examples: 'warehouse-config', 'naming-conventions', 'dbt-patterns'",
      ),
    scope: z
      .enum(["global", "project"])
      .describe("'global' for user-wide preferences, 'project' for project-specific knowledge"),
    content: z
      .string()
      .min(1)
      .max(MEMORY_MAX_BLOCK_SIZE)
      .describe("Markdown content to store. Keep concise and structured."),
    tags: z
      .array(z.string().max(64))
      .max(10)
      .optional()
      .default([])
      .describe("Tags for categorization and filtering (e.g., ['warehouse', 'snowflake'])"),
  }),
  async execute(args, ctx) {
    try {
      const existing = await MemoryStore.read(args.scope, args.id)
      const now = new Date().toISOString()

      await MemoryStore.write({
        id: args.id,
        scope: args.scope,
        tags: args.tags ?? [],
        created: existing?.created ?? now,
        updated: now,
        content: args.content,
      })

      const action = existing ? "Updated" : "Created"
      return {
        title: `Memory: ${action} "${args.id}"`,
        metadata: { action: action.toLowerCase(), id: args.id, scope: args.scope },
        output: `${action} memory block "${args.id}" in ${args.scope} scope.`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Memory Write: ERROR",
        metadata: { action: "error", id: args.id, scope: args.scope },
        output: `Failed to write memory: ${msg}`,
      }
    }
  },
})
