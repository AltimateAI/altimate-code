// altimate_change - new file
//
// Rule or memory? Deterministic, no model call, like the correction classifier.
//
// - A rule is an instruction about how the agent must work in this repository, for everyone, that its
//   output can be checked against: "name staging models stg_<source>__<entity>", "never use FLOAT for money".
// - A memory is a fact or a personal preference that informs the agent but is not a team constraint:
//   "our warehouse is Snowflake", "ARR means annual recurring revenue", "I prefer CTEs".
//
// Repetition is the strongest rule signal and is handled by the recurrence trigger, not here. This reads
// the wording of something the person asked to remember. When neither side has a cue, or both do, the
// answer is `ambiguous` and the card lets the person choose: Memory · Team rule · Skip.

export type Kind = "rule" | "memory" | "ambiguous"

// The person named the kind: these decide on their own, whatever else the text says.
const ASKED_RULE = /\bas\s+a\s+(?:team\s+)?rule\b/i
// Only the named forms: a bare "for me" opens ordinary requests ("fix this model for me"), and "in memory" describes
// data ("never load the fact table in memory").
const ASKED_MEMORY = /\bas\s+a\s+memory\b|\bin\s+my\s+memory\b|\bremember\b[^.!?\n]*\b(?:just\s+)?for\s+me\b/i

// "I want …" / "I like …" open many ordinary requests ("I want staging models in models/staging"): on its own
// that is not enough to file a team convention as a personal memory, so it only makes the text ambiguous.
const WEAK_MEMORY = /\bi\s+(?:like|want)\b/i

const MEMORY_CUES: readonly [RegExp, string][] = [
  [/\bi\s+(?:prefer|usually|tend to)\b/i, "a personal preference"],
  [/\bmy\s+(?:preference|style|default|setup|machine|laptop)\b/i, "a personal preference"],
  [/\bremember\s+(?:that|our|the)\b(?!.*\b(?:always|never|must)\b)/i, "a fact to remember"],
  [/\b(?:our|the)\s+(?:warehouse|database|account|cluster|stack|region|team|company|org)\s+(?:is|uses|runs|lives)\b/i, "a fact about the environment"],
  [/\b[A-Z]{2,}\s+(?:means|stands for|is short for)\b|\bmeans\b.*\b(?:revenue|users?|customers?|metric)\b/, "a glossary term"],
]

const RULE_CUES: readonly [RegExp, string][] = [
  [/\b(?:always|never)\b/i, "an always/never instruction"],
  [/\bmust(?:\s+not)?\b|\bshould(?:\s+not|n't)?\s+(?:use|be|have|name|add|run)\b/i, "a must/should instruction"],
  // Not a bare "we use": "we use Snowflake" is a fact about the environment.
  [/\bwe\s+(?:always|never|don't|do not)\b|\b(?:our|team|house|repo|project)\s+(?:convention|standard|rule|style|policy)\b/i, "a team convention"],
  [/\buse\s+\S+\s+instead\s+of\b|\b(?:don't|do not|avoid)\s+(?:use|using|add|write|name|cast)\b/i, "a do/don't instruction"],
  [/\b(?:name|prefix|suffix|alias)\s+\S+(?:\s+\S+)?\s+(?:as|with|like)\b/i, "a naming convention"],
]

export function classify(text: string): { kind: Kind; cue?: string } {
  if (ASKED_RULE.test(text)) return { kind: "rule", cue: "asked for a rule" }
  if (ASKED_MEMORY.test(text)) return { kind: "memory", cue: "asked to remember it for themselves" }
  const memory = MEMORY_CUES.find(([pattern]) => pattern.test(text))
  const rule = RULE_CUES.find(([pattern]) => pattern.test(text))
  if (rule && !memory && !WEAK_MEMORY.test(text)) return { kind: "rule", cue: rule[1] }
  if (memory && !rule) return { kind: "memory", cue: memory[1] }
  return { kind: "ambiguous" }
}

/** A preference is the person's own (global memory); a fact belongs to the project, even when it says "my". */
export function memoryScope(text: string): "global" | "project" {
  return /\bi\s+(?:prefer|like|want|usually|tend to)\b|\bfor\s+me\b|\bmy\s+(?:preference|style|default|setup|machine|laptop|editor|shell)\b/i.test(text)
    ? "global"
    : "project"
}

export * as RuleClassify from "./classify"
