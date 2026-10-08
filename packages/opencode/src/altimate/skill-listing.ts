/**
 * Bounded skill listing.
 *
 * The `skill` tool description and the system prompt both enumerate the installed skills. Without a
 * bound, the system-prompt copy grows with every skill (about 190 tokens each: name, description and a
 * file URL) and the tool-description copy stops at 50 entries, leaving skill 51 onward unreachable by
 * the model unless it already knows the name. Both sit in the prompt prefix that is re-sent on every
 * request.
 *
 * This renders a listing that stays inside a token budget and never hides a skill:
 *   1. Skills are ordered deterministically (embedded skills first, then by name), so the text is the
 *      same for the same set of skills and the cached prefix is stable.
 *   2. Every skill gets at least its name. Descriptions (single line, truncated) are added in order
 *      while the budget lasts.
 *   3. If even the names do not fit, the tail is replaced by a count and a pointer to the search below.
 *   4. Passing a keyword as the skill `name` searches all installed skills (see `findSkills`), so a
 *      skill that is not shown can still be found, then loaded by its exact name.
 *
 * Budgets are in estimated tokens (4 characters each); the estimate is only used to bound size.
 */
import { Skill } from "../skill"

export const TOOL_LISTING_BUDGET_TOKENS = 1_000
export const SYSTEM_LISTING_BUDGET_TOKENS = 2_500
/**
 * Description lengths to try, longest first. The listing uses the longest one at which every skill
 * still fits its budget, so a short list keeps its trigger conditions and a long one degrades evenly.
 */
const TOOL_DESCRIPTION_CAPS = [160, 70]
const SYSTEM_DESCRIPTION_CAPS = [400, 160]
const SYSTEM_DESCRIPTION_CHARS = 160
const CHARS_PER_TOKEN = 4
const MATCH_LIMIT = 15
const NAME_LIMIT = 40
/** A name longer than this is shortened for display; it is still found by search and loaded by its full name. */
const DISPLAY_NAME_CHARS = 100
/** The longest name a search result shows whole. */
const RESULT_NAME_CHARS = 256
/** Room kept for the wrapper tags and the "not listed" footer, which the entries must not crowd out. */
const OVERHEAD_CHARS = 400

export type ListingKind = "tool" | "system"

type Entry = Pick<Skill.Info, "name" | "description" | "location">

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Embedded (shipped) skills first, then everything else; each group by name. */
export function orderSkills<T extends Entry>(skills: readonly T[]): T[] {
  const rank = (skill: Entry) => (Skill.hasNoSkillDirectory(skill.location) ? 0 : 1)
  return [...skills].sort((a, b) => rank(a) - rank(b) || compare(a.name, b.name) || compare(a.location, b.location))
}

/** Collapse to one line and cut to `max` characters by code point, so a surrogate pair is never split. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  const chars = Array.from(flat)
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("").trimEnd()}…`
}

/**
 * How a name is shown. A plain name is shown as it is, so it can be copied back. A name with line breaks,
 * repeated spaces or tabs is shown JSON-quoted, which keeps it exact on one line. A name over the display
 * length is shortened with an ellipsis; search shows the longer form.
 */
function display(name: string, max: number): string {
  const neutral = Skill.neutralizeListingWrapper(name)
  const plain = neutral === neutral.replace(/\s+/g, " ").trim()
  // JSON leaves U+2028 and U+2029 as they are; they would still break a line, so escape them too.
  const shown = plain ? neutral : JSON.stringify(neutral).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
  const chars = Array.from(shown)
  return chars.length <= max ? shown : `${chars.slice(0, max - 1).join("")}…`
}

function label(skill: Entry) {
  return display(skill.name, DISPLAY_NAME_CHARS)
}

function line(skill: Entry, max: number, name = label(skill)): string {
  const description = oneLine(Skill.neutralizeListingWrapper(skill.description ?? ""), max)
  return description ? `${name}: ${description}` : name
}

export function renderBoundedListing(skills: readonly Entry[], kind: ListingKind): string {
  const ordered = orderSkills(skills)
  const budget =
    (kind === "tool" ? TOOL_LISTING_BUDGET_TOKENS : SYSTEM_LISTING_BUDGET_TOKENS) * CHARS_PER_TOKEN - OVERHEAD_CHARS
  const caps = kind === "tool" ? TOOL_DESCRIPTION_CAPS : SYSTEM_DESCRIPTION_CAPS
  const names = ordered.map(label)
  const render = (max: number) => ordered.map((skill) => line(skill, max))
  // Same per-entry cost as the spending loop below: the line, a separator and a newline.
  const total = (lines: string[]) => lines.reduce((sum, l) => sum + l.length + 2, 0)
  let full = render(caps[caps.length - 1]!)
  for (const max of caps) {
    const lines = render(max)
    if (total(lines) <= budget) {
      full = lines
      break
    }
  }

  // Names are the floor: show as many as fit, in order.
  let used = 0
  let listed = 0
  for (const name of names) {
    const next = used + name.length + 2
    if (next > budget) break
    used = next
    listed++
  }

  // Spend what is left on descriptions, front to back, and stop at the first one that does not fit.
  let described = 0
  while (described < listed) {
    const extra = full[described]!.length - names[described]!.length
    if (used + extra > budget) break
    used += extra
    described++
  }

  const hidden = ordered.length - listed
  const out = ["<available_skills>"]
  for (let i = 0; i < described; i++) out.push(full[i]!)
  if (listed > described) out.push(names.slice(described, listed).join(", "))
  if (hidden > 0) {
    out.push(
      `... and ${hidden} more installed skills (${ordered.length} in total) are not listed here. ` +
        `Call this tool with a keyword as the name (for example "snowflake") to search all of them.`,
    )
  } else if (ordered.length > 0 && listed > described) {
    out.push(`Call this tool with a keyword as the name to search skills by description.`)
  }
  out.push("</available_skills>")
  return out.join("\n")
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * Rank every installed skill against a query. Deterministic: score, then the listing order.
 * Used when the model passes something that is not an exact skill name.
 */
export function findSkills<T extends Entry>(skills: readonly T[], query: string, limit = MATCH_LIMIT): T[] {
  const terms = [...new Set(words(query))]
  if (terms.length === 0) return []
  const exact = query.trim().toLowerCase()
  return orderSkills(skills)
    .map((skill, index) => {
      const name = skill.name.toLowerCase()
      const description = (skill.description ?? "").toLowerCase()
      // A skill is always found by its own name: an exact match outranks any keyword score.
      let score = name === exact ? 1000 : 0
      let covered = 0
      for (const term of terms) {
        const inName = name.includes(term)
        const inDescription = description.includes(term)
        if (inName) score += 3
        if (inDescription) score += 1
        if (inName || inDescription) covered++
      }
      // Matching more of the query beats matching one term strongly.
      score += covered * 20
      return { skill, score, index }
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((hit) => hit.skill)
}

/** The text of a failed lookup: matches with descriptions when the keyword hits, else a bounded name list. */
export function notFoundMessage(skills: readonly Entry[], requested: string): string {
  const matches = findSkills(skills, requested)
  const head = `Skill "${oneLine(Skill.neutralizeListingWrapper(requested), 80)}" not found. ${skills.length} skills are installed.`
  if (matches.length > 0) {
    const total = findSkills(skills, requested, Number.MAX_SAFE_INTEGER).length
    return [
      head,
      `Closest matches (call this tool again with the exact name to load one):`,
      // Search results carry the full name: it is what the skill is loaded by.
      ...matches.map((skill) => `- ${line(skill, SYSTEM_DESCRIPTION_CHARS, display(skill.name, RESULT_NAME_CHARS))}`),
      ...(total > matches.length ? [`... ${total - matches.length} more match; use a more specific keyword.`] : []),
    ].join("\n")
  }
  const ordered = orderSkills(skills)
  const shown = ordered.slice(0, NAME_LIMIT).map(label)
  const rest = ordered.length - shown.length
  return [
    head,
    `No skill matches that keyword. ${rest > 0 ? "First" : "Available"} skills: ${shown.join(", ") || "none"}${rest > 0 ? `, and ${rest} more` : ""}.`,
  ].join("\n")
}

/**
 * Configuration switch. The environment variable wins over the config file; `fallback` applies when
 * neither is set.
 */
export function switchEnabled(envKey: string, configured: boolean | undefined, fallback: boolean): boolean {
  const raw = process.env[envKey]?.toLowerCase()
  if (raw === "1" || raw === "true") return true
  if (raw === "0" || raw === "false") return false
  return configured ?? fallback
}

/** Default for the bounded listing. */
export const BOUNDED_SKILL_LISTING_DEFAULT = true

export function boundedSkillListingEnabled(configured: boolean | undefined): boolean {
  return switchEnabled("ALTIMATE_BOUNDED_SKILL_LISTING", configured, BOUNDED_SKILL_LISTING_DEFAULT)
}

export * as SkillListing from "./skill-listing"
