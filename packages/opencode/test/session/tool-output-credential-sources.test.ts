// altimate_change — synthetic fixtures for known credential sources.
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Effect } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { expect, test } from "bun:test"
import { loadToolCredentialRedactor, toolCredentialRedactor } from "@/altimate/tool-output-credentials"
import * as Store from "@/altimate/native/connections/credential-store"
import { AppRuntime } from "@/effect/app-runtime"
import { McpAuth } from "@/mcp/auth"
import { provideTestInstance, tmpdir } from "../fixture/fixture"

test("collects provider token environment names and MCP OAuth credentials", async () => {
  const providerToken = "fixture-gateway-token"
  const accessToken = "fixture-mcp-access-token"
  const refreshToken = "fixture-mcp-refresh-token"
  const clientSecret = "fixture-mcp-client-secret"
  const clientId = "fixture-mcp-client-id"
  const entry = "fixture-output-redaction"
  const previous = process.env.CF_AIG_TOKEN
  process.env.CF_AIG_TOKEN = providerToken
  try {
    await AppRuntime.runPromise(
      McpAuth.use.set(entry, { tokens: { accessToken, refreshToken }, clientInfo: { clientId, clientSecret } }),
    )
    const redact = await toolCredentialRedactor()
    for (const value of [providerToken, accessToken, refreshToken, clientSecret]) {
      expect(redact.text(value)).toBe("[REDACTED]")
    }
    expect(redact.text(clientId)).toBe(clientId)
  } finally {
    if (previous === undefined) delete process.env.CF_AIG_TOKEN
    else process.env.CF_AIG_TOKEN = previous
    await AppRuntime.runPromise(McpAuth.use.remove(entry))
  }
})

test("collects warehouse credential leaves without changing a password-free connection value", async () => {
  const envName = "ALTIMATE_CODE_CONN_REDACTION_SOURCE_TEST"
  const cleanEnvName = "ALTIMATE_CODE_CONN_REDACTION_CLEAN_SOURCE_TEST"
  const privateKey = "fixture-environment-private-key\nsecond-line"
  const storedKey = "fixture-stored-private-key\nsecond-line"
  const accountId = "fixture-warehouse-account"
  const stored = JSON.stringify({ private_key: storedKey, client_email: accountId })
  const config = JSON.stringify({ type: "bigquery", credentials_json: JSON.stringify({ private_key: privateKey }) })
  const clean = JSON.stringify({ type: "duckdb", path: "fixture-local.duckdb" })
  const previous = process.env[envName]
  const previousClean = process.env[cleanEnvName]
  process.env[envName] = config
  process.env[cleanEnvName] = clean
  Store.setSecretBackendForTests({
    name: "fixture",
    get: async () => stored,
    set: async () => {},
    delete: async () => true,
  })
  try {
    await Store.getCredential("fixture-output-redaction", "credentials_json")
    const redact = await toolCredentialRedactor()
    for (const value of [privateKey, storedKey]) {
      expect(redact.text(value)).toBe("[REDACTED]")
    }
    expect(redact.text(JSON.stringify({ key: storedKey }))).toBe('{"key":"[REDACTED]"}')
    expect(redact.text(config)).toBe(
      JSON.stringify({ type: "bigquery", credentials_json: JSON.stringify({ private_key: "[REDACTED]" }) }),
    )
    expect(redact.text(stored)).toBe(JSON.stringify({ private_key: "[REDACTED]", client_email: accountId }))
    expect(redact.text(clean)).toBe(clean)
    expect(redact.text(accountId)).toBe(accountId)
  } finally {
    Store.setSecretBackendForTests(undefined)
    if (previous === undefined) delete process.env[envName]
    else process.env[envName] = previous
    if (previousClean === undefined) delete process.env[cleanEnvName]
    else process.env[cleanEnvName] = previousClean
  }
})

test("collects configured and command-resolved MCP authorization in an isolated SDK process", async () => {
  // Other MCP suites replace the SDK transports in the parent process.
  const child = Bun.spawn(
    [process.execPath, "test", path.join(import.meta.dir, "tool-output-mcp-credentials.fixture.ts")],
    { cwd: path.resolve(import.meta.dir, "../.."), stdout: "ignore", stderr: "pipe" },
  )
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect({ code, error: code === 0 ? "" : stderr }).toEqual({ code: 0, error: "" })
}, 40_000)

test("collects serialized connection URL credentials without masking ordinary URL fields", async () => {
  const envName = "ALTIMATE_CODE_CONN_REDACTION_URL_TEST"
  const previous = process.env[envName]
  const password = "fixture/url-password"
  const encodedPassword = encodeURIComponent(password)
  const token = "fixture-url-token"
  const connection = `postgres://reader:${encodedPassword}@warehouse.example/db?token=${token}&region=west`
  const clean = "postgres://reader@warehouse.example/db?region=west"
  process.env[envName] = JSON.stringify({ type: "postgres", connection_string: connection, host: "warehouse.example" })
  try {
    const redact = await toolCredentialRedactor()
    expect(redact.text(password)).toBe("[REDACTED]")
    expect(redact.text(connection)).toBe(
      `postgres://reader:[REDACTED]@warehouse.example/db?token=[REDACTED]&region=west`,
    )
    expect(redact.text(clean)).toBe(clean)
  } finally {
    if (previous === undefined) delete process.env[envName]
    else process.env[envName] = previous
  }
})

test("collects local warehouse credentials with only InstanceRef context", async () => {
  const password = "fixture-instance-ref-password"
  await using tmp = await tmpdir({
    init: async (directory) => {
      const configDir = path.join(directory, ".altimate-code")
      await mkdir(configDir)
      await Bun.write(
        path.join(configDir, "connections.json"),
        JSON.stringify({ fixture: { type: "postgres", password } }),
      )
    },
  })
  await provideTestInstance({
    directory: tmp.path,
    fn: async (instance) => {
      const redact = await Effect.runPromise(
        loadToolCredentialRedactor.pipe(Effect.provideService(InstanceRef, instance)),
      )
      expect(redact.text(password)).toBe("[REDACTED]")
    },
  })
})
