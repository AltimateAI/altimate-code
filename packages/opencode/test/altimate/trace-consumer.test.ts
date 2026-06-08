/**
 * Tests for the shared event-stream → trace consumer.
 *
 * The consumer is the extracted form of the TUI worker's inline tracing
 * logic, now also wired into `altimate serve` so headless sessions (e.g.
 * the VS Code chat panel) write trace files. These tests feed realistic
 * bus-event sequences and assert trace files land on disk.
 *
 * Behaviour contracts mirrored from the worker:
 *   - traces are NOT finalized on `session.status: idle` (idle fires every
 *     turn); incremental snapshots are written as events arrive, and the
 *     trace is finalized on flush() (shutdown) / reset() / eviction.
 *   - cache-miss re-creation rehydrates the rich on-disk trace rather than
 *     clobbering it with a fresh empty one.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import {
  TraceConsumer,
  subscribeTraceConsumer,
  type TraceEventSource,
} from "../../src/altimate/observability/trace-consumer"
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

async function feed(consumer: TraceConsumer, events: unknown[]) {
  for (const event of events) {
    await consumer.handleEvent(event)
  }
}

/**
 * Poll until `predicate` holds, instead of a fixed sleep — snapshot/endTrace
 * writes are async + debounced, so a fixed delay is flaky under CI load.
 */
async function waitFor<T>(read: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    try {
      const v = await read()
      if (predicate(v)) return v
    } catch {
      // not ready yet (e.g. file not written) — keep polling
    }
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met within timeout")
    await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * Build a single-use event source for the `subscribeTraceConsumer` test seam.
 * Optionally throws mid-stream (to exercise reconnect) or holds the stream open
 * until the shutdown signal fires (to exercise stop()/drain).
 */
function eventSource(
  events: unknown[],
  opts?: { throwAfter?: number; holdUntilAbort?: AbortSignal },
): TraceEventSource {
  async function* gen() {
    let i = 0
    for (const e of events) {
      yield e
      i++
      if (opts?.throwAfter !== undefined && i >= opts.throwAfter) throw new Error("simulated stream disconnect")
    }
    const sig = opts?.holdUntilAbort
    if (sig) {
      await new Promise<void>((resolve) => {
        if (sig.aborted) return resolve()
        sig.addEventListener("abort", () => resolve(), { once: true })
      })
    }
  }
  return { stream: gen() }
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
  test("a full session sequence is captured and finalized on flush", async () => {
    const consumer = makeConsumer()
    await feed(consumer, sessionEvents("ses_consumer_1"))

    // idle does NOT finalize the trace; flush() (shutdown) does — and writes
    // the completed file with full metadata + summary.
    await consumer.flush()
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

  test("idle does not finalize — a second turn keeps appending to the same trace", async () => {
    const consumer = makeConsumer()
    await feed(consumer, sessionEvents("ses_consumer_multiturn"))

    // Second turn on the same session AFTER idle. Pre-fix this hit a cache
    // miss and clobbered the rich file with an empty one; now the trace is
    // still live (no idle finalize) so it just appends.
    await feed(consumer, [
      {
        type: "message.updated",
        properties: {
          info: { id: "msg-user-2", sessionID: "ses_consumer_multiturn", role: "user", time: { created: Date.now() } },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses_consumer_multiturn",
            type: "tool",
            tool: "grep",
            callID: "c2",
            state: {
              status: "completed",
              input: { pattern: "x" },
              output: "hit",
              time: { start: Date.now() - 10, end: Date.now() },
            },
          },
        },
      },
      { type: "session.status", properties: { sessionID: "ses_consumer_multiturn", status: { type: "idle" } } },
    ])
    await consumer.flush()

    const trace = await readTraceFile("ses_consumer_multiturn")
    // Both turns' tool calls survived in one trace.
    expect(trace.summary.totalToolCalls).toBe(2)
    expect(trace.spans.filter((s) => s.kind === "tool").length).toBe(2)
  })

  test("cache-miss re-creation rehydrates the rich on-disk trace, not an empty one", async () => {
    const sessionID = "ses_consumer_rehydrate"
    const c1 = makeConsumer()
    await feed(c1, sessionEvents(sessionID))
    await c1.flush()
    const before = await readTraceFile(sessionID)
    expect(before.summary.totalToolCalls).toBe(1)

    // A brand-new consumer (simulating worker restart) gets a late event for
    // the same session. It must rehydrate the existing file, not overwrite it.
    const c2 = makeConsumer()
    await c2.handleEvent({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID,
          type: "tool",
          tool: "ls",
          callID: "c-late",
          state: { status: "completed", input: {}, output: "ok", time: { start: Date.now() - 5, end: Date.now() } },
        },
      },
    })
    await c2.flush()

    const after = await readTraceFile(sessionID)
    // Original tool call preserved + the late one appended — nothing clobbered.
    expect(after.summary.totalToolCalls).toBe(2)
  })

  test("two interleaved sessions write separate trace files", async () => {
    const consumer = makeConsumer()
    const a = sessionEvents("ses_consumer_a")
    const b = sessionEvents("ses_consumer_b")
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i]) await consumer.handleEvent(a[i])
      if (b[i]) await consumer.handleEvent(b[i])
    }
    await consumer.flush()

    const traceA = await readTraceFile("ses_consumer_a")
    const traceB = await readTraceFile("ses_consumer_b")
    expect(traceA.summary.status).toBe("completed")
    expect(traceB.summary.status).toBe("completed")
    expect(traceA.summary.totalToolCalls).toBe(1)
    expect(traceB.summary.totalToolCalls).toBe(1)
  })

  test("malformed events never throw", async () => {
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
      await expect(consumer.handleEvent(event)).resolves.toBeUndefined()
    }
  })

  test("disabled consumer writes nothing", async () => {
    const consumer = new TraceConsumer({ exporters: [new FileExporter(tmpDir)], enabled: false })
    await feed(consumer, sessionEvents("ses_consumer_off"))
    await consumer.flush()
    const files = await fs.readdir(tmpDir)
    expect(files.length).toBe(0)
  })

  test("reset finalizes in-flight traces and clears state", async () => {
    const consumer = makeConsumer()
    await feed(consumer, sessionEvents("ses_consumer_reset"))
    consumer.reset()
    // reset finalizes fire-and-forget; poll for the write instead of a fixed
    // sleep so the test isn't flaky under CI load.
    const trace = await waitFor(
      () => readTraceFile("ses_consumer_reset"),
      (t) => t.spans.some((s) => s.kind === "tool"),
    )
    expect(trace.spans.some((s) => s.kind === "tool")).toBe(true)
  })

  test("incremental snapshots land on disk BEFORE any flush (the serve path)", async () => {
    // serve never calls flush() during normal operation — it relies entirely
    // on the incremental snapshots written as events arrive. This is the path
    // every other test skips by flushing first.
    const consumer = makeConsumer()
    await feed(consumer, sessionEvents("ses_consumer_noflush"))
    const trace = await waitFor(
      () => readTraceFile("ses_consumer_noflush"),
      (t) => t.spans.some((s) => s.kind === "tool"),
    )
    expect(trace.summary.totalToolCalls).toBe(1)
    expect(trace.metadata.prompt).toBe("list my files")
  })

  test("session.deleted finalizes the trace and releases per-session state", async () => {
    const consumer = makeConsumer()
    await feed(consumer, sessionEvents("ses_consumer_del"))
    await consumer.handleEvent({ type: "session.deleted", properties: { info: { id: "ses_consumer_del" } } })
    // endTrace is fire-and-forget on session.deleted; poll for finalization.
    const trace = await waitFor(
      () => readTraceFile("ses_consumer_del"),
      (t) => t.summary.status === "completed",
    )
    expect(trace.summary.status).toBe("completed")
    // State is already released, so a later flush must be a harmless no-op.
    await consumer.flush()
  })
})

describe("subscribeTraceConsumer (serve integration)", () => {
  test("stop() drains the loop and flushes — serve traces are finalized", async () => {
    const consumer = makeConsumer()
    let calls = 0
    const sub = subscribeTraceConsumer(
      { directory: tmpDir },
      {
        consumer,
        subscribe: async (signal) => {
          calls++
          // Deliver a full session on the first connect, then hold the stream
          // open until shutdown so stop() exercises the drain path.
          return eventSource(calls === 1 ? sessionEvents("ses_sub_stop") : [], { holdUntilAbort: signal })
        },
      },
    )
    // Wait until the session's events have been consumed (snapshot on disk).
    await waitFor(
      () => readTraceFile("ses_sub_stop"),
      (t) => t.spans.some((s) => s.kind === "tool"),
    )
    // Pre-stop the trace is not yet finalized; stop() must flush → "completed".
    await sub.stop()
    const trace = await readTraceFile("ses_sub_stop")
    expect(trace.summary.status).toBe("completed")
    expect(trace.summary.totalToolCalls).toBe(1)
  })

  test("a mid-stream throw does not kill the loop — it reconnects", async () => {
    const consumer = makeConsumer()
    let calls = 0
    const sub = subscribeTraceConsumer(
      { directory: tmpDir },
      {
        consumer,
        subscribe: async (signal) => {
          calls++
          // 1st connect throws mid-stream; 2nd connect delivers a different
          // session in full. If the throw killed the loop, session B's file
          // would never appear and the wait below would time out.
          if (calls === 1) return eventSource(sessionEvents("ses_sub_A"), { throwAfter: 2 })
          return eventSource(sessionEvents("ses_sub_B"), { holdUntilAbort: signal })
        },
      },
    )
    const trace = await waitFor(
      () => readTraceFile("ses_sub_B"),
      (t) => t.summary.totalToolCalls >= 1,
    )
    expect(trace.summary.totalToolCalls).toBe(1)
    expect(calls).toBeGreaterThanOrEqual(2)
    await sub.stop()
  })
})
