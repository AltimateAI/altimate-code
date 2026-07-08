import YAML from "yaml"
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
  const proposedTests = env.findings.filter(isProposedTest)
  const regularFindings = env.findings.filter((f) => !isProposedTest(f))

  if (env.summary.degraded) {
    lines.push(
      "> ⚙️ **Lint-only run** — no dbt manifest/warehouse was available, so lineage, equivalence and",
      "> data-impact checks were skipped. Wire `manifest_path` (and optionally warehouse creds) for the full verdict.",
      "",
    )
  }
  if (env.summary.enforcedConstraints) {
    const c = env.summary.enforcedConstraints
    lines.push(`**Spec coverage:** ${c.executed} executed / ${c.passed} passed / ${c.failed} failed.`, "")
  }

  if (!env.findings.length) {
    lines.push("No issues found in the changed dbt models. 🎉", "")
  } else {
    const grouped = groupBySeverity(regularFindings)
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
    if (proposedTests.length) renderProposedTests(lines, proposedTests)
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

function isProposedTest(f: Finding): boolean {
  return f.evidence?.tool === "altimate.spec_test.proposed"
}

function renderProposedTests(lines: string[], findings: Finding[]): void {
  lines.push("### Proposed tests", "")
  lines.push("Candidate tests to consider adding; this review did not execute them.", "")
  for (const f of findings) {
    const loc = f.file + (f.startLine ? `:${f.startLine}` : "")
    const ref = String((f.evidence?.result as any)?.proposal?.derivedFrom?.ref ?? "")
    lines.push(
      `- **${f.title}**  \n  ${oneLine(stripYamlFence(f.body))}  \n  <sub>\`${loc}\`${ref ? ` · \`${ref}\`` : ""}</sub>`,
    )
  }
  const patch = proposedTestsPatch(findings)
  if (patch) {
    lines.push("", "```yaml", patch, "```")
  }
  lines.push("")
}

function stripYamlFence(body: string): string {
  return body.replace(/```yaml[\s\S]*?```/g, "").trim()
}

function yamlFences(body: string): string[] {
  return [...body.matchAll(/```yaml\s*([\s\S]*?)```/g)].map((m) => m[1].trim()).filter(Boolean)
}

function proposedTestsPatch(findings: Finding[]): string {
  const merged = new Map<string, any>()
  for (const f of findings) {
    for (const yaml of yamlFences(f.body)) {
      try {
        const doc = YAML.parse(yaml)
        for (const rawModel of Array.isArray(doc?.models) ? doc.models : []) {
          const modelName = typeof rawModel?.name === "string" ? rawModel.name : ""
          if (!modelName) continue
          const target = merged.get(modelName) ?? { name: modelName }
          mergeTests(target, rawModel)
          mergeColumns(target, rawModel)
          merged.set(modelName, target)
        }
      } catch {
        // Bodies are generated locally; if one is malformed, omit it from the
        // aggregate patch instead of breaking PR summary rendering.
      }
    }
  }
  if (!merged.size) return ""
  return YAML.stringify({ version: 2, models: [...merged.values()] }).trim()
}

function mergeTests(target: any, source: any): void {
  if (!Array.isArray(source?.tests)) return
  target.tests = target.tests ?? []
  for (const test of source.tests) pushUnique(target.tests, test)
}

function mergeColumns(target: any, source: any): void {
  if (!Array.isArray(source?.columns)) return
  target.columns = target.columns ?? []
  for (const rawColumn of source.columns) {
    const name = typeof rawColumn?.name === "string" ? rawColumn.name : ""
    if (!name) continue
    let column = target.columns.find((c: any) => c.name === name)
    if (!column) {
      column = { name }
      target.columns.push(column)
    }
    if (!Array.isArray(rawColumn.tests)) continue
    column.tests = column.tests ?? []
    for (const test of rawColumn.tests) pushUnique(column.tests, test)
  }
}

function pushUnique(items: any[], value: any): void {
  const key = JSON.stringify(value)
  if (!items.some((item) => JSON.stringify(item) === key)) items.push(value)
}
