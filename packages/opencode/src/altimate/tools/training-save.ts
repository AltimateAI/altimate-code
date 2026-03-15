// altimate_change - Training save tool for AI Teammate learning
import z from "zod"
import { Tool } from "../../tool/tool"
import { TrainingStore } from "../training"
import { TrainingKind, TRAINING_MAX_PATTERNS_PER_KIND } from "../training/types"
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
      .regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/, {
        message: "Name must be lowercase alphanumeric with hyphens/underscores",
      })
      .describe("Short identifier for this training entry (e.g., 'staging-model', 'no-float', 'arr-definition')"),
    content: z
      .string()
      .min(1)
      .max(1800)
      .describe("The knowledge to save. Be specific and actionable. Use markdown for structure."),
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
      const existing = await TrainingStore.count({ kind: args.kind, scope: args.scope === "global" ? "global" : "project" })
      if (existing[args.kind] >= TRAINING_MAX_PATTERNS_PER_KIND) {
        return {
          title: "Training: limit reached",
          metadata: { action: "error" as string, kind: args.kind, name: args.name, scope: args.scope },
          output: `Cannot save: already at ${TRAINING_MAX_PATTERNS_PER_KIND} ${args.kind} entries. Remove an existing one first with training_remove.`,
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

      let output = `Saved ${args.kind} "${args.name}" to ${args.scope} training.`
      if (args.scope === "project") {
        output += "\nThis will be shared with your team when committed to git."
      }
      if (duplicates.length > 0) {
        output += `\n\nNote: Found ${duplicates.length} similar training block(s). Consider consolidating.`
      }

      return {
        title: `Training: saved "${args.name}" (${args.kind})`,
        metadata: { action: "saved" as string, kind: args.kind, name: args.name, scope: args.scope },
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
