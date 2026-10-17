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
  // Project scope reviews the whole manifest rather than a diff; say so in the
  // headline so a reader never mistakes it for a PR verdict.
  const scopeLabel = env.scope === "project" ? "whole project" : tierLabel
  return `${VERDICT_LABEL[env.verdict]} — ${counts} (${scopeLabel})`
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

  // Lane report — only present in project scope. It goes ABOVE the findings:
  // "no findings" means nothing until the reader knows which lanes produced it.
  if (env.lanes) {
    lines.push(
      `> 🛠️ **Project review** — every model in the manifest, no base ref.`,
      `> Lanes run: ${env.lanes.ran.length ? env.lanes.ran.map((l) => `\`${l}\``).join(", ") : "_none_"}`,
      "",
    )
    // The AST lanes are only as good as their input. `dbt compile` is the
    // customer's job, and when it hasn't run the engine silently returns zero
    // findings per unparseable model — which reads as "clean". Say so.
    const { compiledModels: compiled, totalModels: total } = env.lanes
    if (total > 0 && compiled < total) {
      lines.push(
        `> ⚠️ **${total - compiled} of ${total} models had no compiled SQL** — the engine analysed their raw Jinja,`,
        `> which the SQL parser cannot read, so the AST lanes (core lint, PII classification, grain,`,
        `> filter consistency) returned nothing for them. Run \`dbt compile\` and re-run for a complete review.`,
        "",
      )
    }
    if (env.lanes.skipped.length) {
      lines.push(`<details><summary>Lanes skipped (${env.lanes.skipped.length}) — why</summary>`, "")
      for (const s of env.lanes.skipped) lines.push(`- \`${s.lane}\` — ${s.reason}`)
      lines.push("", "</details>", "")
    }
  }

  if (!env.findings.length) {
    lines.push(
      env.scope === "project"
        ? "No issues found in any model in the manifest — within the lanes listed above. 🎉"
        : "No issues found in the changed dbt models. 🎉",
      "",
    )
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
