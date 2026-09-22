// altimate_change start — dbt-perf-helpers: pure normalization + text rendering
// for the deterministic `altimate dbt-perf` command. Exported separately from
// the command so they can be unit-tested without importing the yargs module
// (same split as check-helpers.ts).

// ---------------------------------------------------------------------------
// Types — the engine's `PerfReport`, as the napi binding serializes it.
// Everything is optional/loose on purpose: this is a cross-binary contract and
// a field the engine adds or renames must not crash the CLI.
// ---------------------------------------------------------------------------

export type PerfSeverity = "info" | "warning" | "error"

/** A guardrail attached to a finding. `MaterializationChange` is the one this
 *  command renders in full: a past perf "fix" that switched a materialization
 *  without deleting the old relation caused a data incident, which is why
 *  `delete_scope` and `reader_requirements` exist at all. */
export interface PerfGuardrail {
  kind?: string
  /** What must be dropped/rebuilt before the change is safe. */
  delete_scope?: unknown
  /** What downstream readers must be able to tolerate. */
  reader_requirements?: unknown
  [key: string]: unknown
}

export interface PerfFinding {
  code?: string
  rule?: string
  family?: string
  scope?: string
  severity?: string
  model?: string
  related_models?: string[]
  message?: string
  suggestion?: string
  evidence?: unknown[]
  inputs_used?: string[]
  confidence?: unknown
  cost?: unknown
  guardrail?: PerfGuardrail
  tension?: unknown
  blast_radius?: unknown
  suppression?: unknown
  [key: string]: unknown
}

export interface PerfSkippedRule {
  code?: string
  name?: string
  reason?: string
}

export interface PerfSummary {
  models_analyzed?: number
  rules_run?: number
  rules_skipped?: number
  findings_total?: number
  had_compiled_sql?: boolean
  had_sink_map?: boolean
  [key: string]: unknown
}

export interface PerfReport {
  findings: PerfFinding[]
  skipped_rules: PerfSkippedRule[]
  summary: PerfSummary
}

export const PERF_SEVERITY_RANK: Record<PerfSeverity, number> = { error: 2, warning: 1, info: 0 }

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Coerce an engine severity to the CLI's three levels. Unknown values become
 *  `warning` rather than `info`: an unrecognized severity must not slip under a
 *  `--fail-on warning` gate. */
export function normalizePerfSeverity(s: unknown): PerfSeverity {
  const lower = typeof s === "string" ? s.toLowerCase() : ""
  if (lower === "error" || lower === "critical" || lower === "high" || lower === "fatal") return "error"
  if (lower === "info" || lower === "low" || lower === "suggestion" || lower === "note") return "info"
  return "warning"
}

/** Normalize whatever the binding returned into a `PerfReport`. The engine owns
 *  this shape; a missing or oddly-typed section becomes empty rather than
 *  throwing, so a contract drift degrades to "reported nothing" (visible in the
 *  summary line) instead of a crash. */
export function normalizePerfReport(data: unknown): PerfReport {
  const d = (data ?? {}) as Record<string, unknown>
  const findings = Array.isArray(d.findings) ? (d.findings as PerfFinding[]) : []
  const skipped = Array.isArray(d.skipped_rules) ? (d.skipped_rules as PerfSkippedRule[]) : []
  const summary = d.summary && typeof d.summary === "object" ? (d.summary as PerfSummary) : {}
  return { findings, skipped_rules: skipped, summary }
}

export function filterPerfBySeverity(findings: PerfFinding[], min: PerfSeverity): PerfFinding[] {
  const minRank = PERF_SEVERITY_RANK[min]
  return findings.filter((f) => PERF_SEVERITY_RANK[normalizePerfSeverity(f.severity)] >= minRank)
}

/** Exit gate. Computed on the UNFILTERED findings so `--severity` only controls
 *  what is printed, never whether CI fails (matching `altimate check`). */
export function perfPass(findings: PerfFinding[], failOn: "none" | "warning" | "error"): boolean {
  if (failOn === "none") return true
  const worst = findings.map((f) => PERF_SEVERITY_RANK[normalizePerfSeverity(f.severity)])
  const errors = worst.filter((r) => r === 2).length
  const warnings = worst.filter((r) => r === 1).length
  if (failOn === "error") return errors === 0
  return errors === 0 && warnings === 0
}

// ---------------------------------------------------------------------------
// Text formatter
// ---------------------------------------------------------------------------

/** Render a value that may be a string, an array of strings, or a nested
 *  object, on one line. Used for the guardrail fields, whose exact shape is the
 *  engine's to choose. */
function inlineValue(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "string") return v
  if (Array.isArray(v)) return v.map(inlineValue).filter(Boolean).join(", ")
  if (typeof v === "object") return JSON.stringify(v)
  return String(v as string | number | boolean)
}

/** Group key: the rule code, falling back to the rule name. */
function groupKey(f: PerfFinding): string {
  return f.code ?? f.rule ?? "unknown"
}

export interface FormatPerfOptions {
  /** The findings that survived `--severity`, for the body. */
  findings: PerfFinding[]
  /** The full, unfiltered set — the summary must not lie about what was found. */
  allFindings: PerfFinding[]
  skippedRules: PerfSkippedRule[]
  summary: PerfSummary
  pass: boolean
  minSeverity: PerfSeverity
}

export function formatPerfText(opts: FormatPerfOptions): string {
  const { summary, allFindings } = opts
  const lines: string[] = []

  const tally = { error: 0, warning: 0, info: 0 }
  for (const f of allFindings) tally[normalizePerfSeverity(f.severity)]++

  // 1. Summary first — everything below is only interpretable against it.
  lines.push(
    `Analyzed ${summary.models_analyzed ?? "?"} model(s): ` +
      `${summary.rules_run ?? "?"} rule(s) run, ${summary.rules_skipped ?? opts.skippedRules.length} skipped — ` +
      `${allFindings.length} finding(s) (${tally.error} error, ${tally.warning} warning, ${tally.info} info)`,
  )
  // The two inputs that decide how much of the rule set could even run. A
  // report with neither is a shallow one and should read as such.
  const inputs: string[] = []
  if (summary.had_compiled_sql !== undefined) inputs.push(`compiled SQL: ${summary.had_compiled_sql ? "yes" : "NO"}`)
  if (summary.had_sink_map !== undefined) inputs.push(`sink map: ${summary.had_sink_map ? "yes" : "NO"}`)
  if (inputs.length) lines.push(`Inputs — ${inputs.join(", ")}`)
  lines.push("")

  // 2. Skipped rules, BEFORE the findings. A rule that could not run is not a
  // clean result, and a reader who sees only findings will read it as one.
  if (opts.skippedRules.length) {
    lines.push(`--- RULES SKIPPED (${opts.skippedRules.length}) ---`)
    for (const r of opts.skippedRules) {
      const code = r.code ? `[${r.code}] ` : ""
      lines.push(`  ${code}${r.name ?? "(unnamed)"}: ${r.reason ?? "no reason given"}`)
    }
    lines.push("")
  }

  // 3. Findings, grouped by rule code.
  if (!opts.findings.length) {
    lines.push(
      allFindings.length
        ? `No findings at or above "${opts.minSeverity}" (${allFindings.length} below the threshold).`
        : "No findings.",
    )
  } else {
    const groups = new Map<string, PerfFinding[]>()
    for (const f of opts.findings) {
      const k = groupKey(f)
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k)!.push(f)
    }
    for (const [code, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const rule = items[0].rule && items[0].rule !== code ? ` ${items[0].rule}` : ""
      const family = items[0].family ? ` (${items[0].family})` : ""
      lines.push(`--- ${code}${rule}${family} — ${items.length} finding(s) ---`)
      for (const f of items) {
        const sev = normalizePerfSeverity(f.severity).toUpperCase()
        const model = f.model ? ` ${f.model}` : ""
        const scope = f.scope ? ` <${f.scope}>` : ""
        lines.push(`  ${sev}${model}${scope}: ${f.message ?? ""}`)
        if (f.related_models?.length) lines.push(`    related: ${f.related_models.join(", ")}`)
        if (f.suggestion) lines.push(`    suggestion: ${f.suggestion}`)
        if (f.confidence !== undefined && f.confidence !== null)
          lines.push(`    confidence: ${inlineValue(f.confidence)}`)
        if (f.cost !== undefined && f.cost !== null) lines.push(`    cost: ${inlineValue(f.cost)}`)
        if (f.blast_radius !== undefined && f.blast_radius !== null)
          lines.push(`    blast radius: ${inlineValue(f.blast_radius)}`)
        if (f.tension !== undefined && f.tension !== null) lines.push(`    tension: ${inlineValue(f.tension)}`)
        // A materialization change is the one guardrail whose omission has
        // already caused a data incident: the old relation survives the switch
        // and readers silently keep hitting it. Print both fields in full.
        const g = f.guardrail
        if (g) {
          const kind = g.kind ?? ""
          if (kind === "MaterializationChange") {
            lines.push(`    GUARDRAIL MaterializationChange:`)
            lines.push(`      delete scope: ${inlineValue(g.delete_scope) || "(not stated — verify manually)"}`)
            lines.push(
              `      reader requirements: ${inlineValue(g.reader_requirements) || "(not stated — verify manually)"}`,
            )
          } else if (kind) {
            lines.push(`    guardrail: ${kind}`)
          }
        }
        if (f.suppression !== undefined && f.suppression !== null)
          lines.push(`    suppression: ${inlineValue(f.suppression)}`)
        const ev = Array.isArray(f.evidence) ? f.evidence : []
        for (const e of ev) lines.push(`    evidence: ${inlineValue(e)}`)
        if (f.inputs_used?.length) lines.push(`    inputs used: ${f.inputs_used.join(", ")}`)
      }
      lines.push("")
    }
  }

  lines.push(opts.pass ? "PASS" : "FAIL")
  return lines.join("\n")
}
// altimate_change end
