import { describe, test, expect } from "bun:test"
import { mapOpenAICompatibleFinishReason } from "@opencode-ai/core/github-copilot/chat/map-openai-compatible-finish-reason"
import { mapOpenAIResponseFinishReason } from "@opencode-ai/core/github-copilot/responses/map-openai-responses-finish-reason"

// ---------------------------------------------------------------------------
// mapOpenAICompatibleFinishReason (Chat API path)
// ---------------------------------------------------------------------------

describe("mapOpenAICompatibleFinishReason", () => {
  test("maps 'stop' to 'stop'", () => {
    expect(mapOpenAICompatibleFinishReason("stop")).toBe("stop")
  })

  test("maps 'length' to 'length'", () => {
    expect(mapOpenAICompatibleFinishReason("length")).toBe("length")
  })

  test("maps 'content_filter' to 'content-filter'", () => {
    expect(mapOpenAICompatibleFinishReason("content_filter")).toBe("content-filter")
  })

  test("maps 'function_call' to 'tool-calls'", () => {
    expect(mapOpenAICompatibleFinishReason("function_call")).toBe("tool-calls")
  })

  test("maps 'tool_calls' to 'tool-calls'", () => {
    expect(mapOpenAICompatibleFinishReason("tool_calls")).toBe("tool-calls")
  })

  test("maps null to 'other'", () => {
    expect(mapOpenAICompatibleFinishReason(null)).toBe("other")
  })

  test("maps undefined to 'other'", () => {
    expect(mapOpenAICompatibleFinishReason(undefined)).toBe("other")
  })

  test("maps empty string to 'other'", () => {
    expect(mapOpenAICompatibleFinishReason("")).toBe("other")
  })

  test("maps unrecognized string to 'other'", () => {
    expect(mapOpenAICompatibleFinishReason("something_else")).toBe("other")
  })
})

// ---------------------------------------------------------------------------
// mapOpenAIResponseFinishReason (Responses API path)
// ---------------------------------------------------------------------------

describe("mapOpenAIResponseFinishReason", () => {
  test("null without function call returns 'stop'", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: null, hasFunctionCall: false })).toBe("stop")
  })

  test("null with function call returns 'tool-calls'", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: null, hasFunctionCall: true })).toBe("tool-calls")
  })

  test("undefined without function call returns 'stop'", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: undefined, hasFunctionCall: false })).toBe("stop")
  })

  test("undefined with function call returns 'tool-calls'", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: undefined, hasFunctionCall: true })).toBe("tool-calls")
  })

  test("'max_output_tokens' maps to 'length'", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: "max_output_tokens", hasFunctionCall: false })).toBe("length")
  })

  test("'max_output_tokens' maps to 'length' even with function call", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: "max_output_tokens", hasFunctionCall: true })).toBe("length")
  })

  test("'content_filter' maps to 'content-filter'", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: "content_filter", hasFunctionCall: false })).toBe(
      "content-filter",
    )
  })

  test("unknown string without function call returns 'other'", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: "something_else", hasFunctionCall: false })).toBe("other")
  })

  test("unknown string with function call returns 'tool-calls'", () => {
    expect(mapOpenAIResponseFinishReason({ finishReason: "something_else", hasFunctionCall: true })).toBe("tool-calls")
  })
})
