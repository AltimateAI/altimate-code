import { describe, test, expect, spyOn, mock, afterEach, beforeEach } from "bun:test"
import {
  batchOutcomeState,
  numberedSlice,
  runAiVerify,
  type AiVerifyEvidence,
  type VerifierLlm,
  type VerifierStep,
  type VerifierStepRequest,
} from "../../src/altimate/review/ai-verify"
import { NO_RULE_FINDINGS_REASON, runRuleVerify } from "../../src/altimate/review/ai-verify-rules"
import {
  runAiReview,
  withRuleVerdicts,
  type AiReviewFile,
  type AiReviewInput,
  type AiReviewResult,
} from "../../src/altimate/review/ai-review"
import { envSwitch, resolveAiSwitches, AI_SWITCH_DEFAULTS, type AiSwitches } from "../../src/altimate/review/ai-switches"
import { makeFinding, ruleId, type Finding } from "../../src/altimate/review/finding"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG, parseReviewConfig } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
import { Dispatcher } from "../../src/altimate/native"
import { LLM } from "../../src/session/llm"
import { Provider } from "../../src/provider/provider"
import { mergeProjectEnvelopes } from "../../src/altimate/review/multi-project"

// The rule verifier: after the finder (and its verifier), the rule findings the review would post
// are verified and the refuted ones are not posted. Every model here is scripted.

const DIFF =
  "@@ -10,2 +10,3 @@\n select order_id,\n+  coalesce(amount_cents, 0) / 100 as amount,\n from {{ ref('stg_orders') }}\n"
const HEAD = "select order_id,\n  coalesce(amount_cents, 0) / 100 as amount,\nfrom {{ ref('stg_orders') }}"
const FILE: AiReviewFile = { path: "models/fct.sql", status: "modified", model: "fct", diff: DIFF, sql: HEAD }
const FAKE_MODEL = { providerID: "fake", id: "m", api: { npm: "x" }, cost: {} } as unknown as Provider.Model

function evidence(): AiVerifyEvidence {
  return {
    files: [FILE],
    addedLines: new Map([["models/fct.sql", new Set([11])]]),
    prTitle: "Fix revenue rounding",
    runner: { graphParents: async () => [], downstreamModels: async () => [] } as any,
    readFile: async (_p, side, start, end) => numberedSlice(side === "new" ? HEAD : undefined, start, end),
    compiledSql: async () => HEAD,
  }
}

function ruleFinding(n: number): Finding {
  return makeFinding({
    severity: "warning",
    category: "sql_correctness",
    title: `fct: rule finding ${n}`,
    body: `Rule body ${n}.`,
    file: "models/fct.sql",
    model: "fct",
    startLine: 11,
    endLine: 11,
    confidence: "high",
    evidence: { tool: "dbt-patterns", result: { line: "coalesce(amount_cents, 0) / 100" } },
    ruleKey: `dbt-patterns:rule-${n}`,
    rule: ruleId("dbt-patterns", `rule-${n}`),
  })
}

const verdict = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  claim_type: "code_fact",
  verdict: "confirmed",
  value: "actionable",
  requires_assumed_input: false,
  evidence: "line 11: coalesce(amount_cents, 0) / 100",
  tools_used: ["compiled_sql"],
  ...over,
})

function scripted(script: (req: VerifierStepRequest, turn: number) => Partial<VerifierStep>) {
  const calls: VerifierStepRequest[] = []
  const llm: VerifierLlm = async (req) => {
    calls.push(req)
    return { text: "", finishReason: "stop", toolCalls: [], messages: [], ...script(req, calls.length) }
  }
  return { llm, calls }
}
const candidateIds = (req: VerifierStepRequest) =>
  [...String(req.messages[0].content).matchAll(/^id: (c\d+)$/gm)].map((m) => m[1])

const ENV_KEYS = [
  "ALTIMATE_REVIEW_AI_VERIFY",
  "ALTIMATE_REVIEW_AI_VERIFY_RULES",
  "ALTIMATE_REVIEW_AI_DRYRUN",
  "ALTIMATE_REVIEW_AI_VERIFY_DRYRUN",
  "ALTIMATE_REVIEW_RULES_OFF",
  "ALTIMATE_REVIEW_RULE_POLICY",
  "ALTIMATE_REVIEW_AI_TEST_GAP",
]
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  mock.restore()
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

/** The finder answers `finderItems`; each verifier refutes candidates whose title matches `refute`. */
function scriptModels(finderItems: unknown[], refute: RegExp) {
  spyOn(Provider, "defaultModel").mockResolvedValue({ providerID: "fake", modelID: "m" } as any)
  spyOn(Provider, "getModel").mockResolvedValue(FAKE_MODEL as any)
  spyOn(Dispatcher, "call").mockImplementation((async (method: string) =>
    method === "altimate_core.review_ai_prompt"
      ? { success: true, data: { prompt: "FINDER SYSTEM" } }
      : { success: true, data: { findings: finderItems } }) as any)
  return spyOn(LLM, "stream").mockImplementation(async (input: any) => {
    const content = String(input.messages[0].content)
    let text = "[]"
    if (input.agent.name === "dbt-ai-verifier") {
      const blocks = content.split(/^id: /m).slice(1)
      text = JSON.stringify(
        blocks.map((b) =>
          verdict(b.split("\n")[0].trim(), { verdict: refute.test(/^title: (.*)$/m.exec(b)?.[1] ?? "") ? "refuted" : "confirmed" }),
        ),
      )
    }
    return {
      fullStream: (async function* () {})(),
      text: Promise.resolve(text),
      finishReason: Promise.resolve("stop"),
      response: Promise.resolve({ messages: [{ role: "assistant", content: text }] }),
      totalUsage: Promise.resolve({ inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 }),
      providerMetadata: Promise.resolve(undefined),
    } as any
  })
}

describe("verifyRules switch", () => {
  test("on by default; `drop_refuted`/`1` on, `off`/`0` off; `ai.verifyRules: false` off", () => {
    expect(AI_SWITCH_DEFAULTS.verifyRules).toBe(true)
    expect(envSwitch("verifyRules", { ALTIMATE_REVIEW_AI_VERIFY_RULES: "drop_refuted" })).toBe(true)
    expect(envSwitch("verifyRules", { ALTIMATE_REVIEW_AI_VERIFY_RULES: "1" })).toBe(true)
    expect(envSwitch("verifyRules", { ALTIMATE_REVIEW_AI_VERIFY_RULES: "off" })).toBe(false)
    expect(envSwitch("verifyRules", { ALTIMATE_REVIEW_AI_VERIFY_RULES: "0" })).toBe(false)
    expect(envSwitch("verifyRules", { ALTIMATE_REVIEW_AI_VERIFY_RULES: "only" })).toBeUndefined()
    const cfg = parseReviewConfig("ai:\n  verifyRules: false")
    expect(resolveAiSwitches(cfg, {}).verifyRules).toBe(false)
    expect(resolveAiSwitches(cfg, { ALTIMATE_REVIEW_AI_VERIFY_RULES: "drop_refuted" }).verifyRules).toBe(true)
  })

  test("`ai.verify: false` (or its env `0`) turns rule verification off too", () => {
    expect(resolveAiSwitches(parseReviewConfig("ai:\n  verify: false"), {}).verifyRules).toBe(false)
    expect(resolveAiSwitches({ ai: true }, { ALTIMATE_REVIEW_AI_VERIFY: "0" }).verifyRules).toBe(false)
    expect(resolveAiSwitches({ ai: true }, { ALTIMATE_REVIEW_AI_VERIFY: "0", ALTIMATE_REVIEW_AI_VERIFY_RULES: "1" }).verifyRules).toBe(false)
  })
})

describe("runAiVerify with rulesOnly: verdicts recorded, nothing triaged", () => {
  test("each rule finding gets a verdict record; refuted and unreviewed findings come back unchanged", async () => {
    const rules = [ruleFinding(1), ruleFinding(2), ruleFinding(3)]
    const { llm, calls } = scripted(() => ({
      text: JSON.stringify([
        verdict("c1"),
        verdict("c2", { verdict: "refuted", claim_type: "convention", value: "nit", evidence: "line 11 has no division" }),
      ]),
      usage: { tokens: { input: 900, inputTotal: 1_000, output: 100, reasoning: 0, cacheRead: 100 }, cost: 0.01 },
    }))
    const res = await runAiVerify(
      { findings: rules, grounding: rules, evidence: evidence(), model: FAKE_MODEL, rulesOnly: true },
      { llm, env: {} },
    )
    expect(calls).toHaveLength(1)
    expect(res.findings).toBe(rules)
    expect(res.status).toMatchObject({ state: "ok", reviewed: 2, kept: 3, discarded: 0, summary: 0, unreviewed: 1 })
    expect(res.status.dropped).toBeUndefined()
    expect(res.status.decisions).toBeUndefined()
    expect(res.status.ruleVerdicts!.map((v) => [v.id, v.verdict, v.noVerdict, v.batch])).toEqual([
      [rules[0].id, "confirmed", false, 0],
      [rules[1].id, "refuted", false, 0],
      [rules[2].id, null, true, 0],
    ])
    expect(res.status.ruleVerdicts![1]).toMatchObject({ claimType: "convention", value: "nit", rule: rules[1].rule })
    expect(res.status.batches).toEqual([
      { findings: 3, state: "ok", turns: 1, toolCalls: 0, tokens: { input: 900, inputTotal: 1_000, output: 100, reasoning: 0, cacheRead: 100 } },
    ])
  })

  test("batches of at most 8; each verdict names its batch", async () => {
    const rules = Array.from({ length: 11 }, (_, i) => ruleFinding(i + 1))
    const { llm, calls } = scripted((req) => ({ text: JSON.stringify(candidateIds(req).map((id) => verdict(id))) }))
    const res = await runAiVerify(
      { findings: rules, grounding: [], evidence: evidence(), model: FAKE_MODEL, rulesOnly: true },
      { llm, env: {} },
    )
    expect(calls.map((c) => candidateIds(c).length).sort()).toEqual([3, 8])
    expect(res.status.ruleVerdicts!.map((v) => v.batch)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1])
    expect(res.status).toMatchObject({ reviewed: 11, unreviewed: 0 })
  })

  test("a failed call: every finding without a verdict, state error", async () => {
    const rules = [ruleFinding(1)]
    const llm: VerifierLlm = async () => {
      throw new Error("provider down")
    }
    const res = await runAiVerify(
      { findings: rules, grounding: [], evidence: evidence(), model: FAKE_MODEL, rulesOnly: true },
      { llm, env: {} },
    )
    expect(res.findings).toBe(rules)
    expect(res.status).toMatchObject({ state: "error", reviewed: 0, unreviewed: 1 })
    expect(res.status.ruleVerdicts!.map((v) => v.noVerdict)).toEqual([true])
  })
})

describe("runRuleVerify", () => {
  test("skips without a model call: no evidence, no rule findings, dry run", async () => {
    const llm = scriptModels([], /x/)
    const base: AiReviewInput = { files: [FILE], grounding: [] }
    expect((await runRuleVerify(base, [ruleFinding(1)])).status.verifier).toMatchObject({ state: "skipped" })
    expect((await runRuleVerify({ ...base, evidence: evidence() }, [])).status.verifier).toMatchObject({
      state: "skipped",
      reason: NO_RULE_FINDINGS_REASON,
    })
    const dry = await runRuleVerify({ ...base, evidence: evidence() }, [ruleFinding(1)], { env: { ALTIMATE_REVIEW_AI_DRYRUN: "1" } })
    expect(dry.status.verifier?.state).toBe("skipped")
    expect(llm).not.toHaveBeenCalled()
  })

  test("a skipped run reports every rule finding as kept and unreviewed (fail-open)", async () => {
    const rules = [ruleFinding(1), ruleFinding(2), ruleFinding(3)]
    const noEvidence = await runRuleVerify({ files: [FILE], grounding: [] }, rules)
    expect(noEvidence.status.verifier).toMatchObject({ state: "skipped", reviewed: 0, kept: 3, unreviewed: 3, discarded: 0 })
    const dry = await runRuleVerify({ files: [FILE], grounding: [], evidence: evidence() }, rules, { env: { ALTIMATE_REVIEW_AI_DRYRUN: "1" } })
    expect(dry.status.verifier).toMatchObject({ kept: 3, unreviewed: 3 })
  })
})

describe("runAiReview with verifyRulesAfter", () => {
  test("finder first, then the rule verifier; verdicts recorded, the finder's own status kept", async () => {
    const llm = scriptModels([], /rule finding 1$/)
    const rules = [ruleFinding(1), ruleFinding(2)]
    const res = await runAiReview({ files: [FILE], grounding: rules, evidence: evidence(), verifyRulesAfter: rules })
    expect(llm.mock.calls.map((c: any) => c[0].agent.name)).toEqual(["dbt-ai-reviewer", "dbt-ai-verifier"])
    expect(res.findings).toEqual([])
    expect(res.status).toMatchObject({ state: "ok", calls: 1, verifyRules: "drop_refuted" })
    expect(res.status.verifier?.ruleVerdicts?.map((v) => [v.id, v.verdict])).toEqual([
      [rules[0].id, "refuted"],
      [rules[1].id, "confirmed"],
    ])
    // No AI verifier configured: its counters stay empty; the rule run's spend is under ruleVerifier.
    expect(res.status.verifier).toMatchObject({ state: "skipped", turns: 0, reviewed: 0 })
    expect(res.status.ruleVerifier).toMatchObject({ state: "ok", model: "fake/m", turns: 1, reviewed: 2, unreviewed: 0 })
    expect(res.status.ruleVerifier).not.toHaveProperty("ruleVerdicts")
  })

  test("with the AI verifier on: it verifies the finder's findings first, the rule run comes after", async () => {
    const finderItem = { file: "models/fct.sql", line: 11, severity: "warning", category: "sql_correctness", title: "ai claim", body: "AI body.", confidence: "high" }
    const llm = scriptModels([finderItem], /rule finding 2$/)
    const rules = [ruleFinding(1), ruleFinding(2)]
    const res = await runAiReview({
      files: [FILE],
      grounding: rules,
      evidence: evidence(),
      switches: { verify: true },
      verifyRulesAfter: rules,
    })
    const calls = llm.mock.calls.map((c: any) => [c[0].agent.name, String(c[0].messages[0].content).includes("rule finding 1")])
    expect(calls).toEqual([
      ["dbt-ai-reviewer", true],
      ["dbt-ai-verifier", false],
      ["dbt-ai-verifier", true],
    ])
    expect(res.findings.map((f) => f.title)).toEqual(["fct: ai claim"])
    expect(res.status.verifier).toMatchObject({ state: "ok", reviewed: 1 })
    expect(res.status.verifier?.ruleVerdicts?.map((v) => v.verdict)).toEqual(["confirmed", "refuted"])
    expect(res.status.ruleVerifier).toMatchObject({ state: "ok", reviewed: 2 })
  })

  test("without verifyRulesAfter the lane is exactly the finder lane", async () => {
    const llm = scriptModels([], /x/)
    const res = await runAiReview({ files: [FILE], grounding: [ruleFinding(1)], evidence: evidence() })
    expect(llm.mock.calls.map((c: any) => c[0].agent.name)).toEqual(["dbt-ai-reviewer"])
    expect(res.status.verifyRules).toBeUndefined()
    expect(res.status.ruleVerifier).toBeUndefined()
  })

  test("withRuleVerdicts on a skipped rule run: recorded as skipped, findings untouched", () => {
    const res: AiReviewResult = { findings: [], status: { state: "ok", calls: 1 } }
    const out = withRuleVerdicts(res, { findings: [], status: { state: "skipped", reason: "the verifier's evidence is unavailable", durationMs: 0 } })
    expect(out.findings).toBe(res.findings)
    expect(out.status).toMatchObject({
      state: "ok",
      calls: 1,
      verifyRules: "drop_refuted",
      ruleVerifier: { state: "skipped", reason: "the verifier's evidence is unavailable" },
    })
    expect(out.status.verifier?.ruleVerdicts).toBeUndefined()
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
  async check() {
    return { issues: [], ran: true }
  },
  async equivalence() {
    return { decided: true, equivalent: true }
  },
  async detectPii() {
    return { columns: [] }
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

function run(seen: AiReviewInput[], switches: Partial<AiSwitches>, refuteFirst = true) {
  return runReview({
    changedFiles: [{ path: "models/marts/m.sql", status: "modified", diff: `@@ -1 +1,4 @@\n-select 1\n+${SQL.split("\n").join("\n+")}\n` }],
    config: { ...DEFAULT_REVIEW_CONFIG },
    rubric: DEFAULT_RUBRIC,
    mode: "comment",
    runner,
    forceTier: "full",
    aiVerify: true,
    aiSwitches: switches,
    getContent: async (_f, side) => (side === "old" ? "select 1" : SQL),
    generatedAt: "2026-11-25T00:00:00Z",
    aiReview: async (input) => {
      seen.push(input)
      const rules = input.verifyRulesAfter
      return {
        findings: [aiFinding],
        status: {
          state: "ok",
          ...(rules
            ? {
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
                  ruleVerdicts: rules.map((f, i) => ({
                    id: f.id,
                    file: f.file,
                    title: f.title,
                    rule: f.rule,
                    verdict: i === 0 && refuteFirst ? ("refuted" as const) : ("confirmed" as const),
                    claimType: "code_fact" as const,
                    value: "actionable" as const,
                    evidence: "quoted",
                    toolsUsed: [],
                    noVerdict: false,
                    batch: 0,
                  })),
                  batches: [{ findings: rules.length, state: "ok" as const, turns: 1, toolCalls: 0 }],
                },
                ruleVerifier: {
                  state: "ok" as const,
                  durationMs: 1,
                  turns: 1,
                  toolCalls: 0,
                  reviewed: rules.length,
                  kept: rules.length,
                  discarded: 0,
                  summary: 0,
                  unreviewed: 0,
                },
              }
            : {}),
        },
      }
    },
  })
}

describe("orchestrator: drop_refuted", () => {
  const OFF = { verifyRules: false, rulePolicy: false }
  const ON = { verifyRules: true, rulePolicy: false }

  test("off: no verifyRulesAfter; on: same lane input plus the posted rule findings, refuted ones not posted", async () => {
    const off: AiReviewInput[] = []
    const envOff = await run(off, OFF)
    expect("verifyRulesAfter" in off[0]).toBe(false)
    expect(envOff.rulesRefuted).toBeUndefined()

    const on: AiReviewInput[] = []
    const envOn = await run(on, ON)
    const { verifyRulesAfter, ...rest } = on[0]
    expect(Object.keys(rest).sort()).toEqual(Object.keys(off[0]).sort())
    // Exactly the rule findings the switch-off envelope posts.
    const offRules = envOff.findings.filter((f) => f.origin !== "ai")
    expect(offRules.length).toBeGreaterThan(1)
    expect(verifyRulesAfter!.map((f) => f.id)).toEqual(offRules.map((f) => f.id))
    // The first is refuted: gone; the AI finding and the confirmed rule findings stay.
    expect(envOn.findings).toEqual(envOff.findings.filter((f) => f.id !== verifyRulesAfter![0].id))
    expect(envOn.findings.some((f) => f.origin === "ai")).toBe(true)
    expect(envOn.rulesRefuted).toBe(1)
    expect(envOn.ai?.verifyRules).toBe("drop_refuted")
    expect(envOn.ai?.ruleVerifier).toMatchObject({ state: "ok", reviewed: verifyRulesAfter!.length })

    // Nothing refuted: nothing dropped.
    const none = await run([], ON, false)
    expect(none.findings).toEqual(envOff.findings)
    expect(none.rulesRefuted).toBe(0)
  })

  test("without the AI verifier's evidence (`aiVerify` off) the rule verifier does not run", async () => {
    const seen: AiReviewInput[] = []
    await runReview({
      changedFiles: [{ path: "models/marts/m.sql", status: "modified", diff: `@@ -1 +1,4 @@\n-select 1\n+${SQL.split("\n").join("\n+")}\n` }],
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      forceTier: "full",
      aiSwitches: ON,
      getContent: async (_f, side) => (side === "old" ? "select 1" : SQL),
      aiReview: async (input) => {
        seen.push(input)
        return { findings: [], status: { state: "ok" } }
      },
    })
    expect("verifyRulesAfter" in seen[0]).toBe(false)
  })

  test("rule types off are left out before verification", async () => {
    const all: AiReviewInput[] = []
    await run(all, ON, false)
    const first = all[0].verifyRulesAfter!
    const less: AiReviewInput[] = []
    const seenRules = await runReview({
      changedFiles: [{ path: "models/marts/m.sql", status: "modified", diff: `@@ -1 +1,4 @@\n-select 1\n+${SQL.split("\n").join("\n+")}\n` }],
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      forceTier: "full",
      aiVerify: true,
      aiSwitches: ON,
      rulesOff: new Set([first[0].rule!]),
      getContent: async (_f, side) => (side === "old" ? "select 1" : SQL),
      aiReview: async (input) => {
        less.push(input)
        return { findings: [], status: { state: "ok" } }
      },
    })
    expect(less[0].verifyRulesAfter).toEqual(first.filter((f) => f.rule !== first[0].rule))
    expect(seenRules.rulesOff).toEqual({ [first[0].rule!]: first.filter((f) => f.rule === first[0].rule).length })
  })
})

describe("--all-projects merge of the rule verifier", () => {
  const ON = { verifyRules: true, rulePolicy: false }
  const OFF = { verifyRules: false, rulePolicy: false }

  test("verdict batches are offset by the batches of earlier projects; the model is kept", async () => {
    const a = await run([], ON)
    const b = await run([], ON)
    a.ai!.ruleVerifier!.model = "fake/a"
    const merged = mergeProjectEnvelopes([
      { root: "a", paths: ["a/models/m.sql"], env: a },
      { root: "b", paths: ["b/models/m.sql"], env: b },
    ])
    const v = merged.ai!.verifier!
    const na = a.ai!.verifier!.ruleVerdicts!.length
    expect(v.batches).toHaveLength(2)
    expect(v.ruleVerdicts!.slice(0, na).every((r) => r.batch === 0)).toBe(true)
    expect(v.ruleVerdicts!.slice(na).every((r) => r.batch === 1)).toBe(true)
    expect(merged.ai!.ruleVerifier?.model).toBe("fake/a")
  })

  test("verifyRules is set when only a later project verified its rule findings", async () => {
    const a = await run([], OFF)
    const b = await run([], ON)
    expect(a.ai!.verifyRules).toBeUndefined()
    const merged = mergeProjectEnvelopes([
      { root: "a", paths: ["a/models/m.sql"], env: a },
      { root: "b", paths: ["b/models/m.sql"], env: b },
    ])
    expect(merged.ai!.verifyRules).toBe("drop_refuted")
  })
})

describe("batchOutcomeState", () => {
  test("no batches is ok, not an error read from a missing batch", () => {
    expect(batchOutcomeState([])).toEqual({ state: "ok" })
    expect(batchOutcomeState([{ state: "error", reason: "boom" }])).toEqual({ state: "error", reason: "boom" })
    expect(batchOutcomeState([{ state: "ok" }, { state: "error", reason: "boom" }])).toEqual({ state: "ok", reason: "1 of 2 batches failed: boom" })
  })
})

describe("round 2: the rule verifier runs only after a finder that answered, under a per-PR ceiling", () => {
  test("the finder failed: no rule-verifier call, no verdicts, no drop_refuted", async () => {
    const llm = scriptModels([], /x/)
    spyOn(Dispatcher, "call").mockResolvedValue({ success: true, data: {} } as any)
    const rules = [ruleFinding(1)]
    const res = await runAiReview({ files: [FILE], grounding: rules, evidence: evidence(), verifyRulesAfter: rules })
    expect(res.status.state).toBe("error")
    expect(res.status.verifyRules).toBeUndefined()
    expect(res.status.ruleVerifier).toBeUndefined()
    expect(llm).not.toHaveBeenCalled()
  })


})

describe("round 2: credential-like paths", () => {
  test("rule findings on a file named like a credential file are not sent to the rule verifier", async () => {
    const runner = {
      async impact() {
        return { hasManifest: true, severity: "SAFE", directCount: 0, transitiveCount: 0, testCount: 0 }
      },
      async grade() {
        return { grade: "B" }
      },
      async check() {
        return { issues: [{ rule: "ambiguous-column", severity: "error", category: "correctness", message: "ambiguous column status", line: 3 }], ran: true }
      },
      async equivalence() {
        return { decided: true, equivalent: true }
      },
      async detectPii() {
        return { columns: [] }
      },
    } as unknown as ReviewRunner
    const SQL = "select *\nfrom raw.orders\nwhere status = 'x'\norder by 1"
    const seen: AiReviewInput[] = []
    const changed = (p: string) => ({ path: p, status: "modified" as const, diff: `@@ -1 +1,4 @@\n-select 1\n+${SQL.split("\n").join("\n+")}\n` })
    const env = await runReview({
      changedFiles: [changed("models/marts/m.sql"), { path: "models/secrets.yml", status: "modified" as const, diff: "@@ -1 +1 @@\n-a: 1\n+a: [\n" }],
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner,
      forceTier: "full",
      aiVerify: true,
      aiSwitches: { verifyRules: true },
      getContent: async (f, side) => (f.endsWith(".yml") ? (side === "old" ? "a: 1\n" : "a: [\n") : side === "old" ? "select 1" : SQL),
      generatedAt: "2026-11-27T00:00:00Z",
      aiReview: async (input) => {
        seen.push(input)
        return { findings: [], status: { state: "ok" } }
      },
    })
    const files = new Set((seen[0].verifyRulesAfter ?? []).map((f) => f.file))
    expect(files.has("models/marts/m.sql")).toBe(true)
    // The deterministic lanes still report the file; only the model never sees its findings.
    expect(env.findings.some((f) => f.file === "models/secrets.yml")).toBe(true)
    expect(files.has("models/secrets.yml")).toBe(false)
  })
})
