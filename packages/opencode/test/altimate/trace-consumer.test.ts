/**
 * Tests for the shared event-stream → trace consumer.
 *
 * The consumer is the extracted form of the TUI worker's inline tracing
 * logic, now also wired into `altimate serve` so headless sessions (e.g.
 * the VS Code chat panel) write trace files. These tests feed realistic
 * bus-event sequences and assert trace files land on disk.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { TraceConsumer } from "../../src/altimate/observability/trace-consumer"
import { FileExporter, type TraceFile } from "../../src/altimate/observability/tracing"

let tmpDir: string

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `trace-consumer-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

function makeConsumer() {
  return new TraceConsumer({ exporters: [new FileExporter(tmpDir)] })
}

async function readTraceFile(sessionID: string): Promise<TraceFile> {
  const raw = await fs.readFile(path.join(tmpDir, `${sessionID}.json`), "utf8")
  return JSON.parse(raw) as TraceFile
}

/** Event sequence mirroring what a real session emits over the bus. */
function sessionEvents(sessionID: string) {
  const now = Date.now()
  return [
    {
      type: "message.updated",
      properties: { info: { id: "msg-user-1", sessionID, role: "user", time: { created: now } } },
    },
    {
      type: "message.part.updated",
      properties: {
        part: { sessionID, messageID: "msg-user-1", type: "text", text: "list my files", time: { end: now } },
      },
    },
    {
      type: "message.updated",
      properties: {
        info: {
          id: "msg-asst-1",
          sessionID,
          parentID: "msg-user-1",
          role: "assistant",
          modelID: "gpt-4o",
          providerID: "openai",
          agent: "general",
          time: { created: now },
        },
      },
    },
    { type: "message.part.updated", properties: { part: { sessionID, type: "step-start", id: "step-1" } } },
    {
      type: "message.part.updated",
      properties: {
        part: {
          sessionID,
          type: "tool",
          tool: "bash",
          callID: "c1",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "file1.ts",
            time: { start: now - 1000, end: now },
          },
        },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: { sessionID, messageID: "msg-asst-1", type: "text", text: "Found 1 file.", time: { end: now } },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: {
          sessionID,
          type: "step-finish",
          id: "step-1",
          reason: "stop",
          cost: 0.005,
          tokens: { input: 500, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
    { type: "session.updated", properties: { info: { id: sessionID, title: "List files" } } },
    { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
  ]
}

describe("TraceConsumer", () => {
  test("full session event sequence writes a completed trace file", async () => {
    const consumer = makeConsumer()
    for (const event of sessionEvents("ses_consumer_1")) {
      consumer.handleEvent(event)
    }
    // session.status idle finalizes asynchronously
    await new Promise((r) => setTimeout(r, 200))

    const trace = await readTraceFile("ses_consumer_1")
    expect(trace.summary.status).toBe("completed")
    expect(trace.metadata.model).toBe("openai/gpt-4o")
    expect(trace.metadata.agent).toBe("general")
    expect(trace.metadata.title).toBe("List files")
    expect(trace.metadata.prompt).toBe("list my files")
    expect(trace.spans.some((s) => s.kind === "tool")).toBe(true)
    expect(trace.summary.totalToolCalls).toBe(1)
    expect(trace.summary.totalCost).toBeCloseTo(0.005)
  })

  test("two interleaved sessions write separate trace files", async () => {
    const consumer = makeConsumer()
    const a = sessionEvents("ses_consumer_a")
    const b = sessionEvents("ses_consumer_b")
    // Interleave the two sessions' events
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i]) consumer.handleEvent(a[i])
      if (b[i]) consumer.handleEvent(b[i])
    }
    await new Promise((r) => setTimeout(r, 200))

    const traceA = await readTraceFile("ses_consumer_a")
    const traceB = await readTraceFile("ses_consumer_b")
    expect(traceA.summary.status).toBe("completed")
    expect(traceB.summary.status).toBe("completed")
    expect(traceA.summary.totalToolCalls).toBe(1)
    expect(traceB.summary.totalToolCalls).toBe(1)
  })

  test("malformed events never throw", () => {
    const consumer = makeConsumer()
    const malformed = [
      null,
      undefined,
      {},
      { type: "message.updated" },
      { type: "message.updated", properties: null },
      { type: "message.updated", properties: { info: null } },
      { type: "message.part.updated", properties: null },
      { type: "message.part.updated", properties: { part: { type: "tool" } } },
      { type: "session.updated", properties: {} },
      { type: "session.status", properties: { status: null } },
      { type: "session.status", properties: { sessionID: "nope", status: { type: "idle" } } },
      "not-an-object",
      42,
    ]
    for (const event of malformed) {
      expect(() => consumer.handleEvent(event)).not.toThrow()
    }
  })

  test("disabled consumer writes nothing", async () => {
    const consumer = new TraceConsumer({ exporters: [new FileExporter(tmpDir)], enabled: false })
    for (const event of sessionEvents("ses_consumer_off")) {
      consumer.handleEvent(event)
    }
    await new Promise((r) => setTimeout(r, 200))
    const files = await fs.readdir(tmpDir)
    expect(files.length).toBe(0)
  })

  test("flush finalizes in-flight traces that never reached idle", async () => {
    const consumer = makeConsumer()
    // Feed everything except the final session.status idle event
    const events = sessionEvents("ses_consumer_flush")
    for (const event of events.slice(0, -1)) {
      consumer.handleEvent(event)
    }
    await consumer.flush()

    const trace = await readTraceFile("ses_consumer_flush")
    expect(trace.summary.totalToolCalls).toBe(1)
    // flush() after the events still finalizes the trace file on disk
    expect(trace.spans.length).toBeGreaterThan(0)
  })

  test("reset clears state so a reused sessionID starts a fresh trace", async () => {
    const consumer = makeConsumer()
    const events = sessionEvents("ses_consumer_reset")
    for (const event of events.slice(0, 4)) {
      consumer.handleEvent(event)
    }
    consumer.reset()
    await new Promise((r) => setTimeout(r, 200))

    // After reset, feeding the full sequence again produces a complete trace
    for (const event of events) {
      consumer.handleEvent(event)
    }
    await new Promise((r) => setTimeout(r, 200))
    const trace = await readTraceFile("ses_consumer_reset")
    expect(trace.summary.status).toBe("completed")
  })
})
