import { Decimal } from "decimal.js"
import type { Tool } from "../../tool/tool"

/** Markers that identify each check's rejections in this turn's history. */
export const COVERAGE_REJECTION_MARKER = "answer_commit requested-items check:"
export const NUMBER_REJECTION_MARKER = "answer_commit number check:"
export const READING_REJECTION_MARKER = "answer_commit reading check:"
/** Coverage rejections per user turn before a commit is accepted as is. */
export const MAX_COVERAGE_REJECTIONS = 2
/** Number-provenance warnings per user turn before a commit is accepted as is. */
export const MAX_NUMBER_REJECTIONS = 1
/** Reading-challenge warnings per user turn before a commit is accepted as is. */
export const MAX_READING_REJECTIONS = 1
/** Integers up to this magnitude are commonly counted from listed rows; they are not checked. */
const SMALL_INTEGER_LIMIT = 10
/** Bound the scan over prior tool output so a huge session cannot stall the commit. */
const MAX_SCANNED_CHARACTERS = 4_000_000
/** Significant digits that strip binary float noise (0.1 + 0.2) without losing real precision. */
const FLOAT_NOISE_PRECISION = 15

type Cell = string | number | null
type Committed = {
  fields?: { name: string; value: string | number }[]
  rows?: { columns: string[]; values: Cell[][] }
  asked?: string[]
}

type LoosePart = {
  type?: string
  tool?: string
  text?: string
  state?: { status?: string; output?: unknown; error?: unknown }
}

/** Messages of the current user turn: everything after the latest user message, plus that message. */
function currentTurn(messages: Tool.Context["messages"]) {
  const start = messages.findLastIndex((message) => message.info.role === "user")
  return start < 0 ? messages : messages.slice(start)
}

/** Earlier answer_commit rejections in this turn carrying the given marker. */
export function priorRejections(messages: Tool.Context["messages"], marker: string): number {
  return currentTurn(messages)
    .flatMap((message) => message.parts as LoosePart[])
    .filter(
      (part) =>
        part.type === "tool" &&
        part.tool === "answer_commit" &&
        part.state?.status === "error" &&
        String(part.state.error ?? "").includes(marker),
    ).length
}

const STOPWORDS = new Set([
  "a", "an", "the", "of", "and", "or", "for", "with", "its", "their", "his", "her", "each", "per", "in", "on",
  "by", "to", "from", "at", "is", "are", "which", "what", "name", "names",
])

function words(label: string): string[] {
  return label
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !STOPWORDS.has(word))
    .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word))
}

/** 3 = same label, 2 = one label contains the other, 1 = a shared content word, 0 = unrelated. */
function labelScore(asked: string, label: string): number {
  const a = words(asked).join(" ")
  const b = words(label).join(" ")
  if (!a || !b) return 0
  if (a === b) return 3
  if (a.includes(b) || b.includes(a)) return 2
  const shared = new Set(words(asked))
  return words(label).some((word) => shared.has(word)) ? 1 : 0
}

/** Pair each asked item with at most one committed label, strongest matches first. */
function matchAsked(asked: string[], labels: string[]): Map<number, number> {
  const pairs = asked
    .flatMap((item, a) => labels.map((label, l) => ({ a, l, score: labelScore(item, label) })))
    .filter((pair) => pair.score > 0)
    .sort((x, y) => y.score - x.score || x.a - y.a || x.l - y.l)
  const matched = new Map<number, number>()
  const used = new Set<number>()
  for (const pair of pairs) {
    if (matched.has(pair.a) || used.has(pair.l)) continue
    matched.set(pair.a, pair.l)
    used.add(pair.l)
  }
  return matched
}

const blank = (cell: Cell) => cell === null || (typeof cell === "string" && !cell.trim())

/** Asked items that no committed field or column supplies with a non-empty value. */
export function missingAskedItems(args: Committed): string[] {
  const asked = (args.asked ?? []).map((item) => item.trim()).filter(Boolean)
  if (asked.length <= 1) return []
  if (args.fields) {
    const matched = matchAsked(
      asked,
      args.fields.map((field) => field.name),
    )
    return asked.filter((_, index) => !matched.has(index))
  }
  if (args.rows) {
    const { columns, values } = args.rows
    const matched = matchAsked(asked, columns)
    return asked.filter((_, index) => {
      const column = matched.get(index)
      return column === undefined || values.every((row) => blank(row[column] ?? null))
    })
  }
  return []
}

export function coverageRejection(missing: string[], asked: string[]): string {
  return `${COVERAGE_REJECTION_MARKER} the request asks for ${asked.length} items (${asked.map((item) => JSON.stringify(item)).join(", ")}), but no committed field or column supplies ${missing.map((item) => JSON.stringify(item)).join(", ")}. Call answer_commit again with one non-empty field (or rows column) per asked item, named after that item, in the order asked; a value kept only in basis is dropped from answer-only output.`
}

/** A committed value as a plain decimal, or undefined for text that is not purely numeric. */
function numericValue(value: Cell): Decimal | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Decimal(value.toPrecision(FLOAT_NOISE_PRECISION)) : undefined
  }
  if (typeof value !== "string") return undefined
  const stripped = value.trim().replace(/^[$€£¥]\s*/, "").replace(/\s*%$/, "")
  if (!/^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(stripped)) return undefined
  return new Decimal(stripped.replaceAll(",", ""))
}

function committedNumbers(args: Committed): Decimal[] {
  const cells: Cell[] = [
    ...(args.fields ?? []).map((field) => field.value),
    ...(args.rows?.values.flat() ?? []),
  ]
  return cells
    .map(numericValue)
    .filter((value): value is Decimal => value !== undefined)
    .map((value) => value.abs())
    .filter((value) => !(value.isInteger() && value.lte(SMALL_INTEGER_LIMIT)))
}

const NUMBER_TOKENS = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g

function textNumbers(text: string, into: Set<string>) {
  for (const [token] of text.matchAll(NUMBER_TOKENS)) {
    // "12,345" may be one grouped number or two delimited cells; keep both readings.
    for (const candidate of token.includes(",") ? [token.replaceAll(",", ""), ...token.split(",")] : [token]) {
      try {
        into.add(new Decimal(candidate).toString())
      } catch {
        // Malformed tokens are not evidence.
      }
    }
  }
}

const isSqlTool = (tool: string | undefined) => !!tool?.startsWith("sql_")

/** Numbers seen in this session's tool output and user requests, or undefined when no SQL tool has produced output. */
export function sessionNumbers(messages: Tool.Context["messages"]): Set<string> | undefined {
  const parts = messages.flatMap((message) =>
    (message.parts as LoosePart[]).map((part) => ({ role: message.info.role, part })),
  )
  const sql = parts.some(
    ({ part }) => part.type === "tool" && isSqlTool(part.tool) && part.state?.status === "completed",
  )
  if (!sql) return undefined
  const seen = new Set<string>()
  let budget = MAX_SCANNED_CHARACTERS
  for (const { role, part } of parts.toReversed()) {
    const text =
      part.type === "tool" && part.tool !== "answer_commit" && part.state?.status === "completed"
        ? String(part.state.output ?? "")
        : role === "user" && part.type === "text"
          ? (part.text ?? "")
          : ""
    if (!text) continue
    textNumbers(text.slice(0, budget), seen)
    budget -= text.length
    if (budget <= 0) break
  }
  return seen
}

/** Whether any sorted value lies in [low, high). */
function anyWithin(sorted: number[], low: number, high: number): boolean {
  let start = 0
  let end = sorted.length
  while (start < end) {
    const middle = (start + end) >> 1
    if (sorted[middle]! < low) start = middle + 1
    else end = middle
  }
  return start < sorted.length && sorted[start]! < high
}

/**
 * Whether the committed number is a seen number rounded (half up) or truncated to the committed
 * decimal places, directly or as a ratio/percentage conversion (x100 or /100).
 */
function derivable(value: Decimal, sorted: number[]): boolean {
  const unit = new Decimal(10).pow(-value.decimalPlaces())
  // Half-up rounding reaches value from [value - unit/2, value + unit/2); truncation from [value, value + unit).
  const low = value.minus(unit.dividedBy(2))
  const high = value.plus(unit)
  return [new Decimal(1), new Decimal(100), new Decimal(0.01)].some((scale) =>
    anyWithin(sorted, low.dividedBy(scale).toNumber(), high.dividedBy(scale).toNumber()),
  )
}

/** Committed numbers that no prior tool output (or the request) contains, even after simple rounding. */
export function unsourcedNumbers(args: Committed, seen: Set<string>): string[] {
  const sorted = [...seen].map(Number).sort((a, b) => a - b)
  const unsourced = committedNumbers(args).filter((value) => !seen.has(value.toString()) && !derivable(value, sorted))
  return [...new Set(unsourced.map((value) => value.toString()))]
}

export function numberRejection(unsourced: string[]): string {
  return `${NUMBER_REJECTION_MARKER} ${unsourced.join(", ")} did not appear in any query result this session and is not a rounding of one. Compute it in SQL and commit the queried value, or, if it is correct as is (for example derived from the question), call answer_commit again unchanged and say how it was derived in basis. This warning is shown once.`
}

/** A rejection reason that rests on how few rows a reading returns rather than on what the request says. */
const RESULT_SIZE_REASON =
  /\b(?:only (?:one|1|a single)\b(?![\d,.])|just (?:one|1)\b(?![\d,.])|(?:returns?|yields?|gives?|leaves?) (?:just |only )?(?:one|1|a single|no|zero|0)\b(?![\d,.])|single (?:row|record|result|match|value|candidate|opportunit\w*|entity|group)|no comparison|nothing to compare|too few|too small|trivial(?:ly)?|degenerate)/i
/** decided_by that cites the request's own wording is a reasoned choice, not a size-based one. */
const CITES_REQUEST = /\b(?:asks?|requests?|requested|explicit(?:ly)?|states?|stated|says?|defines?|defined)\b/i

/** Entries whose decided_by rejects an alternative reading because it yields a small or trivial result. */
export function sizeBasedRejections(readings: { clause: string; decided_by: string }[] | undefined): string[] {
  return (readings ?? []).filter((entry) => RESULT_SIZE_REASON.test(entry.decided_by) && !CITES_REQUEST.test(entry.decided_by)).map((entry) => entry.clause)
}

export function readingRejection(clauses: string[]): string {
  return `${READING_REJECTION_MARKER} your reading of ${clauses.map((clause) => JSON.stringify(clause)).join(", ")} rejected an alternative because it returns few or trivial rows. A result being small is not evidence against a reading: when the request, a policy or a definition it supplies states the rule, apply that text literally and accept a one-row answer. Choose the alternative only if the request's own wording supports it. Call answer_commit again with the reading the supplied text dictates, or unchanged with decided_by naming the wording that supports your choice. This warning is shown once.`
}
