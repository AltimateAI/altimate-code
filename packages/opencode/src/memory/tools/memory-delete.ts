import z from "zod"
import { Tool } from "../../tool/tool"
import { MemoryStore } from "../store"
import { MemoryBlockSchema } from "../types"

export const MemoryDeleteTool = Tool.define("altimate_memory_delete", {
  description:
    "Delete an Altimate Memory block that is outdated, incorrect, or no longer needed. Use this to keep Altimate Memory clean and relevant.",
  parameters: z.object({
    id: MemoryBlockSchema.shape.id.describe("The ID of the memory block to delete"),
    scope: z
      .enum(["global", "project"])
      .describe("The scope of the memory block to delete"),
  }),
  async execute(args, ctx) {
    try {
      const removed = await MemoryStore.remove(args.scope, args.id)
      if (removed) {
        return {
          title: `Memory: Deleted "${args.id}"`,
          metadata: { deleted: true, id: args.id, scope: args.scope },
          output: `Deleted memory block "${args.id}" from ${args.scope} scope.`,
        }
      }
      return {
        title: `Memory: Not found "${args.id}"`,
        metadata: { deleted: false, id: args.id, scope: args.scope },
        output: `No memory block found with ID "${args.id}" in ${args.scope} scope. Use altimate_memory_read to list existing blocks.`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Memory Delete: ERROR",
        metadata: { deleted: false, id: args.id, scope: args.scope },
        output: `Failed to delete memory: ${msg}`,
      }
    }
  },
})
