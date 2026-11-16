// altimate_change - new file: dbt-grounded verifier for the advisory AI lane
//
// One extra, bounded model call per PR that tries to REFUTE each AI finding
// with dbt evidence (compiled SQL, the manifest DAG, column lineage, project
// grep). The verifier sees only the candidate comments and their diff hunks,
// never the reviewer's prompt or context, and a deterministic triage table —
// not the model — decides what is kept. Opt-in (`ALTIMATE_REVIEW_AI_VERIFY=1`)
// and fail-open: any error, timeout or exhausted budget leaves the findings it
// did not review unchanged.
import type { Provider } from "@/provider/provider"
import type { Finding } from "./finding"
import type { AiReviewFile, AiTokens } from "./ai-review"
import { type ReviewRunner, scanDiffLines, walkDiffLines } from "./orchestrate"

/** What the verifier may read: the PR's files, the engine, and the dbt project. */
export interface AiVerifyEvidence {
  dialect?: string
  /** The files the AI lane reviewed (their diffs give each finding its hunk). */
  files: AiReviewFile[]
  /** The dbt project directory relative to the repository root ("" = repo root); manifest paths are relative to it. */
  projectRoot?: string
  /** Lines `start..end` (1-based, at most 200) of a repo-relative file, numbered; undefined when unreadable. */
  readFile(path: string, side: "old" | "new", start?: number, end?: number): Promise<string | undefined>
  /** dbt-compiled SQL of a model file (raw SQL when it holds no Jinja); undefined when not compiled. */
  compiledSql(path: string, side: "old" | "new"): Promise<string | undefined>
  runner: ReviewRunner
  /** Fixed-string search over the project's dbt directories at head (≤50 hits). */
  grepProject?(pattern: string, glob?: string): Promise<Array<{ path: string; line: number; text: string }>>
  prTitle?: string
  prBody?: string
  /** Head-side line numbers each changed file adds (see `addedLinesByFile`). */
  addedLines: Map<string, Set<number>>
}

export type Decision = "keep" | "discard" | "summary"

/** A finding the verifier discarded, reported on the envelope for audit. */
export interface DroppedFinding {
  id: string
  file: string
  title: string
  category: string
  severity: string
  decision: Decision
  /** The triage rule that decided it. */
  rule: string
  verdict?: string
  claimType?: string
  evidence?: string
}

export interface VerifierStatus {
  state: "ok" | "skipped" | "timeout" | "error" | "budget"
  /** Why the verifier was skipped or failed (never contains credentials). */
  reason?: string
  durationMs: number
  tokens?: AiTokens
  cost?: number
  /** Model calls made, across batches and tool rounds. */
  turns: number
  toolCalls: number
  /** Findings the model returned a verdict for. */
  reviewed: number
  kept: number
  discarded: number
  /** Kept, but moved to the summary (never posted inline). */
  summary: number
  /** Findings with no verdict (omitted, unparsable, timeout, budget, error). */
  unreviewed: number
  dropped?: DroppedFinding[]
}

/** Whether the verifier runs: opt-in until the decision run says otherwise. */
export function aiVerifyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ALTIMATE_REVIEW_AI_VERIFY === "1"
}

export interface RunAiVerifyInput {
  /** The AI lane's findings: the candidates to verify. */
  findings: Finding[]
  /** Deterministic engine findings the AI was told not to repeat. */
  grounding: Finding[]
  evidence: AiVerifyEvidence
  model: Provider.Model
  /** Overrides the verifier system prompt (tests). */
  system?: string
}

/**
 * Verify the AI lane's findings. Never throws: on any failure the findings
 * come back unchanged with a status saying what happened.
 */
export async function runAiVerify(
  input: RunAiVerifyInput,
  _deps: { env?: Record<string, string | undefined> } = {},
): Promise<{ findings: Finding[]; status: VerifierStatus }> {
  const status: VerifierStatus = {
    state: "skipped",
    reason: "the verifier is not implemented yet",
    durationMs: 0,
    turns: 0,
    toolCalls: 0,
    reviewed: 0,
    kept: input.findings.length,
    discarded: 0,
    summary: 0,
    unreviewed: input.findings.length,
  }
  return { findings: input.findings, status }
}

/** Most lines one `read_file` call returns. */
export const READ_FILE_MAX_LINES = 200

/** Lines `start..end` of `text` (1-based, inclusive, at most 200), each prefixed with its number. */
export function numberedSlice(text: string | undefined, start?: number, end?: number): string | undefined {
  if (text === undefined) return undefined
  const lines = text.split("\n")
  const from = Math.max(1, Math.floor(start ?? 1))
  const to = Math.min(lines.length, Math.floor(end ?? from + READ_FILE_MAX_LINES - 1), from + READ_FILE_MAX_LINES - 1)
  if (from > lines.length) return `(the file has ${lines.length} lines)`
  return lines
    .slice(from - 1, to)
    .map((l, i) => `${from + i}: ${l}`)
    .join("\n")
}

/** Deterministic facts about a finding, computed without a model. */
export interface TsFeatures {
  /** The finding's line is on the diff; null when it has no line. */
  evidenceLineValid: boolean | null
  /** It points at code the PR did not add. */
  targetsUnchangedCode: boolean
  /** It repeats a deterministic engine finding on the same file. */
  restatesGrounding: boolean
  /** It makes a claim about another model or source. */
  claimsOtherFile: boolean
  /** A style or naming remark with no correctness signal. */
  styleOnly: boolean
  lowConfidence: boolean
  /** It defers to a data diff instead of stating a defect. */
  hedgedDataDiff: boolean
}

/** Backticked or quoted identifiers in a finding's text, lower-cased. */
function quotedNames(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/`([^`\n]{2,80})`|'([A-Za-z_][\w.]{1,79})'|"([A-Za-z_][\w.]{1,79})"/g)) {
    const name = (m[1] ?? m[2] ?? m[3]).trim().toLowerCase()
    if (name.length >= 2) out.add(name)
  }
  return [...out]
}

function backticked(text: string): Set<string> {
  return new Set([...text.matchAll(/`([^`\n]{1,80})`/g)].map((m) => m[1].trim().toLowerCase()))
}

/** Title words of three or more characters, without the model name. */
function titleWords(title: string, model?: string): Set<string> {
  const skip = model?.toLowerCase()
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 3 && w !== skip),
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const w of a) if (b.has(w)) inter++
  return inter / (a.size + b.size - inter)
}

const STYLE = /alias|naming|readab|format|uppercase|trailing|consisten(t|cy) style|rename/i
const SUBSTANCE = /null|dup|fan.?out|grain|join|filter|timezone|currency|unit|incremental/i

/**
 * Deterministic features of one AI finding (pure). `added` holds the head-side
 * lines the PR added in the finding's file; `names` the dbt parents and
 * downstream models of the changed files. Findings reach the verifier before
 * `anchorToDiff` tags `preExisting`, so a line on the diff that the PR did not
 * add counts as unchanged code here.
 */
export function extractFeatures(
  f: Finding,
  file: AiReviewFile | undefined,
  grounding: Finding[],
  names: { parents: string[]; downstream: string[] },
  added: Set<number>,
): TsFeatures {
  const text = `${f.title}\n${f.body}`
  const { commentable } = scanDiffLines(file?.diff)
  const line = f.startLine
  const onDiff = typeof line === "number" && commentable.has(line)

  let targetsUnchangedCode = f.preExisting === true || (onDiff && !added.has(line!))
  if (!onDiff && f.preExisting !== true) {
    // No usable line: unchanged unless something the finding names appears on an added line.
    const addedText = [...walkDiffLines(file?.diff)]
      .filter((l) => l.kind === "+" || added.has(l.line))
      .map((l) => l.text.toLowerCase())
    const ids = quotedNames(text)
    targetsUnchangedCode = !ids.some((id) => addedText.some((t) => t.includes(id)))
  }

  const words = titleWords(f.title, f.model)
  const cols = quotedNames(text)
  const restatesGrounding = grounding.some((g) => {
    if (g.file !== f.file) return false
    if (jaccard(words, titleWords(g.title, g.model)) >= 0.5) return true
    if (g.category !== f.category) return false
    const gCols = new Set([...backticked(g.title), ...(g.column ? [g.column.toLowerCase()] : [])])
    return cols.some((c) => gCols.has(c))
  })

  const self = f.model?.toLowerCase()
  const graph = new Set(
    [...names.parents, ...names.downstream].flatMap((n) => {
      const low = n.toLowerCase()
      // A source is `source.table`; a reference to either part counts.
      return low.includes(".") ? [low, low.split(".").pop()!] : [low]
    }),
  )
  const refs = [...text.matchAll(/\bref\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1].toLowerCase())
  const claimsOtherFile =
    /\bsource\(/.test(text) ||
    refs.some((r) => r !== self) ||
    [...backticked(text)].some((n) => n !== self && graph.has(n))

  return {
    evidenceLineValid: typeof line === "number" ? onDiff : null,
    targetsUnchangedCode,
    restatesGrounding,
    claimsOtherFile,
    styleOnly: f.category === "sql_quality" && STYLE.test(text) && !SUBSTANCE.test(text),
    lowConfidence: f.confidence === "low",
    hedgedDataDiff: /recommend.*data.?diff/i.test(f.body),
  }
}
