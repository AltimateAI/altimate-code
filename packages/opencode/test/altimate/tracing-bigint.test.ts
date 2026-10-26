import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { RunTracing } from "../../src/cli/cmd/run-tracing"
import { TraceConsumer } from "../../src/altimate/observability/trace-consumer"
import { FileExporter, HttpExporter, Trace, type TraceFile } from "../../src/altimate/observability/tracing"
import { Log } from "../../src/altimate/util/log"
import { tmpdir } from "../fixture/fixture"

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const spy of spies.splice(0).reverse()) spy.mockRestore()
})

const counts = { small: 42n, large: 9007199254740993n, negative: -9007199254740993n }
const serializedCounts = { small: "42", large: "9007199254740993", negative: "-9007199254740993" }

function toolEvent(id: string) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id,
        sessionID: "bigint",
        messageID: "assistant",
        type: "tool",
        tool: "sql_execute",
        callID: id,
        state: {
          status: "completed",
          input: counts,
          output: "42\nChecks:\nCheck: null_propagating_concat",
          time: { start: 1, end: 2 },
        },
      },
    },
  }
}

describe("BigInt tracing boundaries", () => {
  test("snapshots and final exports preserve nested BigInts in spans, tool inputs, and metadata", async () => {
    await using tmp = await tmpdir()
    const trace = Trace.withExporters([new FileExporter(tmp.path, 0)])
    trace.startTrace("bigint", {})
    trace.logSpan({ name: "counts", startTime: 1, endTime: 2, input: counts, output: [counts] })
    trace.logToolCall(toolEvent("count").properties.part as Parameters<Trace["logToolCall"]>[0])
    trace.setSpanAttributes({ counts }, "tool")
    trace.setRunBudget({ elapsed_s: 1, time_budget_deadline: "none", ...{ counts } })
    trace.setRunLineage({ rootSessionId: "bigint", ...{ counts } })
    await trace.flush()

    const snapshot = (await Bun.file(trace.getTracePath()!).json()) as TraceFile
    expect(snapshot.spans.find((span) => span.name === "counts")?.input).toEqual(serializedCounts)
    expect(snapshot.spans.find((span) => span.name === "counts")?.output).toEqual([serializedCounts])
    expect(snapshot.spans.find((span) => span.kind === "tool")?.input).toEqual(serializedCounts)
    expect(snapshot.spans.find((span) => span.kind === "tool")?.attributes?.counts).toEqual(serializedCounts)
    expect(snapshot.metadata).toMatchObject({ counts: serializedCounts })
    expect(snapshot.metadata.run).toMatchObject({ counts: serializedCounts })
    expect(await trace.endTrace()).toBe(trace.getTracePath())
    expect((await Bun.file(trace.getTracePath()!).json()).metadata.counts).toEqual(serializedCounts)
    expect(counts.small).toBe(42n)
  })

  test.each(["finalizeSync", "flushSync"] as const)("%s retains BigInt evidence", async (method) => {
    await using tmp = await tmpdir()
    const trace = Trace.withExporters([new FileExporter(tmp.path, 0)])
    trace.startTrace(`bigint-${method}`, {})
    await trace.flush()
    trace.logSpan({ name: "counts", startTime: 1, endTime: 2, output: counts })
    trace[method]()
    await trace.flush()
    const file = (await Bun.file(trace.getTracePath()!).json()) as TraceFile
    expect(file.spans.find((span) => span.name === "counts")?.output).toEqual(serializedCounts)
  })

  test("file and HTTP exporters accept BigInts supplied directly by an exporter caller", async () => {
    await using tmp = await tmpdir()
    let file: TraceFile | undefined
    const trace = Trace.withExporters([
      {
        name: "memory",
        export: async (value) => {
          file = value
          return undefined
        },
      },
    ])
    trace.startTrace("bigint-export", {})
    await trace.endTrace()
    file!.spans[0]!.input = counts
    const filePath = await new FileExporter(tmp.path, 0).export(file!)
    expect(filePath).toBeDefined()
    expect((await Bun.file(filePath!).json()).spans[0].input).toEqual(serializedCounts)

    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"))
    spies.push(fetch)
    expect(await new HttpExporter("test", "https://unused.invalid").export(file!)).toBe("test: exported")
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).spans[0].input).toEqual(serializedCounts)
  })

  test("LLM request snapshots hash and preserve BigInt tool schema fields", async () => {
    let file: TraceFile | undefined
    const trace = Trace.withExporters([
      {
        name: "memory",
        export: async (value) => {
          file = value
          return undefined
        },
      },
    ])
    trace.startTrace("bigint", {})
    const request = {
      requestID: "request-1",
      sessionID: "bigint",
      messageID: "assistant",
      userMessageID: "user",
      agent: "analyst",
      providerID: "test",
      modelID: "test",
      startTime: 1,
      system: "Count rows",
      tools: [{ name: "sql_execute", active: true, inputSchema: { counts } }],
    }
    trace.logLLMRequest(request)
    trace.logLLMRequest({ ...request, requestID: "request-2" })
    await trace.endTrace()
    const inputs = file!.spans.filter((span) => span.name === "llm-request").map((span) => span.input as any)
    expect(inputs).toHaveLength(2)
    expect(inputs[0].tools.content[0].inputSchema.counts).toEqual(serializedCounts)
    expect(inputs[1].tools).toEqual({ hash: inputs[0].tools.hash })
  })

  test.each(["run", "server"] as const)("%s event subscriber logs a tracing fault and continues", async (mode) => {
    const files: TraceFile[] = []
    const exporters = [
      {
        name: "memory",
        export: async (value: TraceFile) => {
          files.push(value)
          return undefined
        },
      },
    ]
    const trace = Trace.withExporters(exporters)
    trace.startTrace("bigint", {})
    const recorder = new RunTracing("bigint", trace, { get: async () => undefined, children: async () => [] })
    const consumer = new TraceConsumer({ exporters })
    const debug = spyOn(Log.Default, "debug").mockImplementation(() => {})
    const failure = spyOn(Trace.prototype, "logToolCall").mockImplementationOnce(() => {
      throw new Error("tracer failed")
    })
    spies.push(debug, failure)
    const observe = (event: unknown) => (mode === "run" ? recorder.observe(event) : consumer.handleEvent(event))
    await expect(observe(toolEvent("first"))).resolves.toBeUndefined()
    expect(debug).toHaveBeenCalled()
    await observe(toolEvent("second"))
    if (mode === "run") await recorder.finish()
    else await consumer.flush()
    expect(files[0]!.spans.some((span) => span.tool?.callId === "second")).toBe(true)
  })
})
