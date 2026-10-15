import { describe, expect, test } from "bun:test"
import path from "node:path"
import { FileExporter, Trace, type TraceFile } from "../../src/altimate/observability/tracing"
import { TraceConsumer } from "../../src/altimate/observability/trace-consumer"
import { RunTracing } from "../../src/cli/cmd/run-tracing"
import { tmpdir } from "../fixture/fixture"

function running(start = Date.now() - 1000) {
  return {
    id: "tool-part",
    sessionID: "session",
    messageID: "assistant-message",
    type: "tool" as const,
    tool: "sql_execute",
    callID: "tool-call",
    state: { status: "running" as const, input: { sql: "SELECT 1" }, time: { start } },
  }
}

async function readTrace(directory: string): Promise<TraceFile> {
  return Bun.file(path.join(directory, "session.json")).json()
}

describe("running tool traces", () => {
  test("persists the tool start and input before the call completes", async () => {
    await using tmp = await tmpdir()
    const trace = Trace.withExporters([new FileExporter(tmp.path)])
    trace.startTrace("session", {})
    trace.logStepStart({ id: "step", messageID: "assistant-message" })
    const part = running()
    trace.logToolCall(part)
    trace.logToolCall(part)
    await trace.flush()

    const file = await readTrace(tmp.path)
    const tools = file.spans.filter((span) => span.kind === "tool")
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      startTime: part.state.time.start,
      status: "running",
      input: part.state.input,
      parentSpanId: file.spans.find((span) => span.kind === "generation")!.spanId,
    })
    expect(tools[0]!.endTime).toBeUndefined()
    expect(file.summary.totalToolCalls).toBe(1)
    await trace.endTrace()
  })

  test.each(["completed", "error"] as const)("updates the same span on %s without double counting", async (status) => {
    await using tmp = await tmpdir()
    const trace = Trace.withExporters([new FileExporter(tmp.path)])
    trace.startTrace("session", {})
    trace.logStepStart({ id: "step", messageID: "assistant-message" })
    const part = running()
    trace.logToolCall(part)
    trace.setSpanAttributes({ warehouse: "warehouse" }, "tool")
    await trace.flush()
    const started = (await readTrace(tmp.path)).spans.find((span) => span.kind === "tool")!
    const end = part.state.time.start + 500
    const finished = {
      ...part,
      state: status === "completed"
        ? { ...part.state, status, output: "one row", time: { ...part.state.time, end } }
        : { ...part.state, status, error: "query failed", time: { ...part.state.time, end } },
    }
    trace.logToolCall(finished)
    trace.logToolCall(finished)
    trace.logToolCall(part)
    await trace.endTrace()

    const file = await readTrace(tmp.path)
    const tools = file.spans.filter((span) => span.kind === "tool")
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      spanId: started.spanId,
      startTime: part.state.time.start,
      endTime: end,
      status: status === "completed" ? "ok" : "error",
      tool: { callId: part.callID, durationMs: 500 },
      output: status === "completed" ? "one row" : { error: "query failed" },
      attributes: { warehouse: "warehouse" },
    })
    expect(file.summary.totalToolCalls).toBe(1)
  })

  test.each(["endTrace", "finalizeSync", "flushSync"] as const)("%s aborts an unfinished tool with its original start", async (method) => {
    await using tmp = await tmpdir()
    const trace = Trace.withExporters([new FileExporter(tmp.path)])
    trace.startTrace("session", {})
    const part = running()
    trace.logToolCall(part)
    const before = Date.now()
    await trace[method]()
    const after = Date.now()

    const file = await readTrace(tmp.path)
    const tools = file.spans.filter((span) => span.kind === "tool")
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ startTime: part.state.time.start, status: "aborted", input: part.state.input })
    expect(tools[0]!.endTime).toBeGreaterThanOrEqual(before)
    expect(tools[0]!.endTime).toBeLessThanOrEqual(after)
    expect(tools[0]!.tool!.durationMs).toBe(tools[0]!.endTime! - part.state.time.start)
    expect(file.summary.totalToolCalls).toBe(1)
    await trace.flush()
  })

  test("an explicitly interrupted tool error is recorded as aborted", async () => {
    await using tmp = await tmpdir()
    const trace = Trace.withExporters([new FileExporter(tmp.path)])
    trace.startTrace("session", {})
    const part = running()
    trace.logToolCall(part)
    trace.logToolCall({
      ...part,
      state: {
        ...part.state,
        status: "error",
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { ...part.state.time, end: part.state.time.start + 400 },
      },
    })
    await trace.endTrace()
    const file = await readTrace(tmp.path)
    expect(file.spans.filter((span) => span.kind === "tool")).toMatchObject([
      { status: "aborted", interrupted: true, tool: { durationMs: 400 } },
    ])
  })

  test("running calls with unserializable inputs still leave a span", async () => {
    await using tmp = await tmpdir()
    const trace = Trace.withExporters([new FileExporter(tmp.path)])
    trace.startTrace("session", {})
    const part = running()
    const input: Record<string, unknown> = {}
    input.self = input
    trace.logToolCall({ ...part, state: { ...part.state, input } })
    await trace.flush()
    const file = await readTrace(tmp.path)
    expect(file.summary.status).toBe("running")
    expect(file.spans.filter((span) => span.kind === "tool")).toMatchObject([
      { status: "running", input: { _serialization_error: expect.any(String) } },
    ])
    await trace.endTrace()
  })

  test("rehydration closes a tool left running by an ungraceful exit", async () => {
    await using tmp = await tmpdir()
    const original = Trace.withExporters([new FileExporter(tmp.path)])
    original.startTrace("session", {})
    const part = running()
    original.logToolCall(part)
    await original.flush()
    const trace = Trace.withExporters([new FileExporter(tmp.path)])
    expect(await trace.rehydrateFromFile("session")).toBe(true)
    await trace.endTrace()
    const file = await readTrace(tmp.path)
    expect(file.spans.filter((span) => span.kind === "tool")).toMatchObject([
      { status: "aborted", startTime: part.state.time.start, input: part.state.input },
    ])
  })

  test("shared event consumer captures a running call before synchronous shutdown", async () => {
    await using tmp = await tmpdir()
    const consumer = new TraceConsumer({ exporters: [new FileExporter(tmp.path)] })
    const part = running()
    await consumer.handleEvent({ type: "message.part.updated", properties: { part } })
    consumer.flushSync()
    const file = await readTrace(tmp.path)
    expect(file.spans.filter((span) => span.kind === "tool")).toMatchObject([
      { status: "aborted", startTime: part.state.time.start, input: part.state.input },
    ])
  })

  test("run event consumer captures a running call before interruption", async () => {
    await using tmp = await tmpdir()
    const trace = Trace.withExporters([new FileExporter(tmp.path)])
    trace.startTrace("session", {})
    const router = new RunTracing("session", trace, { get: async () => undefined, children: async () => [] })
    const part = running()
    await router.observe({ type: "message.part.updated", properties: { part } })
    router.flushSync("Interrupted")
    const file = await readTrace(tmp.path)
    expect(file.spans.filter((span) => span.kind === "tool")).toMatchObject([
      { status: "aborted", startTime: part.state.time.start, input: part.state.input },
    ])
    await trace.flush()
  })
})
