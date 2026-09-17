import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "@/provider/transform"
import type { ModelMessage } from "ai"

/**
 * A request that declares no tools must not carry tool-call messages: OpenAI, Azure's Responses
 * API and Anthropic all reject a call referencing an undeclared function, so every provider in a
 * fallback chain fails and the gateway can only report a generic error (issue #1315).
 */
describe("ProviderTransform.flattenToolParts", () => {
  const history = (): ModelMessage[] => [
    { role: "user", content: "list the files" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Checking." },
        { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { cmd: "ls" } },
      ],
    } as unknown as ModelMessage,
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", output: { value: "a.txt\nb.txt" } }],
    } as unknown as ModelMessage,
    { role: "user", content: "Summarize the conversation above." },
  ]

  function toolPartTypes(msgs: ModelMessage[]) {
    return msgs.flatMap((m) => (Array.isArray(m.content) ? m.content.map((p: any) => p?.type) : []))
  }

  test("removes every tool-call and tool-result part", () => {
    const out = ProviderTransform.flattenToolParts(history())
    expect(toolPartTypes(out)).not.toContain("tool-call")
    expect(toolPartTypes(out)).not.toContain("tool-result")
    expect(out.some((m) => m.role === "tool")).toBe(false)
  })

  test("preserves the tool name, arguments and output as readable text", () => {
    const text = JSON.stringify(ProviderTransform.flattenToolParts(history()))
    expect(text).toContain("bash")
    expect(text).toContain("ls")
    expect(text).toContain("a.txt")
  })

  test("keeps surrounding conversation intact", () => {
    const out = ProviderTransform.flattenToolParts(history())
    expect(out[0]).toEqual({ role: "user", content: "list the files" })
    expect(out.at(-1)).toEqual({ role: "user", content: "Summarize the conversation above." })
  })

  test("an assistant turn holding only tool calls does not become an empty message", () => {
    const out = ProviderTransform.flattenToolParts([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} }],
      } as unknown as ModelMessage,
      { role: "user", content: "summarize" },
    ])
    for (const msg of out) {
      if (Array.isArray(msg.content)) expect(msg.content.length).toBeGreaterThan(0)
    }
  })

  test("an orphaned tool result (head truncated away its call) still flattens", () => {
    const out = ProviderTransform.flattenToolParts([
      { role: "user", content: "go" },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "gone", toolName: "bash", output: { value: "out" } }],
      } as unknown as ModelMessage,
      { role: "user", content: "summarize" },
    ])
    expect(out.some((m) => m.role === "tool")).toBe(false)
    expect(JSON.stringify(out)).toContain("out")
  })

  test("messages with no tool parts are returned unchanged", () => {
    const plain: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] } as unknown as ModelMessage,
    ]
    expect(ProviderTransform.flattenToolParts(plain)).toEqual(plain)
  })
})
