import type { Tool } from "../../tool/tool"

/** Identifies this check's rejections in the current turn's history. */
export const CONJUNCTION_REJECTION_MARKER ="answer_commit conjunction check:"

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

/**
 * Lexical estimate of how many items the request asks for: 1 plus the most item connectives in any
 * sentence of its first paragraph, ignoring ranges, constraint clauses and rounding instructions.
 */
export function requestedItemCount(request: string): number {
  const para = request
    .trim()
    .split(/\n\s*\n|\n#/)[0]!
    .replace(EXCL, " ")
  let best = 0
  for (const sentence of para.split(/(?<=[.?!])\s+/)) {
    if (/\b(decimal|precision|round(?:ed|ing)?)\b/i.test(sentence) && !/\band\b/i.test(sentence)) continue
    const text = sentence.replace(CONSTRAINT, " ")
    const spans: number[] = []
    for (const pattern of [...NARROW, ...BROAD_EXTRA]) {
      for (const match of text.matchAll(pattern)) {
        if (!spans.some((start) => Math.abs(match.index - start) < 4)) spans.push(match.index)
      }
    }
    best = Math.max(best, spans.length)
  }
  return 1 + best
}

type Part = {
  type?: string
  tool?: string
  text?: string
  synthetic?: boolean
  state?: { status?: string; error?: unknown }
}

/** Bounds the in-process record of advised requests; the oldest entries are dropped first. */
const MAX_ADVISED_REQUESTS = 1_000
/**
 * Session and request text already advised in this process. Reserved synchronously before the rejection
 * returns, so parallel commits in one step and a compaction replay of the same request are not rejected again.
 */
const advised = new Set<string>()

/**
 * Advisory for a commit that names one item when the latest user request joins two. Fires at most once
 * per session and request, so the next commit, changed or not, is accepted. Purely lexical: no queries or
 * model calls.
 */
export function conjunctionRejection(
  args: { fields?: { name: string }[]; rows?: unknown; unresolved?: unknown; asked?: string[] },
  messages: Tool.Context["messages"],
  sessionID: string,
): string | undefined {
  if (args.unresolved) return undefined
  const asked = args.asked?.filter((item) => item.trim())
  const count = asked?.length ? asked.length : args.fields?.length
  if (count !== 1) return undefined
  const latest = messages.findLastIndex((message) => message.info.role === "user")
  if (latest < 0) return undefined
  const text = (messages[latest]!.parts as Part[])
    .filter((part) => part.type === "text" && !part.synthetic)
    .map((part) => part.text ?? "")
    .join("\n\n")
  if (requestedItemCount(text) < 2) return undefined
  const key = `${sessionID}\u0000${text}`
  if (advised.has(key)) return undefined
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
  return `${CONJUNCTION_REJECTION_MARKER} the request appears to ask for more than one item (it joins items with "and" or a similar connective), but this commit names one${asked?.length ? ` (${JSON.stringify(asked)})` : ""}. Call answer_commit again with each requested item as its own field (or rows column), named after it, and list them all in \`asked\`. If the request asks for a single item, recommit unchanged; the next commit is accepted.`
}
