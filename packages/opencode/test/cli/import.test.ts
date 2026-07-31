import { test, expect } from "bun:test"
import {
  aggregateImportedUsage,
  formatImportFileError,
  parseShareUrl,
  shouldAttachShareAuthHeaders,
  transformShareData,
  type ShareData,
} from "../../src/cli/cmd/import"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PlatformError } from "effect"

test("formats import file errors", () => {
  expect(
    formatImportFileError(
      "test.json",
      new PlatformError.PlatformError(
        new PlatformError.SystemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readFileString",
        }),
      ),
    ),
  ).toBe("File not found: test.json")
  expect(
    formatImportFileError(
      "test.json",
      new PlatformError.PlatformError(
        new PlatformError.SystemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "readFileString",
        }),
      ),
    ),
  ).toBe("Failed to read file: Permission denied")
  expect(
    formatImportFileError(
      "test.json",
      new FSUtil.FileSystemError({ method: "readJson", cause: new SyntaxError("Unexpected token") }),
    ),
  ).toBe("Invalid JSON in test.json: Unexpected token")
})

// parseShareUrl tests
test("parses valid share URLs", () => {
  expect(parseShareUrl("https://opncd.ai/share/Jsj3hNIW")).toBe("Jsj3hNIW")
  expect(parseShareUrl("https://custom.example.com/share/abc123")).toBe("abc123")
  expect(parseShareUrl("http://localhost:3000/share/test_id-123")).toBe("test_id-123")
})

test("rejects invalid URLs", () => {
  expect(parseShareUrl("https://opncd.ai/s/Jsj3hNIW")).toBeNull() // legacy format
  expect(parseShareUrl("https://opncd.ai/share/")).toBeNull()
  expect(parseShareUrl("https://opncd.ai/share/id/extra")).toBeNull()
  expect(parseShareUrl("not-a-url")).toBeNull()
})

test("only attaches share auth headers for same-origin URLs", () => {
  expect(shouldAttachShareAuthHeaders("https://control.example.com/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("https://other.example.com/share/abc", "https://control.example.com")).toBe(false)
  expect(shouldAttachShareAuthHeaders("https://control.example.com:443/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("not-a-url", "https://control.example.com")).toBe(false)
})

// transformShareData tests
test("transforms share data to storage format", () => {
  const data: ShareData[] = [
    { type: "session", data: { id: "sess-1", title: "Test" } as any },
    { type: "message", data: { id: "msg-1", sessionID: "sess-1" } as any },
    { type: "part", data: { id: "part-1", messageID: "msg-1" } as any },
    { type: "part", data: { id: "part-2", messageID: "msg-1" } as any },
  ]

  const result = transformShareData(data)!

  expect(result.info.id).toBe("sess-1")
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].parts).toHaveLength(2)
})

test("returns null for invalid share data", () => {
  expect(transformShareData([])).toBeNull()
  expect(transformShareData([{ type: "message", data: {} as any }])).toBeNull()
  expect(transformShareData([{ type: "session", data: { id: "s" } as any }])).toBeNull() // no messages
})

// altimate_change start — upstream_fix: imported sessions must persist usage aggregates
test("aggregates imported usage from step-finish parts", () => {
  const result = aggregateImportedUsage([
    {
      info: { role: "assistant", cost: 99, tokens: zeroTokens() } as any,
      parts: [
        {
          type: "step-finish",
          cost: 0.01,
          tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
        } as any,
        {
          type: "step-finish",
          cost: 0.02,
          tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 1 } },
        } as any,
      ],
    },
  ])

  expect(result.cost).toBeCloseTo(0.03)
  expect(result.tokens).toEqual({ input: 11, output: 22, reasoning: 3, cache: { read: 4, write: 6 } })
})

test("falls back to assistant message usage when imported parts have no usage", () => {
  const result = aggregateImportedUsage([
    {
      info: {
        role: "assistant",
        cost: 0.04,
        tokens: { input: 40, output: 50, reasoning: 6, cache: { read: 7, write: 8 } },
      } as any,
      parts: [{ type: "text" } as any],
    },
  ])

  expect(result).toEqual({
    cost: 0.04,
    tokens: { input: 40, output: 50, reasoning: 6, cache: { read: 7, write: 8 } },
  })
})

function zeroTokens() {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}
// altimate_change end
