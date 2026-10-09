import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "@/provider/transform"
import type { ModelMessage } from "ai"

/**
 * A request that declares no tools must not carry tool-call messages: the Altimate gateway
 * rejects that shape, failing every provider in its fallback chain and reporting one generic
 * error (issue #1315). OpenAI and Anthropic both accept it — the defect is gateway-side, and
 * this transform is the client-side mitigation.
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

  // --- regressions from the consensus review of PR #1319 ---

  test("the canonical agentic shape does not leave consecutive assistant messages", () => {
    // user -> assistant(text+call) -> tool(result) -> assistant(text) -> user is the ordinary
    // shape of every session compaction summarizes. Dropping the tool message used to leave two
    // adjacent assistant turns.
    const out = ProviderTransform.flattenToolParts([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { cmd: "ls" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", output: { type: "text", value: "a.txt" } }],
      },
      { role: "assistant", content: [{ type: "text", text: "I found a.txt." }] },
      { role: "user", content: "summarize" },
    ] as unknown as ModelMessage[])

    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    for (let i = 1; i < out.length; i++) expect(out[i].role === out[i - 1].role).toBe(false)
    // nothing is lost in the merge
    const text = JSON.stringify(out)
    expect(text).toContain("Checking.")
    expect(text).toContain("a.txt")
    expect(text).toContain("I found a.txt.")
  })

  test("an intentionally blank assistant text part survives", () => {
    // message-v2.ts preserves a single space between Anthropic signed-reasoning blocks; the
    // blank-part filter must only ever drop parts this transform itself produced.
    const out = ProviderTransform.flattenToolParts([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: " " }] },
      { role: "user", content: "summarize" },
    ] as unknown as ModelMessage[])
    const parts = (out[1] as any).content
    expect(parts.some((p: any) => p.type === "text" && p.text === " ")).toBe(true)
    expect(parts.some((p: any) => p.type === "reasoning")).toBe(true)
  })

  test("a tool-result embedded in an assistant message is flattened too", () => {
    const out = ProviderTransform.flattenToolParts([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool-result", toolCallId: "c9", toolName: "bash", output: { type: "text", value: "x" } }],
      },
      { role: "user", content: "summarize" },
    ] as unknown as ModelMessage[])
    expect(JSON.stringify(out)).not.toContain('"tool-result"')
    expect(JSON.stringify(out)).toContain("x")
  })

  test("content-array output is unwrapped into readable text, not JSON", () => {
    const out = ProviderTransform.flattenToolParts([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: {} }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "read",
            output: { type: "content", value: [{ type: "text", text: "hello world" }] },
          },
        ],
      },
      { role: "user", content: "s" },
    ] as unknown as ModelMessage[])
    const rendered = JSON.stringify(out)
    expect(rendered).toContain("hello world")
    expect(rendered).not.toContain('\\"type\\":\\"text\\"')
  })

  test("parallel tool calls and multiple results keep their order", () => {
    const out = ProviderTransform.flattenToolParts([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "a", toolName: "first", input: {} },
          { type: "tool-call", toolCallId: "b", toolName: "second", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "a", toolName: "first", output: { type: "text", value: "R1" } },
          { type: "tool-result", toolCallId: "b", toolName: "second", output: { type: "text", value: "R2" } },
        ],
      },
      { role: "user", content: "s" },
    ] as unknown as ModelMessage[])
    const flat = (out[1] as any).content.map((p: any) => p.text).join("\n")
    expect(flat.indexOf("first")).toBeLessThan(flat.indexOf("second"))
    expect(flat.indexOf("R1")).toBeLessThan(flat.indexOf("R2"))
  })

  test("output shapes without a value do not throw", () => {
    for (const output of [
      { type: "error-text", value: "boom" },
      { type: "json", value: { a: 1 } },
      { type: "execution-denied" },
      "plain string",
    ]) {
      const run = () =>
        ProviderTransform.flattenToolParts([
          { role: "user", content: "go" },
          {
            role: "tool",
            content: [{ type: "tool-result", toolCallId: "c1", toolName: "t", output }],
          },
        ] as unknown as ModelMessage[])
      expect(run).not.toThrow()
    }
  })

  test("the caller's input array is never mutated", () => {
    const input = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", output: { type: "text", value: "o" } }] },
    ] as unknown as ModelMessage[]
    const before = JSON.stringify(input)
    ProviderTransform.flattenToolParts(input)
    expect(JSON.stringify(input)).toEqual(before)
  })
})
