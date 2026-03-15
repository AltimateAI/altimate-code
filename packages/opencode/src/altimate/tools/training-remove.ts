// altimate_change - Training remove tool for AI Teammate
import z from "zod"
import { Tool } from "../../tool/tool"
import { TrainingStore } from "../training"
import { TrainingKind } from "../training/types"

export const TrainingRemoveTool = Tool.define("training_remove", {
  description:
    "Remove a learned training entry (pattern, rule, glossary term, or standard). Use this when a training entry is outdated, incorrect, or no longer relevant.",
  parameters: z.object({
    kind: TrainingKind.describe("Kind of training entry to remove"),
    name: z.string().min(1).describe("Name of the training entry to remove"),
    scope: z
      .enum(["global", "project"])
      .default("project")
      .describe("Which scope to remove from"),
  }),
  async execute(args, ctx) {
    try {
      const removed = await TrainingStore.remove(args.scope, args.kind, args.name)

      if (!removed) {
        return {
          title: "Training: not found",
          metadata: { action: "not_found", kind: args.kind, name: args.name },
          output: `No training entry found: ${args.kind}/${args.name} in ${args.scope} scope.`,
        }
      }

      return {
        title: `Training: removed "${args.name}" (${args.kind})`,
        metadata: { action: "removed", kind: args.kind, name: args.name },
        output: `Removed ${args.kind} "${args.name}" from ${args.scope} training.`,
      }
    } catch (e) {
      return {
        title: "Training Remove: ERROR",
        metadata: { action: "error", kind: args.kind, name: args.name },
        output: `Failed to remove training: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  },
})
