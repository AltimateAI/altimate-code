import z from "zod"
import { Tool } from "../../tool/tool"
import { MemoryStore, isExpired } from "../store"
import { MemoryPrompt, mergeOverlay } from "../prompt"
// altimate_change - workspace memory overlay
import { overlayBlocks, whenHydrated, type RemoteMemoryBlock } from "@/altimate/workspace/memory-sync"
import { MemoryBlockSchema, type MemoryBlock } from "../types"

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
      // altimate_change start — this session's workspace memory, resolved once
      // for both branches. Reading only the local store made this tool disagree
      // with what the model was actually given: injection merges the overlay.
      let remote: RemoteMemoryBlock[] = []
      if (ctx?.sessionID) {
        await whenHydrated(ctx.sessionID)
        remote = overlayBlocks(ctx.sessionID).filter((b) => {
          if (args.scope !== "all" && b.scope !== args.scope) return false
          // Overlay blocks are expiry-checked at hydrate time and never again,
          // so honour include_expired here as the local list does.
          return args.include_expired || !isExpired(b)
        })
      }
      // altimate_change end
      if (args.id) {
        const scopes: Array<"global" | "project"> =
          args.scope === "all" ? ["project", "global"] : [args.scope as "global" | "project"]

        const matches: (MemoryBlock & { origin?: string })[] = []
        for (const scope of scopes) {
          // Narrowly suppressed: probing BOTH scopes is our choice, not the
          // caller's, and project scope throws outside an instance context --
          // that must not hide a global or workspace match. A scope the caller
          // asked for explicitly failing is a real error they need to see,
          // rather than a misleading "not found".
          let block: MemoryBlock | undefined
          try {
            block = await MemoryStore.read(scope, args.id)
          } catch (e) {
            if (args.scope === "all" && scope === "project") continue
            throw e
          }
          if (!block) continue
          // Respect include_expired for ID reads
          if (!args.include_expired && isExpired(block)) continue
          matches.push(block)
        }
        // altimate_change start — a workspace-only block is in the model's
        // prompt, so it will be looked up by id; answering "not found" for a
        // block the model is holding is the exact disagreement this closes.
        // Sibling projects may legitimately share an id, so return every match.
        const localKeys = new Set(matches.map((b) => `${b.scope}:${b.id}`))
        for (const block of remote) {
          if (block.id !== args.id) continue
          if (block.origin === undefined && localKeys.has(`${block.scope}:${block.id}`)) continue
          matches.push(block)
        }
        // altimate_change end
        if (matches.length === 0) {
          return {
            title: "Memory: not found",
            metadata: { count: 0 },
            output: `No memory block found with ID "${args.id}"`,
          }
        }
        return {
          title:
            matches.length === 1
              ? `Memory: ${matches[0].id} (${matches[0].scope})`
              : `Memory: ${args.id} (${matches.length} blocks)`,
          metadata: { count: matches.length },
          output: matches.map((b) => MemoryPrompt.formatBlock(b)).join("\n\n"),
        }
      }

      const listOpts = { includeExpired: args.include_expired }
      let blocks =
        args.scope === "all"
          ? await MemoryStore.listAll(listOpts)
          : await MemoryStore.list(args.scope as "global" | "project", listOpts)

      // altimate_change - fold in this session's workspace memory (resolved above)
      if (remote.length > 0) blocks = mergeOverlay(blocks, remote)

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
