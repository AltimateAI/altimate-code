import z from "zod"
import { Tool } from "../../tool/tool"
import { MemoryStore } from "../store"
import { MEMORY_MAX_BLOCK_SIZE, MEMORY_MAX_BLOCKS_PER_SCOPE, CitationSchema, MemoryBlockSchema } from "../types"

const idSchema = MemoryBlockSchema.shape.id

export const MemoryWriteTool = Tool.define("altimate_memory_write", {
  description: `Save an Altimate Memory block for cross-session persistence. Use this to store information worth remembering across sessions — warehouse configurations, naming conventions, team preferences, data model notes, or past analysis decisions. Each block is a Markdown file persisted to disk. Max ${MEMORY_MAX_BLOCK_SIZE} chars per block, ${MEMORY_MAX_BLOCKS_PER_SCOPE} blocks per scope. Supports hierarchical IDs with slashes (e.g., 'warehouse/snowflake-config'), optional TTL expiration, and citation-backed memories.`,
  parameters: z.object({
    id: idSchema
      .describe(
        "Unique identifier for this memory block (lowercase, hyphens/underscores/slashes for namespaces). Examples: 'warehouse-config', 'warehouse/snowflake', 'conventions/dbt-naming'",
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
    expires: z
      .string()
      .datetime()
      .optional()
      .describe("Optional ISO datetime when this memory should expire. Omit for permanent memories. Example: '2026-06-01T00:00:00.000Z'"),
    citations: z
      .array(CitationSchema)
      .max(10)
      .optional()
      .describe("Optional source references backing this memory. Each citation has a file path, optional line number, and optional note."),
  }),
  async execute(args, ctx) {
    try {
      const existing = await MemoryStore.read(args.scope, args.id)
      const now = new Date().toISOString()

      const { duplicates } = await MemoryStore.write({
        id: args.id,
        scope: args.scope,
        tags: args.tags ?? [],
        created: existing?.created ?? now,
        updated: now,
        expires: args.expires,
        citations: args.citations,
        content: args.content,
      })

      const action = existing ? "Updated" : "Created"
      let output = `${action} memory block "${args.id}" in ${args.scope} scope.`

      if (args.expires) {
        output += `\nExpires: ${args.expires}`
      }

      if (args.citations && args.citations.length > 0) {
        output += `\nCitations: ${args.citations.length} source(s) attached.`
      }

      if (duplicates.length > 0) {
        output += `\n\n⚠ Potential duplicates detected (overlapping tags):\n`
        output += duplicates.map((d) => `  - "${d.id}" [${d.tags.join(", ")}]`).join("\n")
        output += `\nConsider merging these blocks or updating the existing one instead.`
      }

      return {
        title: `Memory: ${action} "${args.id}"`,
        metadata: { action: action.toLowerCase(), id: args.id, scope: args.scope, duplicates: duplicates.length },
        output,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Memory Write: ERROR",
        metadata: { action: "error", id: args.id, scope: args.scope, duplicates: 0 },
        output: `Failed to write memory: ${msg}`,
      }
    }
  },
})
