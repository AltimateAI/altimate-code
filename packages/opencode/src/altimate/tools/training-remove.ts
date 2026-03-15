// altimate_change - Training remove tool for AI Teammate
import z from "zod"
import { Tool } from "../../tool/tool"
import { Log } from "../../util/log"
import { TrainingStore, TrainingPrompt } from "../training"
import { TrainingKind } from "../training/types"

const log = Log.create({ service: "tool.training_remove" })

export const TrainingRemoveTool = Tool.define("training_remove", {
  description:
    "Remove a learned training entry (pattern, rule, glossary term, or standard). Use this when a training entry is outdated, incorrect, or no longer relevant.",
  parameters: z.object({
    kind: TrainingKind.describe("Kind of training entry to remove"),
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/, {
        message: "Name must be lowercase alphanumeric with hyphens/underscores",
      })
      .describe("Name of the training entry to remove"),
    scope: z
      .enum(["global", "project"])
      .default("project")
      .describe("Which scope to remove from"),
  }),
  async execute(args, ctx) {
    try {
      // Get the entry first so we can show what was removed
      const entry = await TrainingStore.get(args.scope, args.kind, args.name)

      const removed = await TrainingStore.remove(args.scope, args.kind, args.name)

      if (!removed) {
        // Help the user find the right name
        const available = await TrainingStore.list({ kind: args.kind, scope: args.scope })
        let hint = ""
        if (available.length > 0) {
          const names = available.map((e) => `\`${e.name}\``).join(", ")
          hint = `\n\nAvailable ${args.kind} entries: ${names}`
        }
        return {
          title: "Training: not found",
          metadata: { action: "not_found", kind: args.kind, name: args.name },
          output: `No training entry found: ${args.kind}/${args.name} in ${args.scope} scope.${hint}`,
        }
      }

      const appliedNote = entry && entry.meta.applied > 0 ? ` It had been applied ${entry.meta.applied} time(s).` : ""
      const budget = await TrainingPrompt.budgetUsage()

      return {
        title: `Training: removed "${args.name}" (${args.kind})`,
        metadata: { action: "removed", kind: args.kind, name: args.name },
        output: `Removed ${args.kind} "${args.name}" from ${args.scope} training.${appliedNote}\nTraining usage: ${budget.used}/${budget.budget} chars (${budget.percent}% full).`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error("failed to remove training", { kind: args.kind, name: args.name, error: msg })
      return {
        title: "Training Remove: ERROR",
        metadata: { action: "error", kind: args.kind, name: args.name },
        output: `Failed to remove training: ${msg}`,
      }
    }
  },
})
