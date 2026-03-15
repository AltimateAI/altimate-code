// altimate_change - Training validate tool: check training compliance against codebase
import z from "zod"
import fs from "fs/promises"
import path from "path"
import { Tool } from "../../tool/tool"
import { Log } from "../../util/log"
import { TrainingStore } from "../training"
import { TrainingKind } from "../training/types"
import { Instance } from "../../project/instance"
import { Glob } from "../../util/glob"

const log = Log.create({ service: "tool.training_validate" })

// Kinds that can be validated against code
const VALIDATABLE_KINDS = new Set(["rule", "pattern", "standard", "glossary"])

export const TrainingValidateTool = Tool.define("training_validate", {
  description: [
    "Validate saved training entries against the actual codebase to check compliance.",
    "For each training entry, checks whether the code follows it. Reports:",
    "- Followed: Code matches the training",
    "- Violated: Code contradicts the training",
    "- Stale: No relevant code found (training may be outdated)",
    "- Skipped: Not validatable (context and playbook entries)",
    "",
    "Use this to audit training quality and find entries that need updating or removal.",
  ].join("\n"),
  parameters: z.object({
    kind: TrainingKind.optional().describe("Filter validation to a specific training kind"),
    name: z.string().optional().describe("Validate a specific entry by name. If omitted, validates all."),
    scope: z
      .enum(["global", "project", "all"])
      .default("all")
      .describe("Which scope to validate"),
    sample_size: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Number of files to sample for each validation check"),
  }),
  async execute(args, ctx) {
    try {
      const entries = await TrainingStore.list({
        kind: args.kind,
        scope: args.scope === "all" ? undefined : args.scope,
      })

      if (entries.length === 0) {
        return {
          title: "Training Validate: nothing to validate",
          metadata: { total: 0, followed: 0, violated: 0, stale: 0, skipped: 0 },
          output: "No training entries found to validate. Save some training first.",
        }
      }

      // Filter to specific entry if name provided
      const filtered = args.name ? entries.filter((e) => e.name === args.name) : entries

      if (filtered.length === 0) {
        const available = entries.map((e) => `\`${e.name}\``).join(", ")
        return {
          title: "Training Validate: entry not found",
          metadata: { total: 0, followed: 0, violated: 0, stale: 0, skipped: 0 },
          output: `No entry named "${args.name}" found.\n\nAvailable entries: ${available}`,
        }
      }

      const results: {
        entry: (typeof entries)[0]
        verdict: "followed" | "violated" | "stale" | "skipped"
        details: string
        files?: string[]
      }[] = []

      for (const entry of filtered) {
        // Skip non-validatable kinds
        if (!VALIDATABLE_KINDS.has(entry.kind)) {
          results.push({
            entry,
            verdict: "skipped",
            details: `${entry.kind} entries are informational and not code-validatable`,
          })
          continue
        }

        // Extract validation keywords from the entry content
        const keywords = extractKeywords(entry.content)
        if (keywords.length === 0) {
          results.push({
            entry,
            verdict: "stale",
            details: "Could not extract validation keywords from content",
          })
          continue
        }

        // Search for relevant files
        const sqlFiles = await Glob.scan("**/*.sql", {
          cwd: Instance.directory,
          absolute: true,
        })
        const ymlFiles = await Glob.scan("**/*.yml", {
          cwd: Instance.directory,
          absolute: true,
        })
        const allFiles = [...sqlFiles, ...ymlFiles]

        // Sample files
        const sampled =
          allFiles.length > args.sample_size
            ? allFiles.sort(() => 0.5 - Math.random()).slice(0, args.sample_size)
            : allFiles

        if (sampled.length === 0) {
          results.push({
            entry,
            verdict: "stale",
            details: "No SQL or YAML files found in project",
          })
          continue
        }

        // Check each file for keyword presence
        let matchCount = 0
        let violationCount = 0
        const violationFiles: string[] = []

        for (const filePath of sampled) {
          try {
            const content = await fs.readFile(filePath, "utf-8")
            const contentLower = content.toLowerCase()

            // Check for violation indicators (negative rules)
            const negativeKeywords = extractNegativeKeywords(entry.content)
            for (const neg of negativeKeywords) {
              if (contentLower.includes(neg.toLowerCase())) {
                violationCount++
                violationFiles.push(path.relative(Instance.directory, filePath))
                break
              }
            }

            // Check for positive keyword presence (pattern is followed)
            for (const kw of keywords) {
              if (contentLower.includes(kw.toLowerCase())) {
                matchCount++
                break
              }
            }
          } catch {
            // Skip unreadable files
          }
        }

        if (violationCount > 0) {
          results.push({
            entry,
            verdict: "violated",
            details: `${violationCount} of ${sampled.length} files may violate this training`,
            files: violationFiles.slice(0, 5),
          })
        } else if (matchCount > 0) {
          const pct = Math.round((matchCount / sampled.length) * 100)
          results.push({
            entry,
            verdict: "followed",
            details: `Relevant in ${matchCount}/${sampled.length} files (${pct}%)`,
          })
        } else {
          results.push({
            entry,
            verdict: "stale",
            details: `No mentions found in ${sampled.length} sampled files`,
          })
        }
      }

      // Group results by verdict
      const followed = results.filter((r) => r.verdict === "followed")
      const violated = results.filter((r) => r.verdict === "violated")
      const stale = results.filter((r) => r.verdict === "stale")
      const skipped = results.filter((r) => r.verdict === "skipped")

      const sections: string[] = ["## Training Validation Report", ""]

      if (followed.length > 0) {
        sections.push(`### Followed (${followed.length})`)
        for (const r of followed) {
          sections.push(`- **${r.entry.kind}/${r.entry.name}**: ${r.details}`)
        }
        sections.push("")
      }

      if (violated.length > 0) {
        sections.push(`### Violated (${violated.length})`)
        for (const r of violated) {
          sections.push(`- **${r.entry.kind}/${r.entry.name}**: ${r.details}`)
          if (r.files) {
            for (const f of r.files) sections.push(`  - \`${f}\``)
          }
        }
        sections.push("")
      }

      if (stale.length > 0) {
        sections.push(`### Stale (${stale.length})`)
        for (const r of stale) {
          sections.push(`- **${r.entry.kind}/${r.entry.name}**: ${r.details}`)
        }
        sections.push("")
      }

      if (skipped.length > 0) {
        sections.push(`### Skipped (${skipped.length})`)
        for (const r of skipped) {
          sections.push(`- **${r.entry.kind}/${r.entry.name}**: ${r.details}`)
        }
        sections.push("")
      }

      // Add summary
      sections.push("### Summary")
      sections.push(`| Verdict | Count |`)
      sections.push(`|---------|-------|`)
      sections.push(`| Followed | ${followed.length} |`)
      sections.push(`| Violated | ${violated.length} |`)
      sections.push(`| Stale | ${stale.length} |`)
      sections.push(`| Skipped | ${skipped.length} |`)

      if (violated.length > 0 || stale.length > 0) {
        sections.push("")
        sections.push("### Recommendations")
        if (violated.length > 0) {
          sections.push(
            `- Review ${violated.length} violated entries — either fix the code or update the training`,
          )
        }
        if (stale.length > 0) {
          sections.push(
            `- Consider removing ${stale.length} stale entries that no longer match the codebase`,
          )
        }
      }

      return {
        title: `Training Validate: ${followed.length} followed, ${violated.length} violated, ${stale.length} stale`,
        metadata: {
          total: filtered.length,
          followed: followed.length,
          violated: violated.length,
          stale: stale.length,
          skipped: skipped.length,
        },
        output: sections.join("\n"),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error("failed to validate training", { error: msg })
      return {
        title: "Training Validate: ERROR",
        metadata: { total: 0, followed: 0, violated: 0, stale: 0, skipped: 0 },
        output: `Failed to validate training: ${msg}`,
      }
    }
  },
})

/**
 * Extract searchable keywords from training content.
 * Looks for identifiers, SQL keywords, patterns like SELECT *, column names, etc.
 */
function extractKeywords(content: string): string[] {
  const keywords: string[] = []
  // Extract quoted identifiers
  const quoted = content.match(/[`'"]([\w_*]+)[`'"]/g)
  if (quoted) {
    for (const q of quoted) keywords.push(q.replace(/[`'"]/g, ""))
  }
  // Extract SQL-like tokens (uppercase words 3+ chars)
  const sqlTokens = content.match(/\b[A-Z_]{3,}\b/g)
  if (sqlTokens) {
    for (const t of sqlTokens) {
      if (!["THE", "AND", "FOR", "NOT", "USE", "BUT", "ALL", "WITH", "THIS", "THAT", "FROM", "WHEN", "THEY", "HAVE", "EACH"].includes(t)) {
        keywords.push(t)
      }
    }
  }
  // Extract snake_case identifiers
  const snakeCase = content.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)
  if (snakeCase) keywords.push(...snakeCase)
  return [...new Set(keywords)].slice(0, 20)
}

/**
 * Extract negative keywords — things that should NOT appear if the rule is followed.
 * Looks for phrases like "never use X", "don't use X", "avoid X".
 */
function extractNegativeKeywords(content: string): string[] {
  const negatives: string[] = []
  const patterns = [
    /(?:never|don'?t|do not|avoid)\s+(?:use\s+)?[`'"]*(\w[\w\s*]+)[`'"]*(?:\s|$|\.)/gi,
    /(?:no|never)\s+`([^`]+)`/gi,
  ]
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(content)) !== null) {
      const kw = match[1].trim()
      if (kw.length >= 3) negatives.push(kw)
    }
  }
  return [...new Set(negatives)]
}
