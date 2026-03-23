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

    const { items: traces, total } = await Recap.listTraces(tmp.path)
    expect(traces.length).toBe(3)
    expect(total).toBe(3)

    const listedIds = traces.map((t) => t.sessionId)
    for (const sessionId of sessions) {
      expect(listedIds).toContain(sessionId)
    }

    for (const { sessionId, trace } of traces) {
      expect(trace.metadata.title).toBe(`Session ${sessionId}`)
      expect(trace.metadata.prompt).toBe(`prompt for ${sessionId}`)
      expect(trace.summary.status).toBe("completed")
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

    let { items: traces } = await Recap.listTraces(tmp.path)
    expect(traces.length).toBe(1)
    expect(traces[0].sessionId).toBe("ses_A")

    const exporter2 = new FileExporter(tmp.path)
    const tracer2 = Recap.withExporters([exporter2])
    tracer2.startTrace("ses_B", { title: "Session B", prompt: "prompt B" })
    tracer2.logStepStart({ id: "step-1" })
    tracer2.logStepFinish(makeStepFinish())
    await tracer2.endTrace()

    ;({ items: traces } = await Recap.listTraces(tmp.path))
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

    const { items: traces } = await Recap.listTraces(tmp.path)
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
    const trace = JSON.parse(content) as TraceFile
    expect(trace.sessionId).toBe(sessionId)
    expect(trace.metadata.title).toBe("Unique Session")
    expect(trace.summary.totalTokens).toBeGreaterThan(0)
  })

  test("listTraces returns empty items when no traces exist", async () => {
    await using tmp = await tmpdir()
    const { items, total } = await Recap.listTraces(tmp.path)
    expect(items).toEqual([])
    expect(total).toBe(0)
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

    const { items: traces } = await Recap.listTraces(tmp.path)
    expect(traces.length).toBe(1)
    expect(traces[0].sessionId).toBe("ses_valid")
  })
})

describe("listTraces pagination", () => {
  async function createTraces(dir: string, count: number) {
    for (let i = 0; i < count; i++) {
      const exporter = new FileExporter(dir)
      const tracer = Recap.withExporters([exporter])
      tracer.startTrace(`ses_${String(i).padStart(3, "0")}`, { title: `Session ${i}` })
      tracer.logStepStart({ id: "step-1" })
      tracer.logStepFinish(makeStepFinish())
      await tracer.endTrace()
      // Small delay to ensure distinct timestamps for sorting
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  test("returns total count of all traces regardless of limit", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 10)

    const { items, total } = await Recap.listTraces(tmp.path, { limit: 3 })
    expect(total).toBe(10)
    expect(items.length).toBe(3)
  })

  test("limit restricts the number of returned items", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 5)

    const { items, total } = await Recap.listTraces(tmp.path, { limit: 2 })
    expect(items.length).toBe(2)
    expect(total).toBe(5)
  })

  test("offset skips the first N traces", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 5)

    const { items: all } = await Recap.listTraces(tmp.path)
    const { items: page2 } = await Recap.listTraces(tmp.path, { offset: 2, limit: 2 })

    expect(page2.length).toBe(2)
    expect(page2[0].sessionId).toBe(all[2].sessionId)
    expect(page2[1].sessionId).toBe(all[3].sessionId)
  })

  test("offset beyond total returns empty items with correct total", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 3)

    const { items, total } = await Recap.listTraces(tmp.path, { offset: 10, limit: 5 })
    expect(items.length).toBe(0)
    expect(total).toBe(3)
  })

  test("pagination with offset and limit covers all items across pages", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 7)

    const page1 = await Recap.listTraces(tmp.path, { offset: 0, limit: 3 })
    const page2 = await Recap.listTraces(tmp.path, { offset: 3, limit: 3 })
    const page3 = await Recap.listTraces(tmp.path, { offset: 6, limit: 3 })

    expect(page1.total).toBe(7)
    expect(page1.items.length).toBe(3)
    expect(page2.items.length).toBe(3)
    expect(page3.items.length).toBe(1)

    // All session IDs should be unique across pages
    const allIds = [
      ...page1.items.map((t) => t.sessionId),
      ...page2.items.map((t) => t.sessionId),
      ...page3.items.map((t) => t.sessionId),
    ]
    expect(new Set(allIds).size).toBe(7)
  })

  test("no options returns all items (backward compatible)", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 4)

    const { items, total } = await Recap.listTraces(tmp.path)
    expect(items.length).toBe(4)
    expect(total).toBe(4)
  })

  test("limit larger than total returns all items", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 3)

    const { items, total } = await Recap.listTraces(tmp.path, { limit: 100 })
    expect(items.length).toBe(3)
    expect(total).toBe(3)
  })

  test("offset only (no limit) returns remaining items", async () => {
    await using tmp = await tmpdir()
    await createTraces(tmp.path, 5)

    const { items, total } = await Recap.listTraces(tmp.path, { offset: 2 })
    expect(items.length).toBe(3)
    expect(total).toBe(5)
  })
})
