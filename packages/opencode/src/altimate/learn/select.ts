// altimate_change - new file
import { anchors } from "./anchors"
import type { Lesson } from "./lesson"

export interface Limits {
  core_lessons: number
  retrieved_lessons: number
  request_lessons: number
  file_lessons: number
  budget_tokens: number
  session_max_lessons: number
}

export const DEFAULT_LIMITS: Readonly<Limits> = {
  core_lessons: 15,
  retrieved_lessons: 15,
  request_lessons: 5,
  file_lessons: 5,
  budget_tokens: 1500,
  session_max_lessons: 40,
}

/** Zero disables a tier/budget. Environment overrides config, which overrides defaults. */
export function resolveLimits(config: Partial<Limits> = {}, env: NodeJS.ProcessEnv = process.env): Limits {
  const limits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(limits) as (keyof Limits)[]) {
    const variable = `ALTIMATE_LEARN_${key.toUpperCase()}`
    const override = env[variable]?.trim()
    const value = override ? Number(override) : (config[key] ?? limits[key])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`learn.${key} / ${variable} must be a nonnegative safe integer.`)
    limits[key] = value
  }
  return limits
}

/** File delivery is enabled by default; environment overrides config in both directions. */
export function fileHookEnabled(config?: { file_hook?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env["ALTIMATE_LEARN_FILE_HOOK"]?.trim().toLowerCase()
  if (value === "0" || value === "false") return false
  if (value === "1" || value === "true") return true
  return config?.file_hook ?? true
}

/** Identifier boundaries are searchable; keep underscore affixes as well as their component words. */
export function tokenize(text: string): string[] {
  const result: string[] = []
  for (const match of text.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const identifier = match[0].toLowerCase()
    const words = match[0]
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .toLowerCase()
      .split(/[_\s]+/)
      .filter(Boolean)
    if (!words.length) continue
    const tokens = new Set([identifier, ...words])
    // `amount_cents` matches both `amount` and an explicit `_cents` suffix rule.
    for (let i = 0; i < identifier.length; i++) {
      if (identifier[i] !== "_") continue
      if (i > 0) tokens.add(identifier.slice(0, i + 1))
      if (i < identifier.length - 1) tokens.add(identifier.slice(i))
    }
    result.push(...tokens)
  }
  return result
}

const compareID = (a: Lesson, b: Lesson) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export function core(lessons: readonly Lesson[], limit: number): Lesson[] {
  return [...lessons]
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) ||
      (b.helpful - b.harmful) - (a.helpful - a.harmful) || compareID(a, b))
    .slice(0, Math.max(0, limit))
}

export const MINIMUM_SCORE = 0.1

/** Local Okapi BM25 (k1=1.2, b=0.75), over the full approved corpus for stable scores. */
export function retrieve(
  lessons: readonly Lesson[],
  query: string,
  options: { limit: number; exclude?: Iterable<string>; minimumScore?: number },
): Lesson[] {
  const terms = [...new Set(tokenize(query))]
  if (!terms.length || !lessons.length || options.limit <= 0) return []
  const documents = lessons.map((lesson) => {
    const words = tokenize([lesson.text, ...lesson.tags, ...(lesson.trigger?.paths ?? [])].join(" "))
    const counts = new Map<string, number>()
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
    return { lesson, length: words.length, counts }
  })
  const average = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1
  const frequencies = new Map(terms.map((term) => [term, documents.filter((document) => document.counts.has(term)).length]))
  const excluded = new Set(options.exclude)
  const scored = documents.filter(({ lesson }) => !excluded.has(lesson.id)).map(({ lesson, length, counts }) => {
    let score = 0
    for (const term of terms) {
      const count = counts.get(term) ?? 0
      if (!count) continue
      const frequency = frequencies.get(term)!
      const idf = Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))
      score += idf * (count * 2.2) / (count + 1.2 * (0.25 + 0.75 * length / average))
    }
    return { lesson, score }
  })
  return scored
    .filter(({ score }) => score > (options.minimumScore ?? MINIMUM_SCORE))
    .sort((a, b) => b.score - a.score || compareID(a.lesson, b.lesson))
    .slice(0, options.limit)
    .map(({ lesson }) => lesson)
}

export function lessonLine(lesson: Pick<Lesson, "text">): string {
  return lesson.text.replace(/\s+/g, " ").trim()
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Include only complete lesson lines; the heading and newlines count against the budget. */
export function renderSection(lessons: readonly Lesson[], budgetTokens: number): { section: string; lessons: Lesson[] } {
  let section = ""
  const included: Lesson[] = []
  for (const lesson of lessons) {
    const line = lessonLine(lesson)
    if (!line) continue
    const next = `${section || "## Team rules"}\n${line}`
    if (estimateTokens(next) > budgetTokens) continue
    section = next
    included.push(lesson)
  }
  return { section, lessons: included }
}

export interface SelectedLesson {
  lesson: Lesson
  tier: "core" | "retrieved"
}

export function selectStart(lessons: readonly Lesson[], query: string, limits: Limits): {
  section: string
  lessons: SelectedLesson[]
} {
  const selectedCore = core(lessons, limits.core_lessons)
  const retrieved = retrieve(lessons, query, {
    limit: limits.retrieved_lessons,
    exclude: selectedCore.map((lesson) => lesson.id),
  })
  const selected: SelectedLesson[] = [
    ...selectedCore.map((lesson) => ({ lesson, tier: "core" as const })),
    ...retrieved.map((lesson) => ({ lesson, tier: "retrieved" as const })),
  ]
  const rendered = renderSection(selected.map(({ lesson }) => lesson), limits.budget_tokens)
  const shown = new Set(rendered.lessons.slice(0, limits.session_max_lessons).map((lesson) => lesson.id))
  return {
    section: renderSection(rendered.lessons.filter((lesson) => shown.has(lesson.id)), limits.budget_tokens).section,
    lessons: selected.filter(({ lesson }) => shown.has(lesson.id)),
  }
}

/** The caller supplies a project-relative path; this function never reads the filesystem. */
export function matchesFile(lesson: Lesson, file: string): boolean {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "")
  if (lesson.trigger?.paths?.some((pattern) => new Bun.Glob(pattern.replace(/\\/g, "/").replace(/^\.\//, "")).match(normalized)))
    return true
  const identifiers = tokenize(normalized)
  for (const anchor of anchors(lesson.text)) {
    if (identifiers.some((identifier) => identifier === anchor ||
      (anchor.startsWith("_") && identifier.endsWith(anchor)) ||
      (anchor.endsWith("_") && identifier.startsWith(anchor)))) return true
  }
  return false
}
