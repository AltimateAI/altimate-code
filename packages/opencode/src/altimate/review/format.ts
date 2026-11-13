import { type Finding, type Severity } from "./finding"
import { type VerdictEnvelope } from "./verdict"

/**
 * Render a verdict envelope for humans (PR summary markdown) and for the VCS
 * inline-comment API. Kept separate from the engine so posting surfaces
 * (GitHub/GitLab/TUI) share one renderer.
 */

export const REVIEW_MARKER = "<!-- altimate-code-review -->"

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: "🛑",
  warning: "⚠️",
  suggestion: "💡",
}

const VERDICT_LABEL: Record<VerdictEnvelope["verdict"], string> = {
  APPROVE: "✅ Approved",
  COMMENT: "💬 Reviewed with comments",
  REQUEST_CHANGES: "🛑 Changes requested",
}

/** One-line headline used at the top of the summary and as the check title. */
export function verdictHeadline(env: VerdictEnvelope): string {
  const { critical, warning, suggestion } = env.summary
  const counts =
    [critical && `${critical} critical`, warning && `${warning} warning`, suggestion && `${suggestion} suggestion`]
      .filter(Boolean)
      .join(", ") || "no findings"
  // tierClassified is optional in the schema — guard against externally-built
  // envelopes that mark tierForced without threading the original classification.
  const tierLabel = env.tierForced
    ? `${env.tier} tier — forced (was ${env.tierClassified ?? "unknown"})`
    : `${env.tier} tier`
  return `${VERDICT_LABEL[env.verdict]} — ${counts} (${tierLabel})`
}

/** Default size budget for the posted PR comment (characters). */
export const SUMMARY_BUDGET_CHARS = 5_000
/** The same rule on this many models or more collapses into one bullet. */
export const GROUP_MIN = 3

export interface RenderOptions {
  /** Character budget for the comment; findings beyond it are counted, not listed.
   *  `Infinity` renders everything (local CLI output). */
  maxChars?: number
}

/** Full PR/MR summary comment body (markdown), prefixed with the dedup marker. */
export function renderSummary(env: VerdictEnvelope, opts: RenderOptions = {}): string {
  const maxChars = opts.maxChars ?? SUMMARY_BUDGET_CHARS
  const lines: string[] = [REVIEW_MARKER, "", `## ${verdictHeadline(env)}`, ""]

  if (env.summary.degraded) {
    lines.push(
      "> ⚙️ **Lint-only run** — no changed model resolved against a dbt manifest, so lineage, equivalence and",
      "> data-impact checks were skipped. Wire `manifest_path` (and optionally warehouse creds) for the full verdict.",
      "",
    )
  }
  lines.push(...coverageNotes(env))

  // G1 (Round 18) — surface classifier reasons when --explain-tier populated
  // them, so a customer can see why the review ran at this tier. Also surfaces
  // when --force-tier bypassed the classifier (tierReasons is auto-populated).
  // Truncate the rendered summary on very large diffs: classifyPR appends one
  // reason per file forcing FULL tier (e.g. every touched schema.yml or every
  // PII column), which bloats the comment on wide PRs. The full list stays in
  // the signed envelope's tierReasons[]; the summary shows the first 8.
  if (env.tierReasons && env.tierReasons.length) {
    const RENDER_CAP = 8
    // Pick an inline-code-span fence longer than any backtick run inside `r`
    // so a path like `packages/…/foo`bar`.sql` cannot terminate the span
    // (cubic-review P3).
    const shown = env.tierReasons
      .slice(0, RENDER_CAP)
      .map((r) => {
        const runs = r.match(/`+/g)
        const maxRun = runs ? Math.max(...runs.map((run) => run.length)) : 0
        const fence = "`".repeat(maxRun + 1)
        // If the reason itself starts/ends with a backtick, pad with a space so
        // the leading/trailing backtick isn't glued to the fence.
        const pad = /^`|`$/.test(r) ? " " : ""
        return `${fence}${pad}${r}${pad}${fence}`
      })
      .join(", ")
    const overflow =
      env.tierReasons.length > RENDER_CAP
        ? ` (+${env.tierReasons.length - RENDER_CAP} more in verdict envelope)`
        : ""
    lines.push(`> 🧭 **Tier: ${env.tier}** — ${shown}${overflow}`, "")
  }

  const tail: string[] = []
  if (env.override) {
    tail.push(
      `> 🔓 **Break-glass override** by @${env.override.by}: ${env.override.reason}`,
      `> (would have been \`${env.override.priorVerdict}\`)`,
      "",
    )
  }
  tail.push(
    "---",
    `<sub>altimate dbt-pr-review · verdict \`${env.verdict}\`` +
      (env.signature ? ` · signed \`${env.signature.slice(0, 18)}…\`` : "") +
      (env.manifestHash ? ` · manifest \`${env.manifestHash.slice(0, 10)}\`` : "") +
      (env.scope?.baseRef ? ` · base \`${env.scope.baseRef}\`` : "") +
      (env.ai?.state === "ok" && env.ai.model ? ` · AI \`${env.ai.model}\`` : "") +
      "</sub>",
  )

  if (!env.findings.length) {
    lines.push("No issues found in the changed dbt models. 🎉", "")
    return [...lines, ...tail].join("\n")
  }

  // Findings fill the budget left after the fixed parts, most severe first.
  // What does not fit is counted, never silently dropped: the envelope keeps
  // every finding.
  const overflowReserve = 220
  let used = [...lines, ...tail].join("\n").length + overflowReserve
  let hidden = 0
  const grouped = groupBySeverity(env.findings)
  for (const sev of ["critical", "warning", "suggestion"] as const) {
    const items = grouped[sev]
    if (!items.length) continue
    const heading = [`### ${SEVERITY_EMOJI[sev]} ${capitalize(sev)} (${items.length})`, ""]
    const bullets = bulletsFor(items)
    let headed = false
    for (const b of bullets) {
      const cost = b.text.length + 1 + (headed ? 0 : heading.join("\n").length + 2)
      if (used + cost > maxChars) {
        hidden += b.count
        continue
      }
      if (!headed) {
        lines.push(...heading)
        headed = true
      }
      lines.push(b.text)
      used += cost
    }
    if (headed) lines.push("")
  }
  if (hidden) {
    lines.push(
      `> … ${hidden} more finding(s) not shown to keep this comment short — the full list is in the verdict envelope ` +
        "(`altimate review --json`, or the action's `--output` artifact).",
      "",
    )
  }
  return [...lines, ...tail].join("\n")
}

/** A finding's title without its leading `model: `, with backticked names
 *  blanked, so the same rule on different models/columns shares a key. */
function ruleTitle(f: Finding): string {
  const t = f.model && f.title.startsWith(`${f.model}: `) ? f.title.slice(f.model.length + 2) : f.title
  return t.replace(/`[^`]*`/g, "`…`")
}

/** Render findings of one severity as bullets; a rule repeated on GROUP_MIN or
 *  more models collapses into a single bullet listing the models. */
function bulletsFor(items: Finding[]): Array<{ text: string; count: number }> {
  const groups = new Map<string, Finding[]>()
  for (const f of items) {
    const key = `${f.category}|${ruleTitle(f)}`
    const g = groups.get(key)
    if (g) g.push(f)
    else groups.set(key, [f])
  }
  const out: Array<{ text: string; count: number }> = []
  for (const g of groups.values()) {
    if (g.length >= GROUP_MIN) {
      const names = [...new Set(g.map((f) => f.model ?? f.file))]
      const shown = names.slice(0, 8).map((n) => `\`${n}\``).join(", ")
      const more = names.length > 8 ? ` (+${names.length - 8} more)` : ""
      out.push({
        text:
          `- **${ruleTitle(g[0])}** — ${g.length} findings across ${names.length} model(s): ${shown}${more}  \n` +
          `  ${oneLine(g[0].body)}  \n  <sub>${g[0].category}</sub>`,
        count: g.length,
      })
      continue
    }
    for (const f of g) {
      const loc = f.file + (f.startLine ? `:${f.startLine}` : "")
      out.push({
        text: `- **${f.title}**  \n  ${oneLine(f.body)}  \n  <sub>\`${loc}\`${f.degraded ? " · _unverified_" : ""} · ${f.category}</sub>`,
        count: 1,
      })
    }
  }
  return out
}

/**
 * What the review could not fully check, each on its own line: undecidable
 * findings, models without compiled SQL, files outside the dbt project, and
 * the advisory AI lane when it did not run. Kept separate from the lint-only
 * banner so one undecidable finding never mislabels a manifest-backed run.
 */
export function coverageNotes(env: VerdictEnvelope): string[] {
  const notes: string[] = []
  const undecided = env.findings.filter((f) => f.degraded).length
  if (undecided) notes.push(`${undecided} finding(s) could not be decided by the engine and are marked _unverified_.`)
  const unverified = env.scope?.unverified ?? []
  const byReason = new Map<string, string[]>()
  for (const u of unverified) byReason.set(u.reason, [...(byReason.get(u.reason) ?? []), u.path])
  for (const [reason, paths] of byReason) {
    const head = paths.slice(0, 5).map((p) => `\`${p}\``).join(", ")
    const more = paths.length > 5 ? ` and ${paths.length - 5} more` : ""
    const hint = /compiled SQL/.test(reason)
      ? " Run `dbt compile` (and compile the base into `target-base/`) for equivalence and lineage checks."
      : ""
    notes.push(`${paths.length} model(s) not fully verified — ${reason}: ${head}${more}.${hint}`)
  }
  if (env.engineErrors?.length) {
    const list = env.engineErrors.map((e) => `${e.method} ×${e.count} (${e.reason})`).join("; ")
    notes.push(`Some engine checks failed and did not run: ${list}. This verdict is not a clean approval.`)
  }
  if (env.scope?.outOfScopeFiles)
    notes.push(`${env.scope.outOfScopeFiles} changed file(s) outside the dbt project were not reviewed.`)
  if (env.scope?.movedUnchangedFiles)
    notes.push(
      `${env.scope.movedUnchangedFiles} file(s) moved without edits; their SQL was not re-reviewed. ` +
        "Folder-level config in `dbt_project.yml` (`+schema`, `+materialized`, `+tags`) can still change where and how a moved model builds.",
    )
  if (env.policy?.changedInPr?.length) {
    notes.push(
      `This PR changes the review policy (\`.altimate/review.yml\`: ${env.policy.changedInPr.join(", ")}). ` +
        "The base branch's policy was applied; the change takes effect after merge.",
    )
  }
  if (env.ai && env.ai.state !== "ok") {
    const what = { skipped: "skipped", timeout: "timed out", error: "failed" }[env.ai.state]
    notes.push(`Advisory AI review ${what}${env.ai.reason ? `: ${env.ai.reason}` : ""}.`)
  }
  return notes.length ? [...notes.map((n) => `> ℹ️ ${n}`), ""] : []
}

/** GitHub `pulls.createReview` inline comments — only findings with a line. */
export interface InlineComment {
  path: string
  line: number
  side: "RIGHT"
  body: string
}

/** Hidden per-finding marker on inline comments, keyed by the finding's stable
 *  fingerprint (rule, file, model, column — not the line), so a rerun can tell
 *  which findings are already on the PR. */
export function findingMarker(id: string): string {
  return `<!-- altimate-finding:${id} -->`
}

/** Finding ids already posted, read from existing inline comment bodies. */
export function postedFindingIds(bodies: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>()
  for (const b of bodies) for (const m of (b ?? "").matchAll(/<!-- altimate-finding:([\w-]+) -->/g)) out.add(m[1])
  return out
}

export function inlineComments(env: VerdictEnvelope, alreadyPosted: Set<string> = new Set()): InlineComment[] {
  return env.findings
    .filter((f) => typeof f.startLine === "number" && !alreadyPosted.has(f.id))
    .map((f) => ({
      path: f.file,
      line: f.startLine!,
      side: "RIGHT" as const,
      body: `${SEVERITY_EMOJI[f.severity]} **${f.title}**\n\n${f.body}\n\n${findingMarker(f.id)}`,
    }))
}

function groupBySeverity(findings: Finding[]): Record<Severity, Finding[]> {
  const out: Record<Severity, Finding[]> = { critical: [], warning: [], suggestion: [] }
  for (const f of findings) out[f.severity].push(f)
  return out
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim()
}
