import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Recap, FileExporter, type TraceFile } from "../../src/altimate/observability/tracing"
import { tmpdir } from "../fixture/fixture"

function makeStepFinish(overrides?: Partial<{ id: string; cost: number }>) {
  return {
    id: overrides?.id ?? "step-1",
    reason: "stop",
    cost: overrides?.cost ?? 0.005,
    tokens: {
      input: 1500,
      output: 300,
      reasoning: 100,
      cache: { read: 200, write: 50 },
    },
  }
}

describe("Trace persistence across sessions", () => {
  test("traces from multiple sessions are all persisted and listable", async () => {
    await using tmp = await tmpdir()
    const sessions = ["ses_first", "ses_second", "ses_third"]

    for (const sessionId of sessions) {
      const exporter = new FileExporter(tmp.path)
      const tracer = Recap.withExporters([exporter])
      tracer.startTrace(sessionId, {
        title: `Session ${sessionId}`,
        prompt: `prompt for ${sessionId}`,
      })

      tracer.logStepStart({ id: "step-1" })
      tracer.logStepFinish(makeStepFinish())
      await tracer.endTrace()
    }

    const files = await fs.readdir(tmp.path)
    const jsonFiles = files.filter((f) => f.endsWith(".json"))
    expect(jsonFiles.length).toBe(3)

    const traces = await Recap.listTraces(tmp.path)
    expect(traces.length).toBe(3)

    const listedIds = traces.map((t) => t.sessionId)
    for (const sessionId of sessions) {
      expect(listedIds).toContain(sessionId)
    }

    for (const { sessionId, trace: traceFile } of traces) {
      expect(traceFile.metadata.title).toBe(`Session ${sessionId}`)
      expect(traceFile.metadata.prompt).toBe(`prompt for ${sessionId}`)
      expect(traceFile.summary.status).toBe("completed")
    }
  })

  test("ending one session does not affect traces from other sessions", async () => {
    await using tmp = await tmpdir()

    const exporter1 = new FileExporter(tmp.path)
    const tracer1 = Recap.withExporters([exporter1])
    tracer1.startTrace("ses_A", { title: "Session A", prompt: "prompt A" })
    tracer1.logStepStart({ id: "step-1" })
    tracer1.logStepFinish(makeStepFinish())
    await tracer1.endTrace()

    let traces = await Recap.listTraces(tmp.path)
    expect(traces.length).toBe(1)
    expect(traces[0].sessionId).toBe("ses_A")

    const exporter2 = new FileExporter(tmp.path)
    const tracer2 = Recap.withExporters([exporter2])
    tracer2.startTrace("ses_B", { title: "Session B", prompt: "prompt B" })
    tracer2.logStepStart({ id: "step-1" })
    tracer2.logStepFinish(makeStepFinish())
    await tracer2.endTrace()

    traces = await Recap.listTraces(tmp.path)
    expect(traces.length).toBe(2)

    const ids = traces.map((t) => t.sessionId)
    expect(ids).toContain("ses_A")
    expect(ids).toContain("ses_B")

    const traceA = traces.find((t) => t.sessionId === "ses_A")!
    expect(traceA.trace.metadata.title).toBe("Session A")
    expect(traceA.trace.summary.status).toBe("completed")
  })

  test("listTraces returns traces sorted by newest first", async () => {
    await using tmp = await tmpdir()

    for (let i = 0; i < 3; i++) {
      const exporter = new FileExporter(tmp.path)
      const tracer = Recap.withExporters([exporter])
      tracer.startTrace(`ses_${i}`, { title: `Session ${i}` })
      tracer.logStepStart({ id: "step-1" })
      tracer.logStepFinish(makeStepFinish())
      await tracer.endTrace()
      await new Promise((r) => setTimeout(r, 10))
    }

    const traces = await Recap.listTraces(tmp.path)
    expect(traces.length).toBe(3)

    for (let i = 0; i < traces.length - 1; i++) {
      const dateA = new Date(traces[i].trace.startedAt).getTime()
      const dateB = new Date(traces[i + 1].trace.startedAt).getTime()
      expect(dateA).toBeGreaterThanOrEqual(dateB)
    }
  })

  test("traces are individually accessible by session ID filename", async () => {
    await using tmp = await tmpdir()
    const sessionId = "ses_unique123"
    const exporter = new FileExporter(tmp.path)
    const tracer = Recap.withExporters([exporter])
    tracer.startTrace(sessionId, { title: "Unique Session", prompt: "test prompt" })
    tracer.logStepStart({ id: "step-1" })
    tracer.logStepFinish(makeStepFinish())
    await tracer.endTrace()

    const expectedFile = path.join(tmp.path, `${sessionId}.json`)
    const exists = await fs.stat(expectedFile).then(() => true).catch(() => false)
    expect(exists).toBe(true)

    const content = await fs.readFile(expectedFile, "utf-8")
    const traceFile = JSON.parse(content) as TraceFile
    expect(traceFile.sessionId).toBe(sessionId)
    expect(traceFile.metadata.title).toBe("Unique Session")
    expect(traceFile.summary.totalTokens).toBeGreaterThan(0)
  })

  test("listTraces returns empty array when no traces exist", async () => {
    await using tmp = await tmpdir()
    const traces = await Recap.listTraces(tmp.path)
    expect(traces).toEqual([])
  })

  test("listTraces skips corrupted JSON files gracefully", async () => {
    await using tmp = await tmpdir()

    // Write a valid trace
    const exporter = new FileExporter(tmp.path)
    const tracer = Recap.withExporters([exporter])
    tracer.startTrace("ses_valid", { title: "Valid Session" })
    tracer.logStepStart({ id: "step-1" })
    tracer.logStepFinish(makeStepFinish())
    await tracer.endTrace()

    // Write a corrupted JSON file
    await fs.writeFile(path.join(tmp.path, "corrupted.json"), "not valid json{{{")

    const traces = await Recap.listTraces(tmp.path)
    expect(traces.length).toBe(1)
    expect(traces[0].sessionId).toBe("ses_valid")
  })
})
