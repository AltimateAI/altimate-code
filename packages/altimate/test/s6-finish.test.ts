import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { createFixture, createHost } from "./lib/host"

test("S6 validator decides before execution success and continues with synthetic user feedback", async () => {
  await using fixture = await createFixture()
  const deciding = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const counts: number[] = []
  const validator = Plugin.define({
    id: "completion-validator",
    async setup(ctx) {
      await ctx.session.hook("finish", async (event) => {
        counts.push(event.continuations)
        expect(event.message.finish).toBe("stop")
        expect(event.maxContinuations).toBe(3)
        if (event.continuations !== 0) return
        deciding.resolve()
        await release.promise
        event.decision = { continue: true, text: "Validate the result before finishing." }
      })
    },
  })
  await using host = await createHost({ directory: fixture.path, altimate: false, plugins: [validator] })
  const session = await host.createSession()
  await host.start(session.id, [{ text: "Unchecked result." }, { text: "Validated result." }])
  await deciding.promise
  const before = await Array.fromAsync(host.opencode.sessions.log({ sessionID: session.id }))
  expect(before.filter((event) => event.type === "session.execution.succeeded")).toHaveLength(0)
  expect(host.model.calls).toHaveLength(1)
  release.resolve()
  await host.opencode.sessions.wait({ sessionID: session.id })
  const after = await Array.fromAsync(host.opencode.sessions.log({ sessionID: session.id }))
  expect(counts).toEqual([0, 1])
  expect(host.model.calls).toHaveLength(2)
  expect(host.model.calls[1].prompt).toContainEqual({
    role: "user",
    content: [{ type: "text", text: "Validate the result before finishing." }],
  })
  expect(after.filter((event) => event.type === "session.execution.succeeded")).toHaveLength(1)
  const synthetic = after.findIndex((event) => event.type === "session.synthetic")
  const success = after.findIndex((event) => event.type === "session.execution.succeeded")
  expect(synthetic).toBeGreaterThan(-1)
  expect(success).toBeGreaterThan(synthetic)
}, 30_000)

test("S6 validator continuation limit fails execution and resets for a new prompt", async () => {
  await using fixture = await createFixture()
  const counts: number[] = []
  const validator = Plugin.define({
    id: "repeating-validator",
    async setup(ctx) {
      await ctx.session.hook("finish", (event) => {
        counts.push(event.continuations)
        event.decision = { continue: true, text: "Keep validating." }
      })
    },
  })
  await using host = await createHost({ directory: fixture.path, altimate: false, plugins: [validator] })
  const session = await host.createSession()
  const steps = Array.from({ length: 5 }, () => ({ text: "Proposed completion." }))
  const first = await host.run(session.id, steps)
  expect(counts).toEqual([0, 1, 2, 3])
  expect(host.model.calls).toHaveLength(4)
  expect(first.filter((event) => event.type === "session.synthetic")).toHaveLength(3)
  expect(first.filter((event) => event.type === "session.execution.succeeded")).toHaveLength(0)
  expect(first.filter((event) => event.type === "session.execution.failed")).toMatchObject([
    { data: { error: { type: "finish-limit" } } },
  ])
  await host.run(session.id, steps)
  expect(counts).toEqual([0, 1, 2, 3, 0, 1, 2, 3])
  expect(host.model.calls).toHaveLength(8)
}, 30_000)

test("S6 reads the finish continuation limit from a real config file", async () => {
  await using fixture = await createFixture()
  await mkdir(join(fixture.path, "config"))
  await Bun.write(
    join(fixture.path, "config", "opencode.json"),
    JSON.stringify({ experimental: { finish_continuations: 0 } }),
  )
  const limits: number[] = []
  const validator = Plugin.define({
    id: "configured-validator",
    async setup(ctx) {
      await ctx.session.hook("finish", (event) => {
        limits.push(event.maxContinuations)
        event.decision = { continue: true, text: "Disallowed feedback." }
      })
    },
  })
  await using host = await createHost({ directory: fixture.path, altimate: false, plugins: [validator] })
  const session = await host.createSession()
  const log = await host.run(session.id, [{ text: "Proposed completion." }])
  expect(limits).toEqual([0])
  expect(host.model.calls).toHaveLength(1)
  expect(log.filter((event) => event.type === "session.synthetic")).toHaveLength(0)
  expect(log.filter((event) => event.type === "session.execution.succeeded")).toHaveLength(0)
  expect(log.filter((event) => event.type === "session.execution.failed")).toMatchObject([
    { data: { error: { type: "finish-limit" } } },
  ])
}, 30_000)
