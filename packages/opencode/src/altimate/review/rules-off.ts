// altimate_change - new file: rule types not posted once the AI lane runs
//
// `NOISY_RULES_OFF` lists rule ids (`Finding.rule`) whose findings were almost never real
// defects when judged on replayed public dbt PRs, with the AI lane reviewing the same PRs.
// When the AI lane runs and answers, rule findings with one of these ids are dropped before
// the rule verifier and before posting, and counted per rule on the envelope (`rulesOff`).
// AI findings and `critical` rule findings are never dropped (`classify-pii:exposes` is
// critical for a new high-confidence PII column in a mart), and the finder's grounding is
// left as it is. With the AI lane off, skipped or failed nothing changes (fail-open).
// `ai.rulesOff: false` or `ALTIMATE_REVIEW_RULES_OFF=0|off|false` keeps every type;
// `ai.rulesOn: [ids]` keeps single types; `ALTIMATE_REVIEW_RULES_OFF=<path>` replaces the
// list with a JSON list of rule ids. Rule ids compare in one spelling (`normalizeRuleId`).
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative } from "node:path"
import { type Finding, findingOrigin, normalizeRuleId } from "./finding"
import type { ReviewConfig } from "./config"
import type { AiSwitches } from "./ai-switches"

/**
 * `ALTIMATE_REVIEW_RULES_OFF` read: `1`/`on`/`true` and `0`/`off`/`false` (any case) set the
 * switch; a value that looks like a path (has a slash or backslash, or ends in `.json`) names a list
 * file and turns it on; anything else is ignored, so a natural spelling never reaches the
 * file system.
 */
export function rulesOffEnv(v: string | undefined): { on?: boolean; file?: string } {
  const t = v?.trim()
  if (!t) return {}
  if (/^(1|on|true)$/i.test(t)) return { on: true }
  if (/^(0|off|false)$/i.test(t)) return { on: false }
  if (/[\\/]/.test(t) || /\.json$/i.test(t)) return { on: true, file: t }
  return {}
}

/** The git work tree containing `dir` (the nearest ancestor with a `.git` entry), realpath'd; undefined outside one. */
function workTreeOf(dir: string): string | undefined {
  let d: string
  try {
    d = realpathSync(dir)
  } catch {
    return undefined
  }
  for (;;) {
    if (existsSync(join(d, ".git"))) return d
    const up = dirname(d)
    if (up === d) return undefined
    d = up
  }
}

function isInsideDir(p: string, dir: string): boolean {
  const rel = relative(dir, p)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export const NOISY_RULES_OFF: readonly string[] = [
  "altimate-core.classify-pii:exposes",
  "altimate-core.lexical:op-json-arrow1",
  "altimate-core.lexical:op-pg-cast",
  "altimate-core.structural-diff:removed-predicate",
  "altimate-core.structural-diff:union-added",
  "dbt-patterns:hardcoded-date",
  "dbt-patterns:leading-wildcard",
  "dbt-patterns:multi-count-distinct",
  "dbt-patterns:partition-function",
  "dbt-patterns:self-join",
  "rule-catalog:adapter-call",
  "rule-catalog:bq-datetime-vs-timestamp",
  "rule-catalog:cast-chain",
  "rule-catalog:count-distinct-large",
  "rule-catalog:count-star-with-left-join",
  "rule-catalog:dateadd-from-now",
  "rule-catalog:datediff-arg-order",
  "rule-catalog:distinct-and-group-by",
  "rule-catalog:full-outer-join",
  "rule-catalog:hardcoded-year-filter",
  "rule-catalog:join-on-cast",
  "rule-catalog:lateral-join",
  "rule-catalog:multiple-left-joins",
  "rule-catalog:nested-case",
  "rule-catalog:now-in-filter",
  "rule-catalog:ref-to-source-table",
  "rule-catalog:regexp-heavy",
  "rule-catalog:select-now-column",
  "rule-catalog:select-pii-columns",
  "rule-catalog:select-star-in-cte-final",
  "rule-catalog:staging-as-table",
  "rule-catalog:union-not-all",
  "rule-catalog:union-select-star",
  "rule-catalog:unqualified-column-multi-table",
  "rule-catalog:where-1-eq-1",
  "rule-catalog:where-cast-column",
]

/**
 * The rule ids to drop for this review, or undefined when the switch is off. A list file
 * named by `ALTIMATE_REVIEW_RULES_OFF` replaces the shipped list (an unreadable or malformed
 * file is an error); `ai.rulesOn` takes ids back out.
 */
export function resolveRulesOff(
  cfg: Pick<ReviewConfig, "ai">,
  switches: Pick<AiSwitches, "rulesOff">,
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): Set<string> | undefined {
  if (!switches.rulesOff) return undefined
  const { file } = rulesOffEnv(env.ALTIMATE_REVIEW_RULES_OFF)
  let list: readonly string[] = NOISY_RULES_OFF
  if (file) {
    // The list decides which rule findings are posted: a file in the PR checkout would let a PR choose.
    if (!isAbsolute(file)) throw new Error("ALTIMATE_REVIEW_RULES_OFF must name an absolute path outside the repository")
    const tree = workTreeOf(cwd)
    const real = (() => {
      try {
        return realpathSync(file)
      } catch {
        return file
      }
    })()
    if (tree && isInsideDir(real, tree))
      throw new Error(`ALTIMATE_REVIEW_RULES_OFF: the rule list ${file} is inside the git work tree; place it outside the checkout`)
    // Synchronous: read once per review, before it starts, from a synchronous resolver; a small local file.
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"))
    } catch (e) {
      const why = (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "file not found" : e instanceof Error ? e.message : String(e)
      throw new Error(`ALTIMATE_REVIEW_RULES_OFF: cannot read the rule list ${file}: ${why}`)
    }
    if (!Array.isArray(parsed) || parsed.some((r) => typeof r !== "string"))
      throw new Error(`ALTIMATE_REVIEW_RULES_OFF must name a JSON list of rule ids: ${file}`)
    list = parsed as string[]
  }
  const on = new Set((typeof cfg.ai === "object" ? (cfg.ai.rulesOn ?? []) : []).map(normalizeRuleId))
  return new Set(list.map(normalizeRuleId).filter((r) => !on.has(r)))
}

/**
 * `findings` without the rule findings whose rule id is in `off`, and how many each rule lost.
 * AI findings and `critical` rule findings are always kept.
 */
export function dropRulesOff(findings: Finding[], off: Set<string> | undefined): { kept: Finding[]; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {}
  if (!off?.size) return { kept: findings, dropped }
  const ids = new Set([...off].map(normalizeRuleId))
  const kept = findings.filter((f) => {
    if (!f.rule || findingOrigin(f) === "ai" || f.severity === "critical") return true
    const rule = normalizeRuleId(f.rule)
    if (!ids.has(rule)) return true
    dropped[rule] = (dropped[rule] ?? 0) + 1
    return false
  })
  return { kept, dropped }
}
