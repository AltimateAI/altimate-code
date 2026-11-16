import { describe, test, expect, spyOn, mock, afterEach } from "bun:test"
import { streamText, tool, type ModelMessage } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import z from "zod"
import { readStreamStep } from "../../src/altimate/llm/stream-text"
import {
  aiVerifyEnabled,
  applyTriage,
  buildVerifyMessage,
  DEFAULT_TRIAGE_KNOBS,
  triage,
  triageKnobs,
  type ModelFeatures,
  type TsFeatures,
  extractFeatures,
  hunkAround,
  numberedSlice,
  parseVerifierOutput,
  VERIFY_SYSTEM_PROMPT,
} from "../../src/altimate/review/ai-verify"
import { makeFinding, type Finding } from "../../src/altimate/review/finding"
import { inlineEligible } from "../../src/altimate/review/format"
import { DEFAULT_POSTING_POLICY } from "../../src/altimate/review/verdict"
import type { AiReviewFile } from "../../src/altimate/review/ai-review"
import { runAiReview } from "../../src/altimate/review/ai-review"
import { createDispatcherRunner } from "../../src/altimate/review/runner"
import { LLM } from "../../src/session/llm"
import { Provider } from "../../src/provider/provider"

/**
 * The dbt-grounded verifier: an opt-in second model call that tries to refute
 * each AI finding with dbt evidence. Every model here is scripted; no test
 * reaches a provider.
 */

describe("wiring", () => {
  afterEach(() => mock.restore())

  test("opt-in only: ALTIMATE_REVIEW_AI_VERIFY must be exactly 1", () => {
    expect(aiVerifyEnabled({})).toBe(false)
    expect(aiVerifyEnabled({ ALTIMATE_REVIEW_AI_VERIFY: "0" })).toBe(false)
    expect(aiVerifyEnabled({ ALTIMATE_REVIEW_AI_VERIFY: "true" })).toBe(false)
    expect(aiVerifyEnabled({ ALTIMATE_REVIEW_AI_VERIFY: "1" })).toBe(true)
  })

  test("readStreamStep keeps the SDK's tool calls and response messages for tools without execute", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "stream-start", warnings: [] })
            c.enqueue({ type: "tool-call", toolCallId: "t1", toolName: "read_file", input: JSON.stringify({ path: "models/a.sql" }) })
            c.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_use" },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 5, text: 5, reasoning: 0 },
              },
            })
            c.close()
          },
        }),
      }),
    })
    const stream = streamText({
      model,
      prompt: "verify",
      tools: { read_file: tool({ description: "read", inputSchema: z.object({ path: z.string() }) }) },
    })
    const step = await readStreamStep(stream)
    expect(step.finishReason).toBe("tool-calls")
    expect(step.toolCalls).toEqual([{ toolCallId: "t1", toolName: "read_file", input: { path: "models/a.sql" }, invalid: undefined }])
    // One assistant message with the call; no tool message, since nothing executed it.
    const msgs = step.messages as ModelMessage[]
    expect(msgs.map((m) => m.role)).toEqual(["assistant"])
    expect(JSON.stringify(msgs[0].content)).toContain('"toolCallId":"t1"')
  })

  test("numberedSlice numbers lines and caps a read at 200 lines", () => {
    const text = Array.from({ length: 300 }, (_, i) => `l${i + 1}`).join("\n")
    expect(numberedSlice("a\nb\nc", 2, 3)).toBe("2: b\n3: c")
    const all = numberedSlice(text)!.split("\n")
    expect(all).toHaveLength(200)
    expect(all[199]).toBe("200: l200")
    expect(numberedSlice("a", 5)).toBe("(the file has 1 lines)")
    expect(numberedSlice(undefined)).toBeUndefined()
  })

  test("the runner's columnReach never throws (no manifest → undefined)", async () => {
    const runner = createDispatcherRunner({ manifestPath: "/nonexistent/manifest.json" })
    expect(await runner.columnReach!("m", "id")).toBeUndefined()
  })

  test("with the env unset, runAiReview makes one call and reports no verifier, even when given evidence", async () => {
    const prev = process.env.ALTIMATE_REVIEW_AI_VERIFY
    delete process.env.ALTIMATE_REVIEW_AI_VERIFY
    try {
      spyOn(Provider, "defaultModel").mockResolvedValue({ providerID: "fake", modelID: "m" } as any)
      spyOn(Provider, "getModel").mockResolvedValue({ providerID: "fake", id: "m", api: { npm: "x" }, cost: {} } as any)
      const answer = JSON.stringify([
        { file: "models/a.sql", line: 1, severity: "warning", category: "sql_correctness", title: "t", body: "b", confidence: "high" },
      ])
      const stream = spyOn(LLM, "stream").mockImplementation(
        async () =>
          ({
            fullStream: (async function* () {})(),
            text: Promise.resolve(answer),
            totalUsage: Promise.resolve(undefined),
            providerMetadata: Promise.resolve(undefined),
          }) as any,
      )
      const evidence = {
        files: [],
        runner: {} as any,
        addedLines: new Map(),
        readFile: async () => undefined,
        compiledSql: async () => undefined,
      }
      const res = await runAiReview({
        files: [{ path: "models/a.sql", status: "modified", model: "a", diff: "@@ -1 +1 @@\n+select 1\n" }],
        grounding: [],
        evidence,
      })
      expect(stream).toHaveBeenCalledTimes(1)
      expect(res.status.state).toBe("ok")
      expect("verifier" in res.status).toBe(false)
      expect(res.findings).toHaveLength(1)
      expect(res.findings[0].evidence).toEqual({ tool: "ai-review", result: { confidence: "high" } })
    } finally {
      if (prev !== undefined) process.env.ALTIMATE_REVIEW_AI_VERIFY = prev
    }
  })
})

// models/fct.sql at head: line 10 context, 11 added, 12 context.
const DIFF = "@@ -10,2 +10,3 @@\n select order_id,\n+  coalesce(amount_cents, 0) / 100 as amount,\n from {{ ref('stg_orders') }}\n"
const FILE: AiReviewFile = { path: "models/fct.sql", status: "modified", model: "fct", diff: DIFF }
const ADDED = new Set([11])
const NAMES = { parents: ["stg_orders", "raw.payments"], downstream: ["rpt_revenue"] }

function aiFinding(over: Partial<Parameters<typeof makeFinding>[0]> = {}): Finding {
  return makeFinding({
    severity: "warning",
    category: "sql_correctness",
    title: "fct: Division drops cents",
    body: "Integer division truncates `amount`.",
    file: "models/fct.sql",
    model: "fct",
    startLine: 11,
    endLine: 11,
    confidence: "medium",
    evidence: { tool: "ai-review", result: { confidence: "medium" } },
    ...over,
  })
}

describe("extractFeatures (deterministic, free)", () => {
  const feats = (f: Finding, grounding: Finding[] = []) => extractFeatures(f, FILE, grounding, NAMES, ADDED)

  test("a finding on an added line: valid line, changed code, nothing else", () => {
    expect(feats(aiFinding())).toEqual({
      evidenceLineValid: true,
      targetsUnchangedCode: false,
      restatesGrounding: false,
      claimsOtherFile: false,
      styleOnly: false,
      lowConfidence: false,
      hedgedDataDiff: false,
    })
  })

  test("evidenceLineValid: off the diff is false, no line is null", () => {
    expect(feats(aiFinding({ startLine: 40, endLine: 40 })).evidenceLineValid).toBe(false)
    expect(feats(aiFinding({ startLine: undefined, endLine: undefined })).evidenceLineValid).toBeNull()
  })

  test("targetsUnchangedCode: a context line, a pre-existing tag, or no line and nothing it names was added", () => {
    expect(feats(aiFinding({ startLine: 10, endLine: 10 })).targetsUnchangedCode).toBe(true)
    expect(feats({ ...aiFinding(), preExisting: true }).targetsUnchangedCode).toBe(true)
    const noLine = { startLine: undefined, endLine: undefined }
    expect(feats(aiFinding({ ...noLine, body: "`amount_cents` may be null" })).targetsUnchangedCode).toBe(false)
    expect(feats(aiFinding({ ...noLine, body: "`order_id` is not unique" })).targetsUnchangedCode).toBe(true)
  })

  test("restatesGrounding: similar title on the same file, or same category and column", () => {
    const g = makeFinding({
      severity: "warning", category: "sql_correctness", title: "fct: division drops cents in amount",
      body: "x", file: "models/fct.sql", model: "fct", evidence: { tool: "rule-catalog", result: { rule: "r" } },
    })
    expect(feats(aiFinding(), [g]).restatesGrounding).toBe(true)
    expect(feats(aiFinding(), [{ ...g, file: "models/other.sql" }]).restatesGrounding).toBe(false)
    const col = { ...g, title: "fct: unrelated wording", column: "amount" }
    expect(feats(aiFinding(), [col]).restatesGrounding).toBe(true)
    expect(feats(aiFinding(), [{ ...col, category: "join_risk" as const }]).restatesGrounding).toBe(false)
  })

  test("claimsOtherFile: a ref to another model, a source, or a graph neighbour by name", () => {
    expect(feats(aiFinding({ body: "`stg_orders` has no `amount_cents`" })).claimsOtherFile).toBe(true)
    expect(feats(aiFinding({ body: "{{ ref('rpt_revenue') }} reads it" })).claimsOtherFile).toBe(true)
    expect(feats(aiFinding({ body: "comes from source('raw', 'payments')" })).claimsOtherFile).toBe(true)
    expect(feats(aiFinding({ body: "`payments` is a source table" })).claimsOtherFile).toBe(true)
    expect(feats(aiFinding({ body: "`fct` divides" })).claimsOtherFile).toBe(false)
  })

  test("styleOnly: sql_quality naming remarks without a correctness word", () => {
    expect(feats(aiFinding({ category: "sql_quality", title: "fct: Alias naming", body: "Use snake_case aliases." })).styleOnly).toBe(true)
    expect(feats(aiFinding({ category: "sql_quality", title: "fct: Alias naming", body: "The alias hides a null." })).styleOnly).toBe(false)
    expect(feats(aiFinding({ title: "fct: Alias naming", body: "Use snake_case aliases." })).styleOnly).toBe(false)
  })

  test("lowConfidence and hedgedDataDiff", () => {
    expect(feats(aiFinding({ confidence: "low" })).lowConfidence).toBe(true)
    expect(feats(aiFinding({ body: "We recommend a data diff before merging." })).hedgedDataDiff).toBe(true)
  })
})

describe("verifier prompt and parser", () => {
  const ids = new Set(["c1", "c2"])
  const item = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    claim_type: "code_fact",
    verdict: "confirmed",
    value: "actionable",
    requires_assumed_input: false,
    evidence: "line 11 divides an integer",
    tools_used: ["compiled_sql"],
    ...over,
  })

  test("the prompt carries the contract and the injection guard", () => {
    expect(VERIFY_SYSTEM_PROMPT).toContain("adversarial verifier")
    expect(VERIFY_SYSTEM_PROMPT).toContain("UNTRUSTED DATA")
    expect(VERIFY_SYSTEM_PROMPT).toContain("At most 3 rounds of tool calls")
    expect(VERIFY_SYSTEM_PROMPT).toContain('"requires_assumed_input"')
  })

  test("a fenced array with prose and a think block around it", () => {
    const text = `<think>is [this] it?</think>Here you go:\n\`\`\`json\n${JSON.stringify([item("c1"), item("c2", { verdict: "refuted" })])}\n\`\`\`\nDone [1].`
    const out = parseVerifierOutput(text, ids)
    expect(out.get("c1")).toEqual({
      claimType: "code_fact",
      verdict: "confirmed",
      value: "actionable",
      requiresAssumedInput: false,
      evidence: "line 11 divides an integer",
      toolsUsed: ["compiled_sql"],
    })
    expect(out.get("c2")?.verdict).toBe("refuted")
  })

  test("brackets inside strings and a leading non-JSON bracket do not break extraction", () => {
    const text = `See [note]. ${JSON.stringify([item("c1", { evidence: "uses arr[0] ] here" })])}`
    expect(parseVerifierOutput(text, ids).get("c1")?.evidence).toBe("uses arr[0] ] here")
  })

  test("bad enums are coerced, unknown ids ignored, evidence clamped, tools filtered", () => {
    const text = JSON.stringify([
      item("c1", { claim_type: "vibes", verdict: "probably", value: "huge", evidence: "x".repeat(500), tools_used: ["grep_project", 3, null] }),
      item("c9"),
      "junk",
    ])
    const out = parseVerifierOutput(text, ids)
    expect([...out.keys()]).toEqual(["c1"])
    const c1 = out.get("c1")!
    expect([c1.claimType, c1.verdict, c1.value]).toEqual(["code_fact", "unverifiable", "actionable"])
    expect(c1.evidence).toHaveLength(240)
    expect(c1.toolsUsed).toEqual(["grep_project"])
  })

  test("no array, malformed JSON, or an object yields nothing (all unreviewed)", () => {
    expect(parseVerifierOutput("I could not decide.", ids).size).toBe(0)
    expect(parseVerifierOutput('[{"id": "c1", "verdict": ', ids).size).toBe(0)
    expect(parseVerifierOutput('{"id": "c1"}', ids).size).toBe(0)
  })

  test("the hunk is the diff around the line, numbered on the head side", () => {
    const h = hunkAround(DIFF, 11)
    expect(h).toContain("  11 +  coalesce(amount_cents, 0) / 100 as amount,")
    expect(h).toContain("  10  select order_id,")
    const far = "@@ -1,1 +1,1 @@\n-a\n+b\n@@ -100,1 +100,1 @@\n-c\n+d\n"
    expect(hunkAround(far, 100)).not.toContain("+b")
    expect(hunkAround(far, 100)).toContain(" 100 +d")
    expect(hunkAround(undefined, 1)).toBe("(no diff)")
  })

  test("the batch message has each candidate's fields and hunk, not the file or grounding", () => {
    const msg = buildVerifyMessage("Fix revenue", [{ id: "c1", finding: aiFinding(), diff: DIFF }])
    expect(msg.startsWith("PR: Fix revenue")).toBe(true)
    for (const line of ["id: c1", "file: models/fct.sql", "line: 11", "category: sql_correctness", "severity: warning", "title: fct: Division drops cents"])
      expect(msg).toContain(line)
    expect(msg).toContain("```diff")
    expect(msg).not.toContain("GROUNDING")
  })
})

describe("triage (first match wins)", () => {
  const TS: TsFeatures = {
    evidenceLineValid: true,
    targetsUnchangedCode: false,
    restatesGrounding: false,
    claimsOtherFile: false,
    styleOnly: false,
    lowConfidence: false,
    hedgedDataDiff: false,
  }
  const M: ModelFeatures = {
    claimType: "code_fact",
    verdict: "confirmed",
    value: "actionable",
    requiresAssumedInput: false,
    evidence: "line 11: / 100 on an integer",
    toolsUsed: ["compiled_sql"],
  }
  const K = DEFAULT_TRIAGE_KNOBS
  const f = aiFinding()
  const rows: Array<[string, Partial<TsFeatures>, Partial<ModelFeatures>, string, string]> = [
    ["1 restates grounding", { restatesGrounding: true }, {}, "discard", "duplicate_of_engine"],
    ["2 refuted with evidence", {}, { verdict: "refuted" }, "discard", "refuted"],
    ["3 cross-file unverifiable", {}, { claimType: "cross_file", verdict: "unverifiable" }, "discard", "unverifiable_cross_file"],
    ["3 cross-file confirmed without tools", {}, { claimType: "cross_file", toolsUsed: [] }, "discard", "unverifiable_cross_file"],
    ["4 speculation", {}, { claimType: "speculation" }, "discard", "speculative"],
    ["4 assumed input, not confirmed", {}, { requiresAssumedInput: true, verdict: "unverifiable" }, "discard", "speculative"],
    ["5 style only", { styleOnly: true }, {}, "discard", "low_value"],
    ["5 nit", {}, { value: "nit" }, "discard", "low_value"],
    ["6 unchanged code, not confirmed", { targetsUnchangedCode: true }, { verdict: "unverifiable" }, "discard", "unchanged_code"],
    ["7 plausible local claim on a valid line", {}, { verdict: "unverifiable" }, "keep", "plausible_local"],
    ["7 plausible local claim hedged to a data diff", { evidenceLineValid: null, hedgedDataDiff: true }, { verdict: "unverifiable", claimType: "convention" }, "keep", "plausible_local"],
    ["8 unverifiable with no line", { evidenceLineValid: null }, { verdict: "unverifiable" }, "discard", "unverifiable"],
    ["8 unverifiable, low confidence", { lowConfidence: true }, { verdict: "unverifiable" }, "discard", "unverifiable"],
    ["9 confirmed but informational", {}, { value: "informational" }, "summary", "informational"],
    ["10 confirmed", {}, {}, "keep", "verified"],
  ]
  for (const [name, ts, m, decision, rule] of rows) {
    test(name, () => {
      expect(triage(f, { ...TS, ...ts }, { ...M, ...m }, K)).toEqual({ decision: decision as any, rule })
    })
  }

  test("refuted without evidence falls through; unchanged code is kept when confirmed, a test gap, or intent", () => {
    expect(triage(f, TS, { ...M, verdict: "refuted", evidence: " " }, K).rule).toBe("verified")
    const unchanged = { ...TS, targetsUnchangedCode: true }
    expect(triage(f, unchanged, M, K).rule).toBe("verified")
    expect(triage({ ...f, category: "test_coverage" }, unchanged, { ...M, verdict: "unverifiable", claimType: "test_gap" }, K).rule).toBe("plausible_local")
    expect(triage(f, unchanged, { ...M, verdict: "unverifiable", claimType: "intent" }, K).rule).toBe("plausible_local")
  })

  test("knobs: nits kept, unverified local claims dropped, fail closed", () => {
    expect(triage(f, TS, { ...M, value: "nit" }, { ...K, dropNits: false }).rule).toBe("verified")
    expect(triage(f, TS, { ...M, verdict: "unverifiable" }, { ...K, keepUnverifiedLocal: false }).rule).toBe("unverifiable")
    expect(triage(f, TS, undefined, K)).toEqual({ decision: "keep", rule: "unreviewed" })
    expect(triage(f, TS, undefined, { ...K, failMode: "closed" })).toEqual({ decision: "discard", rule: "unreviewed" })
    // Without a verdict even a grounding duplicate is left alone: fail-open means unchanged.
    expect(triage(f, { ...TS, restatesGrounding: true }, undefined, K).decision).toBe("keep")
  })

  test("knobs from the environment", () => {
    expect(triageKnobs({})).toEqual(DEFAULT_TRIAGE_KNOBS)
    expect(
      triageKnobs({ ALTIMATE_REVIEW_AI_VERIFY_DROP_NITS: "0", ALTIMATE_REVIEW_AI_VERIFY_KEEP_LOCAL: "0", ALTIMATE_REVIEW_AI_VERIFY_FAIL: "closed" }),
    ).toEqual({ dropNits: false, keepUnverifiedLocal: false, failMode: "closed" })
  })

  test("applyTriage: verified gets evidence and a body suffix, informational moves to the summary, discards are listed", () => {
    const a = aiFinding()
    const b = aiFinding({ title: "fct: Informational note", ruleKey: "b" })
    const c = aiFinding({ title: "fct: Wrong claim", ruleKey: "c" })
    const d = aiFinding({ title: "fct: Not answered", ruleKey: "d" })
    const res = applyTriage([a, b, c, d], [TS, TS, TS, TS], [M, { ...M, value: "informational" }, { ...M, verdict: "refuted", evidence: "line 11 casts first" }, undefined], K)
    expect(res.findings.map((x) => x.title)).toEqual([a.title, b.title, d.title])
    const [va, vb, vd] = res.findings
    expect(va.body).toBe(`${a.body}\n\nVerified: ${M.evidence}`)
    expect(va.severity).toBe(a.severity)
    expect(va.evidence?.tool).toBe("ai-review")
    expect((va.evidence?.result as any).confidence).toBe("medium")
    expect((va.evidence?.result as any).verification).toMatchObject({ decision: "keep", rule: "verified", verdict: "confirmed", features: TS })
    expect(vb.tier).toBe("summary")
    expect(vb.body).toBe(b.body)
    expect(vd).toBe(d)
    expect(res.dropped).toEqual([
      { id: c.id, file: c.file, title: c.title, category: c.category, severity: c.severity, decision: "discard", rule: "refuted", verdict: "refuted", claimType: "code_fact", evidence: "line 11 casts first" },
    ])
    expect(res.counts).toEqual({ reviewed: 3, kept: 2, discarded: 1, summary: 1, unreviewed: 1 })
  })

  test("a finding the verifier moved to the summary is never inline, even from the AI lane", () => {
    const [kept, summary] = applyTriage([aiFinding(), aiFinding({ ruleKey: "s" })], [TS, TS], [M, { ...M, value: "informational" }], K).findings
    expect(inlineEligible(kept, DEFAULT_POSTING_POLICY)).toBe(true)
    expect(inlineEligible({ ...summary, tier: "summary" }, DEFAULT_POSTING_POLICY)).toBe(false)
  })

  test("dropped is capped at 20", () => {
    const many = Array.from({ length: 25 }, (_, i) => aiFinding({ ruleKey: `k${i}` }))
    const res = applyTriage(many, many.map(() => TS), many.map(() => ({ ...M, verdict: "refuted" as const })), K)
    expect(res.findings).toHaveLength(0)
    expect(res.dropped).toHaveLength(20)
    expect(res.counts.discarded).toBe(25)
  })
})
