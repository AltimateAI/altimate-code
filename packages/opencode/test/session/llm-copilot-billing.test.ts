import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"
import { Effect } from "effect"
import { LLMAISDK } from "../../src/session/llm/ai-sdk"

describe("session.llm.copilotBilling", () => {
  test("enables raw chunks for github-copilot streamText calls", () => {
    const content = readFileSync(path.join(import.meta.dir, "../../src/session/llm.ts"), "utf-8")
    expect(content).toMatch(/includeRawChunks:\s*input\.model\.providerID\.includes\("github-copilot"\)/)
  })

  test("turns raw Copilot usage chunks into step finish metadata", async () => {
    const state = LLMAISDK.adapterState()
    const rawEvent = {
      type: "raw",
      rawValue: {
        copilot_usage: {
          total_nano_aiu: 4_473_525_000,
        },
      },
    } as Parameters<typeof LLMAISDK.toLLMEvents>[1]

    await Effect.runPromise(LLMAISDK.toLLMEvents(state, rawEvent))

    const finishStepEvent = {
      type: "finish-step",
      response: {},
      finishReason: "stop",
      rawFinishReason: "stop",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      providerMetadata: undefined,
    } as Parameters<typeof LLMAISDK.toLLMEvents>[1]

    const events = await Effect.runPromise(LLMAISDK.toLLMEvents(state, finishStepEvent))

    expect(events[0]).toMatchObject({
      type: "step-finish",
      index: 0,
      reason: "stop",
      providerMetadata: {
        copilot: {
          totalNanoAiu: 4_473_525_000,
        },
      },
    })
  })
})
