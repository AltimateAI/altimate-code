// altimate_change - LLM reviewer lane (transport only; prompt + parse live in core)
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { Agent } from "@/agent/agent"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Log } from "@/altimate/util/log"
import { redactSecrets } from "@/installation"
import { Dispatcher } from "../native"
import { readFile } from "node:fs/promises"
import { type Finding, type ReviewCategory, type Severity, makeFinding, ruleId } from "./finding"
import { readStreamText } from "../llm/stream-text"
import { type AiVerifyEvidence, type VerifierStatus, runAiVerify } from "./ai-verify"
import { aiReplayPath, runAiReplay } from "./ai-replay"
import { walkDiffLines } from "./diff-filter"
import { CARD_BATCH_MAX_CHARS } from "./ai-context-card"
import { type AiSwitches, switchOn } from "./ai-switches"
import { AI_OTHER_FILES_QUOTA, AI_OTHER_KINDS } from "./ai-other-files"
import { AI_PYTHON_FILES_QUOTA, AI_PYTHON_KIND } from "./ai-python-files"

const log = Log.create({ service: "ai-review" })

const AI_TIMEOUT_BASE_MS = 60_000
const AI_TIMEOUT_MAX_MS = 300_000
const MAX_DIFF_CHARS = 6_000 // per file, keep the prompt bounded
const MAX_FILES = 20
const CONTEXT_FILE_CHARS = 8_000
const CONTEXT_TOTAL_CHARS = 40_000
const BATCH_CONCURRENCY = 2
/** Per-kind file quotas under `ALTIMATE_REVIEW_AI_COVERAGE=1`. */
const COVERAGE_QUOTAS = { model: 12, macro: 8, test: 4, yml: 6 }
/** Head-side lines of context kept around each changed line in a file excerpt. */
const EXCERPT_CONTEXT_LINES = 20
/** Characters of a file's diff section under coverage (hunks beyond it are listed as omitted). */
const COVERAGE_DIFF_CHARS = 16_000
/** Current-file head kept under coverage when the diff section already carries every hunk of a long diff. */
const COVERAGE_FULL_DIFF_FILE_CHARS = 2_000
/** Default per-call size under coverage (~30k tokens): 30 quota files at up to ~22k chars each would
 *  otherwise make one ~660k-char call that overruns common context windows. */
const COVERAGE_BATCH_CHARS = 120_000
/** Focused batching defaults under `ALTIMATE_REVIEW_AI_FOCUSED=1`. */
const FOCUS_DEFAULTS: AiFocusBudget = { minFiles: 7, batchFiles: 5, maxBatches: 4 }
/** Paths listed per call under "OTHER FILES CHANGED IN THIS PR". */
const FOCUS_OTHER_FILES = 40

/**
 * How much of the PR the lane sends. Defaults keep one bounded call; the
 * `ALTIMATE_REVIEW_AI_*` variables widen it for experiments: more files, longer
 * files, and a per-call size above which files are split across several calls
 * instead of being cut.
 */
export interface AiInputBudget {
  maxFiles: number
  maxFileChars: number
  /** Characters of file sections per call; Infinity keeps a single call (the default without coverage). */
  batchChars: number
  /** `ALTIMATE_REVIEW_AI_COVERAGE=1`: per-kind file quotas (replacing `maxFiles`) and
   *  hunk-centred excerpts instead of head truncation. Undefined keeps today's input.
   *  `otherQuota` (`otherFiles` switch): quota for other/analysis files, kept outside
   *  `quotas` so the existing buckets and their spare are unchanged. `pythonQuota`
   *  (`pythonFiles` switch): the same for the added Python files. */
  coverage?: AiCoverageRender & { quotas: Record<AiFileBucket, number>; otherQuota?: number; pythonQuota?: number }
  /** `ALTIMATE_REVIEW_AI_FOCUSED=1`: on PRs with at least `minFiles` selected files, review
   *  related files together in calls of about `batchFiles` files, at most `maxBatches` calls
   *  unless `batchChars` needs more. */
  focused?: AiFocusBudget
}
export interface AiFocusBudget {
  minFiles: number
  batchFiles: number
  maxBatches: number
}
export function aiInputBudget(
  env: Record<string, string | undefined> = process.env,
  switches?: Partial<AiSwitches>,
): AiInputBudget {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v)
    return v && Number.isFinite(n) && n > 0 ? n : d
  }
  const int = (v: string | undefined, d: number) => {
    const n = Number(v)
    return v && Number.isInteger(n) && n > 0 ? n : d
  }
  // A quota of 0 disables that bucket.
  const quota = (v: string | undefined, d: number) => {
    const n = Number(v)
    return v && Number.isInteger(n) && n >= 0 ? n : d
  }
  const coverageOn = switchOn("coverage", switches, env)
  return {
    maxFiles: num(env.ALTIMATE_REVIEW_AI_MAX_FILES, MAX_FILES),
    maxFileChars: num(env.ALTIMATE_REVIEW_AI_MAX_FILE_CHARS, MAX_DIFF_CHARS),
    batchChars: num(env.ALTIMATE_REVIEW_AI_BATCH_CHARS, coverageOn ? COVERAGE_BATCH_CHARS : Infinity),
    coverage:
      coverageOn
        ? {
            diffChars: num(env.ALTIMATE_REVIEW_AI_COVERAGE_DIFF_CHARS, COVERAGE_DIFF_CHARS),
            quotas: {
              model: quota(env.ALTIMATE_REVIEW_AI_QUOTA_MODEL, COVERAGE_QUOTAS.model),
              macro: quota(env.ALTIMATE_REVIEW_AI_QUOTA_MACRO, COVERAGE_QUOTAS.macro),
              test: quota(env.ALTIMATE_REVIEW_AI_QUOTA_TEST, COVERAGE_QUOTAS.test),
              yml: quota(env.ALTIMATE_REVIEW_AI_QUOTA_YML, COVERAGE_QUOTAS.yml),
            },
            ...(switchOn("otherFiles", switches, env)
              ? { otherQuota: quota(env.ALTIMATE_REVIEW_AI_QUOTA_OTHER, AI_OTHER_FILES_QUOTA) }
              : {}),
            ...(switchOn("pythonFiles", switches, env)
              ? { pythonQuota: quota(env.ALTIMATE_REVIEW_AI_QUOTA_PYTHON, AI_PYTHON_FILES_QUOTA) }
              : {}),
          }
        : undefined,
    focused:
      switchOn("focused", switches, env)
        ? {
            minFiles: int(env.ALTIMATE_REVIEW_AI_FOCUS_MIN_FILES, FOCUS_DEFAULTS.minFiles),
            batchFiles: int(env.ALTIMATE_REVIEW_AI_FOCUS_BATCH_FILES, FOCUS_DEFAULTS.batchFiles),
            maxBatches: int(env.ALTIMATE_REVIEW_AI_FOCUS_MAX_BATCHES, FOCUS_DEFAULTS.maxBatches),
          }
        : undefined,
  }
}

/** `ALTIMATE_REVIEW_AI_DRYRUN=1`: plan the lane's input and record it on the
 *  status without calling a model (state `skipped`), for free coverage counts. */
export function aiDryRunEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ALTIMATE_REVIEW_AI_DRYRUN === "1"
}

/** Opt-in test-gap instruction (`ALTIMATE_REVIEW_AI_TEST_GAP=1`), appended to the core system prompt. */
export function aiTestGapEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ALTIMATE_REVIEW_AI_TEST_GAP === "1"
}

export const TEST_GAP_INSTRUCTION = `

## Tests for changed macros, materializations and tests
For each changed macro, materialization or generic test whose runtime behaviour changes (control flow, the SQL statements it issues, defaults, or the relations it creates, renames or drops), check whether this PR also adds or changes a test that runs the new behaviour: a dbt unit test, a singular or generic test, an integration_tests model, or a test file in the PR's file list. When none does, report ONE test_coverage comment on the changed definition that names the behaviour left untested and the case a test should cover. Do not report this for comments, renames, formatting, or a change that only moves code.`

/** Most PR paths listed for the test-gap instruction. */
const TEST_GAP_FILES_MAX = 40

/** Files a batch message already names: the batch, plus the other reviewed files a focused message lists. */
export function listedFiles(plan: Pick<AiInputPlan, "files" | "focused">, batch: AiReviewFile[]): AiReviewFile[] {
  if (!plan.focused) return batch
  return [...batch, ...plan.files.filter((f) => !batch.includes(f)).slice(0, FOCUS_OTHER_FILES)]
}

/** The PR's other changed paths, appended to a batch message for the test-gap instruction. */
export function testGapFileList(message: string, batch: AiReviewFile[], prFiles: string[] = []): string {
  const inBatch = new Set(batch.map((f) => f.path))
  const others = prFiles.filter((p) => !inBatch.has(p))
  if (!others.length) return message
  const shown = others.slice(0, TEST_GAP_FILES_MAX)
  return [
    message,
    "",
    "## OTHER FILES THIS PR CHANGES (paths only, not shown; use them to judge test coverage)",
    ...shown.map((p) => `- ${p}`),
    ...(others.length > shown.length ? [`- … and ${others.length - shown.length} more`] : []),
  ].join("\n")
}

export interface AiReviewFile {
  path: string
  status: string
  /** Model name for a model; the file's base name for any other dbt file. */
  model: string
  /** dbt role of the file (`model_sql`, `macro`, `schema_yml`, `test`, …); omitted means a model. */
  kind?: string
  /** Unified diff (added/removed lines) for this file. */
  diff?: string
  /** Current content: dbt-compiled (preferred) or raw SQL for a model, the file itself otherwise. */
  sql?: string
  /** Rendered dbt manifest context card (`ALTIMATE_REVIEW_AI_CONTEXT_CARD=1`). */
  card?: string
}

/** Order under the file cap: models first, then the files whose defects reach the most models. */
const KIND_ORDER = ["model_sql", "python_model", "macro", "test", "snapshot", "schema_yml", "source_yml", "seed", "project_config"]
const KIND_LABEL: Record<string, string> = {
  macro: "macro (Jinja; changes every model that calls it)",
  test: "singular data test",
  snapshot: "snapshot",
  schema_yml: "schema yml (tests, contracts, descriptions)",
  source_yml: "sources yml",
  seed: "seed CSV",
  project_config: "project config",
  python_model: "Python model",
  // Sent only with the `otherFiles` switch.
  analysis: "dbt analysis (compiled, not materialized)",
  other: "other project file",
  // Sent only with the `pythonFiles` switch.
  [AI_PYTHON_KIND]: "Python file",
}
const FENCE: Record<string, string> = {
  schema_yml: "yaml",
  source_yml: "yaml",
  project_config: "yaml",
  seed: "csv",
  python_model: "python",
  [AI_PYTHON_KIND]: "python",
}

/** Code fence for a file's current content; `other`/`analysis` files by extension. */
function fenceOf(f: AiReviewFile): string {
  const known = FENCE[f.kind ?? ""]
  if (known) return known
  if (!AI_OTHER_KINDS.has(f.kind ?? "")) return "sql"
  const p = f.path.toLowerCase()
  return p.endsWith(".py") ? "python" : p.endsWith(".yml") || p.endsWith(".yaml") ? "yaml" : "sql"
}

function kindRank(kind: string | undefined): number {
  const i = KIND_ORDER.indexOf(kind ?? "model_sql")
  return i < 0 ? KIND_ORDER.length : i
}

function sendable(f: AiReviewFile): boolean {
  return f.status !== "deleted" && !!(f.diff || f.sql)
}

/** Files the lane sends, in priority order, capped at `maxFiles`. */
export function selectAiFiles(files: AiReviewFile[], maxFiles = MAX_FILES): AiReviewFile[] {
  return files
    .filter(sendable)
    .map((f, i) => ({ f, i }))
    .sort((a, b) => kindRank(a.f.kind) - kindRank(b.f.kind) || a.i - b.i)
    .map(({ f }) => f)
    .slice(0, maxFiles)
}

/** Quota buckets for `ALTIMATE_REVIEW_AI_COVERAGE`. */
export type AiFileBucket = keyof typeof COVERAGE_QUOTAS
const BUCKET_OF: Record<string, AiFileBucket> = {
  model_sql: "model",
  python_model: "model",
  snapshot: "model",
  macro: "macro",
  test: "test",
  schema_yml: "yml",
  source_yml: "yml",
  project_config: "yml",
  seed: "yml",
}
/** Buckets in the order their kinds first appear in KIND_ORDER (model, macro, test, yml). */
const BUCKET_ORDER = [...new Set(KIND_ORDER.map((k) => BUCKET_OF[k]))]

/** Added and removed lines of a unified diff (file headers before the first hunk excluded). */
export function changedLineCount(diff: string | undefined): number {
  if (!diff) return 0
  const lines = diff.split("\n")
  const first = lines.findIndex((l) => l.startsWith("@@"))
  return lines.slice(Math.max(first, 0)).filter((l) => l.startsWith("+") || l.startsWith("-")).length
}

/**
 * Files the lane sends under per-kind quotas, so models cannot crowd out the
 * macros, tests and yml whose defects no model diff shows. Each bucket keeps its
 * most-changed files (ties by input order); quota a bucket leaves unused goes to
 * the other buckets in KIND_ORDER order, up to the sum of the quotas. `unsent`
 * lists the sendable files left out, in input order.
 */
export function selectAiFilesByQuota(
  files: AiReviewFile[],
  quotas: Record<AiFileBucket, number> = COVERAGE_QUOTAS,
  extra: { otherQuota?: number; pythonQuota?: number } = {},
): { sent: AiReviewFile[]; unsent: AiReviewFile[] } {
  const eligible = files.filter(sendable)
  // With an `otherQuota`, other/analysis files are selected apart and appended after the rest.
  const isOther = (f: AiReviewFile) => extra.otherQuota !== undefined && AI_OTHER_KINDS.has(f.kind ?? "")
  // With a `pythonQuota`, the added Python files likewise, after the other files.
  const isPython = (f: AiReviewFile) => extra.pythonQuota !== undefined && f.kind === AI_PYTHON_KIND
  const byBucket = new Map<AiFileBucket, AiReviewFile[]>(BUCKET_ORDER.map((b) => [b, []]))
  eligible
    .filter((f) => !isOther(f) && !isPython(f))
    .map((f, i) => ({ f, i, n: changedLineCount(f.diff) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .forEach(({ f }) => byBucket.get(BUCKET_OF[f.kind ?? "model_sql"] ?? "model")!.push(f))
  const take = new Map(BUCKET_ORDER.map((b) => [b, Math.min(quotas[b], byBucket.get(b)!.length)]))
  let spare = BUCKET_ORDER.reduce((n, b) => n + quotas[b], 0) - [...take.values()].reduce((n, t) => n + t, 0)
  // Unused quota flows to other kinds, but never into a bucket disabled with quota 0.
  for (const b of BUCKET_ORDER) {
    if (quotas[b] <= 0) continue
    const extra = Math.min(spare, byBucket.get(b)!.length - take.get(b)!)
    take.set(b, take.get(b)! + extra)
    spare -= extra
  }
  const sent = BUCKET_ORDER.flatMap((b) => byBucket.get(b)!.slice(0, take.get(b)!))
  sent.push(...mostChanged(eligible.filter(isOther), extra.otherQuota ?? 0))
  sent.push(...mostChanged(eligible.filter(isPython), extra.pythonQuota ?? 0))
  const chosen = new Set(sent)
  return { sent, unsent: eligible.filter((f) => !chosen.has(f)) }
}

/** Up to `n` of `files`, most changed first (ties by input order). */
function mostChanged(files: AiReviewFile[], n: number): AiReviewFile[] {
  return files
    .map((f, i) => ({ f, i, n: changedLineCount(f.diff) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, n)
    .map(({ f }) => f)
}

interface DiffHunk {
  text: string
  /** Head-side line range from the `@@` header; absent for a diff without headers. */
  start?: number
  end?: number
}

/** A unified diff split into the text before its first hunk and its hunks. */
function splitHunks(diff: string): { preamble: string; hunks: DiffHunk[] } {
  const lines = diff.replace(/\n$/, "").split("\n")
  const first = lines.findIndex((l) => l.startsWith("@@"))
  if (first < 0) return { preamble: "", hunks: lines.length && diff ? [{ text: lines.join("\n") }] : [] }
  const hunks: DiffHunk[] = []
  let cur: string[] = []
  const flush = () => {
    if (!cur.length) return
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(cur[0])
    const start = m ? Number(m[1]) : undefined
    const count = m ? (m[2] === undefined ? 1 : Number(m[2])) : 0
    hunks.push({ text: cur.join("\n"), start, end: start === undefined ? undefined : start + Math.max(count, 1) - 1 })
    cur = []
  }
  for (const l of lines.slice(first)) {
    if (l.startsWith("@@")) flush()
    cur.push(l)
  }
  flush()
  return { preamble: lines.slice(0, first).join("\n"), hunks }
}

function lineRange(a: number, b: number): string {
  return a === b ? `line ${a}` : `lines ${a}–${b}`
}

/** What a file section carries of the file's diff and content. */
interface SectionStats {
  truncated: boolean
  hunksSent: number
  hunksTotal: number
}

/**
 * Whole hunks, in order, up to `maxChars`; a hunk is never cut unless it is the
 * first and alone exceeds the budget (its head is kept, marked). Omitted hunks
 * are listed by their head-side line ranges.
 */
export function excerptDiff(diff: string, maxChars: number): { text: string } & SectionStats {
  const { preamble, hunks } = splitHunks(diff)
  const out = preamble ? [preamble] : []
  let used = preamble.length
  let sent = 0
  let cut = false
  for (const h of hunks) {
    if (used + h.text.length + 1 <= maxChars) {
      out.push(h.text)
      used += h.text.length + 1
      sent++
      continue
    }
    if (sent === 0) {
      const head = h.text.slice(0, Math.max(0, maxChars - used))
      const nl = head.lastIndexOf("\n")
      out.push((nl > 0 ? head.slice(0, nl) : head) + "\n… (hunk truncated)")
      sent = 1
      cut = true
    }
    break
  }
  const omitted = hunks.slice(sent)
  if (omitted.length) {
    const ranges = omitted.map((h) => (h.start === undefined ? "?" : lineRange(h.start, h.end!).replace(/^lines? /, "")))
    out.push(`… (${omitted.length} more hunk${omitted.length === 1 ? "" : "s"} omitted, at lines ${ranges.join(", ")})`)
  }
  return { text: out.join("\n"), truncated: cut || omitted.length > 0, hunksSent: sent, hunksTotal: hunks.length }
}

const COMPILED_UNLOCATED_MARKER = "\n… (compiled file: changed lines not located, head shown; windows would be approximate)"
const JINJA = /\{\{|\{%/

/**
 * Where the diff's added lines sit in `lines` when the content is not the raw
 * file (e.g. dbt-compiled SQL, whose line numbers drift once Jinja expands).
 * Returns undefined when the raw line numbers already match (or nothing can be
 * checked), the found line numbers when at least half of the eligible added
 * lines (8+ non-space chars, no Jinja) are found by text, and "unlocated" otherwise.
 * With no eligible added line (Jinja-only or very short changes), the context
 * lines decide: raw line numbers are trusted only when those match.
 */
function locateAddedLines(lines: string[], rows: Array<{ line: number; text: string; kind: string }>): number[] | "unlocated" | undefined {
  const isEligible = (r: { text: string }) => !JINJA.test(r.text) && r.text.replace(/\s/g, "").length >= 8
  const matchesRaw = (r: { line: number; text: string }) => lines[r.line - 1]?.trim() === r.text.trim()
  const eligible = rows.filter((r) => r.kind === "+" && isEligible(r))
  if (!eligible.length) {
    const context = rows.filter((r) => r.kind !== "+" && isEligible(r))
    return context.length && !context.every(matchesRaw) ? "unlocated" : undefined
  }
  if (eligible.every(matchesRaw)) return undefined
  const found: number[] = []
  const used = new Set<number>()
  let from = 0
  for (const r of eligible) {
    const want = r.text.trim()
    let at = -1
    for (let i = from; i < lines.length; i++)
      if (!used.has(i) && lines[i].trim() === want) {
        at = i
        break
      }
    if (at < 0) continue
    used.add(at)
    found.push(at + 1)
    from = at + 1
  }
  return found.length * 2 >= eligible.length ? found : "unlocated"
}

/**
 * The parts of a file around its changed lines (±20 head-side lines each,
 * merged), up to `maxChars`, then as much of the file head as still fits.
 * Gaps are marked with their real line numbers. Without changed lines the file
 * head is kept, as before. When the content is not the raw file (compiled SQL),
 * windows are anchored on the added lines' text instead of raw line numbers.
 */
export function excerptFile(content: string, diff: string | undefined, maxChars: number): { text: string; truncated: boolean } {
  if (content.length <= maxChars) return { text: content, truncated: false }
  const lines = content.split("\n")
  const n = lines.length
  const rows = [...walkDiffLines(diff)]
  const located = locateAddedLines(lines, rows)
  if (located === "unlocated") return { text: truncate(content, maxChars) + COMPILED_UNLOCATED_MARKER, truncated: true }
  const added = located ?? rows.filter((r) => r.kind === "+").map((r) => r.line)
  const anchors = (added.length ? added : rows.map((r) => r.line)).filter((l) => l >= 1 && l <= n).sort((a, b) => a - b)
  if (!anchors.length) return { text: truncate(content, maxChars), truncated: true }
  const windows: Array<[number, number]> = []
  for (const a of anchors) {
    const s = Math.max(1, a - EXCERPT_CONTEXT_LINES)
    const e = Math.min(n, a + EXCERPT_CONTEXT_LINES)
    const last = windows[windows.length - 1]
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e)
    else windows.push([s, e])
  }
  const MARKER = 40 // room reserved per omission marker
  const size = (s: number, e: number) => lines.slice(s - 1, e).reduce((t, l) => t + l.length + 1, 0)
  const kept: Array<[number, number]> = []
  let used = 0
  for (const [s, e] of windows) {
    const sz = size(s, e) + MARKER
    if (used + sz <= maxChars) {
      kept.push([s, e])
      used += sz
      continue
    }
    if (!kept.length) {
      // The first window alone is over budget: keep as many of its lines as fit.
      let end = s - 1
      while (end < e && used + size(s, end + 1) + MARKER <= maxChars) end++
      if (end >= s) {
        kept.push([s, end])
        used += size(s, end) + MARKER
      }
    }
    break
  }
  if (!kept.length) return { text: truncate(content, maxChars), truncated: true }
  // Fill what is left with the file head, before the first window.
  let head = 0
  while (head + 1 < kept[0][0] && used + size(1, head + 1) + MARKER <= maxChars) head++
  if (head) {
    if (head + 1 >= kept[0][0]) kept[0][0] = 1
    else kept.unshift([1, head])
  }
  const out: string[] = []
  let next = 1
  for (const [s, e] of kept) {
    if (s > next) out.push(`… (${lineRange(next, s - 1)} omitted)`)
    out.push(lines.slice(s - 1, e).join("\n"))
    next = e + 1
  }
  if (next <= n) out.push(`… (${lineRange(next, n)} omitted)`)
  return { text: out.join("\n"), truncated: true }
}

/** Hunks of `diff` whose text lies wholly within its first `maxChars` characters. */
function headHunkStats(diff: string | undefined, maxChars: number): Omit<SectionStats, "truncated"> {
  if (!diff) return { hunksSent: 0, hunksTotal: 0 }
  const { preamble, hunks } = splitHunks(diff)
  let end = preamble ? preamble.length + 1 : 0
  let sent = 0
  for (const h of hunks) {
    end += h.text.length
    if (end > maxChars) break
    sent++
    end += 1
  }
  return { hunksSent: sent, hunksTotal: hunks.length }
}

/** How coverage mode renders a file: the diff section's own character budget. */
export interface AiCoverageRender {
  diffChars: number
}
/** `true` means coverage with the default diff budget; `false` keeps today's rendering. */
type CoverageArg = boolean | AiCoverageRender | undefined

function coverageRender(c: CoverageArg): AiCoverageRender | undefined {
  if (!c) return undefined
  return c === true ? { diffChars: COVERAGE_DIFF_CHARS } : c
}

/** One changed file as it appears in the prompt, with what it carries. */
function renderFile(f: AiReviewFile, maxChars: number, coverageArg: CoverageArg, withCard: boolean): { text: string } & SectionStats {
  const coverage = coverageRender(coverageArg)
  const label = f.kind && KIND_LABEL[f.kind]
  const parts = [`\n### ${f.path} (${f.status}${label ? `, ${label}` : ""})`]
  if (withCard && f.card) parts.push(`dbt context (from manifest):\n${f.card}`)
  let stats: SectionStats = { ...headHunkStats(f.diff, maxChars), truncated: (f.diff?.length ?? 0) > maxChars }
  // Under coverage a long diff sent whole makes the file windows redundant: keep a short head instead.
  let fileChars = maxChars
  if (f.diff) {
    if (coverage && f.diff.length > maxChars) {
      const { text: excerpt, ...ex } = excerptDiff(f.diff, coverage.diffChars)
      stats = ex
      if (ex.hunksSent === ex.hunksTotal && !ex.truncated) fileChars = Math.min(COVERAGE_FULL_DIFF_FILE_CHARS, maxChars)
      parts.push("Diff:\n```diff\n" + excerpt + "\n```")
    } else parts.push("Diff:\n```diff\n" + truncate(f.diff, maxChars) + "\n```")
  }
  if (f.sql) {
    const isModel = !f.kind || f.kind === "model_sql"
    const body = !coverage
      ? truncate(f.sql, maxChars)
      : fileChars < maxChars
        ? truncate(f.sql, fileChars)
        : excerptFile(f.sql, f.diff, maxChars).text
    if (f.sql.length > fileChars) stats = { ...stats, truncated: true }
    parts.push(`${isModel ? "Current SQL" : "Current file"}:\n\`\`\`${fenceOf(f)}\n` + body + "\n```")
  }
  return { text: parts.join("\n"), ...stats }
}

function fileSection(f: AiReviewFile, maxChars: number, coverage: CoverageArg = false): string {
  return renderFile(f, maxChars, coverage, true).text
}

/** Split files, in order, into groups whose sections fit `batchChars` (an oversized file goes alone). */
export function batchAiFiles(files: AiReviewFile[], budget: AiInputBudget): AiReviewFile[][] {
  const batches: AiReviewFile[][] = []
  let cur: AiReviewFile[] = []
  let size = 0
  for (const f of files) {
    const n = fileSection(f, budget.maxFileChars, budget.coverage).length
    if (cur.length && size + n > budget.batchChars) {
      batches.push(cur)
      cur = []
      size = 0
    }
    cur.push(f)
    size += n
  }
  if (cur.length) batches.push(cur)
  return batches
}

const MACRO_DEF = /\{%-?\s*macro\s+(\w+)\s*\(/g
const DISPATCH_CALL = /adapter\.dispatch\(\s*['"](\w+)['"]/g
const REF_CALL = /\bref\(([^)]*)\)/g
const STRING_ARG = /['"]([^'"]+)['"]/g
const YML_NAME = /^[+ ]?\s*-\s*name:\s*['"]?([\w.-]+)['"]?\s*$/gm

function dirOf(p: string): string {
  const i = p.lastIndexOf("/")
  return i < 0 ? "" : p.slice(0, i)
}

/** Macro names a macro file defines: from its content, or from the diff's added lines without it. */
function definedMacros(f: AiReviewFile): string[] {
  if (f.kind !== "macro") return []
  const text =
    f.sql ??
    (f.diff ?? "")
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1))
      .join("\n")
  return [...text.matchAll(MACRO_DEF)].map((m) => m[1])
}

/**
 * Related changed files, for focused batches: connected components over macro
 * dispatch families (`default__x`, `snowflake__x`, `adapter.dispatch('x'`), `ref()`
 * edges, yml `- name:` declarations, then a same-directory fallback for files with
 * no edge. Components follow the input order of their first member; members keep
 * input order.
 */
export function groupAiFiles(files: AiReviewFile[]): AiReviewFile[][] {
  const parent = files.map((_, i) => i)
  const linked = files.map(() => false)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const join = (a: number, b: number) => {
    if (a === b) return
    linked[a] = linked[b] = true
    const [ra, rb] = [find(a), find(b)]
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  const byModel = new Map<string, number[]>()
  files.forEach((f, i) => byModel.set(f.model, [...(byModel.get(f.model) ?? []), i]))
  const family = new Map<string, number>()
  const joinFamily = (base: string, i: number) => {
    const first = family.get(base)
    if (first === undefined) family.set(base, i)
    else join(first, i)
  }
  files.forEach((f, i) => {
    const text = `${f.sql ?? ""}\n${f.diff ?? ""}`
    for (const name of definedMacros(f)) joinFamily(name.replace(/^[A-Za-z0-9]+__(?=\w)/, ""), i)
    for (const m of text.matchAll(DISPATCH_CALL)) joinFamily(m[1], i)
    for (const m of text.matchAll(REF_CALL)) {
      const name = [...m[1].matchAll(STRING_ARG)].at(-1)?.[1]
      for (const j of (name && byModel.get(name)) || []) join(i, j)
    }
    if (f.kind === "schema_yml" || f.kind === "source_yml")
      for (const m of text.matchAll(YML_NAME)) for (const j of byModel.get(m[1]) ?? []) join(i, j)
  })
  const byDir = new Map<string, number>()
  files.forEach((f, i) => {
    if (linked[i]) return
    const first = byDir.get(dirOf(f.path))
    if (first === undefined) byDir.set(dirOf(f.path), i)
    else join(first, i)
  })
  const groups = new Map<number, AiReviewFile[]>()
  files.forEach((f, i) => {
    const root = find(i)
    groups.set(root, [...(groups.get(root) ?? []), f])
  })
  // Roots are each component's lowest index, so sorting by root orders components by first member.
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g)
}

/**
 * Pack related-file groups into calls: groups over `batchFiles` files or
 * `batchChars` characters split into consecutive chunks, chunks fill calls of up
 * to `batchFiles` files and `batchChars` characters without being split; over
 * `maxBatches` calls, the chunks are balanced by prompt size into at most
 * `maxBatches` calls instead. `batchChars` keeps each call inside the model's
 * context window, so it wins over `maxBatches`: a balanced call over it is split
 * again, and the plan then has more than `maxBatches` calls.
 */
export function packFocusedBatches(groups: AiReviewFile[][], budget: AiInputBudget): AiReviewFile[][] {
  const { batchFiles, maxBatches } = budget.focused ?? FOCUS_DEFAULTS
  const chars = new Map<AiReviewFile, number>()
  const size = (c: AiReviewFile[]) =>
    c.reduce((n, f) => {
      if (!chars.has(f)) chars.set(f, fileSection(f, budget.maxFileChars, budget.coverage).length)
      return n + chars.get(f)!
    }, 0)
  const chunks = groups.flatMap((g) => {
    const out: AiReviewFile[][] = []
    for (let i = 0; i < g.length; i += batchFiles) out.push(...batchAiFiles(g.slice(i, i + batchFiles), budget))
    return out
  })
  const batches: AiReviewFile[][] = []
  for (const c of chunks) {
    const cur = batches.at(-1)
    if (cur && cur.length + c.length <= batchFiles && size(cur) + size(c) <= budget.batchChars) cur.push(...c)
    else batches.push([...c])
  }
  if (batches.length <= maxBatches) return batches
  const bins = Array.from({ length: maxBatches }, () => ({ chars: 0, chunks: [] as number[] }))
  chunks
    .map((c, i) => ({ i, chars: size(c) }))
    .sort((a, b) => b.chars - a.chars || a.i - b.i)
    .forEach(({ i, chars }) => {
      const bin = bins.reduce((best, b) => (b.chars < best.chars ? b : best))
      bin.chars += chars
      bin.chunks.push(i)
    })
  return bins
    .filter((b) => b.chunks.length)
    .flatMap((b) => (b.chars <= budget.batchChars ? [b.chunks] : splitByChars(b.chunks.sort((x, y) => x - y), (i) => size(chunks[i]), budget.batchChars)))
    .map((ids) => ids.sort((x, y) => x - y).flatMap((i) => chunks[i]))
}

/** Consecutive runs of `ids` whose summed size fits `max` (an oversized id goes alone). */
function splitByChars(ids: number[], sizeOf: (i: number) => number, max: number): number[][] {
  const out: number[][] = []
  let cur: number[] = []
  let total = 0
  for (const i of ids) {
    const n = sizeOf(i)
    if (cur.length && total + n > max) {
      out.push(cur)
      cur = []
      total = 0
    }
    cur.push(i)
    total += n
  }
  if (cur.length) out.push(cur)
  return out
}

/** Findings from several calls without repeats: same file, line and title (case and punctuation aside). */
export function dedupAiFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>()
  return findings.filter((f) => {
    const key = [f.file ?? "", f.startLine ?? 0, f.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()].join("\u0000")
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** An unchanged file the changed ones depend on (dbt DAG parent), sent as read-only context. */
export interface AiContextFile {
  path: string
  /** dbt resource type: `model`, `seed`, `snapshot`, `source`, `macro`. */
  kind: string
  name: string
  /** Changed files that depend on it. */
  forPaths: string[]
  content: string
}

export interface AiReviewInput {
  files: AiReviewFile[]
  /** Unchanged parents of the changed files, for cross-file checks (columns, seeds, macro signatures). */
  context?: AiContextFile[]
  /** Deterministic engine findings — grounding the AI must NOT duplicate. */
  grounding: Finding[]
  prTitle?: string
  prBody?: string
  /** Explicit `provider/model`; omit to use the configured default model. */
  model?: string
  /** What the verifier may read; it runs only when this is set and `ALTIMATE_REVIEW_AI_VERIFY=1`. */
  evidence?: AiVerifyEvidence
  /** Every file the PR changes (repo-relative), including files outside the dbt project. */
  prFiles?: string[]
  /** The review's resolved AI switches; without them each switch reads only its env variable. */
  switches?: Partial<AiSwitches>
}

/** What happened in the advisory lane, reported on the envelope and in the comment. */
export type AiLaneState = "ok" | "skipped" | "timeout" | "error"
export interface AiLaneStatus {
  state: AiLaneState
  /** Why the lane was skipped or failed (never contains credentials). */
  reason?: string
  /** `provider/model` the lane ran with. */
  model?: string
  durationMs?: number
  /** Tokens spent across all calls that reported usage. */
  tokens?: AiTokens
  /** Estimated cost in USD from the model's price table (0 when unpriced). */
  cost?: number
  /** Model calls made (one per batch). */
  calls?: number
  /** The dbt-grounded verifier's outcome, when it ran (opt-in). */
  verifier?: VerifierStatus
  /** The generator's findings came from an earlier envelope (`ALTIMATE_REVIEW_AI_REPLAY`);
   *  tokens, cost and calls are that run's, so only `verifier` was spent now. */
  replayed?: boolean
  /** The replayed envelope did not list every generator finding. */
  replayIncomplete?: boolean
  /** What each file sent carried; recorded under coverage, context cards or dry run. */
  input?: AiInputRecord[]
  /** Sendable files left out by the coverage quotas (they still went through the deterministic lanes). */
  unsent?: string[]
}
/** One file as sent to the model. */
export interface AiInputRecord {
  path: string
  kind: string
  /** Characters of the file's prompt section. */
  chars: number
  /** Some of the diff or file content was left out. */
  truncated: boolean
  hunksSent: number
  hunksTotal: number
  /** A manifest context card went with the file. */
  card: boolean
  /** Index of the call that carried the file; set only under focused batching. */
  batch?: number
}
/** Token counts as `Session.getUsage` reports them: `input` excludes cached
 *  tokens, `inputTotal` includes them. */
export interface AiTokens {
  input: number
  inputTotal: number
  output: number
  reasoning: number
  cacheRead: number
}
export interface AiReviewResult {
  findings: Finding[]
  status: AiLaneStatus
}

/** Timeout scaled to the prompt: 60 s plus 1 s per 2,000 characters, capped at 5 minutes. */
export function aiTimeoutMs(promptChars: number): number {
  return Math.min(AI_TIMEOUT_MAX_MS, AI_TIMEOUT_BASE_MS + Math.ceil(promptChars / 2_000) * 1_000)
}

/** Error text safe to show in a PR comment: one line, bounded, with
 *  credentials masked (authorization headers, `Basic`/`Bearer` values,
 *  `key=value` secrets, `user:pass@` URL userinfo, provider-prefixed tokens).
 *  Redaction runs before whitespace is collapsed so a header match stops at
 *  its own line. */
export function safeReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return redactSecrets(raw)
    .replace(/\s+/g, " ")
    .replace(/(bearer\s+)[^\s]+/gi, "$1***")
    .replace(/\b(sk|pk|key|token)[-_][A-Za-z0-9_-]{8,}/gi, "***")
    .slice(0, 200)
}

/**
 * IP boundary: the reviewer's system prompt (its remit + "what NOT to flag"
 * guardrails + output contract) and the response parse/clamp logic live in the
 * compiled core (`altimate_core.review_ai_*`), not in this public file. This
 * module only does TRANSPORT — assemble the user message, run the LLM through
 * the harness, and hand the raw response back to core to parse and clamp.
 */

function truncate(s: string | undefined, n: number): string {
  if (!s) return ""
  return s.length > n ? s.slice(0, n) + "\n… (truncated)" : s
}

/** Context sections for the parents of the files in this call, within the context budget. */
function relatedContext(input: AiReviewInput): string[] {
  const paths = new Set(input.files.map((f) => f.path))
  const out: string[] = []
  let used = 0
  for (const c of input.context ?? []) {
    if (paths.has(c.path) || !c.forPaths.some((p) => paths.has(p))) continue
    const section = `\n### ${c.path} (${c.kind} \`${c.name}\`, used by ${c.forPaths.filter((p) => paths.has(p)).join(", ")})\n\`\`\`${c.kind === "source" || c.path.endsWith(".yml") ? "yaml" : c.path.endsWith(".csv") ? "csv" : "sql"}\n${truncate(c.content, CONTEXT_FILE_CHARS)}\n\`\`\``
    if (used + section.length > CONTEXT_TOTAL_CHARS) break
    out.push(section)
    used += section.length
  }
  return out
}

/** Assemble the user message (mechanical formatting — not IP). */
export function buildUserMessage(input: AiReviewInput, maxFileChars = MAX_DIFF_CHARS, coverage: CoverageArg = false): string {
  return buildBatchMessage(input, maxFileChars, coverage).message
}

/** The user message for one call and a record of each file it carries. A context
 *  card is added only while the call's cards total at most 6,000 characters; a card
 *  that would pass that is skipped and later, smaller ones may still fit. */
function buildBatchMessage(
  input: AiReviewInput,
  maxFileChars: number,
  coverage: CoverageArg,
  focus?: { batch: number; others: AiReviewFile[] },
): { message: string; records: AiInputRecord[] } {
  const records: AiInputRecord[] = []
  const parts: string[] = []
  if (input.prTitle) parts.push(`PR title: ${truncate(input.prTitle, 200)}`)
  if (input.prBody) parts.push(`PR description:\n${truncate(input.prBody, 1500)}`)

  // A focused call carries only the grounding for its own files (and file-less findings).
  const inCall = new Set(input.files.map((f) => f.path))
  const grounding = focus ? input.grounding.filter((g) => !g.file || inCall.has(g.file)) : input.grounding
  if (grounding.length) {
    parts.push(
      "\n## GROUNDING — deterministic engine findings (DO NOT repeat these):",
      ...grounding.slice(0, 40).map((f) => `- [${f.severity}] ${f.category} · ${f.file}: ${f.title}`),
    )
  } else {
    parts.push("\n## GROUNDING — the engine produced no findings.")
  }

  parts.push("\n## CHANGED FILES (review for what the engine missed):")
  let cardChars = 0
  for (const f of input.files) {
    const withCard = !!f.card && cardChars + f.card.length <= CARD_BATCH_MAX_CHARS
    if (withCard) cardChars += f.card!.length
    const r = renderFile(f, maxFileChars, coverage, withCard)
    parts.push(r.text)
    records.push({
      path: f.path,
      kind: f.kind ?? "model_sql",
      chars: r.text.length,
      truncated: r.truncated,
      hunksSent: r.hunksSent,
      hunksTotal: r.hunksTotal,
      card: withCard,
      ...(focus ? { batch: focus.batch } : {}),
    })
  }
  if (focus?.others.length) {
    parts.push(
      "\n## OTHER FILES CHANGED IN THIS PR (reviewed in separate calls; do not comment on them):",
      ...focus.others.slice(0, FOCUS_OTHER_FILES).map((f) => `- ${f.path} (${f.kind ?? "model_sql"})`),
    )
  }
  const context = relatedContext(input)
  if (context.length) {
    parts.push(
      "\n## RELATED FILES — unchanged dbt parents of the changed files (context only; comment on the changed files, not these):",
      ...context,
    )
  }
  parts.push("\nReturn ONLY the JSON array per the output contract.")
  return { message: parts.join("\n"), records }
}

/**
 * The finder's system prompt: the compiled core's, or the text of the file named by
 * `ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE`, which replaces it. An unreadable or empty file is
 * an error, never a silent fallback to the core prompt.
 */
export async function finderSystemPrompt(env: Record<string, string | undefined> = process.env): Promise<string | undefined> {
  const file = env.ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE
  if (file) {
    const text = await readFile(file, "utf8")
    if (!text.trim()) throw new Error(`ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE is empty: ${file}`)
    return text
  }
  const promptRes = await Dispatcher.call("altimate_core.review_ai_prompt", {})
  return ((promptRes.data ?? {}) as Record<string, unknown>).prompt as string | undefined
}

/** What the lane would send: files, the unsent rest, one message per call, and a record per file. */
export interface AiInputPlan {
  budget: AiInputBudget
  files: AiReviewFile[]
  /** Sendable files left out (by the quotas under coverage, by `maxFiles` otherwise). */
  unsent: AiReviewFile[]
  batches: AiReviewFile[][]
  messages: string[]
  input: AiInputRecord[]
  /** Focused batching applied (`ALTIMATE_REVIEW_AI_FOCUSED=1` and enough files). */
  focused: boolean
}

/**
 * Plan the lane's input without calling a model: selection, batching, the exact
 * user messages and what each file carries. Pure: the budget comes from the
 * `env` argument; `runAiReview` sends exactly these messages.
 */
export function planAiInput(input: AiReviewInput, env: Record<string, string | undefined> = process.env): AiInputPlan {
  const budget = aiInputBudget(env, input.switches)
  let files: AiReviewFile[]
  let unsent: AiReviewFile[]
  if (budget.coverage) ({ sent: files, unsent } = selectAiFilesByQuota(input.files, budget.coverage.quotas, budget.coverage))
  else {
    files = selectAiFiles(input.files, budget.maxFiles)
    const chosen = new Set(files)
    unsent = input.files.filter((f) => sendable(f) && !chosen.has(f))
  }
  const focused = !!budget.focused && files.length >= budget.focused.minFiles
  const batches = focused ? packFocusedBatches(groupAiFiles(files), budget) : files.length ? batchAiFiles(files, budget) : []
  const built = batches.map((b, i) => {
    const focus = focused ? { batch: i, others: files.filter((f) => !b.includes(f)) } : undefined
    return buildBatchMessage({ ...input, files: b }, budget.maxFileChars, budget.coverage, focus)
  })
  return { budget, files, unsent, batches, messages: built.map((b) => b.message), input: built.flatMap((b) => b.records), focused }
}

/**
 * Run the LLM reviewer lane. Returns advisory findings (severity ≤ warning,
 * clamped by core) and a status saying whether the lane ran, was skipped, timed
 * out or failed. Never throws — a review must not crash because the AI layer is
 * unavailable — but never fails silently either: the status reaches the
 * envelope and the PR comment.
 */
export async function runAiReview(input: AiReviewInput): Promise<AiReviewResult> {
  const replay = aiReplayPath()
  const startedAt = Date.now()
  const plan = planAiInput(input)
  const { files, budget } = plan
  const dryRun = aiDryRunEnabled()
  // Recorded only when an opt-in switch changed or inspects the input, so the default envelope is unchanged.
  const recorded: Pick<AiLaneStatus, "input" | "unsent"> = {
    ...(budget.coverage || dryRun || plan.focused || plan.input.some((r) => r.card) ? { input: plan.input } : {}),
    ...(budget.coverage && plan.unsent.length ? { unsent: plan.unsent.map((f) => f.path) } : {}),
  }
  const done = (findings: Finding[], status: Omit<AiLaneStatus, "durationMs">): AiReviewResult => ({
    findings,
    status: { ...status, ...recorded, durationMs: Date.now() - startedAt },
  })
  if (!files.length && (dryRun || !replay)) return done([], { state: "skipped", reason: "no changed dbt files to review" })
  // Dry run wins over replay: a replayed envelope would still reach the verifier, a model call.
  if (dryRun) return done([], { state: "skipped", reason: "dry run (ALTIMATE_REVIEW_AI_DRYRUN=1): no model call" })
  if (replay) return runAiReplay(input, replay)

  let modelLabel: string | undefined
  try {
    // Prompt comes from the compiled core, not this file (or ALTIMATE_REVIEW_AI_SYSTEM_PROMPT_FILE).
    const corePrompt = await finderSystemPrompt()
    if (!corePrompt) return done([], { state: "error", reason: "the core reviewer prompt is unavailable" })
    const testGap = aiTestGapEnabled()
    const system = testGap ? corePrompt + TEST_GAP_INSTRUCTION : corePrompt

    let model: Awaited<ReturnType<typeof Provider.getModel>>
    try {
      const chosen = input.model ? Provider.parseModel(input.model) : await Provider.defaultModel()
      model = await Provider.getModel(chosen.providerID, chosen.modelID)
    } catch (err) {
      // An explicitly requested model that cannot be resolved is an error, not
      // the same as `--no-ai`; only a missing default is a skip.
      return done([], {
        state: input.model ? "error" : "skipped",
        reason: `no usable model: ${safeReason(err)}`,
        model: input.model,
      })
    }
    modelLabel = `${model.providerID}/${model.id}`

    // One call per batch; a PR that fits the budget is a single call, as before.
    const batches = plan.batches
    const results: BatchResult[] = []
    for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) {
      const slice = batches.slice(i, i + BATCH_CONCURRENCY)
      results.push(...(await Promise.all(slice.map((b, j) => reviewBatch(testGap ? testGapFileList(plan.messages[i + j], listedFiles(plan, b), input.prFiles) : plan.messages[i + j], b, system, model)))))
    }
    let findings = results.flatMap((r) => r.findings)
    if (plan.focused) findings = dedupAiFindings(findings)
    const failed = results.filter((r) => r.state !== "ok")
    log.info("ai review complete", { findings: findings.length, batches: batches.length, failed: failed.length })
    // The lane is ok when any call answered; a partial failure is reported, not hidden.
    const spent = laneUsage(results)
    if (failed.length === results.length)
      return done([], { state: failed[0].state, reason: failed[0].reason, model: modelLabel, ...spent })
    const reason = failed.length ? `${failed.length} of ${results.length} calls failed: ${failed[0].reason}` : undefined
    // Opt-in: try to refute each finding with dbt evidence. Never throws.
    let verifier: VerifierStatus | undefined
    if (input.evidence && switchOn("verify", input.switches)) {
      const v = await runAiVerify({ findings, grounding: input.grounding, evidence: input.evidence, model })
      findings = v.findings
      verifier = v.status
    }
    return done(findings, { state: "ok", model: modelLabel, ...(reason ? { reason } : {}), ...spent, ...(verifier ? { verifier } : {}) })
  } catch (err) {
    log.error("ai review failed", { error: err })
    return done([], { state: "error", reason: safeReason(err), model: modelLabel })
  }
}

interface BatchResult {
  findings: Finding[]
  state: AiLaneState
  reason?: string
  usage?: BatchUsage
}

export interface BatchUsage {
  tokens: AiTokens
  cost: number
}

export function addUsage(a: BatchUsage, b: BatchUsage): BatchUsage {
  return {
    tokens: {
      input: a.tokens.input + b.tokens.input,
      inputTotal: a.tokens.inputTotal + b.tokens.inputTotal,
      output: a.tokens.output + b.tokens.output,
      reasoning: a.tokens.reasoning + b.tokens.reasoning,
      cacheRead: a.tokens.cacheRead + b.tokens.cacheRead,
    },
    cost: a.cost + b.cost,
  }
}

/** Lane-status accounting fields for a set of batch results: calls made, and
 *  tokens and cost summed over the calls that reported usage. */
export function laneUsage(results: Array<{ usage?: BatchUsage }>): Pick<AiLaneStatus, "tokens" | "cost" | "calls"> {
  const reported = results.flatMap((r) => (r.usage ? [r.usage] : []))
  if (!reported.length) return { calls: results.length }
  const total = reported.reduce(addUsage)
  return { tokens: total.tokens, cost: total.cost, calls: results.length }
}

/**
 * Tokens and cost of one drained stream, with the session's accounting rules.
 * Returns undefined when the provider reported nothing usable: accounting
 * never fails the lane.
 */
export async function streamUsage(
  stream: { totalUsage: PromiseLike<unknown>; providerMetadata: PromiseLike<unknown> },
  model: Pick<Provider.Model, "cost" | "api">,
): Promise<BatchUsage | undefined> {
  try {
    const usage = await stream.totalUsage
    const metadata = await stream.providerMetadata
    if (!usage) return undefined
    // Loaded lazily, as in learn/usage.ts, to keep the session module out of
    // this module's import graph.
    const { Session } = await import("@/session")
    const u = Session.getUsage({ model: model as Provider.Model, usage: usage as any, metadata: (metadata ?? undefined) as any })
    return {
      tokens: {
        input: u.tokens.input,
        inputTotal: u.tokens.inputTotal,
        output: u.tokens.output,
        reasoning: u.tokens.reasoning,
        cacheRead: u.tokens.cache.read,
      },
      cost: u.cost,
    }
  } catch (err) {
    log.warn("ai review usage unavailable", { error: err })
    return undefined
  }
}

/** One model call over a group of files: send, wait (bounded), parse and clamp in core. */
async function reviewBatch(
  message: string,
  files: AiReviewFile[],
  system: string,
  model: Awaited<ReturnType<typeof Provider.getModel>>,
): Promise<BatchResult> {
  const controller = new AbortController()
  const timeoutMs = aiTimeoutMs(message.length)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const timedOut = (): BatchResult => ({ findings: [], state: "timeout", reason: `no answer within ${Math.round(timeoutMs / 1000)} s` })
  let usage: BatchUsage | undefined
  try {
    const agent: Agent.Info = {
      name: "dbt-ai-reviewer",
      mode: "primary",
      hidden: true,
      options: {},
      permission: [],
      prompt: system,
      temperature: 0,
    }
    const user: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: SessionID.descending(),
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model: { providerID: model.providerID, modelID: model.id },
    }
    const stream = await LLM.stream({
      agent,
      user,
      system: [system],
      small: false,
      tools: {},
      model,
      abort: controller.signal,
      sessionID: user.sessionID,
      retries: 1,
      messages: [{ role: "user", content: message }],
    })
    const text = await readStreamText(stream)
    if (controller.signal.aborted) return timedOut()
    usage = await streamUsage(stream, model)
    if (!text) return { findings: [], state: "error", reason: "the model returned no text", usage }

    // Parse + clamp in core (the prompt-injection-resistant, advisory-only
    // contract). Returns already-validated, severity-clamped, file-checked items.
    const parseRes = await Dispatcher.call("altimate_core.review_ai_parse", {
      text,
      valid_files: files.map((f) => f.path),
    })
    // The core parser reports failure in-band (`success: false`) rather than
    // throwing; that is an error, never an "ok" run with no findings.
    const parsedRaw = ((parseRes.data ?? {}) as Record<string, unknown>).findings
    if (parseRes.success === false || !Array.isArray(parsedRaw))
      return {
        findings: [],
        state: "error",
        reason: `could not parse the model's answer: ${safeReason(parseRes.error ?? "no findings list")}`,
      }
    const parsed = parsedRaw as any[]
    const byFile = new Map(files.map((f) => [f.path, f]))

    const out: Finding[] = []
    for (const item of parsed) {
      // Per-item guard: a single malformed finding (e.g. an out-of-enum severity that
      // makes makeFinding's schema throw) must NOT discard the whole batch.
      try {
        const file = byFile.get(String(item?.file ?? ""))
        if (!file || !item?.title || !item?.body) continue
        // Defense-in-depth clamp in the transport layer too: the advisory lane is
        // never allowed to emit `critical` (or any non-enum value), independent of
        // what core returns. Only `warning` survives as `warning`; everything else
        // degrades to `suggestion`.
        const severity: Severity = item.severity === "warning" ? "warning" : "suggestion"
        out.push(
          makeFinding({
            severity,
            category: item.category as ReviewCategory,
            title: `${file.model}: ${item.title}`,
            body: String(item.body),
            file: file.path,
            model: file.model,
            startLine: typeof item.line === "number" ? item.line : undefined,
            endLine: typeof item.line === "number" ? item.line : undefined,
            confidence: item.confidence === "high" ? "high" : item.confidence === "low" ? "low" : "medium",
            evidence: { tool: "ai-review", result: { confidence: item.confidence } },
            ruleKey: `ai:${item.category}:${String(item.title).slice(0, 60)}`,
            rule: ruleId("ai-review", String(item.category)),
          }),
        )
      } catch (err) {
        log.warn("skipping malformed ai finding", { error: err })
      }
    }
    return { findings: out, state: "ok", usage }
  } catch (err) {
    if (controller.signal.aborted) return timedOut()
    return { findings: [], state: "error", reason: safeReason(err), usage }
  } finally {
    clearTimeout(timeout)
  }
}
