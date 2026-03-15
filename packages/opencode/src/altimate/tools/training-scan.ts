// altimate_change - Training scan tool: auto-discover patterns in codebase
import z from "zod"
import fs from "fs/promises"
import path from "path"
import { Tool } from "../../tool/tool"
import { Log } from "../../util/log"
import { TrainingStore } from "../training"
import { Instance } from "../../project/instance"
import { Glob } from "../../util/glob"

const log = Log.create({ service: "tool.training_scan" })

const MAX_SAMPLE_FILES = 20

const TARGET_GLOBS: Record<string, string[]> = {
  models: ["**/models/**/*.sql", "**/staging/**/*.sql", "**/intermediate/**/*.sql", "**/marts/**/*.sql"],
  sql: ["**/*.sql"],
  config: ["**/dbt_project.yml", "**/packages.yml", "**/profiles.yml", "**/models/**/*.yml"],
  tests: ["**/tests/**/*.sql", "**/tests/**/*.yml", "**/*_test.*"],
  docs: ["**/*.md", "**/docs/**/*"],
}

export const TrainingScanTool = Tool.define("training_scan", {
  description: [
    "Scan the codebase to automatically discover patterns, conventions, and standards worth training on.",
    "Analyzes file structure, naming conventions, SQL patterns, dbt configurations, and coding standards.",
    "",
    "Scan targets:",
    "- 'models': Scan dbt model files for SQL and YAML patterns",
    "- 'sql': Scan all SQL files for query patterns",
    "- 'config': Scan dbt_project.yml, profiles, packages for configuration patterns",
    "- 'tests': Scan test files for testing conventions",
    "- 'docs': Scan markdown/text files for documentation standards",
    "- 'all': Scan everything (slower)",
    "",
    "Returns discovered patterns as suggestions. Does NOT auto-save — always present to the user first.",
  ].join("\n"),
  parameters: z.object({
    target: z
      .enum(["models", "sql", "config", "tests", "docs", "all"])
      .default("all")
      .describe("What to scan for patterns"),
    path: z
      .string()
      .optional()
      .describe("Specific directory to scan. Defaults to project root."),
    focus: z
      .string()
      .optional()
      .describe("Specific aspect to focus on (e.g., 'naming', 'structure', 'testing', 'materialization')"),
    compare_existing: z
      .boolean()
      .default(true)
      .describe("If true, compare discoveries against existing training to avoid duplicates"),
  }),
  async execute(args, ctx) {
    try {
      const baseDir = args.path
        ? path.resolve(Instance.directory, args.path)
        : Instance.directory

      // Collect glob patterns for the target
      const globs =
        args.target === "all"
          ? Object.values(TARGET_GLOBS).flat()
          : TARGET_GLOBS[args.target] ?? []

      if (globs.length === 0) {
        return {
          title: "Training Scan: no patterns",
          metadata: { target: args.target, files_scanned: 0, total_files: 0, discoveries: 0 },
          output: `No glob patterns defined for target "${args.target}".`,
        }
      }

      // Find matching files
      const allFiles: string[] = []
      for (const pattern of globs) {
        const matches = await Glob.scan(pattern, { cwd: baseDir, absolute: true })
        for (const match of matches) {
          if (!allFiles.includes(match)) allFiles.push(match)
        }
      }

      if (allFiles.length === 0) {
        return {
          title: "Training Scan: no files found",
          metadata: { target: args.target, files_scanned: 0, total_files: 0, discoveries: 0 },
          output: `No files found matching target "${args.target}" in ${baseDir}.\n\nTry a different target or path.`,
        }
      }

      // Sample files if too many
      const sampled =
        allFiles.length > MAX_SAMPLE_FILES
          ? allFiles.sort(() => 0.5 - Math.random()).slice(0, MAX_SAMPLE_FILES)
          : allFiles

      // Analyze each file for structural observations
      const observations: string[] = []
      const namingPatterns = new Map<string, number>()
      const fileExtensions = new Map<string, number>()
      const dirPatterns = new Map<string, number>()
      let sqlFileCount = 0
      let ymlFileCount = 0
      let mdFileCount = 0

      for (const filePath of sampled) {
        const ext = path.extname(filePath).toLowerCase()
        fileExtensions.set(ext, (fileExtensions.get(ext) ?? 0) + 1)

        // Track directory structure patterns
        const relPath = path.relative(baseDir, filePath)
        const topDir = relPath.split(path.sep)[0]
        if (topDir) dirPatterns.set(topDir, (dirPatterns.get(topDir) ?? 0) + 1)

        // Track naming conventions
        const basename = path.basename(filePath, ext)
        const prefix = basename.split(/[_-]/)[0]
        if (prefix && prefix.length >= 2) {
          namingPatterns.set(prefix, (namingPatterns.get(prefix) ?? 0) + 1)
        }

        if (ext === ".sql") sqlFileCount++
        else if (ext === ".yml" || ext === ".yaml") ymlFileCount++
        else if (ext === ".md") mdFileCount++

        // Read file content for deeper analysis (cap at 5KB per file)
        try {
          const content = await fs.readFile(filePath, "utf-8")
          const truncated = content.slice(0, 5000)

          if (ext === ".sql") {
            // SQL pattern detection
            if (/\bWITH\b/i.test(truncated)) observations.push(`${relPath}: Uses CTEs`)
            if (/\{\{[\s]*config\s*\(/i.test(truncated)) observations.push(`${relPath}: Has dbt config block`)
            if (/\{\{[\s]*source\s*\(/i.test(truncated)) observations.push(`${relPath}: Uses {{ source() }} macro`)
            if (/\{\{[\s]*ref\s*\(/i.test(truncated)) observations.push(`${relPath}: Uses {{ ref() }} macro`)
            if (/SELECT\s+\*/i.test(truncated)) observations.push(`${relPath}: Contains SELECT *`)
            if (/materialized\s*=\s*['"]incremental/i.test(truncated))
              observations.push(`${relPath}: Incremental materialization`)
            if (/is_incremental\s*\(\)/i.test(truncated))
              observations.push(`${relPath}: Has incremental filter`)
          } else if (ext === ".yml" || ext === ".yaml") {
            if (/\btests?\s*:/i.test(truncated)) observations.push(`${relPath}: Defines tests`)
            if (/\bdescription\s*:/i.test(truncated)) observations.push(`${relPath}: Has descriptions`)
            if (/\bcolumns?\s*:/i.test(truncated)) observations.push(`${relPath}: Documents columns`)
          }
        } catch {
          // Skip unreadable files
        }
      }

      // Build discoveries summary
      const discoveries: string[] = []

      // Naming convention discovery
      const significantPrefixes = [...namingPatterns.entries()]
        .filter(([, count]) => count >= 2)
        .sort(([, a], [, b]) => b - a)
      if (significantPrefixes.length > 0) {
        const prefixList = significantPrefixes
          .slice(0, 10)
          .map(([prefix, count]) => `\`${prefix}_*\` (${count} files)`)
          .join(", ")
        discoveries.push(`**Naming Conventions**: ${prefixList}`)
      }

      // Directory structure discovery
      const topDirs = [...dirPatterns.entries()]
        .filter(([, count]) => count >= 2)
        .sort(([, a], [, b]) => b - a)
      if (topDirs.length > 0) {
        const dirList = topDirs.map(([dir, count]) => `\`${dir}/\` (${count} files)`).join(", ")
        discoveries.push(`**Directory Structure**: ${dirList}`)
      }

      // SQL pattern aggregation
      const sqlPatterns = new Map<string, number>()
      for (const obs of observations) {
        const pattern = obs.split(": ").slice(1).join(": ")
        sqlPatterns.set(pattern, (sqlPatterns.get(pattern) ?? 0) + 1)
      }
      const commonPatterns = [...sqlPatterns.entries()]
        .filter(([, count]) => count >= 2)
        .sort(([, a], [, b]) => b - a)
      if (commonPatterns.length > 0) {
        discoveries.push("**Common Patterns**:")
        for (const [pattern, count] of commonPatterns.slice(0, 10)) {
          const pct = Math.round((count / sampled.length) * 100)
          discoveries.push(`  - ${pattern}: ${count}/${sampled.length} files (${pct}%)`)
        }
      }

      // Compare against existing training if requested
      let alreadyKnown = ""
      if (args.compare_existing) {
        const existing = await TrainingStore.list()
        if (existing.length > 0) {
          alreadyKnown = `\n### Already Known (${existing.length} training entries)\n`
          alreadyKnown += existing
            .slice(0, 10)
            .map((e) => `- ${e.kind}/${e.name}`)
            .join("\n")
          if (existing.length > 10) {
            alreadyKnown += `\n- ...and ${existing.length - 10} more`
          }
        }
      }

      // Build output
      const output = [
        `## Scan Results: ${args.target}`,
        "",
        `Scanned **${sampled.length}** files${allFiles.length > MAX_SAMPLE_FILES ? ` (sampled from ${allFiles.length} total)` : ""} in \`${path.relative(Instance.directory, baseDir) || "."}\``,
        "",
        `| Type | Count |`,
        `|------|-------|`,
        `| SQL files | ${sqlFileCount} |`,
        `| YAML files | ${ymlFileCount} |`,
        `| Markdown files | ${mdFileCount} |`,
        "",
        "### Discovered Patterns",
        "",
        ...(discoveries.length > 0 ? discoveries : ["No significant patterns detected in sample."]),
        alreadyKnown,
        "",
        "### Suggested Next Steps",
        "",
        "Review the patterns above and tell me which ones to save as training entries.",
        "I can save them as patterns, rules, standards, or context — just confirm what's useful.",
      ].join("\n")

      return {
        title: `Training Scan: ${discoveries.length} patterns in ${sampled.length} files`,
        metadata: {
          target: args.target,
          files_scanned: sampled.length,
          total_files: allFiles.length,
          discoveries: discoveries.length,
        },
        output,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error("failed to scan for training", { target: args.target, error: msg })
      return {
        title: "Training Scan: ERROR",
        metadata: { target: args.target, files_scanned: 0, total_files: 0, discoveries: 0 },
        output: `Failed to scan: ${msg}`,
      }
    }
  },
})
