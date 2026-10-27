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

const MEMORY_CUES: readonly [RegExp, string][] = [
  [/\bi\s+(?:prefer|like|want|usually|tend to)\b/i, "a personal preference"],
  [/\bfor\s+me\b|\bmy\s+(?:preference|style|default|setup|machine|laptop)\b/i, "a personal preference"],
  [/\bremember\s+(?:that|our|the)\b(?!.*\b(?:always|never|must)\b)/i, "a fact to remember"],
  [/\b(?:our|the)\s+(?:warehouse|database|account|cluster|stack|region|team|company|org)\s+(?:is|uses|runs|lives)\b/i, "a fact about the environment"],
  [/\b[A-Z]{2,}\s+(?:means|stands for|is short for)\b|\bmeans\b.*\b(?:revenue|users?|customers?|metric)\b/, "a glossary term"],
]

const RULE_CUES: readonly [RegExp, string][] = [
  [/\b(?:always|never)\b/i, "an always/never instruction"],
  [/\bmust(?:\s+not)?\b|\bshould(?:\s+not|n't)?\s+(?:use|be|have|name|add|run)\b/i, "a must/should instruction"],
  [/\bwe\s+(?:always|never|use|don't|do not)\b|\b(?:our|team|house|repo|project)\s+(?:convention|standard|rule|style|policy)\b/i, "a team convention"],
  [/\buse\s+\S+\s+instead\s+of\b|\b(?:don't|do not|avoid)\s+(?:use|using|add|write|name|cast)\b/i, "a do/don't instruction"],
  [/\b(?:name|prefix|suffix|alias)\s+\S+(?:\s+\S+)?\s+(?:as|with|like)\b/i, "a naming convention"],
  [/\bas\s+a\s+(?:team\s+)?rule\b/i, "asked for a rule"],
]

export function classify(text: string): { kind: Kind; cue?: string } {
  const memory = MEMORY_CUES.find(([pattern]) => pattern.test(text))
  const rule = RULE_CUES.find(([pattern]) => pattern.test(text))
  if (rule && !memory) return { kind: "rule", cue: rule[1] }
  if (memory && !rule) return { kind: "memory", cue: memory[1] }
  // "As a rule" wins over a stray preference cue: the person named the kind.
  if (rule?.[1] === "asked for a rule") return { kind: "rule", cue: rule[1] }
  return { kind: "ambiguous" }
}

/** A preference is the person's own (global memory); a fact belongs to the project. */
export function memoryScope(text: string): "global" | "project" {
  return /\bi\s+(?:prefer|like|want|usually|tend to)\b|\bfor\s+me\b|\bmy\s+/i.test(text) ? "global" : "project"
}

export * as RuleClassify from "./classify"
