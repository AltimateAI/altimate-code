import { describe, test, expect } from "bun:test"
import { prepareTools } from "@opencode-ai/core/github-copilot/chat/openai-compatible-prepare-tools"

describe("prepareTools", () => {
  test("undefined tools returns all undefined", () => {
    const result = prepareTools({ tools: undefined })
    expect(result.tools).toBeUndefined()
    expect(result.toolChoice).toBeUndefined()
    expect(result.toolWarnings).toEqual([])
  })

  test("empty tools array returns all undefined", () => {
    const result = prepareTools({ tools: [] })
    expect(result.tools).toBeUndefined()
    expect(result.toolChoice).toBeUndefined()
    expect(result.toolWarnings).toEqual([])
  })

  test("converts a single function tool to OpenAI format", () => {
    const result = prepareTools({
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get weather for a city",
          inputSchema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    })
    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ])
    expect(result.toolWarnings).toEqual([])
  })

  test("provider tool emits unsupported-feature warning", () => {
    const providerTool = {
      type: "provider" as const,
      id: "some.provider-tool" as `${string}.${string}`,
      name: "provider_tool",
      args: {},
    }
    const result = prepareTools({
      tools: [providerTool],
    })
    expect(result.toolWarnings).toHaveLength(1)
    expect(result.toolWarnings[0]).toEqual({
      type: "unsupported",
      feature: "tool type: provider",
    })
    // Provider tools are not included in the output tools array
    expect(result.tools).toEqual([])
  })

  test("toolChoice 'auto' passes through", () => {
    const result = prepareTools({
      tools: [
        { type: "function", name: "foo", description: "test", inputSchema: {} },
      ],
      toolChoice: { type: "auto" },
    })
    expect(result.toolChoice).toBe("auto")
  })

  test("toolChoice 'none' passes through", () => {
    const result = prepareTools({
      tools: [
        { type: "function", name: "foo", description: "test", inputSchema: {} },
      ],
      toolChoice: { type: "none" },
    })
    expect(result.toolChoice).toBe("none")
  })

  test("toolChoice 'required' passes through", () => {
    const result = prepareTools({
      tools: [
        { type: "function", name: "foo", description: "test", inputSchema: {} },
      ],
      toolChoice: { type: "required" },
    })
    expect(result.toolChoice).toBe("required")
  })

  test("toolChoice type 'tool' converts to function format", () => {
    const result = prepareTools({
      tools: [
        { type: "function", name: "my_func", description: "desc", inputSchema: {} },
      ],
      toolChoice: { type: "tool", toolName: "my_func" },
    })
    expect(result.toolChoice).toEqual({
      type: "function",
      function: { name: "my_func" },
    })
  })

  test("no toolChoice returns undefined toolChoice", () => {
    const result = prepareTools({
      tools: [
        { type: "function", name: "foo", description: "test", inputSchema: {} },
      ],
    })
    expect(result.toolChoice).toBeUndefined()
    expect(result.tools).toHaveLength(1)
  })
})
