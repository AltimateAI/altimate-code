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
