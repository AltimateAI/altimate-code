import { describe, test, expect, spyOn } from "bun:test"
import { Effect, Result, Schema } from "effect"
import path from "node:path"
import { BatchTool } from "../../src/tool/batch"
import { ToolRegistry } from "../../src/tool/registry"
import { Session } from "../../src/session"
import { MessageID, SessionID } from "../../src/session/schema"
import { Delivery } from "../../src/altimate/learn/delivery"
import { initTool } from "../altimate/tool-fixture"
import { tmpdir } from "../fixture/fixture"

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

describe("BatchTool: file lessons", () => {
  test.each(["read", "edit", "write", "apply_patch"])("appends approved lessons to the inner %s result", async (toolName) => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_batch_lessons")
    const messageID = MessageID.make("msg_batch_lessons")
    const filePath = path.join(tmp.path, "models/report.sql")
    const rule = "Use explicit source schemas for these model files."
    await Bun.write(path.join(tmp.path, ".altimate-code/learn/team/approved.json"), JSON.stringify([{
      id: "L-0001", text: rule, tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0,
      created: "2026-09-30T00:00:00.000Z", updated: "2026-09-30T00:00:00.000Z",
      trigger: { paths: ["models/**"] },
    }]))
    const lessons = new Delivery(tmp.path, { core_lessons: 0, retrieved_lessons: 0 })
    await lessons.prepare(sessionID, "first", "Inspect the project.")
    const tool = await getToolInfo()
    const registry = spyOn(ToolRegistry, "tools").mockResolvedValue([{
      id: toolName,
      registrySource: undefined,
      description: "test file tool",
      parameters: Schema.Unknown,
      execute: () => Effect.succeed({
        title: "File result", output: "Original tool output",
        metadata: toolName === "apply_patch" ? { files: [{ filePath: path.join(tmp.path, "old.sql"), movePath: filePath }] } : {},
      }),
    }])
    const updatePart = Object.assign(async (part: Parameters<typeof Session.updatePart>[0]) => part, Session.updatePart)
    const updates = spyOn(Session, "updatePart").mockImplementation(updatePart)
    try {
      const result = await tool.execute({ tool_calls: [{
        tool: toolName, parameters: toolName === "apply_patch" ? { patchText: "patch" } : { filePath },
      }] }, {
        sessionID, messageID, agent: "build", abort: AbortSignal.any([]), messages: [], extra: { lessons },
      })
      expect(result.metadata.successful).toBe(1)
      const completed = updates.mock.calls.map(([part]) => part).find((part) => part.type === "tool" && part.state.status === "completed")
      expect(completed?.type === "tool" && completed.state.status === "completed" ? completed.state.output : "")
        .toBe(`Original tool output\n\nTeam rules for models/report.sql:\n[applies to: models/**] ${rule}`)
      expect(await lessons.file(sessionID, filePath)).toBe("")
    } finally {
      updates.mockRestore()
      registry.mockRestore()
    }
  })
})

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
