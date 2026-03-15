// altimate_change - Training list tool for AI Teammate learned knowledge
import z from "zod"
import { Tool } from "../../tool/tool"
import { TrainingStore, TrainingPrompt } from "../training"
import { TrainingKind } from "../training/types"

export const TrainingListTool = Tool.define("training_list", {
  description: [
    "List all learned training entries (patterns, rules, glossary, standards).",
    "Shows what your teammate has been taught and how often each entry has been applied.",
    "Use this to review training, check what's been learned, or find entries to update/remove.",
  ].join("\n"),
  parameters: z.object({
    kind: TrainingKind.optional().describe("Filter by kind: pattern, rule, glossary, or standard"),
    scope: z
      .enum(["global", "project", "all"])
      .optional()
      .default("all")
      .describe("Filter by scope"),
  }),
  async execute(args, ctx) {
    try {
      const entries = await TrainingStore.list({ kind: args.kind, scope: args.scope === "all" ? undefined : args.scope })

      if (entries.length === 0) {
        const hint = args.kind ? ` of kind "${args.kind}"` : ""
        return {
          title: "Training: empty",
          metadata: { count: 0 },
          output: `No training entries found${hint}. Use /teach to learn from example files, /train to learn from documents, or correct me and I'll offer to save the rule.`,
        }
      }

      const counts = await TrainingStore.count()
      const summary = [
        `## Training Status`,
        "",
        `| Kind | Count |`,
        `|------|-------|`,
        `| Patterns | ${counts.pattern} |`,
        `| Rules | ${counts.rule} |`,
        `| Glossary | ${counts.glossary} |`,
        `| Standards | ${counts.standard} |`,
        `| **Total** | **${entries.length}** |`,
        "",
      ].join("\n")

      const details = entries
        .map((e) => {
          const applied = e.meta.applied > 0 ? ` (applied ${e.meta.applied}x)` : ""
          const source = e.meta.source ? ` — from: ${e.meta.source}` : ""
          const scope = e.scope === "global" ? " [global]" : ""
          return `- **${e.name}** (${e.kind})${scope}${applied}${source}\n  ${e.content.split("\n")[0].slice(0, 100)}`
        })
        .join("\n")

      return {
        title: `Training: ${entries.length} entries`,
        metadata: { count: entries.length },
        output: summary + details,
      }
    } catch (e) {
      return {
        title: "Training List: ERROR",
        metadata: { count: 0 },
        output: `Failed to list training: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  },
})
