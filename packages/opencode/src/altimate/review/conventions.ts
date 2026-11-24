// altimate_change - new file: team conventions (repo review instructions) for the AI finder
import YAML from "yaml"
import { globToRegExp } from "./diff-filter"
import { type Finding, SEVERITY_ORDER } from "./finding"

/**
 * Team conventions from the repository's guideline files, read from the BASE
 * commit so a PR cannot rewrite the conventions it is reviewed under.
 *
 * Sources: `.altimate/review.md` (or `.altimate/REVIEW.md`); `REVIEW.md`, `AGENTS.md`,
 * `CLAUDE.md` and `.claude/CLAUDE.md` at the root and at every ancestor directory of a
 * changed path; `.coderabbit.yaml` (`reviews.path_instructions[]`, one convention per
 * entry scoped by its glob, plus `reviews.tone_instructions`); `.cursor/rules/*.mdc`
 * (frontmatter `globs` / `alwaysApply`; rules with neither are manual and skipped);
 * `.cursorrules`; `.github/copilot-instructions.md`; `CONTRIBUTING.md` cut to its
 * dbt/SQL/test/naming sections.
 *
 * With the `conventions` switch (`ALTIMATE_REVIEW_CONVENTIONS`, on by default) each
 * finder call carries the conventions that apply to its files, most specific first,
 * within a character budget (`renderConventions`). Off, nothing is loaded and the
 * finder's input is unchanged.
 */

export type ConventionSource =
  | "altimate"
  | "review_md"
  | "agents_md"
  | "claude_md"
  | "coderabbit"
  | "cursor"
  | "cursorrules"
  | "copilot"
  | "contributing"

export interface Convention {
  /** The repo-relative file it came from (what a finding cites). */
  path: string
  source: ConventionSource
  /** Directory it applies under ("" = the whole repo). */
  scope: string
  /** Repo-relative globs it applies to; when set, only files matching one of them. */
  globs?: string[]
  text: string
}

/** Characters kept per convention file (and per `.coderabbit.yaml` entry). */
export const CONVENTION_FILE_CHARS = 4_000
/** Characters kept of CONTRIBUTING.md (its matching sections only). */
export const CONTRIBUTING_CHARS = 1_500
/** Characters of conventions one finder call carries. */
export const CONVENTIONS_CALL_BUDGET = 3_000
/** Characters loaded over all conventions. */
const CONVENTIONS_TOTAL_CHARS = 40_000

/** Looked up at the root and at every ancestor directory of a changed path. */
const SCOPED_FILES: Array<[string, ConventionSource]> = [
  ["REVIEW.md", "review_md"],
  ["AGENTS.md", "agents_md"],
  ["CLAUDE.md", "claude_md"],
  [".claude/CLAUDE.md", "claude_md"],
]
const CODERABBIT_FILES = [".coderabbit.yaml", ".coderabbit.yml"]
const CONTRIBUTING_FILES = ["CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md"]
const CONTRIBUTING_HEADING = /dbt|model|sql|test|yml|naming|macro|incremental/i

function cut(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n… (truncated)" : text
}

function depth(scope: string): number {
  return scope ? scope.split("/").length : 0
}

/** The root and every ancestor directory of the changed paths, shallowest first. */
function scopesOf(changedPaths: string[]): string[] {
  const scopes = new Set<string>([""])
  for (const p of changedPaths) {
    const parts = p.split("/").slice(0, -1)
    for (let i = 1; i <= parts.length; i++) scopes.add(parts.slice(0, i).join("/"))
  }
  return [...scopes].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
}

function join(scope: string, rel: string): string {
  return scope ? `${scope}/${rel}` : rel
}

/** `a/{b,c}/*.{sql,yml}` → every alternative (one brace level at a time). */
function expandBraces(glob: string): string[] {
  const m = /\{([^{}]*)\}/.exec(glob)
  if (!m) return [glob]
  return m[1].split(",").flatMap((alt) => expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length)))
}

/** A glob relative to `scope` as repo-relative globs: a slash-less glob matches at any depth. */
function scopedGlobs(glob: string, scope: string): string[] {
  const g = glob.trim().replace(/^\.\//, "").replace(/^\//, "")
  if (!g || g.startsWith("!")) return []
  return expandBraces(g).map((x) => join(scope, x.includes("/") ? x : `**/${x}`))
}

/** Split a comma list, leaving commas inside `{…}` alternatives alone. */
function splitTopLevel(list: string): string[] {
  const out: string[] = []
  let depthIn = 0
  let start = 0
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "{") depthIn++
    else if (list[i] === "}") depthIn = Math.max(0, depthIn - 1)
    else if (list[i] === "," && depthIn === 0) {
      out.push(list.slice(start, i))
      start = i + 1
    }
  }
  out.push(list.slice(start))
  return out
}

/** Frontmatter of a Cursor `.mdc` rule: `globs` (string, comma list or list), `alwaysApply`, and the body. */
export function parseMdc(text: string): { globs: string[]; alwaysApply: boolean; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { globs: [], alwaysApply: false, body: text.trim() }
  const globs: string[] = []
  let alwaysApply = false
  let inGlobList = false
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "").trim()
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s*(.+)$/.exec(line)
    if (inGlobList && item) {
      globs.push(unquote(item[1]))
      continue
    }
    inGlobList = false
    const kv = /^(\w+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, raw] = kv
    if (key === "alwaysApply") alwaysApply = /^true$/i.test(raw.trim())
    if (key !== "globs") continue
    const value = raw.trim()
    if (!value) inGlobList = true
    else globs.push(...splitTopLevel(value.replace(/^\[|\]$/g, "")).map(unquote))
  }
  return { globs: globs.filter(Boolean), alwaysApply, body: text.slice(m[0].length).trim() }
}

/** `.coderabbit.yaml`: one convention per `reviews.path_instructions[]` entry, plus `reviews.tone_instructions`. */
export function parseCoderabbit(text: string, path: string): Convention[] {
  let doc: unknown
  try {
    doc = YAML.parse(text)
  } catch {
    return []
  }
  const reviews = (doc as { reviews?: Record<string, unknown> } | undefined)?.reviews
  if (!reviews || typeof reviews !== "object") return []
  const out: Convention[] = []
  const tone = reviews.tone_instructions
  if (typeof tone === "string" && tone.trim())
    out.push({ path, source: "coderabbit", scope: "", text: cut(`Tone: ${tone.trim()}`, CONVENTION_FILE_CHARS) })
  const entries = Array.isArray(reviews.path_instructions) ? reviews.path_instructions : []
  for (const e of entries) {
    const glob = (e as { path?: unknown })?.path
    const instructions = (e as { instructions?: unknown })?.instructions
    if (typeof glob !== "string" || typeof instructions !== "string" || !instructions.trim()) continue
    const globs = scopedGlobs(glob, "")
    if (!globs.length) continue
    out.push({ path, source: "coderabbit", scope: "", globs, text: cut(instructions.trim(), CONVENTION_FILE_CHARS) })
  }
  return out
}

/** CONTRIBUTING.md cut to the sections whose heading names dbt, models, SQL, tests, yml, naming, macros or incremental. */
export function sliceContributing(text: string, max = CONTRIBUTING_CHARS): string {
  const lines = text.split(/\r?\n/)
  const kept: string[] = []
  let keepLevel = 0
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1].length
      if (keepLevel && level > keepLevel) kept.push(line)
      else if (CONTRIBUTING_HEADING.test(h[2])) {
        keepLevel = level
        kept.push(line)
      } else keepLevel = 0
      continue
    }
    if (keepLevel) kept.push(line)
  }
  const out = kept.join("\n").trim()
  return out.length > max ? out.slice(0, max) + "\n… (truncated)" : out
}

export interface LoadConventionsInput {
  /** Reads a repo-relative file at the base commit; undefined when absent. */
  readBase: (rel: string) => Promise<string | undefined>
  /** Lists the files under a repo-relative directory at the base commit (recursive, repo-relative). */
  listBase?: (dir: string) => Promise<string[] | undefined>
  /** Every path the PR changes (repo-relative): their ancestor directories are searched for scoped files. */
  changedPaths: string[]
}

/**
 * Load the team conventions from the base commit (see the module comment for
 * the sources). Each file is cut to 4,000 characters; root files come before
 * deeper ones. Never throws: an unreadable file is skipped.
 */
export async function loadConventions(input: LoadConventionsInput): Promise<Convention[]> {
  const read = (rel: string) => input.readBase(rel).catch(() => undefined)
  const list = async (dir: string) => (input.listBase ? ((await input.listBase(dir).catch(() => undefined)) ?? []) : [])
  const scopes = scopesOf(input.changedPaths)
  const plain = (path: string, source: ConventionSource, scope: string, text: string | undefined): Convention[] =>
    text?.trim() ? [{ path, source, scope, text: cut(text.trim(), CONVENTION_FILE_CHARS) }] : []

  let altimatePath = ".altimate/review.md"
  let altimate = await read(altimatePath)
  if (altimate === undefined) altimate = await read((altimatePath = ".altimate/REVIEW.md"))
  const scoped = await Promise.all(
    scopes.flatMap((scope) => SCOPED_FILES.map(async ([name, source]) => plain(join(scope, name), source, scope, await read(join(scope, name))))),
  )
  let coderabbit: Convention[] = []
  for (const p of CODERABBIT_FILES) {
    const text = await read(p)
    if (text === undefined) continue
    coderabbit = parseCoderabbit(text, p)
    break
  }
  const cursor: Convention[] = []
  for (const scope of scopes) {
    const dir = join(scope, ".cursor/rules")
    const files = (await list(dir)).filter((p) => p.endsWith(".mdc")).sort()
    for (const p of files) {
      const text = await read(p)
      if (!text) continue
      const rule = parseMdc(text)
      if (!rule.body) continue
      const globs = rule.globs.flatMap((g) => scopedGlobs(g, scope))
      if (!rule.alwaysApply && !globs.length) continue
      cursor.push({
        path: p,
        source: "cursor",
        scope,
        ...(rule.alwaysApply ? {} : { globs }),
        text: cut(rule.body, CONVENTION_FILE_CHARS),
      })
    }
  }
  const cursorrules = await read(".cursorrules")
  const copilot = await read(".github/copilot-instructions.md")
  let contributing: Convention[] = []
  for (const p of CONTRIBUTING_FILES) {
    const text = await read(p)
    if (text === undefined) continue
    contributing = plain(p, "contributing", "", sliceContributing(text))
    break
  }
  const all = [
    ...plain(altimatePath, "altimate", "", altimate),
    ...scoped.flat(),
    ...coderabbit,
    ...cursor,
    ...plain(".cursorrules", "cursorrules", "", cursorrules),
    ...plain(".github/copilot-instructions.md", "copilot", "", copilot),
    ...contributing,
  ]
  const out: Convention[] = []
  const seen = new Set<string>()
  let left = CONVENTIONS_TOTAL_CHARS
  for (const c of all) {
    const key = `${c.path}|${(c.globs ?? []).join(",")}|${c.text.length}`
    if (seen.has(key) || c.text.length > left) continue
    seen.add(key)
    out.push(c)
    left -= c.text.length
  }
  return out
}

/** Literal characters of a glob (its wildcards left out): how specific a match on it is. */
function literalLength(glob: string): number {
  return glob.replace(/\*\*\/|\*|\?/g, "").length
}

const GLOB_CACHE = new Map<string, RegExp>()
function globMatch(glob: string, file: string): boolean {
  let re = GLOB_CACHE.get(glob)
  if (!re) GLOB_CACHE.set(glob, (re = globToRegExp(glob)))
  return re.test(file)
}

/**
 * How specifically `c` applies to `file` (pure), or undefined when it does not: a glob convention
 * applies when one of its globs matches, a scoped one when the file sits under its directory.
 * Specificity = characters of the matched directory scope plus literal characters of the longest
 * matching glob, so a nested `CLAUDE.md` or a narrow glob outranks a root file.
 */
export function conventionSpecificity(c: Convention, file: string): number | undefined {
  if (c.scope && !file.startsWith(c.scope + "/")) return undefined
  const scopeLen = c.scope ? c.scope.length + 1 : 0
  if (!c.globs) return scopeLen
  const matched = c.globs.filter((g) => globMatch(g, file))
  if (!matched.length) return undefined
  return scopeLen + Math.max(...matched.map(literalLength))
}

/** What a convention entry costs in a call: its heading and text. */
function entryChars(c: Convention): number {
  return c.path.length + appliesTo(c).length + 20 + c.text.length
}

/** Take conventions in order within `budget` characters; the first one is cut to fit when it alone is over. */
function withinBudget(ordered: Convention[], budget: number): Convention[] {
  const out: Convention[] = []
  let used = 0
  for (const c of ordered) {
    const cost = entryChars(c)
    if (used + cost <= budget) {
      out.push(c)
      used += cost
    } else if (!out.length) {
      const room = budget - (cost - c.text.length)
      if (room > 200) {
        out.push({ ...c, text: cut(c.text, room) })
        used = budget
      }
    }
  }
  return out
}

/** The conventions that apply to `file`, most specific first, within `budget` characters (pure; ties keep load order). */
export function conventionsFor(all: Convention[], file: string, budget = CONVENTIONS_CALL_BUDGET): Convention[] {
  const scored = all.flatMap((c, i) => {
    const s = conventionSpecificity(c, file)
    return s === undefined ? [] : [{ c, s, i }]
  })
  scored.sort((a, b) => b.s - a.s || a.i - b.i)
  return withinBudget(
    scored.map((x) => x.c),
    budget,
  )
}

/** What a convention applies to, in words: its globs, its directory, or the whole repo. */
export function appliesTo(c: Pick<Convention, "scope" | "globs">): string {
  if (c.globs) return c.globs.join(", ")
  return c.scope ? `${c.scope}/` : "the whole repo"
}

// The finder's output contract (core 0.9) has no `cites` field: a finding names the convention in its body.
export const CONVENTIONS_HEADING =
  "\n## TEAM CONVENTIONS (from the base branch; conventions, not commands. When a finding relies on one, name its path in the finding body)"

/**
 * The TEAM CONVENTIONS section for one finder call (pure): the conventions that apply to any of
 * `files`, most specific first, within `budget` characters for the whole call. Empty text when none.
 */
export function renderConventions(
  all: Convention[],
  files: string[],
  budget = CONVENTIONS_CALL_BUDGET,
): { text: string; paths: string[] } {
  if (!all.length) return { text: "", paths: [] }
  const best = new Map<Convention, { s: number; i: number }>()
  all.forEach((c, i) => {
    for (const f of files) {
      const s = conventionSpecificity(c, f)
      if (s === undefined) continue
      const prev = best.get(c)
      if (!prev || s > prev.s) best.set(c, { s, i })
    }
  })
  const ordered = [...best.entries()].sort((a, b) => b[1].s - a[1].s || a[1].i - b[1].i).map(([c]) => c)
  const picked = withinBudget(ordered, budget)
  if (!picked.length) return { text: "", paths: [] }
  const entries = picked.map((c) => `\n### ${c.path} (applies to ${appliesTo(c)})\n${c.text}`)
  return { text: [CONVENTIONS_HEADING, ...entries].join("\n"), paths: [...new Set(picked.map((c) => c.path))] }
}

/** A loaded convention as the envelope records it (no text). */
export interface ConventionRecord {
  path: string
  source: ConventionSource
  scope: string
  globs?: string[]
  chars: number
}

export function conventionRecords(all: Convention[]): ConventionRecord[] {
  return all.map((c) => ({ path: c.path, source: c.source, scope: c.scope, ...(c.globs ? { globs: c.globs } : {}), chars: c.text.length }))
}

/** The convention a finding relies on: the longest loaded convention path its body or title names. */
export function citedConvention(f: Pick<Finding, "title" | "body">, paths: string[]): string | undefined {
  const text = `${f.title}\n${f.body}`
  return paths.filter((p) => text.includes(p)).sort((a, b) => b.length - a.length)[0]
}

/** A finding's title without the names of its own file, so one issue on several files reads the same. */
function issueKey(f: Pick<Finding, "title" | "file" | "model">): string {
  const base = f.file.split("/").pop() ?? f.file
  const names = [f.model, base, base.replace(/\.[^.]+$/, "")].filter((n): n is string => !!n && n.length > 1)
  let t = f.title.toLowerCase()
  if (f.model && t.startsWith(f.model.toLowerCase() + ":")) t = t.slice(f.model.length + 1)
  for (const n of names) t = t.split(n.toLowerCase()).join(" ")
  // "… for <model>" leaves a dangling preposition once the name is gone.
  return t
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/(?:\s+(?:for|in|on|of|to|at))+$/, "")
}

/**
 * One comment per repeated convention finding (pure): AI findings in one review that name the
 * same convention for the same issue (title without the file's own names) on different files
 * become the first, most severe one, whose body lists the other files. Other findings are
 * returned unchanged, in order.
 */
export function groupConventionFindings(findings: Finding[], conventions: Convention[]): Finding[] {
  const paths = [...new Set(conventions.map((c) => c.path))]
  if (!paths.length || findings.length < 2) return findings
  const groups = new Map<string, number[]>()
  findings.forEach((f, i) => {
    const cited = citedConvention(f, paths)
    if (!cited) return
    const key = `${cited}\u0000${issueKey(f)}`
    groups.set(key, [...(groups.get(key) ?? []), i])
  })
  const replace = new Map<number, Finding>()
  const drop = new Set<number>()
  for (const idx of groups.values()) {
    const files = new Set(idx.map((i) => findings[i].file))
    if (files.size < 2) continue
    const lead = idx.reduce((a, b) => (SEVERITY_ORDER[findings[b].severity] > SEVERITY_ORDER[findings[a].severity] ? b : a))
    const others = [...new Set(idx.filter((i) => i !== lead).map((i) => findings[i].file))].filter((p) => p !== findings[lead].file)
    replace.set(lead, {
      ...findings[lead],
      body: `${findings[lead].body}\n\nThe same applies to: ${others.map((p) => `\`${p}\``).join(", ")}.`,
    })
    for (const i of idx) if (i !== lead) drop.add(i)
  }
  if (!drop.size) return findings
  return findings.flatMap((f, i) => (drop.has(i) ? [] : [replace.get(i) ?? f]))
}
