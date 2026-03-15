// altimate_change - Training save tool for AI Teammate learning
import z from "zod"
import { Tool } from "../../tool/tool"
import { TrainingStore, TrainingPrompt } from "../training"
import { TrainingKind, TRAINING_MAX_PATTERNS_PER_KIND, TRAINING_BUDGET } from "../training/types"
import { CitationSchema } from "../../memory/types"

export const TrainingSaveTool = Tool.define("training_save", {
  description: [
    "Save a learned pattern, rule, glossary term, or standard to your teammate's training.",
    "Use this when the user teaches you something, corrects your behavior, or asks you to remember a convention.",
    "",
    "Training kinds:",
    "- pattern: A coding pattern learned from an example file (e.g., how staging models should look)",
    "- rule: A specific rule from a correction (e.g., 'never use FLOAT for financial columns')",
    "- glossary: A domain-specific term definition (e.g., 'ARR means Annual Recurring Revenue')",
    "- standard: A team standard from documentation (e.g., SQL style guide rules)",
    "",
    `Max ${TRAINING_MAX_PATTERNS_PER_KIND} entries per kind. Training persists across sessions.`,
    "Project-scope training is committed to git so the whole team benefits.",
  ].join("\n"),
  parameters: z.object({
    kind: TrainingKind.describe("Type of knowledge being saved"),
    name: z
      .string()
      .min(1)
      .max(64)
      .transform((s) => s.toLowerCase().replace(/\s+/g, "-"))
      .pipe(
        z.string().regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/, {
          message:
            "Name must be lowercase alphanumeric with hyphens/underscores (e.g., 'staging-model', 'no-float', 'arr')",
        }),
      )
      .describe(
        "Short identifier for this training entry (e.g., 'staging-model', 'no-float', 'ARR'). Auto-lowercased.",
      ),
    content: z
      .string()
      .min(1)
      .max(2500)
      .describe("The knowledge to save. Be specific and actionable. Use markdown for structure. Max 2500 chars."),
    scope: z
      .enum(["global", "project"])
      .default("project")
      .describe("'project' to share with team via git, 'global' for personal preferences"),
    source: z
      .string()
      .max(256)
      .optional()
      .describe("Where this knowledge came from (e.g., file path, URL, 'user correction')"),
    citations: z
      .array(CitationSchema)
      .max(5)
      .optional()
      .describe("Source file references backing this training"),
  }),
  async execute(args, ctx) {
    try {
      const scopeForCount = args.scope === "global" ? "global" : "project"

      // Check if this is an update to an existing entry
      const existingEntry = await TrainingStore.get(scopeForCount, args.kind, args.name)
      const isUpdate = !!existingEntry

      // Only check limit for new entries (not updates)
      if (!isUpdate) {
        const existing = await TrainingStore.count({ kind: args.kind, scope: scopeForCount })
        if (existing[args.kind] >= TRAINING_MAX_PATTERNS_PER_KIND) {
          return {
            title: "Training: limit reached",
            metadata: { action: "error" as string, kind: args.kind, name: args.name, scope: args.scope },
            output: `Cannot save: already at ${TRAINING_MAX_PATTERNS_PER_KIND} ${args.kind} entries. Remove an existing one first with training_remove.`,
          }
        }
      }

      const { entry, duplicates } = await TrainingStore.save({
        kind: args.kind,
        name: args.name,
        scope: args.scope,
        content: args.content,
        source: args.source,
        citations: args.citations,
      })

      // Build response with context
      let output: string
      if (isUpdate) {
        const appliedNote = existingEntry.meta.applied > 0 ? ` (preserving ${existingEntry.meta.applied} prior applications)` : ""
        output = `Updated ${args.kind} "${args.name}" in ${args.scope} training${appliedNote}.`
      } else {
        output = `Saved ${args.kind} "${args.name}" to ${args.scope} training.`
      }

      if (args.scope === "project") {
        output += "\nThis will be shared with your team when committed to git."
      }

      // Show budget usage
      const budgetUsed = await TrainingPrompt.budgetUsage()
      output += `\nTraining usage: ${budgetUsed.used}/${budgetUsed.budget} chars (${budgetUsed.percent}% full).`
      if (budgetUsed.percent >= 80) {
        output += "\n⚠ Training is getting full. Oldest entries may not fit in context. Consider consolidating."
      }

      // Show duplicate details
      if (duplicates.length > 0) {
        const dupNames = duplicates
          .map((d) => {
            const parts = d.id.split("/")
            return `\`${parts.slice(1).join("/")}\``
          })
          .join(", ")
        output += `\n\nSimilar entries found: ${dupNames}. Run training_remove to consolidate if these are duplicates.`
      }

      return {
        title: `Training: ${isUpdate ? "updated" : "saved"} "${args.name}" (${args.kind})`,
        metadata: { action: isUpdate ? "updated" : "saved", kind: args.kind, name: args.name, scope: args.scope },
        output,
      }
    } catch (e) {
      return {
        title: "Training Save: ERROR",
        metadata: { action: "error" as string, kind: args.kind, name: args.name, scope: args.scope },
        output: `Failed to save training: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  },
})
