import type { Tool } from "../../tool/tool"
import { RunBudget } from "../run-budget"
import { effortOverride, toolsDisabled } from "../session/run-budget-effort"

/** Identifies this check's rejections in the current turn's history. */
export const CONJUNCTION_REJECTION_MARKER = "answer_commit conjunction check:"

// Narrow connectives strongly suggest another requested item.
const NARROW = [
  /\band (?:its|their|his|her|the corresponding|the associated)\b/gi,
  /\balong with\b/gi,
  /\bas well as\b/gi,
  /\btogether with\b/gi,
  /\band also\b/gi,
  /\bin addition to\b/gi,
  /\band (?:report|list|show|include|provide|return|give|compute|calculate|identify|find)\b/gi,
]
// Articles and comma-separated conjunctions catch less explicit item lists.
const BROAD_EXTRA = [/,\s+and\s+(?!then\b)/gi, /\band (?:the|a|an|which|what|how|whether)\b/gi]
// Ranges and paired expressions do not introduce requested items.
const EXCL = /(?:between|both|either|from)\s+[^.,;]{0,60}?\band\b/gi
// Constraints qualify an item rather than request another one.
const CONSTRAINT =
  /\band (?:only|also consider|consider|excluding|exclude|limit|using|ensure|ensuring|where|for|in|on|at|from|with|by|to|if)\b/gi
/** Words of the request quoted after each connective, to name the item it introduces. */
const JOIN_WORDS = 8

/**
 * Lexical estimate of the items a request asks for: 1 plus the most item connectives in any sentence
 * of its first paragraph, ignoring ranges, constraint clauses and rounding instructions. `joins` quotes
 * each counted connective with the words that follow it, naming the extra items.
 */
export function requestedItems(request: string): { count: number; joins: string[] } {
  const para = request
    .trim()
    .split(/\n\s*\n|\n#/)[0]!
    .replace(EXCL, " ")
  let joins: string[] = []
  for (const sentence of para.split(/(?<=[.?!])\s+/)) {
    if (/\b(decimal|precision|round(?:ed|ing)?)\b/i.test(sentence) && !/\band\b/i.test(sentence)) continue
    const text = sentence.replace(CONSTRAINT, " ")
    const spans: number[] = []
    for (const pattern of [...NARROW, ...BROAD_EXTRA]) {
      for (const match of text.matchAll(pattern)) {
        if (!spans.some((start) => Math.abs(match.index - start) < 4)) spans.push(match.index)
      }
    }
    if (spans.length > joins.length)
      joins = spans
        .sort((a, b) => a - b)
        .map((start) =>
          text
            .slice(start)
            .replace(/^,\s*/, "")
            .split(/[.,;?!]/)[0]!
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, JOIN_WORDS)
            .join(" "),
        )
  }
  return { count: 1 + joins.length, joins }
}

type Part = {
  type?: string
  tool?: string
  text?: string
  synthetic?: boolean
  state?: { status?: string; error?: unknown }
}

/** Text of the latest user message, without synthetic parts such as time-budget reminders. */
function latestRequest(messages: Tool.Context["messages"]): string {
  const latest = messages.findLast((message) => message.info.role === "user")
  return ((latest?.parts ?? []) as Part[])
    .filter((part) => part.type === "text" && !part.synthetic)
    .map((part) => part.text ?? "")
    .join("\n\n")
}

/** Bounds the in-process record of advised requests; the oldest entries are dropped first. */
const MAX_ADVISED_REQUESTS = 1_000
/**
 * Session and request text already advised in this process. Reserved synchronously before the rejection
 * returns, so parallel commits in one step and a compaction replay of the same request are not rejected again.
 */
const advised = new Set<string>()

/** Near the run's time budget a rejected commit may not get another turn, so it is never rejected. */
function budgetEnding(sessionID: string): boolean {
  const deadline = RunBudget.queryDeadline(sessionID)
  return toolsDisabled(sessionID) || effortOverride(sessionID) || (deadline !== undefined && Date.now() >= deadline)
}

/**
 * Rejects a commit naming fewer items than the latest user request joins. A commit's items are its
 * non-blank `asked` labels when given (so a rows commit is checked too), otherwise its field names.
 * Fires at most once per session and request, so the next commit, changed or not, is accepted, and
 * never for an unresolved answer or once the run nears its time budget. Purely lexical: no queries or
 * model calls.
 */
export function conjunctionRejection(
  args: { fields?: { name: string }[]; unresolved?: unknown; asked?: string[] },
  messages: Tool.Context["messages"],
  sessionID: string,
): string | undefined {
  if (args.unresolved || budgetEnding(sessionID)) return undefined
  const asked = args.asked?.map((item) => item.trim()).filter(Boolean)
  const names = asked?.length ? asked : args.fields?.map((field) => field.name)
  if (!names) return undefined
  const text = latestRequest(messages)
  const { count, joins } = requestedItems(text)
  if (count <= names.length) return undefined
  const key = `${sessionID}\u0000${text}`
  if (advised.has(key)) return undefined
  const latest = messages.findLastIndex((message) => message.info.role === "user")
  // History covers a resumed session whose in-process record is gone.
  if (
    messages
      .slice(latest)
      .some((message) =>
        (message.parts as Part[]).some(
          (part) =>
            part.type === "tool" &&
            part.tool === "answer_commit" &&
            part.state?.status === "error" &&
            String(part.state.error).includes(CONJUNCTION_REJECTION_MARKER),
        ),
      )
  )
    return undefined
  advised.add(key)
  if (advised.size > MAX_ADVISED_REQUESTS) advised.delete(advised.values().next().value!)
  const items = asked?.length
    ? `${names.length} asked item${names.length === 1 ? "" : "s"}`
    : `${names.length} field${names.length === 1 ? "" : "s"}`
  return `${CONJUNCTION_REJECTION_MARKER} the request appears to ask for ${count} items, but this commit has ${items} (${JSON.stringify(names)}). The request also asks for ${joins.map((join) => `"${join}"`).join(", ")}. Call answer_commit again with each requested item as its own field (or rows column), named after it, and list them all in \`asked\`. If the request asks for fewer items, recommit unchanged; the next commit is accepted.`
}

export * as AnswerCommitConjunction from "./answer-commit-conjunction"
