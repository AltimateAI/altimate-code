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

  if (env.summary.lintOnly ?? env.summary.degraded) {
    lines.push("> ⚙️ Lint-only run — no dbt manifest was found (run `dbt compile` so lineage/equivalence can run)", "")
  }

  const undecidableFindings =
    env.summary.undecidableFindings ?? env.findings.filter((finding) => finding.degraded).length
  if (undecidableFindings > 0) {
    lines.push(
      `> ℹ️ ${undecidableFindings} finding${undecidableFindings === 1 ? "" : "s"} could not be decided without compiled SQL for base and head — see each finding.`,
      "",
    )
  }

  if (env.summary.artifactHints?.length) {
    lines.push(
      `> 🧩 Missing artifacts: ${env.summary.artifactHints.join(" · ")} — equivalence and lineage run at reduced fidelity`,
      "",
    )
  }

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
      for (const summaryGroup of groupForSummary(items)) {
        if (summaryGroup.length > 1) {
          lines.push(renderGroupedFinding(summaryGroup))
          continue
        }
        const f = summaryGroup[0]
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

  if (env.tier !== "trivial" && env.summary.aiReview) {
    const ai = env.summary.aiReview
    if (ai.status === "ok") {
      lines.push(`🤖 AI reviewer: ${ai.findings} advisory finding${ai.findings === 1 ? "" : "s"}`, "")
    } else if (ai.status === "skipped") {
      lines.push(`🤖 AI reviewer: skipped${ai.reason ? ` — ${ai.reason}` : ""}`, "")
    } else if (ai.status === "timeout") {
      lines.push(`🤖 AI reviewer: ${ai.reason ?? "timed out"}`, "")
    } else {
      lines.push(`🤖 AI reviewer: error${ai.reason ? ` — ${ai.reason}` : ""}`, "")
    }
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

const MISSING_GRAIN_TITLE_FAMILY = "has no uniqueness/grain test"

function summaryGroupKey(finding: Finding): string | undefined {
  if (finding.groupKey) return `group:${finding.groupKey}`
  if (finding.title.toLowerCase().includes(MISSING_GRAIN_TITLE_FAMILY)) {
    return `title:${MISSING_GRAIN_TITLE_FAMILY}`
  }
  return undefined
}

/** Group only the human summary; the envelope and inline comments remain atomic. */
function groupForSummary(findings: Finding[]): Finding[][] {
  const groups: Finding[][] = []
  const groupIndexes = new Map<string, number>()
  for (const finding of findings) {
    const key = summaryGroupKey(finding)
    if (!key) {
      groups.push([finding])
      continue
    }
    const existing = groupIndexes.get(key)
    if (existing === undefined) {
      groupIndexes.set(key, groups.length)
      groups.push([finding])
    } else {
      groups[existing].push(finding)
    }
  }
  return groups
}

function titleFamily(finding: Finding): string {
  const modelPrefix = finding.model ? `${finding.model}: ` : ""
  return modelPrefix && finding.title.startsWith(modelPrefix)
    ? finding.title.slice(modelPrefix.length)
    : finding.title
}

function groupedTitle(findings: Finding[]): string {
  const family = titleFamily(findings[0])
  const newModel = /^new model has\s+(.+)$/i.exec(family)
  if (newModel) return `${findings.length} new models have ${newModel[1]}`
  return `${findings.length} findings: ${family}`
}

function renderGroupedFinding(findings: Finding[]): string {
  const subjects = findings.map((finding) => `\`${finding.model ?? finding.file}\``).join(", ")
  const categories = [...new Set(findings.map((finding) => finding.category))].join(", ")
  return `- **${groupedTitle(findings)}** — ${subjects} · ${categories}`
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim()
}
