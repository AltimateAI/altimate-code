import { describe, test, expect, spyOn, mock, afterEach } from "bun:test"
import { streamText, tool, type ModelMessage } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import z from "zod"
import { readStreamStep } from "../../src/altimate/llm/stream-text"
import {
  aiVerifyEnabled,
  ANSWER_NOW,
  ANSWER_DIRECT,
  applyTriage,
  batchFindings,
  retriage,
  runAiVerify,
  toolsChars,
  verifierTools,
  isCredentialPath,
  type AiVerifyEvidence,
  type VerifierLlm,
  type VerifierStep,
  type VerifierStepRequest,
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
  verifyBudget,
  verifySystemPrompt,
} from "../../src/altimate/review/ai-verify"
import { makeFinding, type Finding } from "../../src/altimate/review/finding"
import { inlineEligible } from "../../src/altimate/review/format"
import { DEFAULT_POSTING_POLICY } from "../../src/altimate/review/verdict"
import type { AiReviewFile } from "../../src/altimate/review/ai-review"
import { runAiReview } from "../../src/altimate/review/ai-review"
import { createDispatcherRunner } from "../../src/altimate/review/runner"
import { LLM } from "../../src/session/llm"
import { mkdirSync, writeFileSync } from "fs"
import { execFileSync } from "child_process"
import { grepFixedAt, projectGrepSpecs } from "../../src/altimate/review/git"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { runReview, type ReviewRunner } from "../../src/altimate/review/orchestrate"
import { DEFAULT_REVIEW_CONFIG } from "../../src/altimate/review/config"
import { DEFAULT_RUBRIC } from "../../src/altimate/review/rubric"
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
            c.enqueue({
              type: "tool-call",
              toolCallId: "t1",
              toolName: "read_file",
              input: JSON.stringify({ path: "models/a.sql" }),
            })
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
    expect(step.toolCalls).toEqual([
      { toolCallId: "t1", toolName: "read_file", input: { path: "models/a.sql" }, invalid: undefined },
    ])
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
    expect(runner.failures!()).toEqual([])
  })

  test("the runner's columnReach answers an unknown model with undefined, not an engine failure", async () => {
    await using tmp = await tmpdir()
    const manifestPath = path.join(tmp.path, "manifest.json")
    writeFileSync(manifestPath, JSON.stringify({ metadata: {}, nodes: { "model.p.fct": { resource_type: "model", name: "fct", depends_on: { nodes: [] } } } }))
    const runner = createDispatcherRunner({ manifestPath })
    expect(await runner.columnReach!("no_such_model", "id")).toBeUndefined()
    expect(runner.failures!()).toEqual([])
  })

  test("with the env unset, runAiReview makes one call and reports no verifier, even when given evidence", async () => {
    const prev = process.env.ALTIMATE_REVIEW_AI_VERIFY
    delete process.env.ALTIMATE_REVIEW_AI_VERIFY
    try {
      spyOn(Provider, "defaultModel").mockResolvedValue({ providerID: "fake", modelID: "m" } as any)
      spyOn(Provider, "getModel").mockResolvedValue({ providerID: "fake", id: "m", api: { npm: "x" }, cost: {} } as any)
      const answer = JSON.stringify([
        {
          file: "models/a.sql",
          line: 1,
          severity: "warning",
          category: "sql_correctness",
          title: "t",
          body: "b",
          confidence: "high",
        },
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
const DIFF =
  "@@ -10,2 +10,3 @@\n select order_id,\n+  coalesce(amount_cents, 0) / 100 as amount,\n from {{ ref('stg_orders') }}\n"
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
      severity: "warning",
      category: "sql_correctness",
      title: "fct: division drops cents in amount",
      body: "x",
      file: "models/fct.sql",
      model: "fct",
      evidence: { tool: "rule-catalog", result: { rule: "r" } },
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
    expect(
      feats(aiFinding({ category: "sql_quality", title: "fct: Alias naming", body: "Use snake_case aliases." }))
        .styleOnly,
    ).toBe(true)
    expect(
      feats(aiFinding({ category: "sql_quality", title: "fct: Alias naming", body: "The alias hides a null." }))
        .styleOnly,
    ).toBe(false)
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
      item("c1", {
        claim_type: "vibes",
        verdict: "probably",
        value: "huge",
        evidence: "x".repeat(500),
        tools_used: ["grep_project", 3, null],
      }),
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
    for (const line of [
      "id: c1",
      "file: models/fct.sql",
      "line: 11",
      "category: sql_correctness",
      "severity: warning",
      "title: fct: Division drops cents",
    ])
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
    [
      "3 cross-file unverifiable",
      {},
      { claimType: "cross_file", verdict: "unverifiable" },
      "summary",
      "unverifiable_cross_file",
    ],
    [
      "3 cross-file confirmed without tools",
      {},
      { claimType: "cross_file", toolsUsed: [] },
      "summary",
      "unverifiable_cross_file",
    ],
    ["4 speculation", {}, { claimType: "speculation" }, "summary", "speculative"],
    [
      "4 assumed input, not confirmed",
      {},
      { requiresAssumedInput: true, verdict: "unverifiable" },
      "summary",
      "speculative",
    ],
    ["5 style only", { styleOnly: true }, {}, "discard", "low_value"],
    ["5 nit", {}, { value: "nit" }, "discard", "low_value"],
    [
      "6 unchanged code, not confirmed",
      { targetsUnchangedCode: true },
      { verdict: "unverifiable" },
      "discard",
      "unchanged_code",
    ],
    ["7 plausible local claim on a valid line", {}, { verdict: "unverifiable" }, "keep", "plausible_local"],
    [
      "7 plausible local claim hedged to a data diff",
      { evidenceLineValid: null, hedgedDataDiff: true },
      { verdict: "unverifiable", claimType: "convention" },
      "keep",
      "plausible_local",
    ],
    [
      "8 unverifiable with no line",
      { evidenceLineValid: null },
      { verdict: "unverifiable" },
      "discard",
      "unverifiable",
    ],
    ["8 unverifiable, low confidence", { lowConfidence: true }, { verdict: "unverifiable" }, "discard", "unverifiable"],
    ["9 confirmed but informational", {}, { value: "informational" }, "summary", "informational"],
    ["10 confirmed", {}, {}, "keep", "verified"],
  ]
  for (const [name, ts, m, decision, rule] of rows) {
    test(name, () => {
      expect(triage(f, { ...TS, ...ts }, { ...M, ...m }, K)).toEqual({ decision: decision as any, rule })
    })
  }

  test("refuted without evidence counts as unverifiable; unchanged code is kept when confirmed, a test gap, or intent", () => {
    const bare = { ...M, verdict: "refuted" as const, evidence: " " }
    // Never labelled verified: it is judged like an unverifiable claim.
    expect(triage(f, TS, bare, K).rule).toBe("plausible_local")
    expect(triage(f, { ...TS, evidenceLineValid: false }, bare, K)).toEqual({ decision: "discard", rule: "unverifiable" })
    expect(triage(f, TS, { ...bare, claimType: "cross_file" }, K).decision).toBe("summary")
    const unchanged = { ...TS, targetsUnchangedCode: true }
    expect(triage(f, unchanged, M, K).rule).toBe("verified")
    expect(
      triage(
        { ...f, category: "test_coverage" },
        unchanged,
        { ...M, verdict: "unverifiable", claimType: "test_gap" },
        K,
      ).rule,
    ).toBe("plausible_local")
    expect(triage(f, unchanged, { ...M, verdict: "unverifiable", claimType: "intent" }, K).rule).toBe("plausible_local")
  })

  test("knobs: nits kept, unverified local claims dropped, fail closed", () => {
    expect(triage(f, TS, { ...M, value: "nit" }, { ...K, dropNits: false }).rule).toBe("verified")
    expect(triage(f, TS, { ...M, verdict: "unverifiable" }, { ...K, keepUnverifiedLocal: false }).rule).toBe(
      "unverifiable",
    )
    expect(triage(f, TS, undefined, K)).toEqual({ decision: "keep", rule: "unreviewed" })
    expect(triage(f, TS, undefined, { ...K, failMode: "closed" })).toEqual({ decision: "discard", rule: "unreviewed" })
    // Without a verdict even a grounding duplicate is left alone: fail-open means unchanged.
    expect(triage(f, { ...TS, restatesGrounding: true }, undefined, K).decision).toBe("keep")
  })

  test("knobs from the environment", () => {
    expect(triageKnobs({})).toEqual(DEFAULT_TRIAGE_KNOBS)
    expect(
      triageKnobs({
        ALTIMATE_REVIEW_AI_VERIFY_DROP_NITS: "0",
        ALTIMATE_REVIEW_AI_VERIFY_KEEP_LOCAL: "0",
        ALTIMATE_REVIEW_AI_VERIFY_FAIL: "closed",
      }),
    ).toEqual({ dropNits: false, keepUnverifiedLocal: false, failMode: "closed" })
  })

  test("applyTriage: verified gets evidence and a body suffix, informational moves to the summary, discards are listed", () => {
    const a = aiFinding()
    const b = aiFinding({ title: "fct: Informational note", ruleKey: "b" })
    const c = aiFinding({ title: "fct: Wrong claim", ruleKey: "c" })
    const d = aiFinding({ title: "fct: Not answered", ruleKey: "d" })
    const res = applyTriage(
      [a, b, c, d],
      [TS, TS, TS, TS],
      [M, { ...M, value: "informational" }, { ...M, verdict: "refuted", evidence: "line 11 casts first" }, undefined],
      K,
    )
    expect(res.findings.map((x) => x.title)).toEqual([a.title, b.title, d.title])
    const [va, vb, vd] = res.findings
    expect(va.body).toBe(`${a.body}\n\nVerified: ${M.evidence}`)
    expect(va.severity).toBe(a.severity)
    expect(va.evidence?.tool).toBe("ai-review")
    expect((va.evidence?.result as any).confidence).toBe("medium")
    expect((va.evidence?.result as any).verification).toMatchObject({
      decision: "keep",
      rule: "verified",
      verdict: "confirmed",
      features: TS,
    })
    expect(vb.tier).toBe("summary")
    expect(vb.body).toBe(b.body)
    expect(vd).toBe(d)
    expect(res.dropped).toEqual([
      {
        id: c.id,
        file: c.file,
        ...(c.startLine ? { startLine: c.startLine } : {}),
        title: c.title,
        body: c.body,
        category: c.category,
        severity: c.severity,
        decision: "discard",
        rule: "refuted",
        verdict: "refuted",
        claimType: "code_fact",
        evidence: "line 11 casts first",
      },
    ])
    expect(res.counts).toEqual({ reviewed: 3, kept: 2, discarded: 1, summary: 1, unreviewed: 1 })
  })

  test("a finding the verifier moved to the summary is never inline, even from the AI lane", () => {
    const [kept, summary] = applyTriage(
      [aiFinding(), aiFinding({ ruleKey: "s" })],
      [TS, TS],
      [M, { ...M, value: "informational" }],
      K,
    ).findings
    // The orchestrator stamps AI findings `inline` by default (`ruleTier`).
    expect(inlineEligible({ ...kept, tier: "inline" }, DEFAULT_POSTING_POLICY)).toBe(true)
    expect(inlineEligible({ ...summary, tier: "summary" }, DEFAULT_POSTING_POLICY)).toBe(false)
    // A config rule that re-tiers AI findings to inline does not undo the demotion.
    expect(inlineEligible({ ...summary, tier: "inline" }, DEFAULT_POSTING_POLICY)).toBe(false)
  })

  test("dropped is capped at 20", () => {
    const many = Array.from({ length: 25 }, (_, i) => aiFinding({ ruleKey: `k${i}` }))
    const res = applyTriage(
      many,
      many.map(() => TS),
      many.map(() => ({ ...M, verdict: "refuted" as const })),
      K,
    )
    expect(res.findings).toHaveLength(0)
    expect(res.dropped).toHaveLength(20)
    expect(res.counts.discarded).toBe(25)
  })
})

// ---------------------------------------------------------------------------
// The tool loop, with a scripted model
// ---------------------------------------------------------------------------

const FAKE_MODEL = { providerID: "fake", id: "verifier", api: { npm: "x" }, cost: {} } as unknown as Provider.Model

function evidence(over: Partial<AiVerifyEvidence> = {}): AiVerifyEvidence {
  const heads: Record<string, string> = {
    "models/fct.sql": "select order_id,\n  coalesce(amount_cents, 0) / 100 as amount,\nfrom {{ ref('stg_orders') }}",
    "models/stg_orders.sql": "select id as order_id, amount_cents from raw.orders",
  }
  return {
    dialect: "snowflake",
    files: [FILE],
    addedLines: new Map([["models/fct.sql", ADDED]]),
    prTitle: "Fix revenue rounding",
    prBody: "Divide cents by 100.",
    runner: {
      async graphParents() {
        return [{ path: "models/stg_orders.sql", kind: "model", name: "stg_orders", forPaths: ["models/fct.sql"] }]
      },
      async downstreamModels() {
        return [{ name: "rpt_revenue", path: "models/rpt_revenue.sql" }]
      },
      async columnLineage(sql: string) {
        return sql.includes("amount_cents from raw")
          ? [{ source: "raw.orders.amount_cents", target: "amount_cents" }]
          : []
      },
    } as any,
    readFile: async (p, side, start, end) => numberedSlice(side === "new" ? heads[p] : undefined, start, end),
    compiledSql: async (p, side) => (side === "new" ? heads[p] : undefined),
    grepProject: async (pattern) => [{ path: "models/rpt_revenue.sql", line: 3, text: `sum(${pattern})` }],
    ...over,
  }
}

function scripted(
  script: (req: VerifierStepRequest, turn: number) => Partial<VerifierStep> | Promise<Partial<VerifierStep>>,
) {
  const calls: VerifierStepRequest[] = []
  const llm: VerifierLlm = async (req) => {
    calls.push(req)
    return { text: "", finishReason: "stop", toolCalls: [], messages: [], ...(await script(req, calls.length)) }
  }
  return { llm, calls }
}

function toolStep(calls: Array<[string, unknown]>, usage?: VerifierStep["usage"]): Partial<VerifierStep> {
  const toolCalls = calls.map(([toolName, input], k) => ({ toolCallId: `t${k}-${Math.random()}`, toolName, input }))
  return {
    finishReason: "tool-calls",
    toolCalls,
    messages: [{ role: "assistant", content: toolCalls.map((c) => ({ type: "tool-call" as const, ...c })) }],
    usage,
  }
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

/** The tool results the loop sent back to the model, in order. */
function toolResults(req: VerifierStepRequest): string[] {
  return req.messages.flatMap((m) =>
    m.role === "tool"
      ? m.content.flatMap((p) => (p.type === "tool-result" && p.output.type === "text" ? [p.output.value] : []))
      : [],
  )
}

const verify = (
  findings: Finding[],
  llm: VerifierLlm,
  over: Partial<AiVerifyEvidence> = {},
  deps: { env?: Record<string, string>; timeoutMs?: number } = {},
) => runAiVerify({ findings, grounding: [], evidence: evidence(over), model: FAKE_MODEL }, { llm, env: {}, ...deps })

describe("runAiVerify: the bounded tool loop", () => {
  test("a confirmed finding is kept with its verification; one call, no tools", async () => {
    const { llm, calls } = scripted(() => ({ text: JSON.stringify([verdict("c1")]) }))
    const { findings, status } = await verify([aiFinding()], llm)
    expect(calls).toHaveLength(1)
    expect(calls[0].toolChoice).toBe("auto")
    expect(calls[0].system).toContain("adversarial verifier")
    expect(Object.keys(calls[0].tools).sort()).toEqual([
      "column_reach",
      "compiled_sql",
      "downstream",
      "equivalence",
      "grain",
      "grep_project",
      "model_columns",
      "model_config",
      "pr_description",
      "read_file",
    ])
    expect(findings).toHaveLength(1)
    expect((findings[0].evidence?.result as any).verification).toMatchObject({ decision: "keep", rule: "verified" })
    expect(findings[0].body).toContain("Verified: line 11")
    expect(status).toMatchObject({
      state: "ok",
      turns: 1,
      toolCalls: 0,
      reviewed: 1,
      kept: 1,
      discarded: 0,
      unreviewed: 0,
    })
  })

  test("tool results go back to the model; after 3 rounds the answer is forced with toolChoice none", async () => {
    const { llm, calls } = scripted((req) =>
      req.toolChoice === "none"
        ? { text: JSON.stringify([verdict("c1")]) }
        : toolStep([["compiled_sql", { path: "models/fct.sql" }]]),
    )
    const { status } = await verify([aiFinding()], llm)
    expect(calls.map((c) => c.toolChoice)).toEqual(["auto", "auto", "auto", "none"])
    const last = calls[3]
    expect(last.messages.at(-1)).toEqual({ role: "user", content: ANSWER_NOW })
    expect(toolResults(last)).toHaveLength(3)
    expect(toolResults(last)[0]).toContain("coalesce(amount_cents, 0) / 100")
    expect(status).toMatchObject({ state: "ok", turns: 4, toolCalls: 3 })
  })

  test("budget env overrides: tokens, tool-output characters and rounds; defaults otherwise", () => {
    expect(verifyBudget({})).toEqual({ maxTokens: 12_000, maxToolChars: 16_000, maxRounds: 3 })
    expect(
      verifyBudget({
        ALTIMATE_REVIEW_AI_VERIFY_MAX_TOKENS: "24000",
        ALTIMATE_REVIEW_AI_VERIFY_MAX_TOOL_CHARS: "32000",
        ALTIMATE_REVIEW_AI_VERIFY_MAX_ROUNDS: "5",
      }),
    ).toEqual({ maxTokens: 24_000, maxToolChars: 32_000, maxRounds: 5 })
    expect(verifyBudget({ ALTIMATE_REVIEW_AI_VERIFY_MAX_ROUNDS: "0", ALTIMATE_REVIEW_AI_VERIFY_MAX_TOOL_CHARS: "x" })).toEqual(
      { maxTokens: 12_000, maxToolChars: 16_000, maxRounds: 3 },
    )
    expect(verifySystemPrompt()).toBe(VERIFY_SYSTEM_PROMPT)
    expect(verifySystemPrompt(5)).toContain("At most 5 rounds of tool calls")
  })

  test("ALTIMATE_REVIEW_AI_VERIFY_MAX_ROUNDS limits the rounds and the prompt states it", async () => {
    const { llm, calls } = scripted((req) =>
      req.toolChoice === "none"
        ? { text: JSON.stringify([verdict("c1")]) }
        : toolStep([["compiled_sql", { path: "models/fct.sql" }]]),
    )
    await verify([aiFinding()], llm, {}, { env: { ALTIMATE_REVIEW_AI_VERIFY_MAX_ROUNDS: "1" } })
    expect(calls.map((c) => c.toolChoice)).toEqual(["auto", "none"])
    expect(calls[0].system).toContain("At most 1 rounds of tool calls")
  })

  test("ALTIMATE_REVIEW_AI_VERIFY_MAX_TOOL_CHARS caps the tool output before the answer is forced", async () => {
    const long = "x".repeat(10_000)
    const step = () =>
      scripted((req) =>
        req.toolChoice === "none" ? { text: JSON.stringify([verdict("c1")]) } : toolStep([["read_file", { path: "models/fct.sql" }]]),
      )
    const env = { ALTIMATE_REVIEW_AI_VERIFY_MAX_TOKENS: "1000000" }
    const wide = step()
    await verify([aiFinding()], wide.llm, { readFile: async () => long }, { env })
    expect(wide.calls.map((c) => c.toolChoice)).toEqual(["auto", "auto", "auto", "none"])
    const narrow = step()
    const res = await verify(
      [aiFinding()],
      narrow.llm,
      { readFile: async () => long },
      { env: { ...env, ALTIMATE_REVIEW_AI_VERIFY_MAX_TOOL_CHARS: "2000" } },
    )
    // One read (about 2,500 characters) spends the 2,000-character budget: the next call must answer.
    expect(narrow.calls.map((c) => c.toolChoice)).toEqual(["auto", "none"])
    expect(res.status.state).toBe("budget")
  })

  test("a round is planned at its typical tool output, not the worst case, so a batch of 8 can use tools", async () => {
    const eight = Array.from({ length: 8 }, (_, i) => aiFinding({ ruleKey: `k${i}` }))
    const { llm, calls } = scripted((req) =>
      req.toolChoice === "none"
        ? { text: JSON.stringify(eight.map((_, i) => verdict(`c${i + 1}`))) }
        : toolStep([["pr_description", {}]]),
    )
    // 8,000 tokens fit one round at two full tool outputs, not at six (the worst case).
    await verify(eight, llm, {}, { env: { ALTIMATE_REVIEW_AI_VERIFY_MAX_TOKENS: "8000" } })
    expect(calls[0].toolChoice).toBe("auto")
  })

  test("a spent token budget forces the answer early and reports budget", async () => {
    const big = { tokens: { input: 30_000, inputTotal: 30_000, output: 10, reasoning: 0, cacheRead: 0 }, cost: 0.1 }
    const { llm, calls } = scripted((req) =>
      req.toolChoice === "none" ? { text: JSON.stringify([verdict("c1")]) } : toolStep([["pr_description", {}]], big),
    )
    const { findings, status } = await verify([aiFinding()], llm)
    expect(calls.map((c) => c.toolChoice)).toEqual(["auto", "none"])
    expect(status.state).toBe("budget")
    expect(status.tokens?.inputTotal).toBe(30_000)
    expect(status.cost).toBeCloseTo(0.1, 10)
    // The forced answer still counts.
    expect(status.reviewed).toBe(1)
    expect(findings).toHaveLength(1)
  })

  test("the env budget override and the tool-output budget both force the answer", async () => {
    const small = { tokens: { input: 600, inputTotal: 600, output: 10, reasoning: 0, cacheRead: 0 }, cost: 0 }
    const a = scripted((req) =>
      req.toolChoice === "none" ? { text: JSON.stringify([verdict("c1")]) } : toolStep([["pr_description", {}]], small),
    )
    // A budget too small for a tool round and an answer: answer straight away, without tools.
    const res = await verify([aiFinding()], a.llm, {}, { env: { ALTIMATE_REVIEW_AI_VERIFY_MAX_TOKENS: "500" } })
    expect(a.calls.map((c) => c.toolChoice)).toEqual(["none"])
    expect(a.calls[0].messages).toHaveLength(1)
    expect(String(a.calls[0].messages[0].content).endsWith(ANSWER_DIRECT)).toBe(true)
    expect(res.status.state).toBe("budget")

    // An unparsable forced answer is an error, not budget: every finding went unreviewed.
    const empty = scripted(() => ({ text: "[]" }))
    const failed = await verify([aiFinding()], empty.llm, {}, { env: { ALTIMATE_REVIEW_AI_VERIFY_MAX_TOKENS: "500" } })
    expect(empty.calls.map((c) => c.toolChoice)).toEqual(["none"])
    expect(failed.status.state).toBe("error")
    expect(failed.status.reason).toContain("no parsable verdicts")

    const long = "x".repeat(10_000)
    const b = scripted((req) =>
      req.toolChoice === "none"
        ? { text: "[]" }
        : toolStep([
            ["read_file", { path: "models/fct.sql" }],
            ["read_file", { path: "models/fct.sql" }],
            ["read_file", { path: "models/fct.sql" }],
            ["read_file", { path: "models/fct.sql" }],
            ["read_file", { path: "models/fct.sql" }],
            ["read_file", { path: "models/fct.sql" }],
            ["read_file", { path: "models/fct.sql" }],
          ]),
    )
    await verify(
      [aiFinding()],
      b.llm,
      { readFile: async () => long },
      { env: { ALTIMATE_REVIEW_AI_VERIFY_MAX_TOKENS: "1000000" } },
    )
    // 6 calls × 2,500 chars (+ truncation marks) exceed 16,000 only after the second round.
    expect(b.calls.map((c) => c.toolChoice)).toEqual(["auto", "auto", "none"])
    const results = toolResults(b.calls[1])
    expect(results).toHaveLength(7)
    expect(results[0].length).toBeLessThanOrEqual(2_500 + 20)
    expect(results[6]).toBe("not available: at most 6 tool calls per round")
  })

  test("the forced answer is budgeted: total tokens stay within the share even with large tool output", async () => {
    // A model that reports usage proportional to what it is sent and always wants more tools.
    const spent: number[] = []
    const llm: VerifierLlm = async (req) => {
      const input = Math.ceil((req.system.length + JSON.stringify(req.messages).length + 4_000) / 4)
      const usage = { tokens: { input, inputTotal: input, output: 300, reasoning: 0, cacheRead: 0 }, cost: 0 }
      spent.push(input + 300)
      if (req.toolChoice === "none")
        return { text: JSON.stringify([verdict("c1")]), finishReason: "stop", toolCalls: [], messages: [], usage }
      return {
        text: "",
        ...toolStep(Array.from({ length: 6 }, () => ["read_file", { path: "models/fct.sql" }] as [string, unknown])),
        usage,
      } as VerifierStep
    }
    const long = "y".repeat(2_400)
    for (const budget of [12_000, 8_000, 20_000]) {
      spent.length = 0
      const { status } = await verify(
        [aiFinding()],
        llm,
        { readFile: async () => long },
        {
          env: { ALTIMATE_REVIEW_AI_VERIFY_MAX_TOKENS: String(budget) },
        },
      )
      const total = spent.reduce((a, b) => a + b, 0)
      expect(total).toBeLessThanOrEqual(budget)
      expect(status.tokens!.inputTotal + status.tokens!.output).toBe(total)
      expect(status.reviewed).toBe(1)
    }
    // Under the default 12k the batch gets one tool round, then the reserved answer.
    spent.length = 0
    const { status } = await verify([aiFinding()], llm, { readFile: async () => long })
    expect(status.turns).toBe(2)
    expect(status.state).toBe("budget")
    expect(spent.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(12_000)
  })

  test("reads are limited to changed files, their parents and downstream models", async () => {
    const { llm, calls } = scripted((req, turn) =>
      turn === 1
        ? toolStep([
            ["read_file", { path: "models/secret.sql" }],
            ["read_file", { path: "../etc/passwd" }],
            ["read_file", { path: "models/stg_orders.sql", start: 1, end: 1 }],
            ["compiled_sql", { path: "stg_orders.sql" }],
            ["read_file", { path: "models/rpt_revenue.sql", side: "old" }],
          ])
        : { text: JSON.stringify([verdict("c1")]) },
    )
    await verify([aiFinding()], llm)
    const [secret, traversal, parent, bySuffix, downstreamOld] = toolResults(calls[1])
    expect(secret).toBe(
      "not available: outside review scope (files the PR changes, their dbt parents and direct downstream models only)",
    )
    expect(traversal).toStartWith("not available: outside review scope")
    expect(parent).toBe("1: select id as order_id, amount_cents from raw.orders")
    expect(bySuffix).toBe("select id as order_id, amount_cents from raw.orders")
    expect(downstreamOld).toBe("not available: models/rpt_revenue.sql does not exist on that side")
  })

  test("the dbt tools answer from the runner; failures and unknown tools say not available", async () => {
    const { llm, calls } = scripted((req, turn) =>
      turn === 1
        ? toolStep([
            ["model_columns", { model: "stg_orders" }],
            ["grep_project", { pattern: "amount" }],
            ["pr_description", {}],
            ["column_reach", { model: "fct", column: "amount" }],
            ["drop_table", { name: "x" }],
            ["model_columns", {}],
          ])
        : { text: JSON.stringify([verdict("c1")]) },
    )
    await verify([aiFinding()], llm)
    const r = toolResults(calls[1])
    expect(JSON.parse(r[0])).toEqual({ model: "stg_orders", columns: ["amount_cents"], contractColumns: [] })
    expect(r[1]).toBe("models/rpt_revenue.sql:3: sum(amount)")
    expect(r[2]).toBe("Fix revenue rounding\n\nDivide cents by 100.")
    expect(r[3]).toBe("not available: no dbt manifest")
    expect(r[4]).toBe("not available: unknown tool or malformed call: drop_table")
    expect(r[5]).toStartWith("not available: invalid input for model_columns")
  })

  test("a tool that throws returns not available instead of failing the loop", async () => {
    const { llm, calls } = scripted((req, turn) =>
      turn === 1 ? toolStep([["compiled_sql", { path: "models/fct.sql" }]]) : { text: JSON.stringify([verdict("c1")]) },
    )
    const { status } = await verify([aiFinding()], llm, {
      compiledSql: async () => {
        throw new Error("compiled dir unreadable")
      },
    })
    expect(toolResults(calls[1])).toEqual(["not available: compiled dir unreadable"])
    expect(status.state).toBe("ok")
  })

  test("calls the SDK already answered (invalid calls) are not answered twice", async () => {
    const { llm, calls } = scripted((req, turn) => {
      if (turn > 1) return { text: JSON.stringify([verdict("c1")]) }
      const step = toolStep([
        ["read_file", { path: "models/fct.sql" }],
        ["nope", {}],
      ])
      const bad = step.toolCalls![1]
      step.toolCalls![1] = { ...bad, invalid: true }
      step.messages!.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: bad.toolCallId,
            toolName: "nope",
            output: { type: "error-text", value: "no such tool" },
          },
        ],
      })
      return step
    })
    await verify([aiFinding()], llm)
    const ids = calls[1].messages.flatMap((m) => (m.role === "tool" ? m.content.map((p) => (p as any).toolCallId) : []))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(2)
  })

  test("ids the model omits stay unchanged (fail-open); a refuted one is dropped and listed", async () => {
    const a = aiFinding()
    const b = aiFinding({ title: "fct: Second claim", ruleKey: "b" })
    const { llm } = scripted(() => ({
      text: JSON.stringify([verdict("c2", { verdict: "refuted", evidence: "line 11 casts first" })]),
    }))
    const { findings, status } = await verify([a, b], llm)
    expect(findings).toEqual([a])
    expect(status).toMatchObject({ state: "ok", reviewed: 1, unreviewed: 1, kept: 1, discarded: 1 })
    expect(status.dropped).toEqual([expect.objectContaining({ id: b.id, rule: "refuted", verdict: "refuted" })])
  })

  test("malformed JSON leaves every finding unchanged and reports an error", async () => {
    const f = aiFinding()
    const { llm } = scripted(() => ({ text: '[{"id": "c1", "verdict": "refu' }))
    const { findings, status } = await verify([f], llm)
    expect(findings).toEqual([f])
    expect(status).toMatchObject({
      state: "error",
      reason: "the verifier returned no parsable verdicts",
      unreviewed: 1,
      kept: 1,
    })
  })

  test("a model call that throws leaves the findings unchanged", async () => {
    const f = aiFinding()
    const llm: VerifierLlm = async () => {
      throw new Error("401 bad key sk-abcdefghijklmnop")
    }
    const { findings, status } = await verify([f], llm)
    expect(findings).toEqual([f])
    expect(status.state).toBe("error")
    expect(status.reason).not.toContain("abcdefghijklmnop")
  })

  test("a timeout aborts the call and leaves the findings unchanged", async () => {
    const f = aiFinding()
    const llm: VerifierLlm = (req) =>
      new Promise((_, reject) => req.abort.addEventListener("abort", () => reject(new Error("aborted"))))
    const { findings, status } = await verify([f], llm, {}, { timeoutMs: 20 })
    expect(findings).toEqual([f])
    expect(status.state).toBe("timeout")
  })

  test("the timeout also interrupts a pending evidence tool", async () => {
    const f = aiFinding()
    const { llm } = scripted(() => toolStep([["read_file", { path: "models/fct.sql" }]]))
    // The read never settles; the deadline must still end the run.
    const { findings, status } = await verify([f], llm, { readFile: () => new Promise<string>(() => {}) }, { timeoutMs: 20 })
    expect(findings).toEqual([f])
    expect(status.state).toBe("timeout")
  })

  test("an unexpected failure honours ALTIMATE_REVIEW_AI_VERIFY_FAIL=closed", async () => {
    const f = aiFinding()
    const { llm } = scripted(() => ({ text: "[]" }))
    const broken = { addedLines: undefined as any }
    const open = await verify([f], llm, broken)
    expect(open.findings).toEqual([f])
    const closed = await verify([f], llm, broken, { env: { ALTIMATE_REVIEW_AI_VERIFY_FAIL: "closed" } })
    expect(closed.findings).toEqual([])
    expect(closed.status).toMatchObject({ state: "error", kept: 0, discarded: 1 })
  })

  test("never throws, even on broken evidence", async () => {
    const f = aiFinding()
    const { llm } = scripted(() => ({ text: "[]" }))
    const { findings, status } = await verify([f], llm, { addedLines: undefined as any })
    expect(findings).toEqual([f])
    expect(status.state).toBe("error")
  })

  test("no findings: skipped without a model call", async () => {
    const { llm, calls } = scripted(() => ({}))
    const { status } = await verify([], llm)
    expect(calls).toHaveLength(0)
    expect(status.state).toBe("skipped")
  })

  test("25 findings go in batches of at most 8; dropped is capped at 20", async () => {
    const many = Array.from({ length: 25 }, (_, i) => aiFinding({ ruleKey: `k${i}`, file: `models/m${i % 3}.sql` }))
    expect(batchFindings(many).map((b) => b.length)).toEqual([8, 1, 8, 8])
    const { llm, calls } = scripted((req) => {
      const ids = [...String(req.messages[0].content).matchAll(/^id: (c\d+)$/gm)].map((m) => m[1])
      return { text: JSON.stringify(ids.map((id) => verdict(id, { verdict: "refuted", evidence: "no" }))) }
    })
    const { findings, status } = await verify(many, llm)
    expect(calls).toHaveLength(4)
    expect(findings).toHaveLength(0)
    expect(status.discarded).toBe(25)
    expect(status.dropped).toHaveLength(20)
  })

  test("batches keep a file's findings together when they fit", () => {
    const f = (file: string, k: string) => aiFinding({ file, ruleKey: k })
    const list = [f("a", "1"), f("b", "2"), f("a", "3"), ...Array.from({ length: 6 }, (_, i) => f("c", `c${i}`))]
    expect(batchFindings(list)).toEqual([
      [0, 2, 1],
      [3, 4, 5, 6, 7, 8],
    ])
  })

  test("tool declarations stay small: under 3,000 chars sent with every call", () => {
    const defs = verifierTools(evidence())
    const tools = Object.fromEntries(
      Object.entries(defs).map(([n, d]) => [n, tool({ description: d.description, inputSchema: d.input })]),
    )
    expect(toolsChars(tools as any)).toBeLessThan(3_000)
  })

  test("read_file opens any file the PR changes, outside the dbt project too", async () => {
    const read: string[] = []
    const defs = verifierTools(
      evidence({
        prFiles: ["models/fct.sql", "packages/transform/tests/unit/test_override.py"],
        readFile: async (p) => (read.push(p), "1: def test_x(): ..."),
      }),
    )
    expect(await defs.read_file.run({ path: "packages/transform/tests/unit/test_override.py" })).toBe("1: def test_x(): ...")
    expect(await defs.read_file.run({ path: "other/secret.py" })).toStartWith("not available: outside review scope")
    expect(read).toEqual(["packages/transform/tests/unit/test_override.py"])
  })

  test("credential files the PR changes stay unreadable, whatever lists them, and never show in grep hits", async () => {
    const read: string[] = []
    const secrets = ["config/profiles.yml", "dbt/.env", "infra/prod.tfvars", "certs/client.pem", "profiles.yaml"]
    const defs = verifierTools(
      evidence({
        prFiles: ["models/fct.sql", ...secrets],
        addedLines: new Map([["config/profiles.yml", new Set([1])]]),
        readFile: async (p) => (read.push(p), "1: password: hunter2"),
        grepProject: async () => [
          { path: "config/profiles.yml", line: 3, text: "password: hunter2" },
          { path: "models/fct.sql", line: 1, text: "select password_hash" },
        ],
      }),
      { parents: [{ name: "profiles", kind: "model", path: "profiles.yaml" }], downstream: [] } as any,
    )
    for (const p of [...secrets, "profiles.yml"]) expect(await defs.read_file.run({ path: p })).toStartWith("not available: outside review scope")
    expect(read).toEqual([])
    expect(await defs.grep_project.run({ pattern: "password" })).toBe("models/fct.sql:1: select password_hash")
    expect(isCredentialPath("models/profiles_summary.sql")).toBe(false)
    expect(isCredentialPath("models/env.yml")).toBe(false)
  })

  test("a test-coverage candidate lists the PR's files; other candidates don't", () => {
    const files = ["models/fct.sql", "tests/unit/test_override.py"]
    const gap = buildVerifyMessage("Fix", [{ id: "c1", finding: aiFinding({ category: "test_coverage" }), diff: DIFF }], files)
    expect(gap).toContain("Files this PR changes (read_file can open any of them):\n- models/fct.sql\n- tests/unit/test_override.py")
    const other = buildVerifyMessage("Fix", [{ id: "c1", finding: aiFinding(), diff: DIFF }], files)
    expect(other).not.toContain("Files this PR changes")
    expect(buildVerifyMessage("Fix", [{ id: "c1", finding: aiFinding(), diff: DIFF }])).toBe(
      buildVerifyMessage("Fix", [{ id: "c1", finding: aiFinding(), diff: DIFF }], []),
    )
  })

  test("verifierTools: equivalence needs a base side; grain needs the engine; grep needs 2 chars", async () => {
    const defs = verifierTools(evidence())
    expect(await defs.grep_project.run({ pattern: "a" })).toBe("not available: pattern needs at least 2 characters")
    expect(await defs.equivalence.run({ path: "models/fct.sql" })).toBe(
      "not available: models/fct.sql has no compiled base SQL",
    )
    expect(await defs.grain.run({ path: "models/fct.sql" })).toBe("not available: grain analysis unavailable")
  })

  test("grep_project: a failed search is reported as failed, never as no matches", async () => {
    const failed = verifierTools({ ...evidence(), grepProject: async () => undefined })
    expect(await failed.grep_project.run({ pattern: "amount" })).toContain("the search failed")
    const empty = verifierTools({ ...evidence(), grepProject: async () => [] })
    expect(await empty.grep_project.run({ pattern: "amount" })).toBe("no matches")
  })

  test("projectGrepSpecs: no doubled project prefix, `..` rejected, dirs under the root", () => {
    expect(projectGrepSpecs("dbt", ["models"], "dbt/models/**")).toEqual(["dbt/models/**"])
    expect(projectGrepSpecs("dbt", ["models"], "models/**")).toEqual(["dbt/models/**"])
    expect(projectGrepSpecs("dbt", ["models"], "./models/x.sql")).toEqual(["dbt/models/x.sql"])
    expect(projectGrepSpecs("dbt", ["models"], "models/../../secrets/**")).toBeUndefined()
    expect(projectGrepSpecs("dbt", ["models", "macros"])).toEqual(["dbt/models", "dbt/macros"])
    expect(projectGrepSpecs("", ["models", "../outside"], undefined)).toEqual(["models"])
  })

  test("grepFixedAt: no match is [], a git failure or empty pathspecs is undefined", async () => {
    await using tmp = await tmpdir()
    const run = (...args: string[]) => execFileSync("git", args, { cwd: tmp.path })
    run("init", "-q")
    mkdirSync(path.join(tmp.path, "models"))
    writeFileSync(path.join(tmp.path, "models", "a.sql"), "select amount from t\n")
    run("add", ".")
    run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
    expect(await grepFixedAt(tmp.path, "HEAD", "amount", ["models"])).toEqual([{ path: "models/a.sql", line: 1, text: "select amount from t" }])
    expect(await grepFixedAt(tmp.path, "HEAD", "nothing_here", ["models"])).toEqual([])
    expect(await grepFixedAt(tmp.path, "no-such-ref", "amount", ["models"])).toBeUndefined()
    expect(await grepFixedAt(tmp.path, "HEAD", "amount", [])).toBeUndefined()
  })
})

describe("runAiReview with the verifier on (harness path, scripted LLM.stream)", () => {
  afterEach(() => mock.restore())

  test("the review call and the verifier calls both go through LLM.stream; the status carries the verifier", async () => {
    const prev = process.env.ALTIMATE_REVIEW_AI_VERIFY
    process.env.ALTIMATE_REVIEW_AI_VERIFY = "1"
    try {
      spyOn(Provider, "defaultModel").mockResolvedValue({ providerID: "fake", modelID: "m" } as any)
      spyOn(Provider, "getModel").mockResolvedValue(FAKE_MODEL as any)
      const review = JSON.stringify([
        {
          file: "models/fct.sql",
          line: 11,
          severity: "warning",
          category: "sql_correctness",
          title: "Division drops cents",
          body: "Integer division truncates `amount`.",
          confidence: "high",
        },
      ])
      const seen: any[] = []
      spyOn(LLM, "stream").mockImplementation(async (input: any) => {
        seen.push(input)
        const verifier = input.agent.name === "dbt-ai-verifier"
        const text = verifier
          ? JSON.stringify([verdict("c1", { verdict: "refuted", evidence: "line 11 casts to numeric first" })])
          : review
        return {
          fullStream: (async function* () {})(),
          text: Promise.resolve(text),
          finishReason: Promise.resolve("stop"),
          response: Promise.resolve({ messages: [{ role: "assistant", content: text }] }),
          totalUsage: Promise.resolve({ inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 }),
          providerMetadata: Promise.resolve(undefined),
        } as any
      })
      const res = await runAiReview({ files: [FILE], grounding: [], evidence: evidence() })
      expect(seen.map((s) => s.agent.name)).toEqual(["dbt-ai-reviewer", "dbt-ai-verifier"])
      const v = seen[1]
      expect(v.toolChoice).toBe("auto")
      expect(v.agent.temperature).toBe(0)
      expect(Object.keys(v.tools)).toContain("read_file")
      expect(v.tools.read_file.execute).toBeUndefined()
      expect(String(v.messages[0].content)).toContain("title: fct: Division drops cents")
      expect(res.findings).toHaveLength(0)
      expect(res.status.verifier).toMatchObject({ state: "ok", turns: 1, reviewed: 1, discarded: 1 })
      expect(res.status.verifier?.tokens?.inputTotal).toBe(1_000)
      // The lane's own accounting is unchanged by the verifier.
      expect(res.status.calls).toBe(1)
    } finally {
      if (prev === undefined) delete process.env.ALTIMATE_REVIEW_AI_VERIFY
      else process.env.ALTIMATE_REVIEW_AI_VERIFY = prev
    }
  })
})

describe("decisions[]: offline re-triage from one run's envelope", () => {
  // Five findings covering the knobs: a nit, an unverifiable local claim, a cross-file
  // wording the model called a code fact, a verified one, and one the model skipped.
  const findings = [
    aiFinding({ title: "fct: Prefer a CTE", ruleKey: "nit" }),
    aiFinding({ title: "fct: Cents may be negative", ruleKey: "local" }),
    aiFinding({ title: "fct: Breaks the report", body: "`rpt_revenue` sums `amount`.", ruleKey: "xfile" }),
    aiFinding({ title: "fct: Integer division", ruleKey: "ok" }),
    aiFinding({ title: "fct: Skipped", ruleKey: "skip" }),
  ]
  const answer = JSON.stringify([
    verdict("c1", { value: "nit" }),
    verdict("c2", { verdict: "unverifiable", evidence: "" }),
    verdict("c3"),
    verdict("c4"),
  ])
  const run = (env: Record<string, string> = {}) =>
    verify(findings, scripted(() => ({ text: answer })).llm, {}, { env })

  test("every finding is recorded, uncapped, with features, verdict and outcome; dropped[] is unchanged", async () => {
    const { status } = await run()
    const d = status.decisions!
    expect(d.map((x) => [x.decision, x.rule])).toEqual([
      ["discard", "low_value"],
      ["keep", "plausible_local"],
      ["keep", "verified"],
      ["keep", "verified"],
      ["keep", "unreviewed"],
    ])
    expect(d[2].ts.claimsOtherFile).toBe(true)
    expect(d[1].model).toEqual({
      claimType: "code_fact",
      verdict: "unverifiable",
      value: "actionable",
      requiresAssumedInput: false,
      toolsUsed: ["compiled_sql"],
      hasEvidence: false,
    })
    expect(d[4].model).toBeUndefined()
    expect(status.dropped!.map((x) => x.rule)).toEqual(["low_value"])
  })

  test("retriage with the live knobs reproduces the run; with other knobs it matches a live run with them", async () => {
    const { status } = await run()
    const recorded = status.decisions!
    expect(retriage(recorded, DEFAULT_TRIAGE_KNOBS).decisions).toEqual(
      recorded.map((d) => ({ id: d.id, decision: d.decision, rule: d.rule })),
    )
    const env = {
      ALTIMATE_REVIEW_AI_VERIFY_DROP_NITS: "0",
      ALTIMATE_REVIEW_AI_VERIFY_KEEP_LOCAL: "0",
      ALTIMATE_REVIEW_AI_VERIFY_FAIL: "closed",
    }
    const live = (await run(env)).status.decisions!
    const offline = retriage(recorded, triageKnobs(env))
    expect(offline.decisions).toEqual(live.map((d) => ({ id: d.id, decision: d.decision, rule: d.rule })))
    expect(offline.counts).toEqual({ kept: 3, discarded: 2, summary: 0, unreviewed: 1 })
  })

  test("the hypothetical claimsOtherFile→rule 3 knob drops cross-file wording verified without tools", async () => {
    const { status } = await verify(
      findings,
      scripted(() => ({ text: JSON.stringify([verdict("c3", { tools_used: [] })]) })).llm,
    )
    const base = retriage(status.decisions!, DEFAULT_TRIAGE_KNOBS).decisions[2]
    const hyp = retriage(status.decisions!, { ...DEFAULT_TRIAGE_KNOBS, claimsOtherFileAsCrossFile: true }).decisions[2]
    expect(base).toMatchObject({ decision: "keep", rule: "verified" })
    expect(hyp).toMatchObject({ decision: "summary", rule: "unverifiable_cross_file" })
  })

  test("decisions survive the envelope and re-triage from it without casts", async () => {
    const { status } = await run()
    const env = await runReview({
      changedFiles: [{ path: "models/fct.sql", status: "modified", diff: DIFF }],
      config: { ...DEFAULT_REVIEW_CONFIG },
      rubric: DEFAULT_RUBRIC,
      mode: "comment",
      runner: {
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
      } as ReviewRunner,
      forceTier: "full",
      getContent: async () => "select 1",
      generatedAt: "2026-11-17T00:00:00Z",
      aiReview: async () => ({ findings: [], status: { state: "ok", verifier: status } }),
    })
    const decisions = env.ai!.verifier!.decisions!
    expect(decisions).toEqual(status.decisions!)
    expect(retriage(decisions, DEFAULT_TRIAGE_KNOBS).counts).toEqual({
      kept: 4,
      discarded: 1,
      summary: 0,
      unreviewed: 1,
    })
  })
})
