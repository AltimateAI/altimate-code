/**
 * Tests for the tool_lookup tool — Zod schema introspection
 * (describeZodSchema, inferZodType, unwrap, getShape).
 *
 * The agent uses tool_lookup to discover other tools' parameter contracts.
 * Incorrect introspection leads to wrong tool calls.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import z from "zod"
import { ToolLookupTool } from "../../src/altimate/tools/tool-lookup"
import { ToolRegistry } from "../../src/tool/registry"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"

beforeEach(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})
afterAll(() => {
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("ToolLookupTool: Zod schema introspection", () => {
  test("returns parameter info for tool with mixed types", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const testTool = {
          id: "__test_lookup_mixed",
          init: async () => ({
            description: "Test tool with mixed params",
            parameters: z.object({
              name: z.string().describe("The name"),
              count: z.number().describe("How many"),
              verbose: z.boolean().optional().describe("Enable verbosity"),
              tags: z.array(z.string()).describe("Tags list"),
              mode: z.enum(["fast", "slow"]).default("fast").describe("Execution mode"),
            }),
            execute: async () => ({ title: "", output: "", metadata: {} }),
          }),
        }
        await ToolRegistry.register(testTool)

        const tool = await ToolLookupTool.init()
        const result = await tool.execute({ tool_name: "__test_lookup_mixed" }, ctx as any)

        // Required string param
        expect(result.output).toContain("name")
        expect(result.output).toContain("string")
        expect(result.output).toContain("required")
        expect(result.output).toContain("The name")

        // Number param
        expect(result.output).toContain("count")
        expect(result.output).toContain("number")

        // Optional boolean
        expect(result.output).toContain("verbose")
        expect(result.output).toContain("optional")

        // Array param
        expect(result.output).toContain("tags")
        expect(result.output).toContain("array")

        // Enum with default — inferZodType unwraps default then hits enum
        expect(result.output).toContain("mode")
        expect(result.output).toContain("enum")
      },
    })
  })

  test("returns 'Tool not found' with available tools list", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ToolLookupTool.init()
        const result = await tool.execute({ tool_name: "nonexistent_tool_xyz" }, ctx as any)
        expect(result.title).toBe("Tool not found")
        expect(result.output).toContain('No tool named "nonexistent_tool_xyz"')
        expect(result.output).toContain("Available tools:")
      },
    })
  })

  test("handles tool with empty parameters object", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const testTool = {
          id: "__test_lookup_empty",
          init: async () => ({
            description: "Tool with empty params",
            parameters: z.object({}),
            execute: async () => ({ title: "", output: "", metadata: {} }),
          }),
        }
        await ToolRegistry.register(testTool)

        const tool = await ToolLookupTool.init()
        const result = await tool.execute({ tool_name: "__test_lookup_empty" }, ctx as any)
        expect(result.output).toContain("No parameters")
      },
    })
  })

  test("unwraps nested optional/default wrappers correctly", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const testTool = {
          id: "__test_lookup_nested",
          init: async () => ({
            description: "Tool with nested wrappers",
            parameters: z.object({
              // default wrapping optional wrapping string
              deep: z.string().optional().default("hello").describe("Deeply wrapped"),
            }),
            execute: async () => ({ title: "", output: "", metadata: {} }),
          }),
        }
        await ToolRegistry.register(testTool)

        const tool = await ToolLookupTool.init()
        const result = await tool.execute({ tool_name: "__test_lookup_nested" }, ctx as any)

        // Should unwrap to the inner string type
        expect(result.output).toContain("deep")
        expect(result.output).toContain("Deeply wrapped")
        // The outer wrapper is default, so it should show as optional
        expect(result.output).toContain("optional")
      },
    })
  })
})
