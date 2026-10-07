// Bundled by bedrock-eventstream-build.test.ts under the release build's resolution conditions,
// then executed. Prints the parsed result of one synthetic Bedrock Converse stream as JSON.
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { eventStreamFrame as frame } from "./bedrock-eventstream-frames"

const frames = [
  frame("messageStart", { role: "assistant" }),
  frame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "hello" } }),
  frame("contentBlockStop", { contentBlockIndex: 0 }),
  frame("messageStop", { stopReason: "end_turn" }),
  frame("metadata", { usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 }, metrics: { latencyMs: 1 } }),
]
const body = new ReadableStream<Uint8Array>({
  start(c) {
    for (const f of frames) c.enqueue(f)
    c.close()
  },
})
const provider = createAmazonBedrock({
  region: "us-east-1",
  apiKey: "unused-synthetic-key",
  fetch: (async () =>
    new Response(body, {
      headers: { "content-type": "application/vnd.amazon.eventstream" },
    })) as unknown as typeof fetch,
})
const { stream } = await provider("us.anthropic.claude-haiku-4-5-20251001-v1:0").doStream({
  prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
} as any)
let text = ""
let finish: unknown
let usage: any
for await (const part of stream as any) {
  if (part.type === "text-delta") text += part.delta
  if (part.type === "finish") {
    finish = part.finishReason
    usage = part.usage
  }
}
console.log(JSON.stringify({ text, finish, input: usage?.inputTokens?.total, output: usage?.outputTokens?.total }))
