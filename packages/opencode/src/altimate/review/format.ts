import { type Finding, type Severity } from "./finding"
import { type VerdictEnvelope } from "./verdict"

/**
 * Render a verdict envelope for humans (PR summary markdown) and for the VCS
 * inline-comment API. Kept separate from the engine so posting surfaces
 * (GitHub/GitLab/TUI) share one renderer.
 */

export const REVIEW_MARKER = "<!-- altimate-code-review -->"

export interface FindingDelta {
  noLongerSurfaced: number
  new: number
  unchanged: number
  reviewSettingsChanged?: boolean
  analysisScopeChanged?: { from: VerdictEnvelope["tier"]; to: VerdictEnvelope["tier"] }
}

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

function codeSpan(value: string): string {
  const runs = value.match(/`+/g)
  const maxRun = runs ? Math.max(...runs.map((run) => run.length)) : 0
  const fence = "`".repeat(maxRun + 1)
  const pad = /^`|`$/.test(value) ? " " : ""
  return `${fence}${pad}${value}${pad}${fence}`
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
export function renderSummary(env: VerdictEnvelope, delta?: FindingDelta): string {
  const lines: string[] = [REVIEW_MARKER, "", `## ${verdictHeadline(env)}`, ""]

  if (delta) {
    const changeNote = delta.reviewSettingsChanged
      ? " (review settings changed)"
      : delta.analysisScopeChanged
        ? ` (analysis scope changed: ${delta.analysisScopeChanged.from} → ${delta.analysisScopeChanged.to})`
        : ""
    lines.push(
      `**Since last review:** ${delta.noLongerSurfaced} no longer surfaced · ${delta.new} new · ${delta.unchanged} unchanged` +
        changeNote,
      "",
    )
  }

  const readFirst = selectReadFirst(env.findings)
  if (readFirst.length) {
    lines.push("**Read first**", "")
    for (const finding of readFirst) {
      lines.push(`- **${finding.title}** <sub>${codeSpan(finding.file)}</sub>`)
    }
    lines.push("")
  }

  if (env.summary.lintOnly ?? env.summary.degraded) {
    lines.push(
      "> ⚙️ Lint-only run — no changed model resolved against a dbt manifest (missing manifest, or the changed models are not in it). Run `dbt compile` on this branch so lineage/equivalence can run.",
      "",
    )
  }

  if (env.summary.emptyScope) {
    if (
      env.summary.emptyScopeReason === "all_excluded" &&
      env.summary.emptyScopeFileCount !== undefined
    ) {
      lines.push(
        `> ⚙️ Nothing to review — all ${env.summary.emptyScopeFileCount} changed dbt files are excluded by the review configuration (\`exclude\` globs)`,
        "",
      )
    } else {
      lines.push("> ⚙️ Nothing to review — no dbt model, schema, or macro files changed in this diff.", "")
    }
  }

  const undecidableFindings =
    env.summary.undecidableFindings ?? env.findings.filter((finding) => finding.degraded).length
  if (undecidableFindings > 0) {
    lines.push(
      `> ℹ️ ${undecidableFindings} finding${undecidableFindings === 1 ? "" : "s"} could not be decided — compiled SQL missing for base or head, unsupported SQL for this dialect, or no schema — see each finding.`,
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
    const shown = env.tierReasons.slice(0, RENDER_CAP).map(codeSpan).join(", ")
    const overflow =
      env.tierReasons.length > RENDER_CAP
        ? ` (+${env.tierReasons.length - RENDER_CAP} more in verdict envelope)`
        : ""
    lines.push(`> 🧭 **Tier: ${env.tier}** — ${shown}${overflow}`, "")
  }

  if (!env.findings.length && !env.summary.emptyScope) {
    lines.push("No issues found in the changed dbt models. 🎉", "")
  } else {
    const grouped = groupBySeverity(env.findings)
    for (const sev of ["critical", "warning", "suggestion"] as const) {
      const items = grouped[sev]
      if (!items.length) continue
      const summaryGroups = groupForSummary(items)
      const sectionCount =
        summaryGroups.length === items.length
          ? `${items.length}`
          : `${items.length} findings · ${summaryGroups.length} items`
      lines.push(`### ${SEVERITY_EMOJI[sev]} ${capitalize(sev)} (${sectionCount})`, "")

      const renderedItems = summaryGroups.map((group) => renderSummaryGroup(group, env.summary.artifactHints))
      const fold = sev !== "critical" && renderedItems.length > 12
      lines.push(...renderedItems.slice(0, fold ? 12 : renderedItems.length))
      if (fold) {
        const remainder = renderedItems.slice(12)
        lines.push("", "<details>", `<summary>${remainder.length} more …</summary>`, "", ...remainder, "", "</details>")
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

  if (env.summary.aiReview) {
    const ai = env.summary.aiReview
    // Name the model on every status so a reader can tell which model ran, timed out or failed.
    const model = ai.model ? ` (${ai.model})` : ""
    const duration = ai.durationMs === undefined ? "" : ` · ${Math.round(ai.durationMs / 1_000)}s`
    if (ai.status === "ok") {
      lines.push(
        `🤖 AI reviewer${model}: ${ai.findings} advisory finding${ai.findings === 1 ? "" : "s"}${duration}`,
        "",
      )
    } else if (ai.status === "skipped") {
      lines.push(`🤖 AI reviewer${model}: skipped${ai.reason ? ` — ${ai.reason}` : ""}${duration}`, "")
    } else if (ai.status === "timeout") {
      lines.push(`🤖 AI reviewer${model}: ${ai.reason ?? "timed out"}${duration}`, "")
    } else {
      lines.push(`🤖 AI reviewer${model}: error${ai.reason ? ` — ${ai.reason}` : ""}${duration}`, "")
    }
  }

  lines.push(
    "---",
    `<sub>altimate dbt-pr-review · verdict \`${env.verdict}\`` +
      (env.signature ? ` · signed \`${env.signature.slice(0, 18)}…\`` : "") +
      (env.manifestHash ? ` · manifest \`${env.manifestHash.slice(0, 10)}\`` : "") +
      "</sub>",
    "",
    `<!-- altimate-tier: ${env.tier} -->`,
    ...(env.policySignature ? [`<!-- altimate-policy: ${env.policySignature} -->`] : []),
    `<!-- altimate-findings: ${env.findings.map((finding) => finding.id).join(",")} -->`,
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

function selectReadFirst(findings: Finding[]): Finding[] {
  if (findings.length < 8) return []

  const selected: Finding[] = []
  const selectedIds = new Set<string>()
  const add = (finding: Finding) => {
    if (selected.length < 3 && !selectedIds.has(finding.id)) {
      selected.push(finding)
      selectedIds.add(finding.id)
    }
  }

  for (const finding of findings) if (finding.severity === "critical") add(finding)
  for (const finding of findings) if (finding.evidence?.tool === "ai-review") add(finding)

  const repetitiveWarningIds = new Set(
    groupForSummary(findings.filter((finding) => finding.severity === "warning"))
      .filter((group) => group.length >= 3)
      .flatMap((group) => group.map((finding) => finding.id)),
  )
  for (const finding of findings) {
    if (finding.severity === "warning" && finding.confidence === "high" && !repetitiveWarningIds.has(finding.id)) {
      add(finding)
    }
  }
  return selected
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

function renderSummaryGroup(findings: Finding[], artifactHints?: string[]): string {
  if (findings.length > 1) return renderGroupedFinding(findings, artifactHints)
  const finding = findings[0]
  const loc = finding.file + (finding.startLine ? `:${finding.startLine}` : "")
  return (
    `- **${finding.title}**  \n  ${oneLine(finding.body)}  \n  ` +
    `<sub>${codeSpan(loc)}${finding.degraded ? " · _unverified_" : ""} · ${finding.category}</sub>`
  )
}

function renderGroupedFinding(findings: Finding[], artifactHints?: string[]): string {
  const subjects = findings.map((finding) => codeSpan(finding.model ?? finding.file)).join(", ")
  const categories = [...new Set(findings.map((finding) => finding.category))].join(", ")
  const files = [...new Set(findings.map((finding) => finding.file))]
  const locations = files.slice(0, 3).map(codeSpan).join(", ")
  const more = files.length > 3 ? ` · +${files.length - 3} more` : ""
  const unverified = findings.some((finding) => finding.degraded) ? " · _unverified_" : ""
  const metadata = `  \n  <sub>${locations}${more}${unverified}</sub>`

  if (findings[0].groupKey === "lineage_fanout") {
    const members = findings
      .map((finding) => {
        const subject = codeSpan(finding.model ?? finding.file)
        const result = finding.evidence?.result
        if (!result || typeof result !== "object") return subject
        const impact = result as Record<string, unknown>
        if (
          typeof impact.directCount !== "number" ||
          typeof impact.transitiveCount !== "number" ||
          typeof impact.testCount !== "number"
        ) {
          return subject
        }
        return `${subject} (${impact.directCount} direct/${impact.transitiveCount} transitive, +${impact.testCount} tests)`
      })
      .join(", ")
    return `- **Downstream fan-out on ${findings.length} models** (informational) — ${members}${metadata}`
  }

  if (findings[0].groupKey === "equivalence_undecided") {
    const flatBody = oneLine(findings[0].body)
    const cause = /equivalence could not be decided\s*\(([^)]+)\)/i.exec(flatBody)?.[1]?.trim() ?? flatBody
    const sentence = /[.!?]$/.test(cause) ? cause : `${cause}.`
    const remedy = artifactHints?.some((hint) => /\bcompiled\b/i.test(hint))
      ? "Fix once: compile base and head (see missing-artifact line)."
      : "Undecidable with the available artifacts — unsupported SQL for this dialect or missing schema; verify with a data-diff."
    return (
      `- **Equivalence could not be decided for ${findings.length} models** — ${sentence} ` +
      `${remedy} Models: ${subjects}${metadata}`
    )
  }

  if (findings[0].groupKey?.startsWith("grain_not_null:")) {
    const model = findings[0].model ?? findings[0].groupKey.slice("grain_not_null:".length)
    const columns = [
      ...new Set(findings.map((finding) => finding.column).filter((column): column is string => !!column)),
    ]
      .map(codeSpan)
      .join(", ")
    const flatBody = oneLine(findings[0].body)
    const remediationStart = flatBody.lastIndexOf(" Add ")
    let remediation =
      remediationStart >= 0
        ? flatBody.slice(remediationStart + 1)
        : "Add `not_null` coverage to each listed grain column."
    if (findings[0].column) remediation = remediation.replace(codeSpan(findings[0].column), "each listed column")
    return (
      `- **${codeSpan(model)}: grain columns without \`not_null\`** — ${columns || subjects} · ${categories}  \n  ` +
      remediation +
      metadata
    )
  }

  return `- **${groupedTitle(findings)}** — ${subjects} · ${categories}${metadata}`
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim()
}
