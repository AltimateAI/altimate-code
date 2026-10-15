import { expect, test } from "bun:test"
import { Model, Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { memoryTelemetry } from "../src/telemetry"
import { createFixture, createHost } from "./lib/host"

test("S4.1. exports two complete model steps and completed/interrupted tools in one session", async () => {
  await using fixture = await createFixture()
  const exporter = memoryTelemetry()
  const started = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const tools = Plugin.define({
    id: "s4-tools-and-costs",
    async setup(ctx) {
      await ctx.provider.transform((editor) =>
        editor.models.update("scripted", "scripted", (model) => {
          model.cost = [Schema.decodeUnknownSync(Model.Cost)({ input: 2, output: 4, cache: { read: 0.5, write: 3 } })]
        }),
      )
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "telemetry_complete",
          description: "Return a delayed local result.",
          input: Schema.Struct({}),
          options: { codemode: false },
          async execute() {
            await Bun.sleep(80)
            return { content: "Completed telemetry probe." }
          },
        })
        editor.add({
          name: "telemetry_interrupt",
          description: "Wait for session interruption.",
          input: Schema.Struct({}),
          options: { codemode: false },
          async execute(_input, context) {
            started.resolve()
            await new Promise<void>((_resolve, reject) => {
              context.signal.addEventListener(
                "abort",
                () => {
                  aborted.resolve()
                  reject(context.signal.reason)
                },
                { once: true },
              )
            })
            return { content: "Unreachable after interruption." }
          },
        })
      })
    },
  })
  await using host = await createHost({ directory: fixture.path, plugins: [exporter.plugin, tools] })
  const session = await host.createSession()
  await host.run(session.id, [
    {
      tool: "telemetry_complete",
      input: {},
      id: "completed",
      delayMs: 20,
      usage: {
        inputTokens: { total: 20, noCache: 10, cacheRead: 6, cacheWrite: 4 },
        outputTokens: { total: 8, text: 5, reasoning: 3 },
      },
    },
    {
      text: "Two-step telemetry completion.",
      delayMs: 25,
      usage: {
        inputTokens: { total: 40, noCache: 30, cacheRead: 8, cacheWrite: 2 },
        outputTokens: { total: 12, text: 10, reasoning: 2 },
      },
    },
  ])
  await until(() => exporter.records.length === 3)
  const generations = exporter.records.filter((record) => record.type === "generation")
  expect(generations).toHaveLength(2)
  expect(generations[0]).toMatchObject({
    session_id: session.id,
    model_id: "scripted",
    provider_id: "scripted",
    agent: "build",
    finish_reason: "tool-calls",
    outcome: "completed",
    tokens_input: 10,
    tokens_input_total: 20,
    tokens_output: 8,
    tokens_visible_output: 5,
    tokens_reasoning: 3,
    tokens_cache_read: 6,
    tokens_cache_write: 4,
  })
  expect(generations[0].cost).toBeCloseTo(0.000067, 10)
  expect(generations[1]).toMatchObject({
    session_id: session.id,
    model_id: "scripted",
    provider_id: "scripted",
    agent: "build",
    finish_reason: "stop",
    outcome: "completed",
    tokens_input: 30,
    tokens_input_total: 40,
    tokens_output: 12,
    tokens_visible_output: 10,
    tokens_reasoning: 2,
    tokens_cache_read: 8,
    tokens_cache_write: 2,
  })
  expect(generations[1].cost).toBeCloseTo(0.000118, 10)
  const log = await Array.fromAsync(host.opencode.sessions.log({ sessionID: session.id }))
  generations.forEach((generation) => {
    const start = log.find(
      (event) => event.type === "session.step.started" && event.data.assistantMessageID === generation.message_id,
    )
    const streamed = log.find(
      (event) => event.type === "session.step.streamed" && event.data.assistantMessageID === generation.message_id,
    )
    if (start?.type !== "session.step.started" || streamed?.type !== "session.step.streamed")
      throw new Error("Missing real step boundaries")
    expect(generation.duration_ms).toBe(streamed.created - start.data.started)
    expect(generation.duration_ms).toBeGreaterThanOrEqual(15)
  })
  const complete = exporter.records.find((record) => record.type === "tool_call")
  expect(complete).toMatchObject({
    session_id: session.id,
    message_id: generations[0].message_id,
    tool_call_id: "completed",
    tool_name: "telemetry_complete",
    status: "success",
    after_hook: "completed",
  })
  expect(complete?.duration_ms).toBeGreaterThanOrEqual(70)
  expect(host.model.calls).toHaveLength(2)

  await host.start(session.id, [
    {
      tool: "telemetry_interrupt",
      input: {},
      id: "interrupted",
      delayMs: 15,
      usage: {
        inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 2, text: 2, reasoning: 0 },
      },
    },
  ])
  await started.promise
  await Bun.sleep(30)
  await host.opencode.sessions.interrupt({ sessionID: session.id })
  await aborted.promise
  await host.opencode.sessions.wait({ sessionID: session.id })
  await until(() => exporter.records.length === 5)
  const interrupted = exporter.records.find(
    (record) => record.type === "tool_call" && record.tool_call_id === "interrupted",
  )
  expect(interrupted).toMatchObject({
    session_id: session.id,
    tool_name: "telemetry_interrupt",
    status: "interrupted",
    error: "Tool execution interrupted",
  })
  if (interrupted?.type !== "tool_call") throw new Error("Missing interrupted tool telemetry")
  expect(interrupted.after_hook).toBeUndefined()
  expect(interrupted.duration_ms).toBeGreaterThanOrEqual(25)
  const interruptedStep = exporter.records.find(
    (record) => record.type === "generation" && record.outcome === "interrupted",
  )
  expect(interruptedStep).toMatchObject({
    message_id: interrupted.message_id,
    model_id: "scripted",
    provider_id: "scripted",
    tokens_input: 7,
    tokens_output: 2,
    finish_reason: "error",
    raw_finish_reason: "tool_calls",
  })
  if (interruptedStep?.type !== "generation") throw new Error("Missing interrupted generation telemetry")
  expect(interruptedStep.cost).toBeCloseTo(0.000022, 10)
  expect(interruptedStep.duration_ms).toBeGreaterThanOrEqual(10)
  const interruptedLog = await Array.fromAsync(host.opencode.sessions.log({ sessionID: session.id }))
  const interruptedStart = interruptedLog.find(
    (event) => event.type === "session.step.started" && event.data.assistantMessageID === interruptedStep.message_id,
  )
  const interruptedStream = interruptedLog.find(
    (event) => event.type === "session.step.streamed" && event.data.assistantMessageID === interruptedStep.message_id,
  )
  if (interruptedStart?.type !== "session.step.started" || interruptedStream?.type !== "session.step.streamed")
    throw new Error("Missing interrupted step boundaries")
  expect(interruptedStep.duration_ms).toBe(interruptedStream.created - interruptedStart.data.started)
  expect(host.model.calls).toHaveLength(3)
  expect(exporter.records.filter((record) => record.type === "tool_call")).toHaveLength(2)
}, 30_000)

test("S4.2. nested Code Mode hooks retain the outer execute identity and duration", async () => {
  await using fixture = await createFixture()
  const exporter = memoryTelemetry()
  const calls: string[] = []
  const nested = Plugin.define({
    id: "s4-nested-tools",
    async setup(ctx) {
      await ctx.tool.transform((editor) => {
        ;["telemetry_inner_first", "telemetry_inner_second"].forEach((name) =>
          editor.add({
            name,
            description: "Return a nested Code Mode result.",
            input: Schema.Struct({}),
            async execute() {
              calls.push(name)
              await Bun.sleep(25)
              return { content: name }
            },
          }),
        )
      })
    },
  })
  await using host = await createHost({ directory: fixture.path, plugins: [exporter.plugin, nested] })
  const session = await host.createSession()
  const log = await host.run(session.id, [
    {
      tool: "execute",
      id: "outer",
      input: {
        code: "const a = await tools.telemetry_inner_first({}); const b = await tools.telemetry_inner_second({}); return [a, b]",
      },
    },
  ])
  expect(calls).toEqual(["telemetry_inner_first", "telemetry_inner_second"])
  expect(log.some((event) => event.type === "session.tool.success" && event.data.id === "outer")).toBe(true)
  await until(() => exporter.records.filter((record) => record.type === "tool_call").length === 1)
  const record = exporter.records.find((record) => record.type === "tool_call")
  expect(record).toMatchObject({
    tool_name: "execute",
    tool_call_id: "outer",
    status: "success",
    after_hook: "completed",
  })
  expect(record?.duration_ms).toBeGreaterThanOrEqual(45)
}, 30_000)

async function until(ready: () => boolean) {
  const deadline = Date.now() + 3000
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error("Telemetry exporter did not receive its expected records")
    await Bun.sleep(5)
  }
}
