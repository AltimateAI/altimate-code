import z from "zod"
import { Tool } from "../../tool/tool"
import { MemoryStore } from "../store"
import { MemoryBlockSchema } from "../types"

const idSchema = MemoryBlockSchema.shape.id

export const MemoryExtractTool = Tool.define("altimate_memory_extract", {
  description:
    "Extract and save key facts from the current session as Altimate Memory blocks. This is an opt-in tool for session-end memory extraction — call it manually or configure it to run at session end. It saves structured facts the agent discovered during the session (warehouse configs found via /discover, query patterns from sql_optimize, naming conventions observed, etc.).",
  parameters: z.object({
    facts: z
      .array(
        z.object({
          id: idSchema,
          scope: z.enum(["global", "project"]),
          content: z.string().min(1).max(2048),
          tags: z.array(z.string().max(64)).max(10).optional().default([]),
          citations: z
            .array(
              z.object({
                file: z.string().min(1).max(512),
                line: z.number().int().positive().optional(),
                note: z.string().max(256).optional(),
              }),
            )
            .max(10)
            .optional(),
        }),
      )
      .min(1)
      .max(10)
      .describe("Array of facts to extract and save as memory blocks"),
  }),
  async execute(args, ctx) {
    const results: string[] = []
    let saved = 0
    let skipped = 0

    for (const fact of args.facts) {
      try {
        const existing = await MemoryStore.read(fact.scope, fact.id)
        const now = new Date().toISOString()

        await MemoryStore.write({
          id: fact.id,
          scope: fact.scope,
          tags: fact.tags ?? [],
          created: existing?.created ?? now,
          updated: now,
          citations: fact.citations,
          content: fact.content,
        })

        const action = existing ? "Updated" : "Created"
        results.push(`  ✓ ${action} "${fact.id}" (${fact.scope})`)
        saved++
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        results.push(`  ✗ Failed "${fact.id}": ${msg}`)
        skipped++
      }
    }

    return {
      title: `Memory Extract: ${saved} saved, ${skipped} skipped`,
      metadata: { saved, skipped },
      output: `Session extraction complete:\n${results.join("\n")}`,
    }
  },
})
