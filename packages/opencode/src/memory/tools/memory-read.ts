import z from "zod"
import { Tool } from "../../tool/tool"
import { MemoryStore, isExpired } from "../store"
import { MemoryPrompt } from "../prompt"
import { MemoryBlockSchema } from "../types"

export const MemoryReadTool = Tool.define("altimate_memory_read", {
  description:
    "Read Altimate Memory blocks from previous sessions. Use this to recall warehouse configurations, naming conventions, team preferences, and past analysis decisions. Supports filtering by scope (global/project) and tags. Expired blocks are hidden by default.",
  parameters: z.object({
    scope: z
      .enum(["global", "project", "all"])
      .optional()
      .default("all")
      .describe("Which scope to read from: 'global' for user-wide, 'project' for current project, 'all' for both"),
    tags: z
      .array(z.string())
      .optional()
      .default([])
      .describe("Filter blocks to only those containing all specified tags"),
    id: MemoryBlockSchema.shape.id.optional().describe("Read a specific block by ID (supports hierarchical IDs like 'warehouse/snowflake')"),
    include_expired: z.boolean().optional().default(false).describe("Include expired memory blocks in results"),
  }),
  async execute(args, ctx) {
    try {
      if (args.id) {
        const scopes: Array<"global" | "project"> =
          args.scope === "all" ? ["project", "global"] : [args.scope as "global" | "project"]

        for (const scope of scopes) {
          const block = await MemoryStore.read(scope, args.id)
          if (block) {
            // Respect include_expired for ID reads
            if (!args.include_expired && isExpired(block)) continue
            return {
              title: `Memory: ${block.id} (${block.scope})`,
              metadata: { count: 1 },
              output: MemoryPrompt.formatBlock(block),
            }
          }
        }
        return {
          title: "Memory: not found",
          metadata: { count: 0 },
          output: `No memory block found with ID "${args.id}"`,
        }
      }

      const listOpts = { includeExpired: args.include_expired }
      let blocks =
        args.scope === "all"
          ? await MemoryStore.listAll(listOpts)
          : await MemoryStore.list(args.scope as "global" | "project", listOpts)

      if (args.tags && args.tags.length > 0) {
        blocks = blocks.filter((b) => args.tags!.every((tag) => b.tags.includes(tag)))
      }

      if (blocks.length === 0) {
        return {
          title: "Memory: empty",
          metadata: { count: 0 },
          output: "No memory blocks found. Use altimate_memory_write to save information for future sessions.",
        }
      }

      const formatted = blocks.map((b) => MemoryPrompt.formatBlock(b)).join("\n\n")
      return {
        title: `Memory: ${blocks.length} block(s)`,
        metadata: { count: blocks.length },
        output: formatted,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Memory Read: ERROR",
        metadata: { count: 0 },
        output: `Failed to read memory: ${msg}`,
      }
    }
  },
})
