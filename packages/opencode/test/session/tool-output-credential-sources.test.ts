// altimate_change — synthetic fixtures for known credential sources.
import path from "node:path"
import { mkdir, utimes } from "node:fs/promises"
import { Effect } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { expect, spyOn, test } from "bun:test"
import { loadToolCredentialRedactor, toolCredentialRedactor } from "@/altimate/tool-output-credentials"
import * as Store from "@/altimate/native/connections/credential-store"
import { AppRuntime } from "@/effect/app-runtime"
import { Instance } from "@/project/instance"
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
  const reads = spyOn(McpAuth, "all")
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
    expect(await toolCredentialRedactor()).toBe(redact)
    expect(reads).toHaveBeenCalledTimes(1)
    const rotated = "fixture-mcp-rotated-token"
    await AppRuntime.runPromise(McpAuth.use.set(entry, { tokens: { accessToken: rotated } }))
    const updated = await toolCredentialRedactor()
    expect(updated.text(rotated)).toBe("[REDACTED]")
    expect(updated.text(accessToken)).toBe(accessToken)
    expect(reads).toHaveBeenCalledTimes(2)

    // Whole-second timestamps cannot safely cache rewrites of equal size.
    await utimes(McpAuth.credentialFile, 1_700_000_000, 1_700_000_000)
    await toolCredentialRedactor()
    await toolCredentialRedactor()
    expect(reads).toHaveBeenCalledTimes(4)
  } finally {
    reads.mockRestore()
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
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "ignore",
      stderr: "pipe",
      signal: AbortSignal.timeout(65_000),
    },
  )
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect({ code, error: code === 0 ? "" : stderr }).toEqual({ code: 0, error: "" })
}, 70_000)

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

test("collects warehouse credentials but preserves public certificate settings", async () => {
  const fixtures = {
    PGPASSWORD: "fixture-postgres-credential",
    MYSQL_PWD: "fixture-mysql-credential",
    FIXTURE_PRIVATE_KEY: "fixture-environment-private-key",
    ALTIMATE_CODE_CONN_FIXTURE_DSN: JSON.stringify({
      type: "fixture",
      connection_string: 'Server=warehouse.example;Pwd={fixture;odbc}}password};Token="fixture-token";',
      ssl_cert: "/fixture/client-cert.pem",
      ssl_ca: "/fixture/root-ca.pem",
      tls_ca_cert: "/fixture/tls-ca.pem",
    }),
  }
  const previous = Object.keys(fixtures).map((key) => [key, process.env[key]] as const)
  Object.assign(process.env, fixtures)
  try {
    const redact = await toolCredentialRedactor()
    for (const value of [
      fixtures.PGPASSWORD,
      fixtures.MYSQL_PWD,
      fixtures.FIXTURE_PRIVATE_KEY,
      "fixture;odbc}password",
      "fixture-token",
    ]) {
      expect(redact.text(value)).toBe("[REDACTED]")
    }
    const config = JSON.parse(fixtures.ALTIMATE_CODE_CONN_FIXTURE_DSN)
    expect(redact.text(config.connection_string)).toBe('Server=warehouse.example;Pwd={[REDACTED]};Token="[REDACTED]";')
    for (const field of [config.ssl_cert, config.ssl_ca, config.tls_ca_cert]) {
      expect(redact.text(field)).toBe(field)
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("preserves provider locations and collects explicit auth aliases and MCP header credentials", async () => {
  const variables = { FIXTURE_AUTH_ALIAS: "fixture-provider-alias", GOOGLE_VERTEX_LOCATION: "fixture-central1" }
  const previous = Object.keys(variables).map((key) => [key, process.env[key]] as const)
  Object.assign(process.env, variables)
  const headers = {
    apikey: "fixture-header-api",
    "Private-Token": "fixture-header-private",
    "X-Api-Token": "fixture-header-token",
    "X-Trace-Id": "fixture-header-trace",
  }
  try {
    await using tmp = await tmpdir({
      config: {
        provider: {
          fixture: { env: ["FIXTURE_AUTH_ALIAS", "GOOGLE_VERTEX_LOCATION"] },
        },
        mcp: {
          fixture: { type: "remote", enabled: false, url: "https://fixture.invalid", headers },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        try {
          const redact = await toolCredentialRedactor()
          expect(redact.text(variables.FIXTURE_AUTH_ALIAS)).toBe("[REDACTED]")
          expect(redact.text(variables.GOOGLE_VERTEX_LOCATION)).toBe(variables.GOOGLE_VERTEX_LOCATION)
          expect(redact.text(headers.apikey)).toBe("[REDACTED]")
          expect(redact.text(headers["Private-Token"])).toBe("[REDACTED]")
          expect(redact.text(headers["X-Api-Token"])).toBe("[REDACTED]")
          expect(redact.text(headers["X-Trace-Id"])).toBe(headers["X-Trace-Id"])
        } finally {
          await Instance.dispose()
        }
      },
    })
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
