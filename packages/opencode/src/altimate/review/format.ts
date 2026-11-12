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

/** Full PR/MR summary comment body (markdown), prefixed with the dedup marker. */
export function renderSummary(env: VerdictEnvelope): string {
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

  if (!env.findings.length) {
    lines.push("No issues found in the changed dbt models. 🎉", "")
  } else {
    const grouped = groupBySeverity(env.findings)
    for (const sev of ["critical", "warning", "suggestion"] as const) {
      const items = grouped[sev]
      if (!items.length) continue
      lines.push(`### ${SEVERITY_EMOJI[sev]} ${capitalize(sev)} (${items.length})`, "")
      for (const f of items) {
        const loc = f.file + (f.startLine ? `:${f.startLine}` : "")
        lines.push(
          `- **${f.title}**  \n  ${oneLine(f.body)}  \n  <sub>\`${loc}\`${f.degraded ? " · _unverified_" : ""} · ${f.category}</sub>`,
        )
      }
      lines.push("")
    }
  }

  if (env.override) {
    lines.push(
      `> 🔓 **Break-glass override** by @${env.override.by}: ${env.override.reason}`,
      `> (would have been \`${env.override.priorVerdict}\`)`,
      "",
    )
  }

  lines.push(
    "---",
    `<sub>altimate dbt-pr-review · verdict \`${env.verdict}\`` +
      (env.signature ? ` · signed \`${env.signature.slice(0, 18)}…\`` : "") +
      (env.manifestHash ? ` · manifest \`${env.manifestHash.slice(0, 10)}\`` : "") +
      (env.scope?.baseRef ? ` · base \`${env.scope.baseRef}\`` : "") +
      (env.ai?.state === "ok" && env.ai.model ? ` · AI \`${env.ai.model}\`` : "") +
      "</sub>",
  )
  return lines.join("\n")
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
  if (unverified.length) {
    const head = unverified.slice(0, 5).map((u) => `\`${u.path}\``).join(", ")
    const more = unverified.length > 5 ? ` and ${unverified.length - 5} more` : ""
    notes.push(
      `${unverified.length} model(s) not verified by the engine — ${unverified[0].reason}: ${head}${more}. ` +
        "Run `dbt compile` (and compile the base into `target-base/`) for equivalence and lineage checks.",
    )
  }
  if (env.scope?.outOfScopeFiles)
    notes.push(`${env.scope.outOfScopeFiles} changed file(s) outside the dbt project were not reviewed.`)
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

export function inlineComments(env: VerdictEnvelope): InlineComment[] {
  return env.findings
    .filter((f) => typeof f.startLine === "number")
    .map((f) => ({
      path: f.file,
      line: f.startLine!,
      side: "RIGHT" as const,
      body: `${SEVERITY_EMOJI[f.severity]} **${f.title}**\n\n${f.body}`,
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
