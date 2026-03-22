// altimate_change - Bulk training import from markdown documents
//
// Enables enterprise teams to import existing style guides, naming conventions,
// glossaries, and standards from markdown documents into the training system.
import z from "zod"
import { Tool } from "../../tool/tool"
import { Log } from "../../util/log"
import { TrainingStore, TrainingPrompt } from "../training"
import { TrainingKind, TRAINING_MAX_PATTERNS_PER_KIND } from "../training/types"

const log = Log.create({ service: "tool.training_import" })

export const TrainingImportTool = Tool.define("training_import", {
  description: [
    "Import training entries from a markdown document (style guide, naming conventions, glossary, playbook).",
    "Parses markdown headings as entry names and content as training material.",
    "",
    "Use this to bulk-load team standards from existing documentation. Each H2 (##) section",
    "becomes a separate training entry. H1 (#) sections are used as context prefixes.",
    "",
    "Examples:",
    '- training_import({ file_path: "docs/sql-style-guide.md", kind: "standard" })',
    '- training_import({ file_path: "docs/glossary.md", kind: "glossary" })',
    '- training_import({ file_path: "docs/incident-playbook.md", kind: "playbook", dry_run: true })',
  ].join("\n"),
  parameters: z.object({
    file_path: z.string().describe("Path to markdown document to import"),
    kind: TrainingKind.describe("What kind of training entries to extract"),
    scope: z
      .enum(["global", "project"])
      .default("project")
      .describe("'project' to share with team via git, 'global' for personal preferences"),
    dry_run: z
      .boolean()
      .default(true)
      .describe("Preview what would be imported without saving. Set to false to actually import."),
    max_entries: z
      .number()
      .optional()
      .default(20)
      .describe("Maximum number of entries to import from the document"),
  }),
  // @ts-expect-error tsgo TS2719 false positive — identical pattern works in other tools
  async execute(args, ctx) {
    try {
      // Read the markdown file
      const fs = await import("fs/promises")
      const content = await fs.readFile(args.file_path, "utf-8")

      // Parse markdown sections
      const sections = parseMarkdownSections(content)

      if (sections.length === 0) {
        return {
          title: "Import: NO SECTIONS FOUND",
          metadata: { success: false, count: 0 },
          output: `No importable sections found in ${args.file_path}.\n\nExpected format: Use ## headings to define sections. Each ## heading becomes a training entry.`,
        }
      }

      // Check current capacity
      const scopeForCount = args.scope === "global" ? "global" : "project"
      const existing = await TrainingStore.count({ kind: args.kind, scope: scopeForCount })
      const currentCount = existing[args.kind] ?? 0
      const available = TRAINING_MAX_PATTERNS_PER_KIND - currentCount
      const toImport = sections.slice(0, Math.min(args.max_entries, sections.length))

      if (args.dry_run) {
        // Preview mode
        const lines: string[] = [
          `Dry run — preview of import from ${args.file_path}`,
          `Kind: ${args.kind} | Scope: ${args.scope}`,
          `Sections found: ${sections.length} | Will import: ${Math.min(toImport.length, available)}`,
          `Current entries: ${currentCount}/${TRAINING_MAX_PATTERNS_PER_KIND}`,
          "",
        ]

        if (toImport.length > available) {
          lines.push(`WARNING: Only ${available} slots available. ${toImport.length - available} entries will be skipped.`)
          lines.push("")
        }

        for (let i = 0; i < toImport.length; i++) {
          const s = toImport[i]
          const willImport = i < available
          const prefix = willImport ? "+" : "SKIP"
          const preview = s.content.length > 120 ? s.content.slice(0, 120) + "..." : s.content
          lines.push(`[${prefix}] ${s.name} (${s.content.length} chars)`)
          lines.push(`    ${preview}`)
          lines.push("")
        }

        lines.push("Set dry_run=false to import these entries.")

        return {
          title: `Import preview: ${Math.min(toImport.length, available)} entries from ${args.file_path}`,
          metadata: { success: true, count: Math.min(toImport.length, available), dry_run: true },
          output: lines.join("\n"),
        }
      }

      // Actual import
      let imported = 0
      let skipped = 0
      const results: string[] = []

      for (const section of toImport) {
        if (imported >= available) {
          skipped++
          continue
        }

        try {
          await TrainingStore.save({
            kind: args.kind,
            name: section.name,
            scope: args.scope,
            content: section.content.slice(0, 1800), // Enforce max content length
            source: args.file_path,
          })
          imported++
          results.push(`  + ${section.name}`)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          results.push(`  FAIL ${section.name}: ${msg}`)
          skipped++
        }
      }

      // Budget usage
      const budgetUsed = await TrainingPrompt.budgetUsage()

      const output = [
        `Imported ${imported} ${args.kind} entries from ${args.file_path}`,
        skipped > 0 ? `Skipped: ${skipped} (limit reached or errors)` : "",
        "",
        ...results,
        "",
        `Training usage: ${budgetUsed.used}/${budgetUsed.budget} chars (${budgetUsed.percent}% full).`,
        args.scope === "project" ? "These entries will be shared with your team when committed to git." : "",
      ]
        .filter(Boolean)
        .join("\n")

      return {
        title: `Import: ${imported} ${args.kind} entries saved`,
        metadata: { success: true, count: imported, skipped },
        output,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error("failed to import training", { file: args.file_path, kind: args.kind, error: msg })
      return {
        title: "Import: ERROR",
        metadata: { success: false, count: 0 },
        output: `Failed to import training from ${args.file_path}: ${msg}`,
      }
    }
  },
})

interface MarkdownSection {
  name: string
  content: string
}

function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = []
  const lines = markdown.split("\n")
  let currentH1 = ""
  let currentName = ""
  let currentContent: string[] = []

  for (const line of lines) {
    // H1 — used as context prefix
    if (line.match(/^#\s+/)) {
      // Save previous section if any
      if (currentName && currentContent.length > 0) {
        sections.push({
          name: slugify(currentName),
          content: currentContent.join("\n").trim(),
        })
      }
      currentH1 = line.replace(/^#\s+/, "").trim()
      currentName = ""
      currentContent = []
      continue
    }

    // H2 — each becomes a training entry
    if (line.match(/^##\s+/)) {
      // Save previous section
      if (currentName && currentContent.length > 0) {
        sections.push({
          name: slugify(currentName),
          content: currentContent.join("\n").trim(),
        })
      }
      currentName = line.replace(/^##\s+/, "").trim()
      if (currentH1) {
        currentContent = [`Context: ${currentH1}`, ""]
      } else {
        currentContent = []
      }
      continue
    }

    // H3+ — include as content within current section
    if (currentName) {
      currentContent.push(line)
    }
  }

  // Save last section
  if (currentName && currentContent.length > 0) {
    sections.push({
      name: slugify(currentName),
      content: currentContent.join("\n").trim(),
    })
  }

  return sections
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}
