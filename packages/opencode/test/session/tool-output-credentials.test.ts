// altimate_change — exact literal redaction preserves unrelated tool bytes.
import { expect, test } from "bun:test"
import { Auth } from "@/auth"
import * as Store from "@/altimate/native/connections/credential-store"
import { createCredentialRedactor, toolCredentialRedactor } from "@/altimate/tool-output-credentials"

test("matches literal and JSON-escaped forms inside longer tokens", () => {
  const value = 'fixture-["one"]\\two\nthree'
  const redact = createCredentialRedactor([value])
  expect(redact.text("prefix-" + value + "-suffix")).toBe("prefix-[REDACTED]-suffix")
  expect(redact.text(JSON.stringify({ value }))).toBe('{"value":"[REDACTED]"}')
  expect(redact.lines("before\n" + value + "\nafter")).toBe("before\n[REDACTED]\n\nafter")
})

test("keeps unrelated output byte-identical with known, empty or missing values", () => {
  const original = "SELECT \"fixture\", 'abcd1234', 'AA+/zXY='\r\nshort!\n"
  for (const values of [undefined, [], ["", undefined], ["short!", "unrelated-credential"]]) {
    expect(createCredentialRedactor(values).text(original)).toBe(original)
  }
})

test("sanitizes strings throughout a structured result", () => {
  const value = "warehouse-fixture-value"
  const raw = {
    output: "no result",
    content: [{ type: "resource", resource: { uri: "local://resource", text: value } }],
    metadata: { nested: [{ detail: "before " + value }] },
  }
  expect(createCredentialRedactor([value]).output(raw)).toEqual({
    output: "no result",
    content: [{ type: "resource", resource: { uri: "local://resource", text: "[REDACTED]" } }],
    metadata: { nested: [{ detail: "before [REDACTED]" }] },
  })
})

test("collects environment, provider auth and observed warehouse credentials", async () => {
  const provider = "tool-output-test-provider"
  const envName = "TOOL_OUTPUT_TEST_API_KEY"
  const connectionName = "ALTIMATE_CODE_CONN_TOOL_OUTPUT_TEST"
  const envValue = "fixture-environment-value"
  const authValue = "fixture-auth-value"
  const warehouseValue = "fixture-warehouse-value"
  const envPassword = "fixture-json-password"
  const connection = JSON.stringify({ type: "postgres", password: envPassword, database: "sample-database" })
  const previousEnv = process.env[envName]
  const previousConnection = process.env[connectionName]
  process.env[envName] = envValue
  process.env[connectionName] = connection
  Store.setSecretBackendForTests({
    name: "fixture",
    get: async () => warehouseValue,
    set: async () => {},
    delete: async () => true,
  })
  try {
    await Auth.set(provider, { type: "api", key: authValue })
    expect((await Store.getCredential("fixture-connection", "password")) === warehouseValue).toBe(true)
    const redact = await toolCredentialRedactor()
    for (const value of [envValue, authValue, warehouseValue, envPassword, connection]) {
      expect(redact.text(value) === "[REDACTED]").toBe(true)
    }
    expect(redact.text("sample-database")).toBe("sample-database")
  } finally {
    await Auth.remove(provider)
    Store.setSecretBackendForTests(undefined)
    if (previousEnv === undefined) delete process.env[envName]
    else process.env[envName] = previousEnv
    if (previousConnection === undefined) delete process.env[connectionName]
    else process.env[connectionName] = previousConnection
  }
})

test("matches alternate JSON escapes without reserializing clean text", () => {
  const redact = createCredentialRedactor(["fixture/key"])
  const escaped = String.raw`{"one":"fi\u0078ture\/key","two":"fi\u0078ture\/other"}`
  expect(redact.text(escaped)).toBe(String.raw`{"one":"[REDACTED]","two":"fi\u0078ture\/other"}`)
})

test("holds credential fragments out of streamed Bash previews", () => {
  const redact = createCredentialRedactor(["fixture-key-value"])
  expect(redact.preview("out: fixture-key", 80)).toBe("out: ")
  expect(redact.preview("out: fixture-key-value", 80)).toBe("out: [REDACTED]")
  expect(redact.preview("out: fixture-results", 80)).toBe("out: fixture-results")
  expect(redact.preview("line with \\", 80)).toBe("line with \\")
  expect(redact.preview("prefix fixture-key-value", 18)).toBe("prefix [REDACTED]")
})

test("preserves tool result envelope keys and MCP discriminators", () => {
  const redact = createCredentialRedactor(["metadata", "resource"])
  expect(
    redact.output({ metadata: { detail: "metadata" }, content: [{ type: "resource", text: "resource" }] }),
  ).toEqual({ metadata: { detail: "[REDACTED]" }, content: [{ type: "resource", text: "[REDACTED]" }] })
})

test("redacts the full union of overlapping exact credential values", () => {
  const redact = createCredentialRedactor(["first-fixture", "fixture-tail"])
  expect(redact.text("before first-fixture-tail after")).toBe("before [REDACTED] after")
  expect(redact.window("first-fixture-tail/visible", 14, 26)).toBe("[REDACTED]/visible")
})

test("filters arbitrary structured keys without renaming result protocol fields", () => {
  const credential = "fixture-header-value"
  const redact = createCredentialRedactor([credential, "structuredContent", "truncated"])
  expect<unknown>(
    redact.output({
      structuredContent: { [credential]: "value", "[REDACTED]": "existing" },
      metadata: { truncated: true, [credential]: "detail" },
    }),
  ).toEqual({
    structuredContent: { "[REDACTED] (2)": "value", "[REDACTED]": "existing" },
    metadata: { truncated: true, "[REDACTED]": "detail" },
  })
})

test("filters serializable plugin class fields and retains clean instances", () => {
  class Details {
    constructor(readonly token: string) {}
  }

  const value = "fixture-class-value"
  const redact = createCredentialRedactor([value])
  expect(JSON.stringify(redact.output({ metadata: { details: new Details(value) } }))).toBe(
    '{"metadata":{"details":{"token":"[REDACTED]"}}}',
  )
  const clean = { metadata: { details: new Details("ordinary detail") } }
  expect(redact.output(clean)).toBe(clean)
})

test("redacts normalized CRLF variants based on the source credential length", () => {
  const redact = createCredentialRedactor(["abc\r\ndef"])
  expect(redact.lines("abc\ndef")).toBe("[REDACTED]\n")
})
