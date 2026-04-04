/**
 * Databricks AI Gateway Provider Tests
 *
 * Unit tests for PAT parsing, host validation, and request body transforms.
 * E2E tests for the serving endpoints API (skipped without credentials).
 *
 * For E2E tests, set:
 *   export DATABRICKS_HOST="myworkspace.cloud.databricks.com"
 *   export DATABRICKS_TOKEN="dapi1234567890abcdef"
 *
 * Run:
 *   bun test test/altimate/databricks-provider.test.ts
 */

import { describe, expect, test } from "bun:test"
import {
  parseDatabricksPAT,
  transformDatabricksBody,
  VALID_HOST_RE,
} from "../../src/altimate/plugin/databricks"

// ---------------------------------------------------------------------------
// Host validation regex
// ---------------------------------------------------------------------------

describe("VALID_HOST_RE", () => {
  test("accepts standard AWS workspace host", () => {
    expect(VALID_HOST_RE.test("myworkspace.cloud.databricks.com")).toBe(true)
  })

  test("accepts Azure workspace host", () => {
    expect(VALID_HOST_RE.test("adb-1234567890.12.azuredatabricks.net")).toBe(true)
  })

  test("accepts GCP workspace host", () => {
    expect(VALID_HOST_RE.test("myworkspace.gcp.databricks.com")).toBe(true)
  })

  test("accepts hyphenated workspace names", () => {
    expect(VALID_HOST_RE.test("my-workspace-123.cloud.databricks.com")).toBe(true)
  })

  test("rejects bare hostname without domain", () => {
    expect(VALID_HOST_RE.test("myworkspace")).toBe(false)
  })

  test("rejects non-databricks domain", () => {
    expect(VALID_HOST_RE.test("myworkspace.cloud.example.com")).toBe(false)
  })

  test("rejects empty string", () => {
    expect(VALID_HOST_RE.test("")).toBe(false)
  })

  test("rejects URL with protocol", () => {
    expect(VALID_HOST_RE.test("https://myworkspace.cloud.databricks.com")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PAT parsing
// ---------------------------------------------------------------------------

describe("parseDatabricksPAT", () => {
  test("parses valid AWS host::token", () => {
    const result = parseDatabricksPAT("myworkspace.cloud.databricks.com::dapi1234567890abcdef")
    expect(result).toEqual({
      host: "myworkspace.cloud.databricks.com",
      token: "dapi1234567890abcdef",
    })
  })

  test("parses valid Azure host::token", () => {
    const result = parseDatabricksPAT("adb-123.45.azuredatabricks.net::dapi-token-here")
    expect(result).toEqual({
      host: "adb-123.45.azuredatabricks.net",
      token: "dapi-token-here",
    })
  })

  test("parses valid GCP host::token", () => {
    const result = parseDatabricksPAT("my-ws.gcp.databricks.com::dapiABCDEF123")
    expect(result).toEqual({
      host: "my-ws.gcp.databricks.com",
      token: "dapiABCDEF123",
    })
  })

  test("trims whitespace from host and token", () => {
    const result = parseDatabricksPAT("  myworkspace.cloud.databricks.com  ::  dapi123  ")
    expect(result).toEqual({
      host: "myworkspace.cloud.databricks.com",
      token: "dapi123",
    })
  })

  test("returns null for missing separator", () => {
    expect(parseDatabricksPAT("myworkspace.cloud.databricks.com:dapi123")).toBeNull()
  })

  test("returns null for empty host", () => {
    expect(parseDatabricksPAT("::dapi123")).toBeNull()
  })

  test("returns null for empty token", () => {
    expect(parseDatabricksPAT("myworkspace.cloud.databricks.com::")).toBeNull()
  })

  test("returns null for invalid host domain", () => {
    expect(parseDatabricksPAT("example.com::dapi123")).toBeNull()
  })

  test("returns null for empty string", () => {
    expect(parseDatabricksPAT("")).toBeNull()
  })

  test("returns null for single colon separator", () => {
    expect(parseDatabricksPAT("host.cloud.databricks.com:token")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Request body transforms
// ---------------------------------------------------------------------------

describe("transformDatabricksBody", () => {
  test("converts max_completion_tokens to max_tokens", () => {
    const input = JSON.stringify({
      model: "databricks-meta-llama-3-1-70b-instruct",
      messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 4096,
    })
    const result = JSON.parse(transformDatabricksBody(input).body)
    expect(result.max_tokens).toBe(4096)
    expect(result.max_completion_tokens).toBeUndefined()
  })

  test("preserves max_tokens if already present", () => {
    const input = JSON.stringify({
      model: "databricks-meta-llama-3-1-70b-instruct",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 2048,
    })
    const result = JSON.parse(transformDatabricksBody(input).body)
    expect(result.max_tokens).toBe(2048)
  })

  test("does not convert when both max_tokens and max_completion_tokens exist", () => {
    const input = JSON.stringify({
      model: "databricks-meta-llama-3-1-70b-instruct",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 2048,
      max_completion_tokens: 4096,
    })
    const result = JSON.parse(transformDatabricksBody(input).body)
    expect(result.max_tokens).toBe(2048)
    expect(result.max_completion_tokens).toBe(4096)
  })

  test("passes through body without max token fields unchanged", () => {
    const input = JSON.stringify({
      model: "databricks-dbrx-instruct",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })
    const result = JSON.parse(transformDatabricksBody(input).body)
    expect(result.model).toBe("databricks-dbrx-instruct")
    expect(result.stream).toBe(true)
    expect(result.max_tokens).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// E2E tests (skipped without credentials)
// ---------------------------------------------------------------------------

const DATABRICKS_HOST = process.env.DATABRICKS_HOST
const DATABRICKS_TOKEN = process.env.DATABRICKS_TOKEN
const HAS_DATABRICKS = !!(DATABRICKS_HOST && DATABRICKS_TOKEN)

describe("Databricks Serving Endpoints E2E", () => {
  const skipReason = HAS_DATABRICKS ? undefined : "DATABRICKS_HOST and DATABRICKS_TOKEN not set"

  test.skipIf(!HAS_DATABRICKS)("chat completion with foundation model", async () => {
    const baseURL = `https://${DATABRICKS_HOST}/serving-endpoints`
    const res = await fetch(`${baseURL}/databricks-meta-llama-3-1-8b-instruct/invocations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DATABRICKS_TOKEN}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Say hello in one word." }],
        max_tokens: 32,
      }),
    })

    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(data.choices).toBeDefined()
    expect(data.choices.length).toBeGreaterThan(0)
    expect(data.choices[0].message.content).toBeTruthy()
  })

  test.skipIf(!HAS_DATABRICKS)("streaming chat completion", async () => {
    const baseURL = `https://${DATABRICKS_HOST}/serving-endpoints`
    const res = await fetch(`${baseURL}/databricks-meta-llama-3-1-8b-instruct/invocations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DATABRICKS_TOKEN}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Say hello." }],
        max_tokens: 32,
        stream: true,
      }),
    })

    expect(res.ok).toBe(true)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const text = await res.text()
    expect(text).toContain("data:")
    expect(text).toContain("[DONE]")
  })
})
