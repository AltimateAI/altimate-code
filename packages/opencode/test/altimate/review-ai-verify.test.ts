import { describe, test, expect, spyOn, mock, afterEach } from "bun:test"
import { streamText, tool, type ModelMessage } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import z from "zod"
import { readStreamStep } from "../../src/altimate/llm/stream-text"
import { aiVerifyEnabled, numberedSlice } from "../../src/altimate/review/ai-verify"
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
