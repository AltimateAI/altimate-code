import { describe, test, expect } from "bun:test"
import {
  DEFAULT_RULE_POST_POLICY,
  NOISY_RULE_TYPES,
  configuredRulePolicy,
  dropByRulePolicy,
  rulePolicyApplies,
  type RuleVerdictValue,
} from "../../src/altimate/review/rule-post-policy"
import { envSwitch, resolveAiSwitches, AI_SWITCH_DEFAULTS, type AiSwitches } from "../../src/altimate/review/ai-switches"
import { makeFinding, ruleId, type Finding, type Severity } from "../../src/altimate/review/finding"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG, parseReviewConfig } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import type { AiLaneStatus, AiReviewInput } from "../../src/altimate/review/ai-review"

// The rule-post policy: after rule types off and refuted rule findings, a rule finding is not
// posted when its verdict is unverifiable at warning, or its type is noisy and not confirmed.
// Critical rule findings are never dropped by the policy or the refuted filter.

const NOISY = NOISY_RULE_TYPES[0]

function rule(n: number, severity: Severity, r = ruleId("dbt-patterns", `rule-${n}`)): Finding {
  return makeFinding({
    severity,
    category: "sql_correctness",
    title: `m: rule ${n}`,
    body: "b",
    file: "models/m.sql",
    evidence: { tool: r.split(":")[0], result: {} },
    ruleKey: `${r}-${n}`,
    rule: r,
  })
}
function ai(n: number, severity: Severity, r = ruleId("ai-review", "sql_correctness")): Finding {
  return makeFinding({
    severity,
    category: "sql_correctness",
    title: `m: ai ${n}`,
    body: "b",
    file: "models/m.sql",
    evidence: { tool: "ai-review", result: {} },
    ruleKey: `ai:${n}`,
    rule: r,
  })
}
const verdicts = (pairs: Array<[Finding, RuleVerdictValue | null]>) => new Map(pairs.map(([f, v]) => [f.id, v] as const))

describe("dropByRulePolicy", () => {
  test("condition 1: unverifiable at warning is dropped; at suggestion it stays", () => {
    const w = rule(1, "warning")
    const s = rule(3, "suggestion")
    const r = dropByRulePolicy([w, s], verdicts([[w, "unverifiable"], [s, "unverifiable"]]))
    expect(r.kept).toEqual([s])
    expect(r.dropped).toEqual({ unverifiable_high_sev: 1, noisy_type_not_confirmed: 0 })
  })

  test("critical rule findings are always kept: unverifiable, no verdict, or a noisy type not confirmed", () => {
    const unverifiable = rule(1, "critical")
    const none = rule(2, "critical")
    const noisy = rule(3, "critical", NOISY)
    const warning = rule(4, "warning")
    const r = dropByRulePolicy(
      [unverifiable, none, noisy, warning],
      verdicts([[unverifiable, "unverifiable"], [noisy, "refuted"], [warning, "unverifiable"]]),
    )
    expect(r.kept).toEqual([unverifiable, none, noisy])
    expect(r.dropped).toEqual({ unverifiable_high_sev: 1, noisy_type_not_confirmed: 0 })
  })

  test("condition 2: a noisy type stays only when confirmed", () => {
    const confirmed = rule(1, "suggestion", NOISY)
    const unverifiable = rule(2, "suggestion", NOISY)
    const refuted = rule(3, "warning", NOISY)
    const r = dropByRulePolicy(
      [confirmed, unverifiable, refuted],
      verdicts([[confirmed, "confirmed"], [unverifiable, "unverifiable"], [refuted, "refuted"]]),
    )
    expect(r.kept).toEqual([confirmed])
    expect(r.dropped).toEqual({ unverifiable_high_sev: 0, noisy_type_not_confirmed: 2 })
  })

  test("confirmed and refuted findings of other types stay (refuted ones are the refuted filter's job)", () => {
    const a = rule(1, "warning")
    const b = rule(2, "critical")
    const r = dropByRulePolicy([a, b], verdicts([[a, "confirmed"], [b, "refuted"]]))
    expect(r.kept).toEqual([a, b])
  })

  test("a finding with no verdict (null or absent) was not judged: it is kept", () => {
    const nul = rule(1, "warning")
    const absent = rule(2, "warning")
    const noisySuggestion = rule(3, "suggestion", NOISY)
    const plainSuggestion = rule(4, "suggestion")
    const r = dropByRulePolicy([nul, absent, noisySuggestion, plainSuggestion], verdicts([[nul, null]]))
    expect(r.kept).toEqual([nul, absent, noisySuggestion, plainSuggestion])
    expect(r.dropped).toEqual({ unverifiable_high_sev: 0, noisy_type_not_confirmed: 0 })
  })

  test("AI findings are never dropped, whatever their verdict, severity or rule id", () => {
    const fs = [ai(1, "warning"), ai(2, "critical"), ai(3, "suggestion", NOISY)]
    const r = dropByRulePolicy(fs, new Map())
    expect(r.kept).toEqual(fs)
    expect(r.dropped).toEqual({ unverifiable_high_sev: 0, noisy_type_not_confirmed: 0 })
  })

  test("a custom noisy list replaces the default", () => {
    const f = rule(1, "suggestion", "x:custom")
    expect(dropByRulePolicy([f], verdicts([[f, "unverifiable"]])).kept).toEqual([f])
    expect(dropByRulePolicy([f], verdicts([[f, "unverifiable"]]), { noisyRules: ["x:custom"] }).kept).toEqual([])
  })

  test("noisy rule ids match in either spelling", () => {
    const f = rule(1, "suggestion", "dbt-patterns:fanout-join")
    expect(dropByRulePolicy([f], verdicts([[f, "unverifiable"]]), { noisyRules: ["dbt_patterns:fanout_join"] }).kept).toEqual([])
  })
})

describe("rulePolicyApplies (fail-open)", () => {
  test("only when the rule verifier ran and reviewed at least one finding", () => {
    expect(rulePolicyApplies(undefined)).toBe(false)
    expect(rulePolicyApplies({ state: "skipped", reviewed: 0 })).toBe(false)
    expect(rulePolicyApplies({ state: "error", reviewed: 0 })).toBe(false)
    expect(rulePolicyApplies({ state: "budget", reviewed: 0 })).toBe(false)
    expect(rulePolicyApplies({ state: "timeout" })).toBe(false)
    expect(rulePolicyApplies({ state: "budget", reviewed: 2 })).toBe(true)
    expect(rulePolicyApplies({ state: "ok", reviewed: 1 })).toBe(true)
  })
})

describe("configuration", () => {
  test("seven noisy types by default", () => {
    expect(NOISY_RULE_TYPES).toHaveLength(7)
    expect(DEFAULT_RULE_POST_POLICY.noisyRules).toBe(NOISY_RULE_TYPES)
  })

  test("`ai.rulePolicy`: false off, an object on with its noisy list; env `0` off", () => {
    expect(AI_SWITCH_DEFAULTS.rulePolicy).toBe(true)
    expect(resolveAiSwitches(parseReviewConfig("ai:\n  rulePolicy: false"), {}).rulePolicy).toBe(false)
    const obj = parseReviewConfig("ai:\n  rulePolicy:\n    noisyRules:\n      - x:y")
    expect(resolveAiSwitches(obj, {}).rulePolicy).toBe(true)
    expect(configuredRulePolicy(obj)).toEqual({ noisyRules: ["x:y"] })
    expect(configuredRulePolicy(DEFAULT_REVIEW_CONFIG)).toBe(DEFAULT_RULE_POST_POLICY)
    // A direct caller passing a non-list keeps the default list instead of failing later.
    expect(configuredRulePolicy({ ai: { rulePolicy: { noisyRules: "x:y" } } })).toBe(DEFAULT_RULE_POST_POLICY)
    expect(configuredRulePolicy({ ai: { rulePolicy: { noisyRules: [1] } } })).toBe(DEFAULT_RULE_POST_POLICY)
    // A typo under `rulePolicy` fails the load rather than leaving the default list.
    expect(() => parseReviewConfig("ai:\n  rulePolicy:\n    noisyRule:\n      - x:y")).toThrow(/unrecognized_keys/)
    expect(envSwitch("rulePolicy", { ALTIMATE_REVIEW_RULE_POLICY: "0" })).toBe(false)
    expect(resolveAiSwitches(obj, { ALTIMATE_REVIEW_RULE_POLICY: "0" }).rulePolicy).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const runner: ReviewRunner = {
  async impact() {
    return { hasManifest: true, severity: "SAFE", directCount: 0, transitiveCount: 0, testCount: 0 }
  },
  async grade() {
    return { grade: "B" }
  },
  // One error-severity engine issue: a warning-severity rule finding.
  async check() {
    return { issues: [{ rule: "ambiguous-column", severity: "error", category: "correctness", message: "ambiguous column status", line: 3 }], ran: true }
  },
  async equivalence() {
    return { decided: true, equivalent: true }
  },
  async detectPii() {
    return { columns: [] }
  },
} as ReviewRunner
// Adds an error-severity contract issue: a critical rule finding.
const critRunner: ReviewRunner = {
  ...runner,
  async check() {
    return {
      issues: [
        { rule: "ambiguous-column", severity: "error", category: "correctness", message: "ambiguous column status", line: 3 },
        { rule: "contract-column-dropped", severity: "error", category: "contract", message: "contract column dropped", line: 2 },
      ],
      ran: true,
    }
  },
} as ReviewRunner
const SQL = "select *\nfrom raw.orders\nwhere status = 'x'\norder by 1"
const aiFinding = makeFinding({
  severity: "warning",
  category: "sql_correctness",
  title: "m: ai claim",
  body: "AI body.",
  file: "models/marts/m.sql",
  model: "m",
  startLine: 2,
  endLine: 2,
  evidence: { tool: "ai-review", result: {} },
  ruleKey: "ai:sql_correctness:ai claim",
  rule: ruleId("ai-review", "sql_correctness"),
})

type RuleVerifierState = NonNullable<AiLaneStatus["ruleVerifier"]>["state"]
interface RunOpts {
  switches?: Partial<AiSwitches>
  /** The verdict per rule finding sent (by index); undefined leaves the finding without a verdict. */
  verdictAt?: (i: number) => RuleVerdictValue | undefined
  ruleState?: RuleVerifierState
  policy?: boolean
  rulesOff?: Set<string>
  ai?: boolean
  runner?: ReviewRunner
  /** The finder lane's state (the rule verdicts are recorded whatever it is). */
  finderState?: "ok" | "timeout" | "error"
  mode?: "comment" | "gate"
}

function run(o: RunOpts = {}, seen: AiReviewInput[] = []) {
  return runReview({
    changedFiles: [{ path: "models/marts/m.sql", status: "modified", diff: `@@ -1 +1,4 @@\n-select 1\n+${SQL.split("\n").join("\n+")}\n` }],
    config: { ...DEFAULT_REVIEW_CONFIG },
    rubric: DEFAULT_RUBRIC,
    mode: o.mode ?? "comment",
    runner: o.runner ?? runner,
    forceTier: "full",
    aiVerify: true,
    aiSwitches: o.switches ?? { verifyRules: true, rulePolicy: true },
    getContent: async (_f, side) => (side === "old" ? "select 1" : SQL),
    generatedAt: "2026-11-25T00:00:00Z",
    ...(o.policy === false ? {} : { rulePolicy: DEFAULT_RULE_POST_POLICY }),
    ...(o.rulesOff ? { rulesOff: o.rulesOff } : {}),
    ...(o.ai === false
      ? {}
      : {
          aiReview: async (input: AiReviewInput) => {
            seen.push(input)
            const rules = input.verifyRulesAfter
            if (!rules) return { findings: [aiFinding], status: { state: "ok" as const } }
            const at = o.verdictAt ?? (() => "confirmed" as const)
            const records = rules.map((f, i) => {
              const v = at(i)
              return {
                id: f.id,
                file: f.file,
                title: f.title,
                rule: f.rule,
                verdict: v ?? null,
                claimType: v ? ("code_fact" as const) : null,
                value: v ? ("actionable" as const) : null,
                evidence: v ? "quoted" : null,
                toolsUsed: [],
                noVerdict: !v,
                batch: 0,
              }
            })
            const reviewed = records.filter((r) => !r.noVerdict).length
            const state = o.ruleState ?? "ok"
            return {
              findings: o.finderState && o.finderState !== "ok" ? [] : [aiFinding],
              status: {
                state: o.finderState ?? ("ok" as const),
                verifyRules: "drop_refuted" as const,
                verifier: {
                  state: "skipped" as const,
                  durationMs: 0,
                  turns: 0,
                  toolCalls: 0,
                  reviewed: 0,
                  kept: 0,
                  discarded: 0,
                  summary: 0,
                  unreviewed: 0,
                  ...(state === "skipped" ? {} : { ruleVerdicts: records }),
                },
                ruleVerifier: {
                  state,
                  durationMs: 1,
                  turns: 1,
                  toolCalls: 0,
                  reviewed: state === "skipped" ? 0 : reviewed,
                  kept: rules.length,
                  discarded: 0,
                  summary: 0,
                  unreviewed: rules.length - reviewed,
                },
              },
            }
          },
        }),
  })
}

describe("orchestrator: rule-post policy", () => {
  test("drops unverifiable warning rule findings, keeps the AI finding, records counts", async () => {
    const base = await run({ switches: { verifyRules: false, rulePolicy: false }, policy: false })
    const seen: AiReviewInput[] = []
    // Every rule finding unverifiable.
    const env = await run({ verdictAt: () => "unverifiable" }, seen)
    const sent = seen[0].verifyRulesAfter!
    const highSev = sent.filter((f) => f.severity !== "suggestion")
    expect(highSev.length).toBeGreaterThan(0)
    expect(env.findings.map((f) => f.id)).toEqual(
      base.findings.filter((f) => !highSev.some((h) => h.id === f.id)).map((f) => f.id),
    )
    expect(env.findings.some((f) => f.origin === "ai")).toBe(true)
    expect(env.rulePolicy?.applied).toBe(true)
    expect(env.rulePolicy?.dropped.unverifiable_high_sev).toBe(highSev.length)
    expect(env.rulesRefuted).toBe(0)
  })

  test("a single rule finding with no verdict is posted (the verifier never judged it)", async () => {
    const seen: AiReviewInput[] = []
    const all = await run({}, seen)
    const sent = seen[0].verifyRulesAfter!
    const idx = sent.findIndex((f) => f.severity !== "suggestion")
    expect(idx).toBeGreaterThanOrEqual(0)
    const env = await run({ verdictAt: (i) => (i === idx ? undefined : "confirmed") })
    expect(env.findings).toEqual(all.findings)
    expect(env.rulePolicy).toEqual({ applied: true, dropped: { unverifiable_high_sev: 0, noisy_type_not_confirmed: 0 } })
  })

  test("all confirmed: nothing dropped, applied with zero counts", async () => {
    const base = await run({ switches: { verifyRules: false, rulePolicy: false }, policy: false })
    const env = await run({ verdictAt: () => "confirmed" })
    expect(env.findings).toEqual(base.findings)
    expect(env.rulePolicy).toEqual({ applied: true, dropped: { unverifiable_high_sev: 0, noisy_type_not_confirmed: 0 } })
  })

  test("fail-open: the rule verifier skipped, failed, or stopped on budget with nothing reviewed", async () => {
    const base = await run({ switches: { verifyRules: false, rulePolicy: false }, policy: false })
    for (const ruleState of ["skipped", "error", "budget"] as const) {
      const env = await run({ verdictAt: () => undefined, ruleState })
      expect(env.findings).toEqual(base.findings)
      expect(env.rulePolicy).toEqual({ applied: false, dropped: { unverifiable_high_sev: 0, noisy_type_not_confirmed: 0 } })
    }
  })

  test("budget with some findings reviewed: the policy applies, unreviewed findings are posted", async () => {
    const base = await run({ switches: { verifyRules: false, rulePolicy: false }, policy: false })
    const env = await run({ verdictAt: (i) => (i === 0 ? "confirmed" : undefined), ruleState: "budget" })
    expect(env.rulePolicy?.applied).toBe(true)
    expect(env.rulePolicy?.dropped.unverifiable_high_sev).toBe(0)
    expect(env.findings).toEqual(base.findings)
  })

  test("a critical rule finding the verifier could not check is posted; the warning one is not", async () => {
    const seen: AiReviewInput[] = []
    const env = await run({ runner: critRunner, verdictAt: () => "unverifiable" }, seen)
    const sent = seen[0].verifyRulesAfter!
    const crit = sent.filter((f) => f.severity === "critical")
    const warn = sent.filter((f) => f.severity === "warning")
    expect(crit.length).toBe(1)
    expect(warn.length).toBeGreaterThan(0)
    expect(env.findings.some((f) => f.id === crit[0].id)).toBe(true)
    expect(env.findings.some((f) => warn.some((w) => w.id === f.id))).toBe(false)
    expect(env.rulePolicy?.dropped.unverifiable_high_sev).toBe(warn.length)
  })

  test("a critical rule finding the verifier refuted is posted; a refuted warning one is not", async () => {
    const seen: AiReviewInput[] = []
    const env = await run({ runner: critRunner, verdictAt: () => "refuted" }, seen)
    const sent = seen[0].verifyRulesAfter!
    const crit = sent.filter((f) => f.severity === "critical")
    const rest = sent.filter((f) => f.severity !== "critical")
    expect(crit.length).toBe(1)
    expect(env.findings.some((f) => f.id === crit[0].id)).toBe(true)
    expect(env.findings.some((f) => rest.some((w) => w.id === f.id))).toBe(false)
    expect(env.rulesRefuted).toBe(rest.length)
  })

  test("policy off (switch or no policy given): only refuted findings are dropped", async () => {
    const base = await run({ switches: { verifyRules: false, rulePolicy: false }, policy: false })
    const env = await run({ verdictAt: () => "unverifiable", policy: false })
    expect(env.findings).toEqual(base.findings)
    expect(env.rulePolicy).toBeUndefined()
  })
})

describe("flags off: unchanged behaviour", () => {
  test("AI lane on with every rule-noise switch off: the envelope equals a run without them", async () => {
    const plain = await runReview({
      changedFiles: [{ path: "models/marts/m.sql", status: "modified", diff: `@@ -1 +1,4 @@\n-select 1\n+${SQL.split("\n").join("\n+")}\n` }],
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      forceTier: "full",
      aiVerify: true,
      aiSwitches: {},
      getContent: async (_f, side) => (side === "old" ? "select 1" : SQL),
      generatedAt: "2026-11-25T00:00:00Z",
      aiReview: async () => ({ findings: [aiFinding], status: { state: "ok" as const } }),
    })
    const off = await run({ switches: { verifyRules: false, rulePolicy: false }, policy: false })
    expect(off).toEqual(plain)
    expect(off.rulesOff).toBeUndefined()
    expect(off.rulesRefuted).toBeUndefined()
    expect(off.rulePolicy).toBeUndefined()
  })

  test("AI lane off: rule types off, the rule verifier and the policy are all no-ops", async () => {
    const plain = await run({ ai: false, switches: {}, policy: false })
    const first = plain.findings[0].rule!
    const withAll = await run({ ai: false, rulesOff: new Set([first]) })
    expect(withAll).toEqual(plain)
    expect(withAll.rulesOff).toBeUndefined()
    expect(withAll.rulePolicy).toBeUndefined()
  })
})

describe("round 2: rule noise fails open", () => {
  test("finder timed out or failed: refuted rule findings are posted and not counted as refuted", async () => {
    // The deterministic review alone: the rule findings a failed AI lane must leave untouched.
    const off = await run({ ai: false })
    for (const finderState of ["timeout", "error"] as const) {
      const env = await run({ verdictAt: () => "refuted", finderState })
      expect(env.findings).toEqual(off.findings)
      expect(env.rulesRefuted).toBeUndefined()
    }
  })

  test("a rule-verifier batch that errored while others answered: its warnings are posted", async () => {
    const seen: AiReviewInput[] = []
    const all = await run({ runner: critRunner }, seen)
    const sent = seen[0].verifyRulesAfter!
    // The critical finding's batch answered; the warning's batch failed (no verdict), run state ok.
    const env = await run({ runner: critRunner, verdictAt: (i) => (sent[i].severity === "critical" ? "confirmed" : undefined) })
    expect(sent.some((f) => f.severity === "warning")).toBe(true)
    expect(env.rulePolicy?.applied).toBe(true)
    expect(env.findings).toEqual(all.findings)
    expect(env.rulePolicy?.dropped.unverifiable_high_sev).toBe(0)
  })

  test("verdict: refuted engine warnings no longer count toward the warning block; a critical one still blocks", async () => {
    const gate = { mode: "gate" as const }
    const confirmed = await run({ ...gate, runner: critRunner, verdictAt: () => "confirmed" })
    expect(confirmed.verdict).toBe("REQUEST_CHANGES")
    const refuted = await run({ ...gate, runner: critRunner, verdictAt: () => "refuted" })
    // The critical contract finding is never dropped, so the PR still blocks.
    expect(refuted.findings.some((f) => f.severity === "critical")).toBe(true)
    expect(refuted.verdict).toBe("REQUEST_CHANGES")
  })
})

describe("round 2: suppressed rule findings are visible", () => {
  test("the PR comment says how many rule findings were not posted, by step", async () => {
    const { renderSummary } = await import("../../src/altimate/review/format")
    const env = await run({ verdictAt: (i) => (i === 0 ? "refuted" : "unverifiable") })
    const refuted = env.rulesRefuted ?? 0
    const policy = (env.rulePolicy?.dropped.unverifiable_high_sev ?? 0) + (env.rulePolicy?.dropped.noisy_type_not_confirmed ?? 0)
    expect(refuted + policy).toBeGreaterThan(0)
    const text = renderSummary(env, { allowSilent: false, maxChars: Infinity })
    expect(text).toContain(`${refuted + policy} rule finding(s) not posted`)
  })

  test("telemetry carries the rule verifier's state and spend and the drop counts", async () => {
    const { spyOn } = await import("bun:test")
    const { emitReviewRun } = await import("../../src/altimate/review/telemetry")
    const { Telemetry } = await import("../../src/altimate/telemetry")
    const env = await run({ verdictAt: () => "refuted", rulesOff: new Set(["x:y"]) })
    const events: any[] = []
    const spy = spyOn(Telemetry, "track").mockImplementation((e: any) => {
      events.push(e)
    })
    try {
      emitReviewRun({ invocation: "cli", durationMs: 1, sessionID: "", envelope: env })
    } finally {
      spy.mockRestore()
    }
    expect(events[0]).toMatchObject({ ai_rule_verify_state: "ok", rules_refuted: env.rulesRefuted, rule_policy_dropped: 0 })
    expect(events[0].rules_off_dropped).toBe(0)
  })
})
