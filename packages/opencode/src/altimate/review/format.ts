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
  return `${VERDICT_LABEL[env.verdict]} — ${counts} (${env.tier} tier)`
}

/** Full PR/MR summary comment body (markdown), prefixed with the dedup marker. */
export function renderSummary(env: VerdictEnvelope): string {
  const lines: string[] = [REVIEW_MARKER, "", `## ${verdictHeadline(env)}`, ""]

  if (env.summary.degraded) {
    lines.push(
      "> ⚙️ **Lint-only run** — no dbt manifest/warehouse was available, so lineage, equivalence and",
      "> data-impact checks were skipped. Wire `manifest_path` (and optionally warehouse creds) for the full verdict.",
      "",
    )
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
      "</sub>",
  )
  return lines.join("\n")
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
