import { describe, test, expect, spyOn, mock, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { replayFindings } from "../../src/altimate/review/ai-replay"
import { runAiVerify, numberedSlice, type AiVerifyEvidence, type VerifierLlm } from "../../src/altimate/review/ai-verify"
import { runAiReview, type AiLaneStatus, type AiReviewFile } from "../../src/altimate/review/ai-review"
import { makeFinding, ruleId, type Finding } from "../../src/altimate/review/finding"
import { Dispatcher } from "../../src/altimate/native"
import { LLM } from "../../src/session/llm"
import { Provider } from "../../src/provider/provider"

/**
 * Replay mode (`ALTIMATE_REVIEW_AI_REPLAY`): the generator's findings come from
 * an earlier envelope and only the verifier runs. Every model here is scripted;
 * no test reaches a provider.
 */

const DIFF =
  "@@ -10,2 +10,3 @@\n select order_id,\n+  coalesce(amount_cents, 0) / 100 as amount,\n from {{ ref('stg_orders') }}\n"
const FILE: AiReviewFile = { path: "models/fct.sql", status: "modified", model: "fct", diff: DIFF }
const FAKE_MODEL = { providerID: "fake", id: "verifier", api: { npm: "x" }, cost: {} } as unknown as Provider.Model
const TOKENS = { input: 30_000, inputTotal: 32_000, output: 2_000, reasoning: 0, cacheRead: 2_000 }

/** A finding as the generator lane builds it. */
function generated(title: string, category: Finding["category"] = "sql_correctness", over: Record<string, unknown> = {}) {
  return makeFinding({
    severity: "warning",
    category,
    title: `fct: ${title}`,
    body: `${title}: integer division truncates \`amount\`.`,
    file: "models/fct.sql",
    model: "fct",
    startLine: 11,
    endLine: 11,
    confidence: "medium",
    evidence: { tool: "ai-review", result: { confidence: "medium" } },
    ruleKey: `ai:${category}:${title}`,
    rule: ruleId("ai-review", category),
    ...over,
  })
}

function evidence(): AiVerifyEvidence {
  const head = "select order_id,\n  coalesce(amount_cents, 0) / 100 as amount,\nfrom {{ ref('stg_orders') }}"
  return {
    files: [FILE],
    addedLines: new Map([["models/fct.sql", new Set([11])]]),
    prTitle: "Fix revenue rounding",
    runner: { graphParents: async () => [], downstreamModels: async () => [] } as any,
    readFile: async (p, side, start, end) => numberedSlice(side === "new" ? head : undefined, start, end),
    compiledSql: async () => head,
  }
}

const answer = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  claim_type: "code_fact",
  verdict: "confirmed",
  value: "actionable",
  requires_assumed_input: false,
  evidence: "line 11: coalesce(amount_cents, 0) / 100",
  tools_used: ["compiled_sql"],
  ...over,
})

/** Five generator findings, one per verifier outcome: verified, summary, refuted, nit, unreviewed. */
const GENERATED = [
  generated("Division drops cents"),
  generated("Upstream column may be renamed", "sql_correctness", { body: "`stg_orders` may rename `amount_cents`." }),
  generated("Null amounts become zero"),
  generated("Alias style", "sql_quality", { confidence: "low", evidence: { tool: "ai-review", result: { confidence: "low" } } }),
  generated("Missing test on amount", "test_coverage"),
]
const VERDICTS = [
  answer("c1"),
  answer("c2", { claim_type: "cross_file", verdict: "unverifiable", tools_used: [] }),
  answer("c3", { verdict: "refuted", evidence: "line 11 keeps nulls via coalesce" }),
  answer("c4", { claim_type: "convention", value: "nit" }),
]

/** An envelope as an earlier verifier run left it: kept findings tiered and stamped, the rest dropped. */
async function storedEnvelope(): Promise<{ envelope: any; status: AiLaneStatus }> {
  const llm: VerifierLlm = async () => ({
    text: JSON.stringify(VERDICTS),
    finishReason: "stop",
    toolCalls: [],
    messages: [],
  })
  const v = await runAiVerify(
    { findings: GENERATED, grounding: [], evidence: evidence(), model: FAKE_MODEL },
    { llm, env: {} },
  )
  const status: AiLaneStatus = { state: "ok", model: "fake/m", durationMs: 1, tokens: TOKENS, cost: 0.12, calls: 1, verifier: v.status }
  // What the envelope stores: posting tier from policy, origin stamped, sorted by severity and file.
  const findings = [...v.findings].reverse().map((f) => ({ ...f, origin: "ai", tier: f.tier ?? "inline" }))
  const engine = makeFinding({ severity: "warning", category: "sql_quality", title: "engine", body: "b", file: "models/fct.sql", evidence: { tool: "dbt.manifest" } })
  return { envelope: JSON.parse(JSON.stringify({ findings: [engine, ...findings], ai: status })), status }
}

describe("replayFindings (envelope → the generator's findings)", () => {
  test("round trip: same ids as kept ∪ dropped, in the generator's order, as the generator built them", async () => {
    const { envelope, status } = await storedEnvelope()
    const kept = envelope.findings.filter((f: any) => f.evidence?.tool === "ai-review").map((f: any) => f.id)
    const dropped = status.verifier!.dropped!.map((d) => d.id)
    expect(kept).toHaveLength(3)
    expect(dropped).toHaveLength(2)
    // The fixture exercises every reversal: a Verified suffix, a summary tier, a verification record.
    expect(envelope.findings.some((f: any) => f.body.includes("\n\nVerified: "))).toBe(true)
    expect(status.verifier!.summary).toBe(1)

    const lane = replayFindings(envelope)
    expect(new Set(lane.findings.map((f) => f.id))).toEqual(new Set([...kept, ...dropped]))
    expect(lane.findings).toEqual(GENERATED)
    expect(lane.warnings).toEqual([])
    expect(lane.status).toEqual({ state: "ok", model: "fake/m", tokens: TOKENS, cost: 0.12, calls: 1, replayed: true })
  })

  test("a dropped list shorter than the discard count marks the replay incomplete", async () => {
    const { envelope } = await storedEnvelope()
    envelope.ai.verifier.dropped = envelope.ai.verifier.dropped.slice(0, 1)
    const lane = replayFindings(envelope)
    expect(lane.findings).toHaveLength(4)
    expect(lane.status.replayIncomplete).toBe(true)
    expect(lane.warnings.join("\n")).toContain("discarded 2 findings but the envelope lists 1")
  })

  test("an envelope from a run without the verifier replays its AI findings unchanged", () => {
    const f = { ...GENERATED[0], origin: "ai", tier: "inline" }
    const lane = replayFindings({ findings: [f], ai: { state: "ok", calls: 1 } })
    expect(lane.findings).toEqual([GENERATED[0]])
    expect(lane.status).toEqual({ state: "ok", calls: 1, replayed: true })
  })

  test("an envelope without an AI lane cannot be replayed", () => {
    expect(() => replayFindings({ findings: [] })).toThrow("no AI lane status")
  })
})

describe("runAiReview with ALTIMATE_REVIEW_AI_REPLAY", () => {
  const saved = { ...process.env }
  afterEach(() => {
    mock.restore()
    for (const k of ["ALTIMATE_REVIEW_AI_REPLAY", "ALTIMATE_REVIEW_AI_VERIFY"]) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  const write = (data: string) => {
    const p = path.join(mkdtempSync(path.join(tmpdir(), "ai-replay-")), "stored.json")
    writeFileSync(p, data)
    return p
  }

  test("verifier off: no model or core call; the stored findings and generator usage come back, marked replayed", async () => {
    const { envelope } = await storedEnvelope()
    process.env.ALTIMATE_REVIEW_AI_REPLAY = write(JSON.stringify(envelope))
    delete process.env.ALTIMATE_REVIEW_AI_VERIFY
    const stream = spyOn(LLM, "stream")
    const core = spyOn(Dispatcher, "call")
    const getModel = spyOn(Provider, "getModel")
    const res = await runAiReview({ files: [FILE], grounding: [], evidence: evidence() })
    expect(stream).not.toHaveBeenCalled()
    expect(core).not.toHaveBeenCalled()
    expect(getModel).not.toHaveBeenCalled()
    expect(res.findings.map((f) => f.id)).toEqual(GENERATED.map((f) => f.id))
    expect(res.status).toMatchObject({ state: "ok", replayed: true, tokens: TOKENS, cost: 0.12, calls: 1 })
    expect(res.status.verifier).toBeUndefined()
  })

  test("verifier on: only the verifier calls the model", async () => {
    const { envelope } = await storedEnvelope()
    process.env.ALTIMATE_REVIEW_AI_REPLAY = write(JSON.stringify(envelope))
    process.env.ALTIMATE_REVIEW_AI_VERIFY = "1"
    spyOn(Provider, "defaultModel").mockResolvedValue({ providerID: "fake", modelID: "m" } as any)
    spyOn(Provider, "getModel").mockResolvedValue(FAKE_MODEL as any)
    const core = spyOn(Dispatcher, "call")
    const agents: string[] = []
    spyOn(LLM, "stream").mockImplementation(async (input: any) => {
      agents.push(input.agent.name)
      const text = JSON.stringify(VERDICTS)
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
    expect(agents).toEqual(["dbt-ai-verifier"])
    expect(core).not.toHaveBeenCalledWith("altimate_core.review_ai_prompt", expect.anything())
    expect(res.status).toMatchObject({ state: "ok", replayed: true, tokens: TOKENS, calls: 1 })
    expect(res.status.verifier).toMatchObject({ reviewed: 4, kept: 2, summary: 1, discarded: 2, unreviewed: 1 })
    expect(res.status.verifier?.tokens?.inputTotal).toBe(1_000)
  })

  test("a missing or unparsable file is an error on stderr, never a generator call", async () => {
    const stream = spyOn(LLM, "stream")
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
    for (const p of [path.join(tmpdir(), "does-not-exist-ai-replay.json"), write("{ not json")]) {
      process.env.ALTIMATE_REVIEW_AI_REPLAY = p
      const res = await runAiReview({ files: [FILE], grounding: [] })
      expect(res.findings).toEqual([])
      expect(res.status).toMatchObject({ state: "error", replayed: true })
      expect(res.status.reason).toContain(p)
    }
    expect(stream).not.toHaveBeenCalled()
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("ALTIMATE_REVIEW_AI_REPLAY")
  })
})
