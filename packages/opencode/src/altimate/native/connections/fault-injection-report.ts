/**
 * Human-readable rendering of a fault-injection result. Shared by the
 * `fault-injection` CLI command and the `dbt_fault_injection` tool so both say
 * exactly the same thing.
 */

import type { DbtFaultInjectionResult, FaultInjectionNodeInfo } from "../types"

type Json = Record<string, any>

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

function seconds(ms: number | undefined): string {
  if (ms === undefined) return "?"
  return ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`
}

function nodeLabel(id: string, nodes: Record<string, FaultInjectionNodeInfo>): string {
  const node = nodes[id]
  if (!node) return id
  if (node.resource_type === "source") return `source ${node.source_name}.${node.name}`
  return `${node.resource_type} ${node.name}`
}

/** What the fault did to the producer, in plain words. */
function describeFault(result: Json): string {
  const rows = `${result.affected_rows} of ${plural(Number(result.producer_rows), "row")}`
  const column = `\`${result.column}\``
  switch (result.template) {
    case "duplicate_rows":
      return `${rows} duplicated`
    case "drop_rows":
      return `${rows} removed`
    case "null_out":
      return `${column} set to NULL in ${rows}`
    case "unit_scale":
      return `${column} multiplied by 100 in ${rows}`
    case "category_inject":
      return `${column} set to a value never seen before in ${rows}`
    case "date_shift":
      return `${column} moved one day later in ${rows}`
    case "orphan_fk":
      return `${column} set to an id that exists nowhere else in ${rows}`
    default:
      return `${result.template}${result.column ? ` on ${column}` : ""}, ${rows} affected`
  }
}

function describeChange(changed: Json, nodes: Record<string, FaultInjectionNodeInfo>): string {
  const label = nodeLabel(changed.unique_id, nodes)
  const before = changed.baseline_rows
  const after = changed.rows
  const comparison = changed.comparison ?? {}
  if (comparison.method === "keyed") {
    const parts: string[] = []
    if (comparison.rows_changed > 0) {
      const columns = (comparison.columns ?? []).map((c: Json) => `${c.column}: ${c.rows_changed}`).join(", ")
      const sampled =
        typeof comparison.sampled_rows === "number"
          ? `; the per-column counts cover the first ${comparison.sampled_rows} changed rows by key`
          : ""
      parts.push(`${plural(comparison.rows_changed, "row")} changed${columns ? ` (${columns}${sampled})` : ""}`)
    }
    if (comparison.rows_added > 0) parts.push(`${plural(comparison.rows_added, "row")} added`)
    if (comparison.rows_removed > 0) parts.push(`${plural(comparison.rows_removed, "row")} removed`)
    const what = parts.length ? parts.join(", ") : "content changed"
    return `${label}: ${what} of ${before} (matched on ${comparison.key_columns.join(", ")})`
  }
  const why = comparison.note ? `; ${comparison.note}, so no row-level detail` : ""
  if (before === null || before === undefined || after === null || after === undefined) {
    return `${label}: relation missing on one side (${before ?? "missing"} -> ${after ?? "missing"} rows)`
  }
  if (before !== after) return `${label}: row count ${before} -> ${after}${why}`
  return `${label}: content changed, row count unchanged at ${after}${why}`
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces)
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n")
}

/** dbt 1.8 renamed the `tests:` key to `data_tests:`. */
function testsKey(dbtVersion: string | undefined): string {
  const match = dbtVersion?.match(/^(\d+)\.(\d+)/)
  if (!match) return "data_tests"
  const [major, minor] = [Number(match[1]), Number(match[2])]
  return major > 1 || (major === 1 && minor >= 8) ? "data_tests" : "tests"
}

/** A name as a YAML scalar: plain when that is safe, quoted otherwise. */
function yamlScalar(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : JSON.stringify(value)
}

/** The proposed test as a block that can be pasted into a schema file. */
export function proposedTestYaml(
  proposal: Json,
  nodes: Record<string, FaultInjectionNodeInfo>,
  dbtVersion?: string,
): string {
  const node = nodes[proposal.node_id]
  const key = testsKey(dbtVersion)
  const name = yamlScalar(node?.name ?? String(proposal.node_id).split(".").pop() ?? "")
  const lines: string[] = []
  let depth: number
  if (proposal.resource_section === "sources" && node?.source_name) {
    lines.push("sources:", `  - name: ${yamlScalar(node.source_name)}`, "    tables:", `      - name: ${name}`)
    depth = 8
  } else {
    lines.push(`${proposal.resource_section}:`, `  - name: ${name}`)
    depth = 4
  }
  if (proposal.column) {
    lines.push(indent("columns:", depth), indent(`- name: ${yamlScalar(String(proposal.column))}`, depth + 2))
    depth += 4
  }
  lines.push(indent(`${key}:`, depth), indent(String(proposal.yaml), depth + 2))
  return lines.join("\n")
}

function describeVerification(proposal: Json): string {
  const check = proposal.verification
  if (!check) return "Not verified against the data."
  if (check.catches_fault) {
    return `Verified on the data: passes on the clean data and fails on the corrupted copy (${check.sandbox_failures} failing).`
  }
  // The engine only returns a proposal that passed this check; anything else is shown as unverified.
  return "Not verified against the data."
}

function formatSlipped(
  index: number,
  result: Json,
  nodes: Record<string, FaultInjectionNodeInfo>,
  project: string,
  dbtVersion?: string,
): string[] {
  const lines: string[] = []
  lines.push(`${index}. ${nodeLabel(result.producer_id, nodes)}: ${describeFault(result)}`)
  lines.push(`   Fault id: ${result.fault_id}`)
  lines.push(`   ${plural(result.tests_run, "test")} ran and none failed because of the fault. Changed downstream:`)
  for (const changed of result.changed_relations ?? []) {
    lines.push(`     - ${describeChange(changed, nodes)}`)
  }
  const proposal = result.proposed_test
  if (!proposal) {
    lines.push(`   No test is proposed for this fault${result.proposal_note ? `: ${result.proposal_note}` : "."}`)
    return lines
  }
  const target = nodes[proposal.node_id]
  const fromPackage = target?.package_name && target.package_name !== project ? target.package_name : undefined
  if (proposal.form === "singular_sql") {
    lines.push(`   Proposed test: ${proposal.test}`)
    lines.push(`   ${describeVerification(proposal)}`)
    // The engine says why it chose a file over a schema entry; older engines do not.
    const why =
      proposal.singular_reason ??
      (fromPackage
        ? `The ${proposal.resource_section === "sources" ? "source" : "node"} belongs to the installed package ${fromPackage}, ` +
          `and dbt accepts only one description per resource, so a schema entry cannot be added for it.`
        : "A schema entry is not possible for this test.")
    lines.push(`   ${why} This is a singular test instead (plain SQL, no package needed).`)
    lines.push(`   Save as ${proposal.file} (or in another folder listed under test-paths in dbt_project.yml):`)
    lines.push(indent(String(proposal.sql).trimEnd(), 6))
    if (proposal.rationale) lines.push(`   Note: ${proposal.rationale}`)
    return lines
  }
  const file = !fromPackage && target?.patch_path ? ` (the node is described in ${target.patch_path})` : ""
  lines.push(`   Proposed test: ${proposal.test}${file}`)
  lines.push(`   ${describeVerification(proposal)}`)
  if (fromPackage) {
    // An engine that predates singular tests proposes a schema entry for a package's node.
    const where = target?.patch_path ? ` (${target.patch_path} there)` : ""
    lines.push(
      proposal.resource_section === "sources"
        ? `   The source is defined in the installed package ${fromPackage}${where}, not in this project.`
        : `   The node belongs to the installed package ${fromPackage}${where}. dbt accepts only one description ` +
            `per node, so this block cannot simply be added to this project's YAML.`,
    )
  }
  lines.push(indent(proposedTestYaml(proposal, nodes, dbtVersion), 6))
  if (proposal.rationale) lines.push(`   Note: ${proposal.rationale}`)
  return lines
}

/**
 * A catch rate as a percentage with one decimal, rounded down so that 99.96%
 * with a fault still slipping through never reads as 100%.
 */
export function formatRate(rate: number): string {
  return `${(Math.floor(rate * 1000) / 10).toFixed(1)}%`
}

/** The summary's catch rate, or "n/a" when no fault was caught or slipped. */
export function catchRateText(summary: Json): string {
  return typeof summary.catch_rate === "number" ? formatRate(summary.catch_rate) : "n/a"
}

/** What became of the user's database and of the work directory, as far as the run established. */
function closingLines(result: DbtFaultInjectionResult): string[] {
  const lines: string[] = []
  if (result.database && result.original_unchanged === true) {
    lines.push(`${result.database} is unchanged (same size and modification time as before the run).`)
  }
  if (result.work_dir) {
    lines.push(
      result.work_dir_removed
        ? `The work directory ${result.work_dir} has been removed.`
        : `The work directory ${result.work_dir} could not be removed; delete it by hand.`,
    )
  }
  if (result.engine?.source === "dev-override") {
    lines.push(`Engine: development build at ${result.engine.path}.`)
  }
  return lines
}

/** One-line outcome, used as the tool title. */
export function summarizeFaultInjection(result: DbtFaultInjectionResult): string {
  if (!result.success || !result.report) return result.interrupted ? "interrupted" : "ERROR"
  const s = result.report.summary ?? {}
  return `catch rate ${catchRateText(s)} (${s.killed} caught, ${s.slipped_through} slipped through)`
}

/** The full text report. Every line states something the run observed. */
export function formatFaultInjection(result: DbtFaultInjectionResult): string {
  const lines: string[] = []

  if (!result.success || !result.report) {
    lines.push(result.interrupted ? "Fault injection interrupted." : `Fault injection failed: ${result.error}`)
    lines.push(...closingLines(result))
    return lines.join("\n")
  }

  const report = result.report
  const s = report.summary ?? {}
  const nodes = result.nodes ?? {}
  const decided = Number(s.killed) + Number(s.slipped_through)

  lines.push(`Fault injection: ${report.project} (${result.warehouse})`)
  lines.push("")
  lines.push(
    decided > 0
      ? `Catch rate: ${catchRateText(s)} (${s.killed} of ${decided} faults that mattered were caught)`
      : "Catch rate: n/a (no fault was caught and none changed downstream data)",
  )
  lines.push(
    `  ${plural(s.executed, "fault")} injected: ${s.killed} caught, ${s.slipped_through} slipped through, ` +
      `${s.inert} harmless, ${s.invalid} invalid`,
  )
  lines.push("  caught = a test failed or a downstream model broke; slipped through = no test failed and downstream data changed;")
  lines.push("  harmless = nothing downstream changed; invalid = the fault touched no row or its sandbox failed")
  if (s.selected < s.candidates) {
    const limited = result.budget !== undefined && s.selected >= result.budget
    lines.push(
      `  ${s.selected} of ${s.candidates} candidate faults were selected` +
        (limited ? ` (budget ${result.budget}). Raise the budget to run more.` : "."),
    )
  }
  if (s.skipped > 0) lines.push(`  ${plural(s.skipped, "selected fault")} not run; see below.`)
  if (report.dialect_verified === false) {
    lines.push(`  The SQL for ${report.dialect} has not been verified against a real engine.`)
  }

  const slipped = (report.slipped_through ?? []) as Json[]
  lines.push("")
  if (slipped.length === 0) {
    lines.push("No fault slipped through.")
  } else {
    lines.push(`Slipped through (${slipped.length}): the project's tests did not notice these`)
    slipped.forEach((entry, i) => {
      lines.push("")
      lines.push(...formatSlipped(i + 1, entry, nodes, String(report.project), result.dbt?.version))
    })
  }

  const controls = ((report.controls ?? []) as Json[]).filter(
    (c) => c.quarantined || c.volatile_relations?.length || c.failing_tests?.length || c.build_errors?.length,
  )
  if (controls.length > 0) {
    lines.push("")
    lines.push("Seen with no fault injected (excluded from the results above):")
    for (const control of controls) {
      const label = nodeLabel(control.producer_id, nodes)
      if (control.quarantined) lines.push(`  - ${label}: not tested (${control.reason ?? "unreliable control run"})`)
      if (control.volatile_relations?.length) {
        lines.push(`  - ${label}: these change on every rebuild: ${control.volatile_relations.join(", ")}`)
      }
      if (control.failing_tests?.length) {
        lines.push(`  - ${label}: these tests already fail: ${control.failing_tests.join(", ")}`)
      }
      if (control.build_errors?.length) {
        lines.push(`  - ${label}: these models already break: ${control.build_errors.join(", ")}`)
      }
    }
  }

  const skipped = (report.skipped ?? []) as Json[]
  if (skipped.length > 0) {
    lines.push("")
    lines.push("Not run:")
    for (const entry of skipped) lines.push(`  - ${entry.fault_id}: ${entry.reason}`)
  }

  const invalid = ((report.results ?? []) as Json[]).filter((r) => r.outcome === "invalid")
  if (invalid.length > 0) {
    lines.push("")
    lines.push("Invalid:")
    for (const entry of invalid) {
      lines.push(`  - ${entry.fault_id}: ${entry.error ?? "the fault touched no row"}`)
    }
  }

  const warnings = (report.warnings ?? []) as string[]
  if (warnings.length > 0) {
    lines.push("")
    lines.push("Warnings:")
    for (const warning of warnings) lines.push(`  - ${warning}`)
  }

  lines.push("")
  lines.push("These are gaps in the project's tests. They are not evidence that the data in the warehouse today is wrong.")
  const t = result.timing
  if (t) {
    const faultMs = Object.values(t.per_fault_ms ?? {}).reduce((sum, ms) => sum + ms, 0)
    const faults = Object.keys(t.per_fault_ms ?? {}).length
    const parts = [`setup and baseline build ${seconds(t.setup_ms)}`]
    if (faults > 0) parts.push(`${plural(faults, "fault")} ${seconds(faultMs)} (${seconds(faultMs / faults)} each on average)`)
    if (t.run_ms !== undefined) parts.push(`profiling and no-fault controls ${seconds(Math.max(t.run_ms - faultMs, 0))}`)
    lines.push(`Took ${seconds(t.total_ms)}: ${parts.join("; ")}.`)
  }
  lines.push(...closingLines(result))
  return lines.join("\n")
}
