#!/usr/bin/env bun
/**
 * Analyze altimate_change marker integrity and upstream divergence.
 *
 * Usage:
 *   bun run script/upstream/analyze.ts
 *   bun run script/upstream/analyze.ts --version v1.2.19
 */

import fs from "fs"
import path from "path"
import { parseArgs } from "util"
import { loadConfig, repoRoot } from "./utils/config"
import { git, gitSafe, tagExists } from "./utils/git"

const { values: args } = parseArgs({
  options: {
    version: { type: "string", short: "v" },
  },
})

interface MarkerBlock {
  file: string
  line: number
  startComment: string
  endLine: number | null
}

function findMarkers(): MarkerBlock[] {
  const config = loadConfig()
  const marker = config.changeMarker
  const root = repoRoot()
  const blocks: MarkerBlock[] = []

  // Search for markers in all TypeScript files under packages/opencode/src/
  const srcDir = path.join(root, "packages", "opencode", "src")
  const files = findFiles(srcDir, [".ts", ".tsx", ".json", ".txt"])

  for (const file of files) {
    const relPath = path.relative(root, file)
    // Skip our own code directory — markers aren't needed there
    if (relPath.includes("src/altimate/")) continue

    const content = fs.readFileSync(file, "utf-8")
    const lines = content.split("\n")

    let openBlock: MarkerBlock | null = null

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.includes(`${marker} start`)) {
        openBlock = {
          file: relPath,
          line: i + 1,
          startComment: line.trim(),
          endLine: null,
        }
      } else if (line.includes(`${marker} end`) && openBlock) {
        openBlock.endLine = i + 1
        blocks.push(openBlock)
        openBlock = null
      }
    }

    // Unclosed marker block
    if (openBlock) {
      blocks.push(openBlock)
    }
  }

  return blocks
}

function findFiles(dir: string, extensions: string[]): string[] {
  const files: string[] = []

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...findFiles(fullPath, extensions))
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(fullPath)
    }
  }

  return files
}

async function main() {
  const config = loadConfig()

  console.log("=== Altimate Change Marker Analysis ===\n")

  // 1. Find all marker blocks
  const markers = findMarkers()
  const complete = markers.filter((m) => m.endLine !== null)
  const incomplete = markers.filter((m) => m.endLine === null)

  console.log(`Found ${markers.length} marker blocks in ${new Set(markers.map((m) => m.file)).size} files`)
  console.log(`  ✓ ${complete.length} complete (start + end)`)

  if (incomplete.length > 0) {
    console.log(`  ✗ ${incomplete.length} INCOMPLETE (missing end marker):`)
    for (const m of incomplete) {
      console.log(`    ${m.file}:${m.line} — ${m.startComment}`)
    }
  }

  // 2. List all marked files
  const fileSet = new Set(markers.map((m) => m.file))
  console.log("\nFiles with markers:")
  for (const f of [...fileSet].sort()) {
    const count = markers.filter((m) => m.file === f).length
    console.log(`  ${f} (${count} block${count > 1 ? "s" : ""})`)
  }

  // 3. Version divergence analysis
  if (args.version) {
    const version = args.version
    console.log(`\n=== Divergence Analysis vs ${version} ===\n`)

    if (!tagExists(version)) {
      console.error(`Tag ${version} not found. Run: git fetch upstream --tags`)
      return
    }

    for (const file of fileSet) {
      const diff = gitSafe(`diff ${version} HEAD -- ${file}`)
      if (diff) {
        const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length
        const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length
        console.log(`  ${file}: +${added}/-${removed} lines changed`)
      }
    }
  }

  // 4. Summary
  console.log("\n=== Summary ===")
  console.log(`Total marked files: ${fileSet.size}`)
  console.log(`Total marker blocks: ${markers.length}`)
  console.log(`Integrity: ${incomplete.length === 0 ? "✓ All blocks properly closed" : `✗ ${incomplete.length} unclosed blocks`}`)
}

main().catch(console.error)
