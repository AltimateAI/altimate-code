// altimate_change - Training list tool for AI Teammate learned knowledge
import z from "zod"
import { Tool } from "../../tool/tool"
import { Log } from "../../util/log"
import { TrainingStore, TrainingPrompt, TrainingInsights } from "../training"
import { TrainingKind } from "../training/types"

const log = Log.create({ service: "tool.training_list" })

export const TrainingListTool = Tool.define("training_list", {
  description: [
    "List all learned training entries (patterns, rules, glossary, standards).",
    "Shows what your teammate has been taught and how often each entry has been applied.",
    "Use this to review training, check what's been learned, or find entries to update/remove.",
    "",
    "Filter by kind (pattern/rule/glossary/standard/context/playbook) or scope (global/project/all).",
  ].join("\n"),
  parameters: z.object({
    kind: TrainingKind.optional().describe("Filter by kind: pattern, rule, glossary, standard, context, or playbook"),
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
          metadata: { count: 0, budgetPercent: 0 },
          output: `No training entries found${hint}. Use /teach to learn from example files, /train to learn from documents, or correct me and I'll offer to save the rule.`,
        }
      }

      // Budget usage
      const budget = await TrainingPrompt.budgetUsage()

      const counts = await TrainingStore.count({ kind: args.kind, scope: args.scope === "all" ? undefined : args.scope })
      const summary = [
        `## Training Status`,
        "",
        `| Kind | Count |`,
        `|------|-------|`,
        `| Patterns | ${counts.pattern} |`,
        `| Rules | ${counts.rule} |`,
        `| Glossary | ${counts.glossary} |`,
        `| Standards | ${counts.standard} |`,
        `| Context | ${counts.context} |`,
        `| Playbooks | ${counts.playbook} |`,
        `| **Total** | **${entries.length}** |`,
        "",
        `**Context budget**: ${budget.used}/${budget.budget} chars (${budget.percent}% full)`,
        "",
      ].join("\n")

      // Sort by applied count descending for visibility of most-used entries
      const sorted = [...entries].sort((a, b) => b.meta.applied - a.meta.applied)

      // Find top applied entries for highlight
      const topApplied = sorted.filter((e) => e.meta.applied > 0).slice(0, 3)
      let highlights = ""
      if (topApplied.length > 0) {
        highlights =
          "**Most applied**: " +
          topApplied.map((e) => `\`${e.name}\` (${e.meta.applied}x)`).join(", ") +
          "\n\n"
      }

      // Group by kind for display
      const grouped = new Map<string, typeof entries>()
      for (const e of entries) {
        const list = grouped.get(e.kind) ?? []
        list.push(e)
        grouped.set(e.kind, list)
      }

      const sections: string[] = []
      for (const kind of ["rule", "pattern", "standard", "glossary", "context", "playbook"] as const) {
        const items = grouped.get(kind)
        if (!items || items.length === 0) continue
        sections.push(`### ${kind.charAt(0).toUpperCase() + kind.slice(1)}s`)
        for (const e of items) {
          const applied = e.meta.applied > 0 ? ` (applied ${e.meta.applied}x)` : ""
          const source = e.meta.source ? ` — from: ${e.meta.source}` : ""
          const scope = e.scope === "global" ? " [global]" : ""
          const firstLine = e.content.split("\n")[0]
          const preview = firstLine.slice(0, 120)
          const truncated = firstLine.length > 120 || e.content.includes("\n") ? "..." : ""
          sections.push(`- **${e.name}**${scope}${applied}${source}\n  ${preview}${truncated}`)
        }
        sections.push("")
      }

      // Self-improvement insights
      const insights = await TrainingInsights.analyze()
      const insightText = TrainingInsights.format(insights)

      return {
        title: `Training: ${entries.length} entries`,
        metadata: { count: entries.length, budgetPercent: budget.percent },
        output: summary + highlights + sections.join("\n") + insightText,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error("failed to list training", { error: msg })
      return {
        title: "Training List: ERROR",
        metadata: { count: 0, budgetPercent: 0 },
        output: `Failed to list training: ${msg}`,
      }
    }
  },
})
