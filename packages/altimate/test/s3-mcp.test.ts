import { expect, test } from "bun:test"
import { Plugin } from "@opencode/plugin"
import { fileURLToPath } from "node:url"
import { workspaceMcp } from "../src/workspace-mcp"
import { createFixture, createHost } from "./lib/host"

const name = "altimate_workspace"
const tool = `${name}_probe`
const config = {
  type: "local" as const,
  command: [process.execPath, fileURLToPath(new URL("./lib/mcp-stub.ts", import.meta.url))],
  codemode: false,
}

test("S3.1. a new session advertises and executes workspace MCP on its first model request", async () => {
  await using fixture = await createFixture()
  const outputs: unknown[] = []
  await using host = await createHost({
    directory: fixture.path,
    plugins: [
      workspaceMcp({ name, config, tools: [tool] }),
      Plugin.define({
        id: "s3-tool-output-observer",
        async setup(ctx) {
          await ctx.tool.hook("execute.after", (event) => {
            if (event.tool === tool && event.status === "completed") outputs.push(event.result.output)
          })
        },
      }),
    ],
    permissions: [{ action: tool, resource: "*", effect: "allow" }],
  })
  const session = await host.createSession()
  expect((await host.opencode.mcp.list({ location: { directory: fixture.path } })).data).toEqual([])
  const events = await host.run(session.id, [{ tool, id: "workspace-first", input: { value: "first-request-ready" } }])
  expect(host.model.calls).toHaveLength(2)
  expect(host.model.calls[0].tools?.some((entry) => entry.name === tool)).toBe(true)
  const success = events.find((event) => event.type === "session.tool.success" && event.data.id === "workspace-first")
  expect(success?.type).toBe("session.tool.success")
  if (success?.type !== "session.tool.success") throw new Error("Missing workspace MCP tool success")
  expect(outputs).toEqual([{ echoed: "first-request-ready" }])
  expect(success.data.content).toContainEqual({ type: "text", text: '{"echoed":"first-request-ready"}' })
  expect((await host.opencode.mcp.list({ location: { directory: fixture.path } })).data).toContainEqual({
    name,
    status: { status: "connected" },
  })
}, 30_000)

test("S3.2. SDK removal suppresses a plugin MCP server even after its transform reloads", async () => {
  await using fixture = await createFixture()
  const observed: { tools?: Plugin.Context["tool"]; mcp?: Plugin.Context["mcp"] } = {}
  await using host = await createHost({
    directory: fixture.path,
    plugins: [
      workspaceMcp({ name, config, tools: [tool], timeoutMs: 2_000 }),
      Plugin.define({
        id: "s3-public-observer",
        setup(ctx) {
          observed.tools = ctx.tool
          observed.mcp = ctx.mcp
        },
      }),
    ],
  })
  const session = await host.createSession()
  await host.run(session.id, [])
  expect((await observed.tools!.list()).some((entry) => entry.id === tool)).toBe(true)
  await host.opencode.mcp.remove({ server: name, location: { directory: fixture.path } })
  await observed.mcp!.reload()
  const deadline = performance.now() + 5_000
  while ((await observed.tools!.list()).some((entry) => entry.id === tool) && performance.now() < deadline) {
    await Bun.sleep(10)
  }
  expect((await host.opencode.mcp.list({ location: { directory: fixture.path } })).data).toEqual([])
  expect((await observed.tools!.list()).some((entry) => entry.id === tool)).toBe(false)
  await expect(
    host.opencode.sessions.prompt({ sessionID: session.id, text: "Still requires the workspace tool" }),
  ).rejects.toThrow()
  expect(host.model.calls).toHaveLength(1)
}, 30_000)

test("S3.4. readiness deadline bounds a transform waiting for a slow MCP catalog", async () => {
  await using fixture = await createFixture()
  await using host = await createHost({
    directory: fixture.path,
    plugins: [
      Plugin.define({
        id: "s3-existing-server",
        async setup(ctx) {
          await ctx.mcp.transform((editor) => editor.set("already_present", { ...config, disabled: true }))
        },
      }),
      workspaceMcp({
        name,
        config: { ...config, environment: { ALTIMATE_MCP_CATALOG_DELAY_MS: "1500" } },
        tools: [tool],
        timeoutMs: 200,
      }),
    ],
  })
  const session = await host.createSession()
  const started = performance.now()
  await expect(
    host.opencode.sessions.prompt({ sessionID: session.id, text: "The slow catalog must not block admission forever" }),
  ).rejects.toThrow()
  expect(performance.now() - started).toBeLessThan(1_000)
  expect(host.model.calls).toHaveLength(0)
}, 30_000)

test("S3.3. a missing required tool hits the readiness deadline before any model request", async () => {
  await using fixture = await createFixture()
  await using host = await createHost({
    directory: fixture.path,
    plugins: [workspaceMcp({ name, config, tools: [`${name}_missing`], timeoutMs: 500 })],
  })
  const session = await host.createSession()
  const started = performance.now()
  await expect(
    host.opencode.sessions.prompt({ sessionID: session.id, text: "Do not run before workspace readiness" }),
  ).rejects.toThrow()
  expect(performance.now() - started).toBeGreaterThanOrEqual(450)
  expect(performance.now() - started).toBeLessThan(5_000)
  expect(host.model.calls).toHaveLength(0)
}, 30_000)
