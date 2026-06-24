/**
 * Adversarial tests for v0.6.0 release.
 *
 * Covers:
 *   1. isValidDatabricksHost — regex anchoring + CRLF/whitespace rejection
 *   2. parseDatabricksPAT — edge cases (multiple ::, empty parts, unicode)
 *   3. transformDatabricksBody — malformed JSON, missing fields, passthrough
 *   4. toolNamesFromMessages — tainted tool names (ANSI, shell meta, overlong)
 *   5. data_diff tool description — cascade + compliance note present
 */

import { describe, test, expect } from "bun:test"
import {
  VALID_HOST_RE,
  isValidDatabricksHost,
  parseDatabricksPAT,
  transformDatabricksBody,
} from "../../src/altimate/plugin/databricks"
import { LLM } from "../../src/session/llm"
import { DataDiffTool } from "../../src/altimate/tools/data-diff"
import { initTool } from "../altimate/tool-fixture"
import type { ModelMessage } from "ai"

// ---------------------------------------------------------------------------
// 1. isValidDatabricksHost — anchoring + CRLF
// ---------------------------------------------------------------------------

describe("isValidDatabricksHost — anchoring", () => {
  test("accepts canonical AWS host", () => {
    expect(isValidDatabricksHost("myworkspace.cloud.databricks.com")).toBe(true)
  })

  test("accepts Azure and GCP hosts", () => {
    expect(isValidDatabricksHost("adb-123.12.azuredatabricks.net")).toBe(true)
    expect(isValidDatabricksHost("my-wks.gcp.databricks.com")).toBe(true)
  })

  test("rejects attacker suffix — evil.cloud.databricks.com.attacker.com", () => {
    expect(isValidDatabricksHost("evil.cloud.databricks.com.attacker.com")).toBe(false)
  })

  test("rejects attacker prefix with databricks.com in middle", () => {
    expect(isValidDatabricksHost("a.cloud.databricks.com.evil.tld")).toBe(false)
  })

  test("rejects CRLF injection — host\\r\\nHost:attacker", () => {
    // JS regex `$` matches before `\n` by default. The helper must filter
    // this independently so a splice into URL/header context can't smuggle
    // a second header or line.
    expect(isValidDatabricksHost("myworkspace.cloud.databricks.com\r\nHost: attacker")).toBe(false)
    expect(isValidDatabricksHost("myworkspace.cloud.databricks.com\n")).toBe(false)
    expect(isValidDatabricksHost("myworkspace.cloud.databricks.com\r")).toBe(false)
  })

  test("rejects leading/trailing whitespace", () => {
    expect(isValidDatabricksHost(" myworkspace.cloud.databricks.com")).toBe(false)
    expect(isValidDatabricksHost("myworkspace.cloud.databricks.com ")).toBe(false)
    expect(isValidDatabricksHost("\tmyworkspace.cloud.databricks.com")).toBe(false)
  })

  test("rejects empty and null-ish inputs", () => {
    expect(isValidDatabricksHost("")).toBe(false)
    expect(isValidDatabricksHost(" ")).toBe(false)
    expect(isValidDatabricksHost("\t")).toBe(false)
  })

  test("rejects bare domain (no workspace prefix)", () => {
    // Regex requires at least one segment before the whitelisted suffix
    expect(isValidDatabricksHost("cloud.databricks.com")).toBe(false)
    expect(isValidDatabricksHost(".cloud.databricks.com")).toBe(false)
  })

  test("rejects similar-looking but unauthorized domains", () => {
    expect(isValidDatabricksHost("myws.databricks.com")).toBe(false)
    expect(isValidDatabricksHost("myws.cloud-databricks.com")).toBe(false)
    expect(isValidDatabricksHost("myws.clouddatabricks.com")).toBe(false)
  })

  test("exported regex is still available for callers that want just the pattern match", () => {
    expect(VALID_HOST_RE.test("myworkspace.cloud.databricks.com")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. parseDatabricksPAT — edge cases
// ---------------------------------------------------------------------------

describe("parseDatabricksPAT — edge cases", () => {
  test("happy path", () => {
    const r = parseDatabricksPAT("myws.cloud.databricks.com::dapi1234567890")
    expect(r).toEqual({ host: "myws.cloud.databricks.com", token: "dapi1234567890" })
  })

  test("rejects input without separator", () => {
    expect(parseDatabricksPAT("nohostnoseparator")).toBe(null)
    expect(parseDatabricksPAT("myws.cloud.databricks.com")).toBe(null)
  })

  test("rejects empty host or token", () => {
    expect(parseDatabricksPAT("::dapi1234")).toBe(null)
    expect(parseDatabricksPAT("myws.cloud.databricks.com::")).toBe(null)
    expect(parseDatabricksPAT("::")).toBe(null)
  })

  test("rejects invalid host even with valid token", () => {
    expect(parseDatabricksPAT("attacker.com::dapi1234")).toBe(null)
    expect(parseDatabricksPAT("evil.cloud.databricks.com.attacker.com::dapi1234")).toBe(null)
  })

  test("rejects CRLF in host part", () => {
    expect(parseDatabricksPAT("myws.cloud.databricks.com\r\nHost:evil::dapi1234")).toBe(null)
  })

  test("token containing :: is preserved (tokens can contain the separator)", () => {
    // Split is on FIRST ::, so tokens with `::` survive intact
    const r = parseDatabricksPAT("myws.cloud.databricks.com::dapi::with::colons")
    expect(r).toEqual({ host: "myws.cloud.databricks.com", token: "dapi::with::colons" })
  })

  test("trims whitespace around host and token", () => {
    const r = parseDatabricksPAT("  myws.cloud.databricks.com  ::  dapi1234  ")
    expect(r).toEqual({ host: "myws.cloud.databricks.com", token: "dapi1234" })
  })

  test("trim strips leading/trailing whitespace even right next to separator", () => {
    // Space before `::` is trimmed, so this parses as the canonical host
    const r = parseDatabricksPAT("myws.cloud.databricks.com ::dapi1234")
    expect(r).toEqual({ host: "myws.cloud.databricks.com", token: "dapi1234" })
  })

  test("rejects host with embedded newline (CRLF survives trim)", () => {
    // trim() strips leading/trailing whitespace but NOT embedded CR/LF in the middle
    expect(parseDatabricksPAT("myws.cloud\r\n.databricks.com::dapi1234")).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// 3. transformDatabricksBody — malformed and edge input
// ---------------------------------------------------------------------------

describe("transformDatabricksBody — edge cases", () => {
  test("renames max_completion_tokens to max_tokens when latter is absent", () => {
    const out = transformDatabricksBody(JSON.stringify({ max_completion_tokens: 500 }))
    const parsed = JSON.parse(out.body)
    expect(parsed.max_tokens).toBe(500)
    expect(parsed.max_completion_tokens).toBeUndefined()
  })

  test("preserves existing max_tokens and does NOT rename when both present", () => {
    const out = transformDatabricksBody(JSON.stringify({ max_tokens: 500, max_completion_tokens: 100 }))
    const parsed = JSON.parse(out.body)
    expect(parsed.max_tokens).toBe(500)
    expect(parsed.max_completion_tokens).toBe(100)
  })

  test("passes body through unchanged when no token field is present", () => {
    const input = JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
    const out = transformDatabricksBody(input)
    expect(JSON.parse(out.body)).toEqual({ messages: [{ role: "user", content: "hi" }] })
  })

  test("throws on invalid JSON (caller catches and passes through)", () => {
    expect(() => transformDatabricksBody("not a json")).toThrow()
    expect(() => transformDatabricksBody("")).toThrow()
  })

  test("handles zero-value max_completion_tokens correctly", () => {
    const out = transformDatabricksBody(JSON.stringify({ max_completion_tokens: 0 }))
    const parsed = JSON.parse(out.body)
    expect(parsed.max_tokens).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. toolNamesFromMessages — tainted tool names
// ---------------------------------------------------------------------------

describe("toolNamesFromMessages — validation guards", () => {
  function msg(toolName: string): ModelMessage[] {
    return [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: toolName as any,
            input: {},
          } as any,
        ],
      },
    ]
  }

  test("accepts standard tool names", () => {
    expect(LLM.toolNamesFromMessages(msg("bash"))).toEqual(new Set(["bash"]))
    expect(LLM.toolNamesFromMessages(msg("data_diff"))).toEqual(new Set(["data_diff"]))
    expect(LLM.toolNamesFromMessages(msg("sql-execute"))).toEqual(new Set(["sql-execute"]))
    expect(LLM.toolNamesFromMessages(msg("Tool123"))).toEqual(new Set(["Tool123"]))
  })

  test("rejects shell metacharacters", () => {
    expect(LLM.toolNamesFromMessages(msg("rm -rf /"))).toEqual(new Set())
    expect(LLM.toolNamesFromMessages(msg("bash; rm -rf /"))).toEqual(new Set())
    expect(LLM.toolNamesFromMessages(msg("$(whoami)"))).toEqual(new Set())
    expect(LLM.toolNamesFromMessages(msg("`id`"))).toEqual(new Set())
  })

  test("rejects ANSI escape sequences", () => {
    expect(LLM.toolNamesFromMessages(msg("[2J"))).toEqual(new Set())
    expect(LLM.toolNamesFromMessages(msg("bash[31m"))).toEqual(new Set())
  })

  test("rejects control characters (null, CR, LF, tab)", () => {
    expect(LLM.toolNamesFromMessages(msg("bash "))).toEqual(new Set())
    expect(LLM.toolNamesFromMessages(msg("bash\r\n"))).toEqual(new Set())
    expect(LLM.toolNamesFromMessages(msg("bash\t"))).toEqual(new Set())
  })

  test("rejects names longer than 64 characters", () => {
    const long = "a".repeat(65)
    expect(LLM.toolNamesFromMessages(msg(long))).toEqual(new Set())

    const exact = "a".repeat(64)
    expect(LLM.toolNamesFromMessages(msg(exact))).toEqual(new Set([exact]))
  })

  test("rejects empty string", () => {
    expect(LLM.toolNamesFromMessages(msg(""))).toEqual(new Set())
  })

  test("rejects non-string input types (tampered session file)", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "x", toolName: 123 as any, input: {} } as any,
          { type: "tool-call", toolCallId: "y", toolName: null as any, input: {} } as any,
          { type: "tool-call", toolCallId: "z", toolName: undefined as any, input: {} } as any,
          { type: "tool-call", toolCallId: "a", toolName: { evil: true } as any, input: {} } as any,
        ],
      },
    ]
    expect(LLM.toolNamesFromMessages(messages)).toEqual(new Set())
  })

  test("scans tool-result blocks (orphaned results from compaction)", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result",
            toolCallId: "r1",
            toolName: "read",
            output: { type: "text", value: "ok" },
          } as any,
        ],
      } as any,
    ]
    expect(LLM.toolNamesFromMessages(messages)).toEqual(new Set(["read"]))
  })

  test("deduplicates across multiple messages", () => {
    const messages: ModelMessage[] = [
      ...msg("bash"),
      ...msg("bash"),
      ...msg("read"),
    ]
    expect(LLM.toolNamesFromMessages(messages)).toEqual(new Set(["bash", "read"]))
  })

  test("returns empty set for messages with text-only content", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ]
    expect(LLM.toolNamesFromMessages(messages)).toEqual(new Set())
  })

  test("ignores messages with non-array content", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "plain text" as any },
    ]
    expect(LLM.toolNamesFromMessages(messages)).toEqual(new Set())
  })
})

// ---------------------------------------------------------------------------
// 5. data_diff tool description — release-notes contract
// ---------------------------------------------------------------------------

describe("data_diff tool description — release contract", () => {
  test("description mentions all 5 algorithms (auto, joindiff, hashdiff, profile, cascade)", async () => {
    const info = await initTool(DataDiffTool)
    expect(info.description).toContain("auto:")
    expect(info.description).toContain("joindiff:")
    expect(info.description).toContain("hashdiff:")
    expect(info.description).toContain("profile:")
    // Fix #6 — cascade was missing from the pre-release description
    expect(info.description).toContain("cascade:")
  })

  test("description warns about PII/PHI/PCI data (Chaos Gremlin P0 partial fix)", async () => {
    const info = await initTool(DataDiffTool)
    expect(info.description.toLowerCase()).toMatch(/pii|phi|pci|compliance/)
    expect(info.description).toContain("profile")
  })

  test("description mentions partition threshold", async () => {
    const info = await initTool(DataDiffTool)
    expect(info.description.toLowerCase()).toContain("partition")
  })

  test("tool parameters enum includes cascade", async () => {
    // altimate_change: post-v1.17.9 the new Tool API stores `parameters` as an opaque
    // Effect Schema (no zod `.shape`). The introspectable parameter contract is now
    // `info.jsonSchema` (zodToJsonSchema of the legacy zod params, via tool-zod-compat).
    const info = await initTool(DataDiffTool)
    const algorithmField = (info as any).jsonSchema?.properties?.algorithm
    expect(algorithmField).toBeDefined()
    expect(algorithmField.enum).toContain("cascade")
  })
})
