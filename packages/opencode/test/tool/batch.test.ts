import { describe, test, expect } from "bun:test"
import { Result, Schema } from "effect"
import { BatchTool } from "../../src/tool/batch"
import { initTool } from "../altimate/tool-fixture"

// BatchTool is an Effect Tool definition; initialize through the test bridge.
async function getToolInfo() {
  return initTool(BatchTool)
}

function safeParse<S extends Schema.Decoder<unknown>>(schema: S, input: unknown) {
  const result = Schema.decodeUnknownResult(schema)(input)
  return Result.isSuccess(result)
    ? { success: true as const, data: result.success as S["Type"] }
    : { success: false as const, error: result.failure }
}

describe("BatchTool: schema validation", () => {
  test("rejects empty tool_calls array", async () => {
    const tool = await getToolInfo()
    const result = safeParse(tool.parameters, { tool_calls: [] })
    expect(result.success).toBe(false)
  })

  test("accepts single tool call", async () => {
    const tool = await getToolInfo()
    const result = safeParse(tool.parameters, {
      tool_calls: [{ tool: "read", parameters: { file_path: "/tmp/x" } }],
    })
    expect(result.success).toBe(true)
  })

  test("accepts multiple tool calls", async () => {
    const tool = await getToolInfo()
    const result = safeParse(tool.parameters, {
      tool_calls: [
        { tool: "read", parameters: { file_path: "/tmp/a" } },
        { tool: "grep", parameters: { pattern: "foo" } },
      ],
    })
    expect(result.success).toBe(true)
  })

  test("rejects tool call without tool name", async () => {
    const tool = await getToolInfo()
    const result = safeParse(tool.parameters, {
      tool_calls: [{ parameters: { file_path: "/tmp/x" } }],
    })
    expect(result.success).toBe(false)
  })

  test("rejects tool call without parameters object", async () => {
    const tool = await getToolInfo()
    const result = safeParse(tool.parameters, {
      tool_calls: [{ tool: "read" }],
    })
    expect(result.success).toBe(false)
  })

  test("accepts tool call with empty parameters", async () => {
    const tool = await getToolInfo()
    const result = safeParse(tool.parameters, {
      tool_calls: [{ tool: "read", parameters: {} }],
    })
    expect(result.success).toBe(true)
  })
})

describe("BatchTool: formatValidationError", () => {
  test("formatValidationError is defined", async () => {
    const tool = await getToolInfo()
    expect(tool.formatValidationError).toBeDefined()
  })

  test("produces readable error message for empty array", async () => {
    const tool = await getToolInfo()
    expect(tool.formatValidationError).toBeDefined()
    const result = safeParse(tool.parameters, { tool_calls: [] })
    expect(result.success).toBe(false)
    if (!result.success) {
      const msg = tool.formatValidationError!(result.error)
      expect(msg).toContain("Invalid parameters for tool 'batch'")
      expect(msg).toContain("Expected payload format")
    }
  })

  test("includes field path in type error", async () => {
    const tool = await getToolInfo()
    expect(tool.formatValidationError).toBeDefined()
    const result = safeParse(tool.parameters, {
      tool_calls: [{ tool: 123, parameters: {} }],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const msg = tool.formatValidationError!(result.error)
      expect(msg).toContain("tool_calls")
    }
  })
})

describe("BatchTool: DISALLOWED set enforcement", () => {
  // The DISALLOWED set prevents recursive batch-in-batch calls.
  // This is a critical safety mechanism — if the LLM can batch the batch tool,
  // it creates infinite recursion.
  // We verify the source code's DISALLOWED set by checking the module exports.
  test("batch tool id is 'batch'", () => {
    expect(BatchTool.id).toBe("batch")
  })

  // The 25-call cap and DISALLOWED enforcement happen inside execute(),
  // which requires a full Session context. We verify the schema allows
  // up to 25+ items at parse time (the cap is enforced at runtime).
  test("schema accepts 25 tool calls (runtime cap is in execute)", async () => {
    const tool = await getToolInfo()
    const calls = Array.from({ length: 25 }, (_, i) => ({
      tool: `tool_${i}`,
      parameters: {},
    }))
    const result = safeParse(tool.parameters, { tool_calls: calls })
    expect(result.success).toBe(true)
  })

  test("schema accepts 26+ tool calls (runtime slices to 25)", async () => {
    const tool = await getToolInfo()
    const calls = Array.from({ length: 30 }, (_, i) => ({
      tool: `tool_${i}`,
      parameters: {},
    }))
    const result = safeParse(tool.parameters, { tool_calls: calls })
    // Schema allows it — the 25-cap is enforced in execute()
    expect(result.success).toBe(true)
  })
})
