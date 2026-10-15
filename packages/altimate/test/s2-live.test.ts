import "./lib/environment"
import { expect, test } from "bun:test"
import { Plugin } from "@opencode/plugin"
import { OpenCode } from "@opencode/sdk"
import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { gateway } from "../src/gateway"
import { createFixture } from "./lib/host"

// Opt in explicitly. ALTIMATE_GATEWAY_URL is the API root (without /agents/v1).
// Requires ALTIMATE_API_KEY and ALTIMATE_INSTANCE; no credentials are printed.
test.skipIf(process.env.ALTIMATE_LIVE !== "1")(
  "S2.live. real Altimate gateway streams a completion",
  async () => {
    expect(process.env.ALTIMATE_API_KEY).toBeTruthy()
    expect(process.env.ALTIMATE_INSTANCE).toBeTruthy()
    expect(process.env.ALTIMATE_GATEWAY_URL ?? process.env.ALTIMATE_API_URL).toBeTruthy()
    await using fixture = await createFixture()
    const installed = createRequire(new URL("../../core/package.json", import.meta.url)).resolve(
      "@ai-sdk/openai-compatible",
    )
    await using opencode = await OpenCode.create({
      database: { path: join(fixture.path, "live.sqlite") },
      events: { persist: true },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
      plugins: [
        gateway({
          credentialsPath: join(fixture.path, "absent.json"),
          baseCredentialsPath: join(fixture.path, "absent-base.json"),
          env: process.env,
        }),
        Plugin.define({
          id: "s2-installed-provider",
          async setup(ctx) {
            await ctx.provider.transform((editor) =>
              editor.update("altimate-backend", (provider) => {
                provider.package = `aisdk:${pathToFileURL(installed).href}`
              }),
            )
          },
        }),
      ],
      config: {
        directory: join(fixture.path, "config"),
        project: false,
        content: JSON.stringify({
          model: "altimate-backend/altimate-default",
          agents: { title: { disabled: true } },
          snapshots: false,
        }),
      },
    })
    const session = await opencode.sessions.create({ location: { directory: fixture.path } })
    await opencode.sessions.prompt({
      sessionID: session.id,
      text: "Reply with exactly: Altimate live completion succeeded.",
    })
    await opencode.sessions.wait({ sessionID: session.id })
    const events = await Array.fromAsync(opencode.sessions.log({ sessionID: session.id }))
    expect(events.some((event) => event.type === "session.step.streamed")).toBe(true)
    expect(events.some((event) => event.type === "session.step.ended" && event.data.finish === "stop")).toBe(true)
    expect(events.some((event) => event.type === "session.text.ended" && event.data.text.trim().length > 0)).toBe(true)
  },
  120_000,
)
