import { expect, test } from "bun:test"
import { Plugin, Provider } from "@opencode/plugin"
import { join } from "node:path"
import { gateway } from "../src/gateway"
import { createFixture, createHost } from "./lib/host"
import { createScriptedModel } from "./lib/scripted-model"

test("S2.1. default Altimate setup registers the tenant gateway and key method", async () => {
  await using fixture = await createFixture()
  await using host = await createHost({ directory: fixture.path })
  await host.createSession()
  const location = { directory: fixture.path }
  const integrations = (await host.opencode.integration.list({ location })).data
  expect(integrations.find((integration) => integration.id === "altimate-backend")?.methods).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "key" })]),
  )
  await host.opencode.integration.connect.key({
    location,
    integrationID: "altimate-backend",
    key: "default_team::default-key",
  })
  const providers = (await host.opencode.provider.list({ location })).data
  expect(JSON.stringify(providers)).not.toContain("default-key")
  expect(providers.find((provider) => provider.id === "altimate-backend")).toMatchObject({
    name: "Altimate AI",
    package: "aisdk:@ai-sdk/openai-compatible",
  })
  expect((await host.opencode.provider.get({ location, providerID: "altimate-free" })).data).toMatchObject({
    name: "Altimate",
    package: "aisdk:@ai-sdk/openai-compatible",
    activation: "disabled",
  })
  const integration = await host.opencode.integration.get({ location, integrationID: "altimate-backend" })
  expect(integration.data.methods).toEqual(expect.arrayContaining([expect.objectContaining({ type: "key" })]))
  expect((await host.opencode.model.list({ location })).data).toEqual(
    expect.arrayContaining([expect.objectContaining({ providerID: "altimate-backend", id: "altimate-default" })]),
  )
}, 30_000)

test("S2.2. v1 credential file with environment substitution supplies models, tenant and request URL", async () => {
  await using fixture = await createFixture()
  const credentialsPath = join(fixture.path, "altimate.json")
  await Bun.write(
    credentialsPath,
    JSON.stringify({
      altimateUrl: "https://tenant.example.invalid/",
      altimateInstanceName: "${env:TEST_TENANT}",
      altimateApiKey: "${env:TEST_API_KEY}",
    }),
  )
  const capture = scriptedGateway()
  await using host = await createHost({
    directory: fixture.path,
    altimate: false,
    plugins: [
      gateway({
        credentialsPath,
        baseCredentialsPath: join(fixture.path, "absent-base.json"),
        env: {
          TEST_TENANT: "warehouse_team",
          TEST_API_KEY: "file-key",
          ALTIMATE_GATEWAY_URL: "https://ignored.example.invalid",
          ALTIMATE_INSTANCE: "ignored",
          ALTIMATE_API_KEY: "ignored",
        },
      }),
      capture.plugin,
    ],
  })
  const models = (await host.opencode.model.list({ location: { directory: fixture.path } })).data
  expect(models.find((model) => model.providerID === "altimate-backend")).toMatchObject({ id: "altimate-default" })
  const session = await host.createSession()
  await host.opencode.sessions.switchModel({
    sessionID: session.id,
    model: { providerID: "altimate-backend", id: "altimate-default" },
  })
  await host.run(session.id, [])
  expect(capture.requests).toEqual([
    {
      providerID: "altimate-backend",
      baseURL: "https://tenant.example.invalid/agents/v1",
      headers: expect.objectContaining({ "x-tenant": "warehouse_team", Authorization: "Bearer file-key" }),
    },
  ])
  expect(capture.model.calls).toHaveLength(1)
  expect(capture.model.remaining).toBe(0)
}, 30_000)

test("S2.3. key integration persists a credential and enables a streamed gateway completion", async () => {
  await using fixture = await createFixture()
  const capture = scriptedGateway()
  await using host = await createHost({
    directory: fixture.path,
    altimate: false,
    plugins: [
      gateway({
        credentialsPath: join(fixture.path, "absent.json"),
        baseCredentialsPath: join(fixture.path, "absent-base.json"),
        env: {},
      }),
      capture.plugin,
    ],
  })
  const location = { directory: fixture.path }
  const key = "https://key.example.invalid::key_team::sdk-key"
  const session = await host.createSession()
  await host.opencode.integration.list({ location })
  expect(
    (await host.opencode.model.list({ location })).data.some((model) => model.providerID === "altimate-backend"),
  ).toBe(false)
  await host.opencode.integration.connect.key({ location, integrationID: "altimate-backend", key })
  expect(await host.opencode.credential.list()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ integrationID: "altimate-backend", active: true, value: { type: "key", key } }),
    ]),
  )
  const models = (await host.opencode.model.list({ location })).data
  expect(models.some((model) => model.providerID === "altimate-backend" && model.id === "altimate-default")).toBe(true)
  await host.opencode.sessions.switchModel({
    sessionID: session.id,
    model: { providerID: "altimate-backend", id: "altimate-default" },
  })
  const events = await host.run(session.id, [])
  expect(
    events.some((event) => event.type === "session.text.ended" && event.data.text === "Gateway fixture completed."),
  ).toBe(true)
  expect(capture.requests[0]).toMatchObject({
    baseURL: "https://key.example.invalid/agents/v1",
    headers: {
      "x-tenant": "key_team",
      Authorization: "Bearer sdk-key",
    },
  })
  expect(capture.model.calls).toHaveLength(1)
}, 30_000)

test("S2.4. explicit environment credentials provide the gateway URL and tenant", async () => {
  await using fixture = await createFixture()
  const capture = scriptedGateway()
  await using host = await createHost({
    directory: fixture.path,
    altimate: false,
    plugins: [
      gateway({
        credentialsPath: join(fixture.path, "absent.json"),
        baseCredentialsPath: join(fixture.path, "absent-base.json"),
        env: {
          ALTIMATE_GATEWAY_URL: "https://env.example.invalid",
          ALTIMATE_INSTANCE: "env_team",
          ALTIMATE_API_KEY: "env-key",
        },
      }),
      capture.plugin,
    ],
  })
  const session = await host.createSession()
  await host.opencode.sessions.switchModel({
    sessionID: session.id,
    model: { providerID: "altimate-backend", id: "altimate-default" },
  })
  await host.run(session.id, [])
  expect(capture.requests[0]).toMatchObject({
    baseURL: "https://env.example.invalid/agents/v1",
    headers: {
      "x-tenant": "env_team",
      Authorization: "Bearer env-key",
    },
  })
  expect(capture.model.calls).toHaveLength(1)
}, 30_000)

test("S2.5. matching Altimate Base credential enables its model with bearer auth and no tenant", async () => {
  await using fixture = await createFixture()
  const baseCredentialsPath = join(fixture.path, "base.json")
  await Bun.write(
    baseCredentialsPath,
    JSON.stringify({
      version: 1,
      installSecret: "fixture-install-secret",
      apiKey: "base-key",
      baseURL: "https://base.example.invalid",
    }),
  )
  const capture = scriptedGateway("altimate-free")
  await using host = await createHost({
    directory: fixture.path,
    altimate: false,
    plugins: [
      gateway({
        credentialsPath: join(fixture.path, "absent.json"),
        baseCredentialsPath,
        env: {
          ALTIMATE_BASE_GATEWAY_URL: "https://base.example.invalid",
        },
      }),
      capture.plugin,
    ],
  })
  const models = (await host.opencode.model.list({ location: { directory: fixture.path } })).data
  expect(models.some((model) => model.providerID === "altimate-free" && model.id === "altimate-base")).toBe(true)
  const session = await host.createSession()
  await host.opencode.sessions.switchModel({
    sessionID: session.id,
    model: { providerID: "altimate-free", id: "altimate-base" },
  })
  await host.run(session.id, [])
  expect(capture.requests[0]).toMatchObject({
    baseURL: "https://base.example.invalid/v1",
    headers: { Authorization: "Bearer base-key" },
  })
  expect(capture.requests[0]?.headers["x-tenant"]).toBeUndefined()
  expect(capture.model.calls).toHaveLength(1)
}, 30_000)

test.each([
  { reason: "expired", stored: { expiresAt: "2000-01-01T00:00:00.000Z" } },
  { reason: "rejected", stored: { rejected: true } },
  { reason: "different gateway", stored: { baseURL: "https://different.example.invalid" } },
])(
  "S2.6. Altimate Base $reason credentials do not enable its model",
  async ({ stored }) => {
    await using fixture = await createFixture()
    const baseCredentialsPath = join(fixture.path, "base.json")
    await Bun.write(
      baseCredentialsPath,
      JSON.stringify({
        version: 1,
        installSecret: "fixture-install-secret",
        apiKey: "base-key",
        baseURL: "https://base.example.invalid",
        ...stored,
      }),
    )
    await using host = await createHost({
      directory: fixture.path,
      altimate: false,
      plugins: [
        gateway({
          credentialsPath: join(fixture.path, "absent.json"),
          baseCredentialsPath,
          env: {
            ALTIMATE_BASE_GATEWAY_URL: "https://base.example.invalid",
          },
        }),
      ],
    })
    const location = { directory: fixture.path }
    expect(
      (await host.opencode.model.list({ location })).data.some((model) => model.providerID === "altimate-free"),
    ).toBe(false)
    expect((await host.opencode.provider.get({ location, providerID: "altimate-free" })).data.activation).toBe(
      "disabled",
    )
  },
  30_000,
)

function scriptedGateway(id = "altimate-backend") {
  const model = createScriptedModel([{ text: "Gateway fixture completed." }])
  const requests: Array<{ providerID: string; baseURL?: string; headers: Record<string, string> }> = []
  return {
    model,
    requests,
    plugin: Plugin.define({
      id: "s2-scripted-gateway",
      async setup(ctx) {
        const providerID = Provider.ID.make(id)
        await ctx.provider.transform((editor) =>
          editor.update(providerID, (provider) => {
            provider.package = `aisdk:${new URL("./lib/provider-fixture.ts", import.meta.url).href}`
          }),
        )
        await ctx.aisdk.hook(
          "language",
          (event) => {
            event.language = model.language
          },
          { providerID },
        )
        await ctx.session.hook(
          "model.request",
          (event) => {
            requests.push({ providerID: event.model.providerID, baseURL: event.baseURL, headers: { ...event.headers } })
          },
          { providerID },
        )
      },
    }),
  }
}

test("S2.9. malformed legacy credentials disable gateways without failing plugin setup", async () => {
  await using fixture = await createFixture()
  const credentialsPath = join(fixture.path, "invalid-tenant.json")
  const baseCredentialsPath = join(fixture.path, "invalid-base.json")
  await Bun.write(credentialsPath, "{invalid json")
  await Bun.write(baseCredentialsPath, JSON.stringify({ version: 99 }))
  await using host = await createHost({
    directory: fixture.path,
    altimate: false,
    plugins: [gateway({ credentialsPath, baseCredentialsPath, env: {} })],
  })
  const location = { directory: fixture.path }
  const integrations = (await host.opencode.integration.list({ location })).data
  expect(integrations.some((integration) => integration.id === "altimate-backend")).toBe(true)
  const models = (await host.opencode.model.list({ location })).data
  expect(models.some((model) => model.providerID.startsWith("altimate-"))).toBe(false)
  const session = await host.createSession()
  const events = await host.run(session.id, [])
  expect(events.some((event) => event.type === "session.text.ended" && event.data.text === "Script complete.")).toBe(
    true,
  )
})
