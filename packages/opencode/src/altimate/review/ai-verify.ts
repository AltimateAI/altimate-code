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
import type { ReviewRunner } from "./orchestrate"

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
