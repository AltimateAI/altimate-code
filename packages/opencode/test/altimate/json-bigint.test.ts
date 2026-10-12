import { expect, test } from "bun:test"
import { bigintReplacer, normalizeBigInts } from "../../src/altimate/util/json"
import { estimateInputTokens } from "../../src/provider/output-token-budget"

test("request normalization preserves exact integers, source data, and SDK media", () => {
  const image = new Uint8Array([137, 80, 78, 71])
  const url = new URL("https://example.com/image.png")
  const source = {
    rows: [{ counts: [0n, 42n, 9223372036854775807n, -9223372036854775808n], nullable: null }],
    attachments: [{ image }, { image: url }],
    sparse: new Array(2),
  }
  const result = normalizeBigInts(source)
  expect(result.rows as unknown).toEqual([
    { counts: ["0", "42", "9223372036854775807", "-9223372036854775808"], nullable: null },
  ])
  expect(result.attachments[0]!.image).toBe(image)
  expect(result.attachments[1]!.image).toBe(url)
  expect(result.sparse.length).toBe(2)
  expect(source.rows[0]!.counts[2]).toBe(9223372036854775807n)
  expect(JSON.stringify(source.rows, bigintReplacer)).toBe(JSON.stringify(result.rows))
})

test("request estimator handles BigInts in message output, schema metadata, and instructions", () => {
  const input = {
    system: [],
    messages: [
      {
        role: "tool",
        content: [{ type: "tool-result", output: { type: "json", value: { count: 9223372036854775807n } } }],
      },
    ],
    tools: { count: { inputSchema: { default: 42n } } },
    instructions: { count: -9223372036854775808n },
  }
  expect(estimateInputTokens(input)).toBe(estimateInputTokens(normalizeBigInts(input)))
  expect(estimateInputTokens(input)).toBeGreaterThan(0)
})
