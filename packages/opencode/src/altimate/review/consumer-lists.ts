import { execFile } from "node:child_process"
import { promisify } from "node:util"

/**
 * Opt-in: explicit column lists outside dbt (loaders, exports, reverse-ETL
 * configs) that must stay in step with a model's columns. A project names the
 * files and a regex whose first capture group holds the list in
 * `.altimate/review.yml`; the review then reports model columns a list is
 * missing, and list entries the model no longer selects. Off unless configured,
 * since no such convention is universal.
 */

export interface ConsumerColumnListConfig {
  /** Repository-relative glob of the files holding the lists. */
  files: string
  /** Regex whose first capture group is the column list. */
  pattern: string
  /** The model the lists mirror; omitted = files that mention the model by name. */
  model?: string
}

export interface ConsumerColumnList {
  path: string
  model?: string
  columns: string[]
  /** File text, to match lists to models by name when `model` is omitted. */
  content: string
}

const exec = promisify(execFile)
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/

/** Column names from every match of `pattern` in `content` (lowercased, de-duplicated). */
export function extractColumnList(content: string, pattern: RegExp): string[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"
  const re = new RegExp(pattern.source, flags)
  const out = new Set<string>()
  for (const m of content.matchAll(re)) {
    for (const token of (m[1] ?? "").split(/[,\s]+/)) {
      const name = token.replace(/^["'`]+|["'`]+$/g, "")
      if (IDENT.test(name)) out.add(name.toLowerCase())
    }
  }
  return [...out]
}

/** True when a list belongs to `model`: named explicitly, or the file mentions the model. */
export function listMirrorsModel(list: ConsumerColumnList, model: string): boolean {
  if (list.model) return list.model.toLowerCase() === model.toLowerCase()
  return new RegExp(`\\b${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(list.content)
}

/**
 * Read the configured lists at the head (`head` ref, or the working tree).
 * An invalid pattern is reported on stderr and skipped, never fatal.
 */
export async function loadConsumerLists(opts: {
  configs: ConsumerColumnListConfig[]
  gitRoot: string
  head?: string
  read: (repoRelPath: string) => Promise<string | undefined>
}): Promise<ConsumerColumnList[]> {
  const out: ConsumerColumnList[] = []
  for (const cfg of opts.configs) {
    let re: RegExp
    try {
      re = new RegExp(cfg.pattern, "g")
    } catch (e) {
      process.stderr.write(`⚠️  consumerColumnLists: invalid pattern ${JSON.stringify(cfg.pattern)} (${String(e)}); skipped.\n`)
      continue
    }
    const pathspec = `:(glob)${cfg.files}`
    const args = opts.head ? ["ls-tree", "-r", "--name-only", opts.head, "--", pathspec] : ["ls-files", "--", pathspec]
    let files: string[] = []
    try {
      files = (await exec("git", args, { cwd: opts.gitRoot, maxBuffer: 16 * 1024 * 1024 })).stdout.split("\n").filter(Boolean)
    } catch {
      files = []
    }
    for (const file of files) {
      const content = await opts.read(file)
      if (!content) continue
      const columns = extractColumnList(content, re)
      if (columns.length) out.push({ path: file, model: cfg.model, columns, content })
    }
  }
  return out
}
