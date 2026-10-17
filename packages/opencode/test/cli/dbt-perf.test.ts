// altimate_change start — tests for the dbt-perf CLI command helpers
import { describe, test, expect } from "bun:test"
import {
  type PerfFinding,
  type PerfReport,
  buildPerfOptions,
  formatPerfCost,
  sortPerfFindings,
  filterPerfBySeverity,
  formatPerfText,
  normalizePerfReport,
  normalizePerfSeverity,
  perfPass,
} from "../../src/cli/cmd/dbt-perf-helpers"

function finding(overrides: Partial<PerfFinding> = {}): PerfFinding {
  return {
    code: "P001",
    rule: "unpartitioned_incremental",
    family: "io",
    scope: "model",
    severity: "warning",
    model: "mrt_orders",
    related_models: [],
    message: "incremental model scans the full table",
    evidence: [],
    inputs_used: ["manifest"],
    confidence: "high",
    ...overrides,
  }
}

const baseReport = (over: Partial<PerfReport> = {}): PerfReport => ({
  findings: [],
  skipped_rules: [],
  summary: { models_analyzed: 3, rules_run: 7, rules_skipped: 1, findings_total: 0 },
  ...over,
})

describe("dbt-perf: normalization", () => {
  test("unknown severities become warning, never info", () => {
    // An unrecognized level must not slip under `--fail-on warning`.
    expect(normalizePerfSeverity("error")).toBe("error")
    expect(normalizePerfSeverity("critical")).toBe("error")
    expect(normalizePerfSeverity("info")).toBe("info")
    expect(normalizePerfSeverity("something-new")).toBe("warning")
    expect(normalizePerfSeverity(undefined)).toBe("warning")
  })

  test("a malformed report degrades to empty rather than throwing", () => {
    expect(normalizePerfReport(undefined)).toEqual({ findings: [], skipped_rules: [], summary: {} })
    expect(normalizePerfReport({ findings: "nope", skipped_rules: null, summary: 3 })).toEqual({
      findings: [],
      skipped_rules: [],
      summary: {},
    })
  })

  test("severity filter and the exit gate are independent", () => {
    const findings = [finding({ severity: "info" }), finding({ severity: "error", code: "P002" })]
    expect(filterPerfBySeverity(findings, "error")).toHaveLength(1)
    // --severity hid the info finding, but --fail-on still sees everything.
    expect(perfPass(findings, "none")).toBe(true)
    expect(perfPass(findings, "error")).toBe(false)
    expect(perfPass([finding({ severity: "warning" })], "error")).toBe(true)
    expect(perfPass([finding({ severity: "warning" })], "warning")).toBe(false)
  })
})

describe("dbt-perf: text output", () => {
  const render = (over: Partial<PerfReport> = {}, min: "info" | "warning" | "error" = "info") => {
    const r = baseReport(over)
    return formatPerfText({
      findings: filterPerfBySeverity(r.findings, min),
      allFindings: r.findings,
      skippedRules: r.skipped_rules,
      summary: r.summary,
      pass: perfPass(r.findings, "none"),
      minSeverity: min,
    })
  }

  test("leads with the summary line", () => {
    const out = render({ findings: [finding()] })
    expect(out.split("\n")[0]).toContain("Analyzed 3 model(s)")
    expect(out.split("\n")[0]).toContain("7 rule(s) run")
    expect(out.split("\n")[0]).toContain("1 finding(s)")
  })

  test("surfaces skipped rules — a rule that could not run is not a clean result", () => {
    const out = render({
      skipped_rules: [{ code: "P009", name: "spill_risk", reason: "no compiled SQL" }],
    })
    expect(out).toContain("RULES SKIPPED (1)")
    expect(out).toContain("[P009] spill_risk: no compiled SQL")
    // Skips print BEFORE findings so a reader can't take "no findings" at face value.
    expect(out.indexOf("RULES SKIPPED")).toBeLessThan(out.indexOf("No findings"))
  })

  test("reports whether compiled SQL and the sink map were available", () => {
    const out = render({ summary: { ...baseReport().summary, had_compiled_sql: false, had_sink_map: true } })
    expect(out).toContain("compiled SQL: NO")
    expect(out).toContain("sink map: yes")
  })

  test("groups findings by rule code", () => {
    const out = render({
      findings: [
        finding({ code: "P001", model: "a" }),
        finding({ code: "P001", model: "b" }),
        finding({ code: "P002", rule: "wide_scan", model: "c" }),
      ],
    })
    expect(out).toContain("--- P001 unpartitioned_incremental (io) — 2 finding(s) ---")
    expect(out).toContain("--- P002 wide_scan (io) — 1 finding(s) ---")
  })

  test("a MaterializationChange guardrail prints delete_scope and reader_requirements", () => {
    const out = render({
      findings: [
        finding({
          guardrail: {
            kind: "MaterializationChange",
            delete_scope: ["drop table analytics.mrt_orders"],
            reader_requirements: "downstream readers must tolerate a full rebuild",
          },
        }),
      ],
    })
    expect(out).toContain("GUARDRAIL MaterializationChange:")
    expect(out).toContain("delete scope: drop table analytics.mrt_orders")
    expect(out).toContain("reader requirements: downstream readers must tolerate a full rebuild")
  })

  test("a MaterializationChange guardrail with the fields missing says so rather than staying silent", () => {
    const out = render({ findings: [finding({ guardrail: { kind: "MaterializationChange" } })] })
    expect(out).toContain("delete scope: (not stated — verify manually)")
    expect(out).toContain("reader requirements: (not stated — verify manually)")
  })

  test("distinguishes 'nothing found' from 'everything filtered out'", () => {
    expect(render()).toContain("No findings.")
    const filtered = render({ findings: [finding({ severity: "info" })] }, "error")
    expect(filtered).toContain('No findings at or above "error" (1 below the threshold).')
  })
})
// altimate_change start — A1: run_results / trino profile / sinks inputs + cost sort
describe("dbt-perf: inputs and cost ordering", () => {
  test("options carry only the inputs that were supplied (the binding rejects unknown keys)", () => {
    expect(buildPerfOptions({})).toEqual({})
    expect(buildPerfOptions({ runResults: "/r.json", trinoProfile: "/t.json", sinks: "/s.json", experimental: true })).toEqual({
      run_results: "/r.json",
      trino_profile: "/t.json",
      sinks: "/s.json",
      include_experimental: true,
    })
    // Exposure-derived sinks are on by default; only the opt-out is sent.
    expect(buildPerfOptions({ exposureSinks: true })).toEqual({})
    expect(buildPerfOptions({ exposureSinks: false })).toEqual({ sinks_from_exposures: false })
  })

  test("--sort cost: most expensive first, unmeasured last, stable", () => {
    const f = (code: string, cost?: unknown) => finding({ code, cost })
    const sorted = sortPerfFindings(
      [f("A"), f("B", { exec_time_s: 2 }), f("C", { exec_time_s: 30 }), f("D", { exec_time_s: 2, exec_share: 0.5 }), f("E")],
      "cost",
    )
    expect(sorted.map((x) => x.code)).toEqual(["C", "D", "B", "A", "E"])
    expect(sortPerfFindings([f("A"), f("B", { exec_time_s: 9 })], "rule").map((x) => x.code)).toEqual(["A", "B"])
  })

  test("cost renders as one readable line", () => {
    expect(
      formatPerfCost({ exec_time_s: 12.34, exec_share: 0.25, physical_input_bytes: 3 * 1024 ** 3, on_critical_path: true }),
    ).toBe("exec 12.3s (25.0% of run), input 3.0 GB, on critical path")
  })

  test("summary reports run_results / trino profile / parse failures", () => {
    const out = formatPerfText({
      findings: [],
      allFindings: [],
      skippedRules: [],
      summary: { had_run_results: true, had_trino_profile: false, parse_failures: 2, parse_failed_models: ["a", "b"] },
      pass: true,
      minSeverity: "info",
    })
    expect(out).toContain("run_results: yes")
    expect(out).toContain("trino profile: NO")
    expect(out).toContain("Parse failures — 2 model(s) not read by SQL rules: a, b")
  })

  test("--sort cost prints a flat list with each finding's rule code", () => {
    const out = formatPerfText({
      findings: [finding({ code: "P101", cost: { exec_time_s: 5 } })],
      allFindings: [finding({ code: "P101" })],
      skippedRules: [],
      summary: {},
      pass: true,
      minSeverity: "info",
      sort: "cost",
    })
    expect(out).toContain("--- FINDINGS BY COST — 1 finding(s) ---")
    expect(out).toContain("WARNING [P101] mrt_orders")
    expect(out).toContain("cost: exec 5.0s")
  })

  test("the snake_case materialization_change guardrail prints its fields too", () => {
    const out = formatPerfText({
      findings: [finding({ guardrail: { kind: "materialization_change", delete_scope: "drop x" } })],
      allFindings: [finding()],
      skippedRules: [],
      summary: {},
      pass: true,
      minSeverity: "info",
    })
    expect(out).toContain("GUARDRAIL MaterializationChange:")
    expect(out).toContain("delete scope: drop x")
  })
})
// altimate_change end
