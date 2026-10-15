import { expect, test } from "bun:test"
import { Plugin } from "@opencode/plugin"
import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { gateway } from "../src/gateway"
import { createFixture, createHost } from "./lib/host"

test("S2.http.1. actual AI SDK HTTP request uses a custom endpoint connected after setup", async () => {
  await using fixture = await createFixture()
  const transport = captureGatewayTransport()
  await using host = await createHost({
    directory: fixture.path,
    altimate: false,
    plugins: [
      gateway({
        credentialsPath: join(fixture.path, "absent.json"),
        baseCredentialsPath: join(fixture.path, "absent-base.json"),
        env: {},
      }),
      transport.plugin,
    ],
  })
  const session = await host.createSession()
  await host.opencode.integration.list({ location: { directory: fixture.path } })
  await host.opencode.integration.connect.key({
    location: { directory: fixture.path },
    integrationID: "altimate-backend",
    key: "https://connected.example.invalid/root::key_team::transport-key",
  })
  await host.opencode.sessions.switchModel({
    sessionID: session.id,
    model: { providerID: "altimate-backend", id: "altimate-default" },
  })
  const events = await host.run(session.id, [])
  expect(transport.requests).toHaveLength(1)
  expect(transport.requests[0].url).toBe("https://connected.example.invalid/root/agents/v1/chat/completions")
  expect(transport.requests[0].headers).toMatchObject({
    "x-tenant": "key_team",
    authorization: "Bearer transport-key",
  })
  expect(transport.requests[0].body).toMatchObject({ model: "altimate-default", stream: true })
  expect(
    events.some((event) => event.type === "session.text.ended" && event.data.text === "Gateway transport completed."),
  ).toBe(true)
  expect(events.some((event) => event.type === "session.step.ended" && event.data.finish === "stop")).toBe(true)
}, 30_000)

test("S2.http.2. cached AI SDK language uses updated file endpoint and tenant on the next request", async () => {
  await using fixture = await createFixture()
  const credentialsPath = join(fixture.path, "altimate.json")
  await Bun.write(
    credentialsPath,
    JSON.stringify({
      altimateUrl: "https://first.example.invalid",
      altimateInstanceName: "first_team",
      altimateApiKey: "first-key",
    }),
  )
  const transport = captureGatewayTransport()
  await using host = await createHost({
    directory: fixture.path,
    altimate: false,
    plugins: [
      gateway({ credentialsPath, baseCredentialsPath: join(fixture.path, "absent-base.json"), env: {} }),
      transport.plugin,
    ],
  })
  const session = await host.createSession()
  await host.opencode.sessions.switchModel({
    sessionID: session.id,
    model: { providerID: "altimate-backend", id: "altimate-default" },
  })
  await host.run(session.id, [])
  await Bun.write(
    credentialsPath,
    JSON.stringify({
      altimateUrl: "https://second.example.invalid/nested",
      altimateInstanceName: "second_team",
      altimateApiKey: "second-key",
    }),
  )
  await host.run(session.id, [])
  expect(transport.requests).toHaveLength(2)
  expect(transport.requests[0]).toMatchObject({
    url: "https://first.example.invalid/agents/v1/chat/completions",
    headers: { "x-tenant": "first_team", authorization: "Bearer first-key" },
  })
  expect(transport.requests[1]).toMatchObject({
    url: "https://second.example.invalid/nested/agents/v1/chat/completions",
    headers: { "x-tenant": "second_team", authorization: "Bearer second-key" },
  })
}, 30_000)

function captureGatewayTransport() {
  const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = []
  const installed = createRequire(new URL("../../core/package.json", import.meta.url)).resolve(
    "@ai-sdk/openai-compatible",
  )
  const chunks = [
    {
      id: "s2-transport",
      object: "chat.completion.chunk",
      created: 1,
      model: "altimate-default",
      choices: [
        { index: 0, delta: { role: "assistant", content: "Gateway transport completed." }, finish_reason: null },
      ],
    },
    {
      id: "s2-transport",
      object: "chat.completion.chunk",
      created: 1,
      model: "altimate-default",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    },
  ]
  const responseURL = `data:text/event-stream,${encodeURIComponent(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n")}`
  return {
    requests,
    plugin: Plugin.define({
      id: "s2-http-capture",
      async setup(ctx) {
        await ctx.provider.transform((editor) =>
          editor.update("altimate-backend", (provider) => {
            provider.package = `aisdk:${pathToFileURL(installed).href}`
          }),
        )
        await ctx.session.hook(
          "http.request",
          async (event) => {
            requests.push({
              url: event.request.url,
              headers: Object.fromEntries(event.request.headers),
              body: await event.request.clone().json(),
            })
            // Exercise real AI SDK serialization and the core HTTP seam without a listener or network.
            event.request = new Request(responseURL, event.request)
          },
          { providerID: "altimate-backend" },
        )
      },
    }),
  }
}
