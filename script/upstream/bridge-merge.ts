/**
 * Bridge merge: one-time history overlay for upstream rewrites.
 *
 * Background
 * ----------
 * Upstream (anomalyco/opencode) rewrote git history between v1.3.17 and v1.4.0,
 * leaving zero common ancestor with our fork. The standard merge.ts tooling
 * relies on `git merge`, which requires a merge base, so it cannot bridge
 * across this rewrite.
 *
 * Strategy
 * --------
 * Treat v1.4.0 as the new baseline tree:
 *
 *   1. For each file in v1.4.0:
 *        - keepOurs glob match  → leave main's version
 *        - skipFiles glob match → don't include
 *        - otherwise            → take v1.4.0's content
 *
 *   2. For each file in main but not in v1.4.0:
 *        - skipFiles match → delete (truly upstream-only)
 *        - keepOurs match → keep (custom file)
 *        - has altimate_change markers → keep (altimate code)
 *        - otherwise → keep, flag for human review
 *
 *   3. For files where main had `altimate_change` marker blocks but we
 *      just overwrote with v1.4.0's content, re-apply each block by
 *      anchoring on the lines immediately surrounding the markers in main.
 *      Anchors that no longer exist in upstream are reported for human
 *      review (the block is *not* silently dropped).
 *
 *   4. Restore PR #18186 changes so we keep Anthropic as a provider.
 *
 *   5. Generate per-file report at .bridge-merge-report.md.
 *
 * Usage
 * -----
 *   bun run script/upstream/bridge-merge.ts --version v1.4.0
 *   bun run script/upstream/bridge-merge.ts --version v1.4.0 --dry-run
 */

import { $ } from "bun"
import { parseArgs } from "util"
import path from "path"
import { writeFileSync, existsSync, readFileSync, rmSync } from "fs"
import { loadConfig, repoRoot, type MergeConfig } from "./utils/config.ts"
import * as logger from "./utils/logger.ts"
import { bold, cyan, dim, green, yellow, red } from "./utils/logger.ts"
import { assertSameMajor } from "./utils/version.ts"

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    version: { type: "string", short: "v" },
    "dry-run": { type: "boolean", default: false },
    "no-branch": { type: "boolean", default: false },
    "skip-pr-revert": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: false,
})

if (args.help || !args.version) {
  console.log(`
  ${bold("Bridge Merge")} — one-time history overlay for upstream rewrites

  ${bold("USAGE")}
    bun run script/upstream/bridge-merge.ts --version <tag>

  ${bold("OPTIONS")}
    --version, -v <tag>      Upstream tag to overlay (e.g., v1.4.0)
    --dry-run                Print the plan without writing files
    --no-branch              Don't create a branch (operate on current branch)
    --skip-pr-revert         Skip the PR #18186 anthropic-provider fix step
    --help, -h               Show this help
`)
  process.exit(args.help ? 0 : 1)
}

const VERSION = args.version as string
const DRY_RUN = !!args["dry-run"]
const NO_BRANCH = !!args["no-branch"]
const SKIP_PR_REVERT = !!args["skip-pr-revert"]

const ROOT = repoRoot()
const REPORT_PATH = path.join(ROOT, ".bridge-merge-report.md")

// ---------------------------------------------------------------------------
// Marker handling
// ---------------------------------------------------------------------------

const CHANGE_MARKER = "altimate_change"
const START_RE = new RegExp(`${CHANGE_MARKER} start`)
const END_RE = new RegExp(`${CHANGE_MARKER} end`)
const ANCHOR_LINES = 3 // lines of context to use as anchor

interface MarkerBlock {
  startLine: number
  endLine: number
  body: string[] // full block including start/end markers
  anchorBefore: string[] // up to ANCHOR_LINES non-blank, non-altimate lines before start
  description: string
}

/**
 * Extract every altimate_change block from a file.
 *
 * Anchor rules:
 *   - Skip blank lines.
 *   - Skip lines INSIDE any altimate_change block (so anchors are
 *     pure upstream code that should exist in v1.4.0 too).
 *   - Walk backward up to ANCHOR_LINES non-skip lines.
 */
function extractMarkerBlocks(content: string): MarkerBlock[] {
  const lines = content.split("\n")

  // Pre-compute "is this line inside any altimate_change block?"
  const insideBlock: boolean[] = new Array(lines.length).fill(false)
  let inB = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (!inB && START_RE.test(line)) {
      inB = true
      insideBlock[i] = true
      continue
    }
    if (inB) {
      insideBlock[i] = true
      if (END_RE.test(line)) inB = false
    }
  }

  const blocks: MarkerBlock[] = []
  let inBlock = false
  let blockStart = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (!inBlock && START_RE.test(line)) {
      inBlock = true
      blockStart = i
    } else if (inBlock && END_RE.test(line)) {
      const body = lines.slice(blockStart, i + 1)
      const anchorBefore: string[] = []
      for (let j = blockStart - 1; j >= 0 && anchorBefore.length < ANCHOR_LINES; j--) {
        const candidate = lines[j] ?? ""
        if (candidate.trim().length === 0) continue
        if (insideBlock[j]) continue
        anchorBefore.unshift(candidate)
      }
      const desc = (lines[blockStart] ?? "")
        .replace(/.*altimate_change start[\s—\-:]*/i, "")
        .replace(/[*/}]+\s*$/, "")
        .trim()
      blocks.push({ startLine: blockStart, endLine: i, body, anchorBefore, description: desc })
      inBlock = false
      blockStart = -1
    }
  }
  return blocks
}

interface ApplyResult {
  applied: MarkerBlock[]
  skipped: { block: MarkerBlock; reason: string }[]
  output: string
}

function findAnchor(targetLines: string[], anchor: string[]): number[] {
  if (anchor.length === 0) return []
  const matches: number[] = []
  for (let i = 0; i <= targetLines.length - anchor.length; i++) {
    let ok = true
    for (let j = 0; j < anchor.length; j++) {
      if (targetLines[i + j] !== anchor[j]) {
        ok = false
        break
      }
    }
    if (ok) matches.push(i + anchor.length - 1) // index of last anchor line
  }
  return matches
}

/**
 * Re-apply marker blocks from `ourContent` onto `upstreamContent`.
 *
 * Strategy:
 *   - Process blocks in source order (so earlier insertions can serve as
 *     anchors for later blocks).
 *   - For each block, search the *current* (already-modified) target for
 *     the anchor. Try the full anchor first; if not found, progressively
 *     drop the oldest line until we have a match or run out.
 *   - If no unique match: report skip with reason.
 */
function reapplyMarkers(ourContent: string, upstreamContent: string): ApplyResult {
  const blocks = extractMarkerBlocks(ourContent)
  let lines = upstreamContent.split("\n")
  const applied: MarkerBlock[] = []
  const skipped: { block: MarkerBlock; reason: string }[] = []

  for (const block of blocks) {
    let anchor = block.anchorBefore.slice()
    let matches: number[] = []

    if (anchor.length === 0) {
      // Block at top of file — insert at line 0.
      lines = [...block.body, ...lines]
      applied.push(block)
      continue
    }

    while (anchor.length > 0) {
      matches = findAnchor(lines, anchor)
      if (matches.length === 1) break
      if (matches.length === 0) {
        anchor = anchor.slice(1) // drop oldest line, try shorter anchor
        continue
      }
      // matches.length > 1 — ambiguous; try shorter to disambiguate.
      anchor = anchor.slice(1)
    }

    if (matches.length === 1) {
      lines = [...lines.slice(0, matches[0]! + 1), ...block.body, ...lines.slice(matches[0]! + 1)]
      applied.push(block)
    } else {
      skipped.push({
        block,
        reason: matches.length === 0 ? "anchor-not-found" : `ambiguous-${matches.length}`,
      })
    }
  }

  return { applied, skipped, output: lines.join("\n") }
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

interface Plan {
  takeUpstream: string[]
  keepOurs: string[]
  /**
   * Files in config.requireMarkers that we treat as keep-ours regardless of
   * whether they currently have markers. They hold known altimate behavioral
   * patches; the bridge tool MUST NOT overlay upstream content on them. Humans
   * merge any upstream improvements manually so the patches survive.
   */
  requireMarkers: string[]
  /**
   * Sub-list of requireMarkers where the file has zero altimate_change blocks.
   * The patches were either lost (regression — must restore before merging) or
   * never marked in the first place. Block the merge until resolved.
   */
  requireMarkersMissing: string[]
  skipFile: string[]
  upstreamDeletedSkip: string[]
  upstreamDeletedKeepOurs: string[]
  upstreamDeletedHasMarkers: string[]
  upstreamDeletedReview: string[]
}

async function listTreeFiles(ref: string): Promise<Set<string>> {
  const out = await $`git ls-tree -r --name-only ${ref}`.cwd(ROOT).text()
  return new Set(out.split("\n").filter(Boolean))
}

function readUtf8(p: string): string {
  return readFileSync(p, "utf8")
}

function fileHasMarkers(filePath: string): boolean {
  const abs = path.join(ROOT, filePath)
  if (!existsSync(abs)) return false
  try {
    return readUtf8(abs).includes(CHANGE_MARKER)
  } catch {
    return false
  }
}

function buildPlan(upstreamFiles: Set<string>, ourFiles: Set<string>, config: MergeConfig, minimatch: any): Plan {
  const plan: Plan = {
    takeUpstream: [],
    keepOurs: [],
    requireMarkers: [],
    requireMarkersMissing: [],
    skipFile: [],
    upstreamDeletedSkip: [],
    upstreamDeletedKeepOurs: [],
    upstreamDeletedHasMarkers: [],
    upstreamDeletedReview: [],
  }
  // Pre-compute the requireMarkers set as exact paths (not globs).
  const requireMarkersSet = new Set(config.requireMarkers)
  for (const file of upstreamFiles) {
    if (config.keepOurs.some((p) => minimatch(file, p, { dot: true }))) {
      plan.keepOurs.push(file)
    } else if (config.skipFiles.some((p) => minimatch(file, p, { dot: true }))) {
      plan.skipFile.push(file)
    } else if (requireMarkersSet.has(file)) {
      // Defense in depth: never overlay upstream content on these files.
      // The list is curated in config.requireMarkers and contains every file
      // known to hold altimate behavioral patches (UA strings, retry loops,
      // OAuth skew buffers, etc.). Humans merge upstream improvements into
      // these files manually so the patches survive.
      plan.requireMarkers.push(file)
      if (!fileHasMarkers(file)) plan.requireMarkersMissing.push(file)
    } else {
      plan.takeUpstream.push(file)
    }
  }
  for (const file of ourFiles) {
    if (upstreamFiles.has(file)) continue
    if (config.skipFiles.some((p) => minimatch(file, p, { dot: true }))) {
      plan.upstreamDeletedSkip.push(file)
    } else if (config.keepOurs.some((p) => minimatch(file, p, { dot: true }))) {
      plan.upstreamDeletedKeepOurs.push(file)
    } else if (fileHasMarkers(file)) {
      plan.upstreamDeletedHasMarkers.push(file)
    } else {
      plan.upstreamDeletedReview.push(file)
    }
  }
  return plan
}

// ---------------------------------------------------------------------------
// PR #18186 anthropic-provider fix reapplication
// ---------------------------------------------------------------------------

// Reapplies the four code-level edits PR #18186 wiped out, keeping Anthropic
// as a fully-supported provider in the fork: BUILTIN plugin, login hint in
// providers.ts, claude-code beta header, and the non-anthropic User-Agent
// guard in session/llm.ts.
//
// We deliberately do NOT restore prompt/anthropic-20250930.txt — it was an
// unused legacy variant; the active prompt is anthropic.txt. The skipFiles
// entry in utils/config.ts blocks any future upstream resurrection.
async function reapplyPR18186AnthropicProviderFixes(report: string[]): Promise<void> {
  report.push("\n## PR #18186 anthropic-provider fix reapplication\n")
  await editProvidersTs(report)
  await editPluginIndex(report)
  await editProviderTs(report)
  await editSessionLlmTs(report)
}

async function editProvidersTs(report: string[]): Promise<void> {
  const file = path.join(ROOT, "packages/opencode/src/cli/cmd/providers.ts")
  if (!existsSync(file)) {
    report.push(`- ⚠ providers.ts not found, skipping anthropic hint`)
    return
  }
  const content = readUtf8(file)
  if (content.includes(`anthropic: "API key"`)) {
    report.push(`- providers.ts: anthropic hint already present, skipping`)
    return
  }
  const search = /(\s+)opencode: "recommended",\n(\s+)openai: "ChatGPT Plus\/Pro or API key",/
  if (!search.test(content)) {
    report.push(`- ⚠ providers.ts: could not find login-hint block; skipping`)
    return
  }
  const next = content.replace(
    search,
    (_m, ind1, ind2) =>
      `${ind1}opencode: "recommended",\n${ind2}// altimate_change start — preserve anthropic provider login hint (PR #18186 reverted)\n${ind2}anthropic: "API key",\n${ind2}// altimate_change end\n${ind2}openai: "ChatGPT Plus/Pro or API key",`,
  )
  if (!DRY_RUN) writeFileSync(file, next)
  report.push(`- providers.ts: re-added anthropic hint`)
}

async function editPluginIndex(report: string[]): Promise<void> {
  const file = path.join(ROOT, "packages/opencode/src/plugin/index.ts")
  if (!existsSync(file)) {
    report.push(`- ⚠ plugin/index.ts not found, skipping BUILTIN`)
    return
  }
  let content = readUtf8(file)
  if (content.includes("opencode-anthropic-auth")) {
    report.push(`- plugin/index.ts: BUILTIN already present, skipping`)
    return
  }
  const logDecl = `const log = Log.create({ service: "plugin" })`
  if (!content.includes(logDecl)) {
    report.push(`- ⚠ plugin/index.ts: log declaration not found; skipping BUILTIN insert`)
    return
  }
  content = content.replace(
    logDecl,
    `${logDecl}\n\n  // altimate_change start — preserve anthropic auth plugin (PR #18186 reverted)\n  const BUILTIN = ["opencode-anthropic-auth@0.0.13"]\n  // altimate_change end`,
  )
  const anchor = `if (plugins.length) await Config.waitForDependencies()`
  if (content.includes(anchor)) {
    content = content.replace(
      anchor,
      `${anchor}\n    // altimate_change start — preserve anthropic auth plugin auto-load (PR #18186 reverted)\n    if (!Flag.OPENCODE_DISABLE_DEFAULT_PLUGINS) {\n      plugins = [...BUILTIN, ...plugins]\n    }\n    // altimate_change end`,
    )
  } else {
    report.push(`- ⚠ plugin/index.ts: waitForDependencies anchor not found; skipping BUILTIN load`)
  }
  if (!DRY_RUN) writeFileSync(file, content)
  report.push(`- plugin/index.ts: re-added BUILTIN anthropic-auth plugin`)
}

async function editProviderTs(report: string[]): Promise<void> {
  const file = path.join(ROOT, "packages/opencode/src/provider/provider.ts")
  if (!existsSync(file)) {
    report.push(`- ⚠ provider/provider.ts not found, skipping anthropic-beta header`)
    return
  }
  const content = readUtf8(file)
  if (content.includes("claude-code-20250219")) {
    report.push(`- provider/provider.ts: claude-code-20250219 already present, skipping`)
    return
  }
  const old = `"anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",`
  if (!content.includes(old)) {
    report.push(`- ⚠ provider/provider.ts: anthropic-beta header not in expected form; skipping`)
    return
  }
  const next = content.replace(
    old,
    `// altimate_change start — preserve claude-code anthropic-beta header (PR #18186 reverted)\n            "anthropic-beta":\n              "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",\n            // altimate_change end`,
  )
  if (!DRY_RUN) writeFileSync(file, next)
  report.push(`- provider/provider.ts: re-added claude-code-20250219 in anthropic-beta header`)
}

async function editSessionLlmTs(report: string[]): Promise<void> {
  const file = path.join(ROOT, "packages/opencode/src/session/llm.ts")
  if (!existsSync(file)) {
    report.push(`- ⚠ session/llm.ts not found, skipping User-Agent restore`)
    return
  }
  const content = readUtf8(file)
  if (content.includes(`input.model.providerID !== "anthropic"`)) {
    report.push(`- session/llm.ts: anthropic User-Agent conditional already present, skipping`)
    return
  }
  const search = `        ...(input.model.providerID.startsWith("opencode") && {
          "x-opencode-project": Instance.project.id,
          "x-opencode-session": input.sessionID,
          "x-opencode-request": input.user.id,
          "x-opencode-client": Flag.OPENCODE_CLIENT,
        }),`
  if (!content.includes(search)) {
    report.push(`- ⚠ session/llm.ts: headers block not in expected form; skipping User-Agent restore`)
    return
  }
  const replacement = `        // altimate_change start — preserve User-Agent for non-anthropic providers (PR #18186 reverted)
        ...(input.model.providerID.startsWith("opencode")
          ? {
              "x-opencode-project": Instance.project.id,
              "x-opencode-session": input.sessionID,
              "x-opencode-request": input.user.id,
              "x-opencode-client": Flag.OPENCODE_CLIENT,
            }
          : input.model.providerID !== "anthropic"
            ? {
                "User-Agent": \`opencode/\${Installation.VERSION}\`,
              }
            : undefined),
        // altimate_change end`
  const next = content.replace(search, replacement)
  if (!DRY_RUN) writeFileSync(file, next)
  report.push(`- session/llm.ts: re-added User-Agent conditional for non-anthropic providers`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig()
  assertSameMajor(VERSION, config.upstreamBaseline)

  const { minimatch } = await import("minimatch")
  const report: string[] = []
  report.push(`# Bridge Merge Report — overlay ${VERSION}\n`)
  report.push(`Generated: ${new Date().toISOString()}\n`)
  report.push(`Working tree: ${ROOT}\n`)

  logger.banner(`Bridge Merge: overlay ${VERSION}`)

  const status = (await $`git status --porcelain -uno`.cwd(ROOT).text()).trim()
  if (status.length > 0 && !DRY_RUN) {
    logger.error("Working tree has uncommitted changes. Stash or commit first.")
    process.exit(1)
  }

  const tagSha = await $`git rev-parse ${VERSION}`
    .cwd(ROOT)
    .text()
    .catch(() => "")
  if (!tagSha.trim()) {
    logger.error(`Tag ${VERSION} not found. Fetch upstream first: git fetch upstream --tags`)
    process.exit(1)
  }
  logger.success(`Target ${VERSION} = ${tagSha.trim().slice(0, 12)}`)

  const mergeBranch = `upstream/merge-${VERSION}`
  const backupBranch = `backup/main-${Date.now()}`
  if (!DRY_RUN && !NO_BRANCH) {
    await $`git branch ${backupBranch}`.cwd(ROOT).quiet()
    logger.success(`Backup branch: ${cyan(backupBranch)}`)
    try {
      await $`git checkout -b ${mergeBranch}`.cwd(ROOT).quiet()
      logger.success(`Merge branch: ${cyan(mergeBranch)}`)
    } catch {
      logger.error(`Could not create branch ${mergeBranch} (may already exist)`)
      process.exit(1)
    }
  }
  report.push(`- Backup branch: \`${backupBranch}\``)
  report.push(`- Merge branch: \`${mergeBranch}\`\n`)

  logger.step(1, 7, "Listing trees")
  const upstreamFiles = await listTreeFiles(VERSION)
  const ourFiles = await listTreeFiles("HEAD")
  logger.info(`upstream ${VERSION}: ${upstreamFiles.size} files`)
  logger.info(`our HEAD:           ${ourFiles.size} files`)

  logger.step(2, 7, "Classifying files")
  const plan = buildPlan(upstreamFiles, ourFiles, config, minimatch)
  logger.info(`take upstream:                    ${plan.takeUpstream.length}`)
  logger.info(`keep ours (keepOurs):             ${plan.keepOurs.length}`)
  logger.info(`keep ours (requireMarkers):       ${plan.requireMarkers.length}  → must merge upstream changes manually`)
  logger.info(`skip (skipFiles):                 ${plan.skipFile.length}`)
  logger.info(`upstream deleted (skipFiles):     ${plan.upstreamDeletedSkip.length}  → delete`)
  logger.info(`upstream deleted (keepOurs):      ${plan.upstreamDeletedKeepOurs.length}  → keep`)
  logger.info(`upstream deleted (has markers):   ${plan.upstreamDeletedHasMarkers.length}  → keep (altimate code)`)
  logger.info(`upstream deleted (REVIEW):        ${plan.upstreamDeletedReview.length}  → keep + flag`)

  // Hard abort if a requireMarkers file is missing markers entirely. Either the
  // patches were lost (regression — restore before merging) or never marked
  // (run a marker sweep first). Pushing through would silently re-introduce
  // the v1.4.0 regression class.
  if (plan.requireMarkersMissing.length > 0) {
    logger.error(
      `${plan.requireMarkersMissing.length} requireMarkers file(s) have NO altimate_change blocks — bridge merge aborted to prevent silent loss of altimate behavioral patches:`,
    )
    for (const f of plan.requireMarkersMissing) logger.error(`  ${f}`)
    logger.info("")
    logger.info("Run `bun run script/upstream/analyze.ts --require-markers --strict` for details.")
    logger.info("Resolve by either:")
    logger.info("  (a) Restoring missing altimate_change blocks around the patches,")
    logger.info("  (b) Removing the file from config.requireMarkers if it no longer holds patches.")
    process.exit(1)
  }

  report.push(`## Plan summary\n`)
  report.push(`| Category | Action | Count |`)
  report.push(`|---|---|---|`)
  report.push(`| In v1.4.0 — Take upstream | overwrite | ${plan.takeUpstream.length} |`)
  report.push(`| In v1.4.0 — keepOurs glob | leave main's version | ${plan.keepOurs.length} |`)
  report.push(`| In v1.4.0 — requireMarkers list | leave main's version (review for upstream changes) | ${plan.requireMarkers.length} |`)
  report.push(`| In v1.4.0 — skipFiles glob | exclude | ${plan.skipFile.length} |`)
  report.push(`| Not in v1.4.0 — skipFiles glob | delete | ${plan.upstreamDeletedSkip.length} |`)
  report.push(`| Not in v1.4.0 — keepOurs glob | keep | ${plan.upstreamDeletedKeepOurs.length} |`)
  report.push(`| Not in v1.4.0 — has \`altimate_change\` markers | keep | ${plan.upstreamDeletedHasMarkers.length} |`)
  report.push(`| Not in v1.4.0 — no rule (REVIEW) | keep + flag | ${plan.upstreamDeletedReview.length} |\n`)

  if (DRY_RUN) {
    logger.info("Dry-run: writing report only, no changes.")
    report.push(`\n## Files upstream removed that we'll DELETE (skipFiles match)\n`)
    for (const f of plan.upstreamDeletedSkip.sort()) report.push(`- \`${f}\``)
    report.push(`\n## Files upstream removed that we KEEP — has altimate_change markers\n`)
    for (const f of plan.upstreamDeletedHasMarkers.sort()) report.push(`- \`${f}\``)
    report.push(`\n## Files upstream removed — REVIEW (kept by default; remove if truly stale)\n`)
    for (const f of plan.upstreamDeletedReview.sort()) report.push(`- \`${f}\``)
    report.push(`\n## Files upstream removed that we KEEP — keepOurs glob match\n`)
    for (const f of plan.upstreamDeletedKeepOurs.sort()) report.push(`- \`${f}\``)
    writeFileSync(REPORT_PATH, report.join("\n"))
    logger.success(`Report written: ${REPORT_PATH}`)
    return
  }

  logger.step(3, 7, "Identifying marker-bearing files (kept entirely from main)")
  const markerFiles = new Set<string>()
  for (const file of plan.takeUpstream) {
    const abs = path.join(ROOT, file)
    if (!existsSync(abs)) continue
    if (readUtf8(abs).includes(CHANGE_MARKER)) markerFiles.add(file)
  }
  logger.info(`marker-bearing files: ${markerFiles.size}  → kept from main`)
  const overlayList = plan.takeUpstream.filter((f) => !markerFiles.has(f))

  logger.step(4, 7, "Overlaying upstream content (skipping marker files)")
  let overlaid = 0
  const batchSize = 200
  for (let i = 0; i < overlayList.length; i += batchSize) {
    const batch = overlayList.slice(i, i + batchSize)
    const cmd = `git checkout ${VERSION} -- ${batch.map((f) => JSON.stringify(f)).join(" ")}`
    await $`sh -c ${cmd}`
      .cwd(ROOT)
      .quiet()
      .catch(() => null)
    overlaid += batch.length
    if ((i / batchSize) % 5 === 0) logger.info(`  overlaid ${overlaid}/${overlayList.length}`)
  }
  logger.success(`overlaid ${overlaid} files from ${VERSION}`)

  logger.step(5, 7, "Marker files preserved (no re-application attempted)")
  report.push(`\n## Marker file handling\n`)
  report.push(`Files with \`altimate_change\` markers in main: **${markerFiles.size}**\n`)
  report.push(`These files were NOT overlaid — main's version is preserved entirely so altimate `)
  report.push(`code is not lost. Trade-off: upstream's improvements to these files are not yet `)
  report.push(`applied. Followup work: for each file, manually merge upstream's changes while `)
  report.push(`keeping marker blocks intact.\n`)
  report.push(`\n### Marker files preserved (need manual upstream merge)\n`)
  for (const f of [...markerFiles].sort()) report.push(`- \`${f}\``)
  report.push("")

  logger.step(6, 7, "Cleaning up upstream-removed files (skipFiles only)")
  let deleted = 0
  for (const file of plan.upstreamDeletedSkip) {
    const abs = path.join(ROOT, file)
    if (existsSync(abs)) {
      rmSync(abs, { force: true })
      deleted++
    }
  }
  for (const file of plan.skipFile) {
    const abs = path.join(ROOT, file)
    if (existsSync(abs)) rmSync(abs, { force: true })
  }
  logger.info(`deleted ${deleted} files (matched skipFiles)`)
  logger.info(`kept ${plan.upstreamDeletedReview.length} files for human review (see report)`)
  report.push(`\n## Files kept for human review (upstream removed, no rule matched)\n`)
  report.push(`These files exist in our main but not in v1.4.0. They don't match keepOurs/skipFiles `)
  report.push(`patterns and don't carry altimate_change markers. We kept them by default — review `)
  report.push(
    `each and either:\n- Add to \`keepOurs\` in \`script/upstream/utils/config.ts\` if it's altimate code, or\n- Add to \`skipFiles\` (and delete) if it's truly stale upstream code.\n`,
  )
  for (const f of plan.upstreamDeletedReview.sort()) report.push(`- \`${f}\``)

  if (!SKIP_PR_REVERT) {
    logger.step(7, 7, "Reapplying PR #18186 anthropic-provider fixes")
    await reapplyPR18186AnthropicProviderFixes(report)
  }

  writeFileSync(REPORT_PATH, report.join("\n"))
  logger.success(`Report written: ${REPORT_PATH}`)

  console.log()
  logger.banner("Bridge Merge Complete")
  console.log(`  Branch:           ${cyan(mergeBranch)}`)
  console.log(`  Backup:           ${cyan(backupBranch)}`)
  console.log(
    `  Marker files:     ${green(String(markerFiles.size))} preserved from main (need manual upstream merge in followup)`,
  )
  console.log(`  Files overlaid:   ${overlaid}`)
  console.log(`  Files deleted:    ${deleted}`)
  console.log(`  Report:           ${REPORT_PATH}`)
  console.log()
  console.log(`${bold("Next steps:")}`)
  console.log(`  1. Review the report:    ${dim("cat .bridge-merge-report.md")}`)
  console.log(`  2. Check unmarked files: ${dim("git status")}`)
  console.log(`  3. Run branding audit:   ${dim("bun run script/upstream/analyze.ts --branding")}`)
  console.log(
    `  4. Run typecheck/tests:  ${dim("bun install && bunx turbo typecheck && bun run --cwd packages/opencode test")}`,
  )
  console.log()
}

main().catch((e) => {
  logger.error(e?.message ?? String(e))
  console.error(e?.stack)
  process.exit(1)
})
