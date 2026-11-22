// altimate_change — synthetic fixtures for known credential sources.
import { expect, test } from "bun:test"
import { toolCredentialRedactor } from "@/altimate/tool-output-credentials"
import * as Store from "@/altimate/native/connections/credential-store"
import { AppRuntime } from "@/effect/app-runtime"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Instance } from "@/project/instance"
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
    for (const value of [privateKey, storedKey, config, stored]) {
      expect(redact.text(value)).toBe("[REDACTED]")
    }
    expect(redact.text(JSON.stringify({ key: storedKey }))).toBe('{"key":"[REDACTED]"}')
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

test("collects configured and command-resolved MCP authorization without changing ordinary headers", async () => {
  const configuredToken = "fixture-configured-token"
  const resolvedToken = "fixture-command-resolved-token"
  const traceHeader = "fixture-not-a-credential"
  const serverName = "fixture-output-redaction"
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const message = (await request.json()) as {
        id?: number
        method: string
        params?: { protocolVersion: string }
      }
      if (message.id === undefined) return new Response(null, { status: 202 })
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion,
          capabilities: {},
          serverInfo: { name: serverName, version: "1" },
        },
      })
    },
  })
  await using tmp = await tmpdir({
    config: {
      mcp: {
        configured: {
          type: "remote",
          enabled: false,
          url: String(server.url),
          headers: { Authorization: "Bearer " + configuredToken, "X-Trace-Id": traceHeader },
        },
      },
    },
  })
  await provideTestInstance({
    directory: tmp.path,
    fn: (instance) =>
      Instance.restore(instance, async () => {
        await MCP.add(serverName, {
          type: "remote",
          url: String(server.url),
          timeout: 1_000,
          headersCommand: {
            Authorization: [
              process.execPath,
              "-e",
              `process.stdout.write("Bearer " + ${JSON.stringify(resolvedToken)})`,
            ],
          },
        })
        try {
          expect((await MCP.status())[serverName]?.status).toBe("connected")
          const redact = await toolCredentialRedactor()
          for (const value of [configuredToken, resolvedToken, "Bearer " + resolvedToken]) {
            expect(redact.text(value)).toBe("[REDACTED]")
          }
          expect(redact.text(traceHeader)).toBe(traceHeader)
        } finally {
          await MCP.remove(serverName)
        }
        expect((await toolCredentialRedactor()).text(resolvedToken)).toBe(resolvedToken)
      }),
  })
}, 25_000)
