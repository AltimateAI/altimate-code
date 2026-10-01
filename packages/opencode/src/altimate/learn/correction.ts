// altimate_change - new file
//
// Conservative classifier for "the user is correcting the agent". It models the idea behind
// codex-engineer's `correction_reason` (clause-level cue matching, first match wins, no stored
// conversation text) with its own cue list. Precision matters more than recall: a missed correction
// costs one lesson, a false positive puts noise in front of the reflector.
//
// Not corrections: thanks/LGTM, a new unrelated task ("now add a model for X"), and ordinary
// questions ("what does this do?"). Only a `why did you ...` question counts as a challenge.

const MAX_CLASSIFIED_CHARS = 4000

interface Cue {
  pattern: RegExp
  reason: string
  /** Also matches a clause that ends in `?` (a challenge, not a plain question). */
  question?: boolean
}

// Connectors that may precede a cue without changing its meaning ("but you forgot ...").
const LEAD = String.raw`(?:(?:also|but|and|yet|still|actually|clearly|apparently|however|please|ok(?:ay)?|so)[,:]?\s+)*`

const CUES: readonly Cue[] = [
  {
    pattern: /\b(?:that|this|it|what you did)(?:'s| is| was)\s+(?:wrong|incorrect|not\s+(?:right|correct|what)|still\s+wrong)\b/i,
    reason: "user identified an incorrect result",
  },
  {
    pattern: /^\s*(?:that|this|it)\s+(?:isn't|is not|wasn't|was not)\s+(?:right|correct)\b/i,
    reason: "user identified an incorrect result",
  },
  { pattern: /^\s*incorrect\b/i, reason: "user identified an incorrect result" },
  { pattern: /\bnot\s+what\s+i\s+(?:asked|wanted|meant|said)\b/i, reason: "user said the result is not what was asked" },
  {
    pattern: /^\s*(?:no|nope|nah)\b[,.:;!\s-]+(?!problem|worries|thanks|thank you|need\b|rush)\S/i,
    reason: "user rejected the previous action and gave a direction",
  },
  {
    pattern: /\byou\s+(?:(?:have|had)\s+)?(?:forgot(?:ten)?|missed|overlooked|ignored|neglected|failed to)\b/i,
    reason: "user identified a forgotten or missed action",
    question: true,
  },
  {
    pattern: new RegExp(String.raw`^\s*${LEAD}(?:you|the agent)\s+(?:did(?:n't| not)|ha(?:ve|s)(?:n't| not))\b`, "i"),
    reason: "user identified an omitted action",
    question: true,
  },
  {
    pattern: /\bwe\s+(?:always|never)\b|\bwe\s+(?:do(?:n't| not)|should(?:n't| not)?)\s+(?:ever\s+)?\w+/i,
    reason: "user stated a team convention",
  },
  {
    pattern: /\b(?:our|the\s+team's|team|house|repo|project)\s+(?:convention|standard|rule|style|guideline|policy)s?\b/i,
    reason: "user stated a team convention",
  },
  {
    pattern: new RegExp(
      String.raw`^\s*${LEAD}(?:always|never)\s+(?:use|list|name|prefix|suffix|put|add|write|include|run|call|cast|alias|qualify)\b`,
      "i",
    ),
    reason: "user stated an always/never rule",
  },
  {
    pattern:
      /\bshould(?:n't| not)\s+(?:be|have|use|include|add|contain)\b|\bshould\s+(?:be|have|always|never|use)\b(?!\s+(?:fine|ok|okay|good|enough|great|all right|alright|able|possible)\b)/i,
    reason: "user stated what the result should have been",
  },
  {
    pattern:
      /\b(?:use|using|prefer|call|name|write|make|put)\b[^.?!\n]{0,80}\binstead\s+of\b|\binstead,?\s+(?:use|do|make|put|name|write|call)\b|\bplease\s+use\b[^.?!\n]{0,80}\binstead\b/i,
    reason: "user asked for a different approach",
  },
  {
    pattern: new RegExp(String.raw`^\s*${LEAD}(?:don't|do not|dont|never|stop)\s+(?!worry\b|bother\b)\w+`, "i"),
    reason: "user prohibited an action",
  },
  {
    pattern: /^\s*(?:actually|wait|hold on)[,:]?\s+(?![^.!?\n]{0,40}\b(?:great|perfect|works|nice|good|awesome|thanks)\b)\S/i,
    reason: "user corrected course",
  },
  { pattern: /\bwhy\s+(?:did(?:n't| not)?|would|were|are)\s+you\b/i, reason: "user challenged an action", question: true },
  { pattern: /^\s*(?:please\s+)?rename\b[^.?!\n]{1,80}\bto\b/i, reason: "user asked to rename to a convention" },
  {
    pattern: /\buse\s+the\s+[\w.`'-]+\s+(?:macro|helper|function|ref|source|test|materialization|pattern)\b/i,
    reason: "user pointed to the project's own helper",
  },
  { pattern: /\bi\s+(?:said|told you)\b/i, reason: "user repeated an earlier instruction" },
  {
    pattern: /\bagain\b[^.!?\n]{0,120}\b(?:miss|fail|forgot|wrong|skip)|\b(?:same|repeated)\s+(?:mistake|problem|failure)\b/i,
    reason: "user identified a repeated failure",
  },
]

/** Prose only: fenced code and pasted logs carry words like "should be" that are not the user's own. */
function proseOf(text: string): string {
  return text.slice(0, MAX_CLASSIFIED_CHARS).replace(/```[\s\S]*?(?:```|$)/g, " ")
}

function clauses(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((c) => c.trim())
    .filter(Boolean)
}

/** Why `text` reads as a user correcting the agent, or undefined when it does not. */
export function correctionReason(text: string): string | undefined {
  if (typeof text !== "string" || !text.trim()) return undefined
  for (const clause of clauses(proseOf(text))) {
    const isQuestion = clause.endsWith("?")
    for (const cue of CUES) {
      if (isQuestion && !cue.question) continue
      if (cue.pattern.test(clause)) return cue.reason
    }
  }
  return undefined
}
