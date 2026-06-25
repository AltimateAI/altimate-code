import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import { readFileSync, existsSync } from "node:fs"
import path from "path"
import os from "os"
import { Recap, FileExporter, type TraceFile } from "../../src/altimate/observability/tracing"
import { TraceConsumer } from "../../src/altimate/observability/trace-consumer"

// Regression guard for the TUI-tracing fix. On a quiet/idle Bun Worker thread, pending async `fs`
// writes from the consumer don't flush before `worker.terminate()`, so an async finalize silently
// writes nothing and TUI sessions produced no trace files. The fix finalizes SYNCHRONOUSLY on
// shutdown via `Trace.finalizeSync()` / `TraceConsumer.flushSync()`. These tests assert the write is
// truly synchronous (file present with NO await) and the trace is COMPLETE and marked "completed"
// (not "crashed", which `flushSync` produces). See E2E-TUI-TRACING-REGRESSION.md.

let tmpDir: string
beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `tracing-finalize-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tmpDir, { recursive: true })
})
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

describe("Trace.finalizeSync", () => {
  test("writes a COMPLETE trace SYNCHRONOUSLY (no await) with status 'completed'", () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("ses-sync-1", { model: "anthropic/claude", providerId: "anthropic", prompt: "hi" })
    tracer.logStepStart({ id: "1" })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0.01,
      tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    })

    // The whole point: a synchronous call → the file must exist on disk the instant it returns,
    // with NO await/event-loop tick (the failure mode was async writes never flushing).
    const filePath = tracer.finalizeSync()
    expect(filePath).toBeDefined()
    expect(existsSync(filePath!)).toBe(true)

    const trace: TraceFile = JSON.parse(readFileSync(filePath!, "utf-8"))
    expect(trace.sessionId).toBe("ses-sync-1")
    expect(trace.summary.status).toBe("completed") // NOT "crashed" (that's flushSync)
    expect(trace.summary.totalGenerations).toBe(1)
    expect(trace.summary.narrative).toContain("Completed in") // enrichSummary ran (parity with endTrace)
    expect(trace.spans.length).toBeGreaterThan(0)
  })

  test("applies maxFiles pruning synchronously (the path bypasses export()'s async prune)", () => {
    // Regression for the Kilo finding: the sync shutdown write skips FileExporter.export, so without
    // an explicit sync prune the traces dir grows unbounded on the TUI path.
    for (let i = 1; i <= 4; i++) {
      const tracer = Recap.withExporters([new FileExporter(tmpDir, 2)]) // maxFiles = 2
      tracer.startTrace(`ses-prune-${i}`, { prompt: "x" })
      tracer.finalizeSync()
    }
    const files = require("node:fs")
      .readdirSync(tmpDir)
      .filter((n: string) => n.endsWith(".json"))
      .sort()
    expect(files.length).toBe(2) // pruned to maxFiles
    expect(files).toEqual(["ses-prune-3.json", "ses-prune-4.json"]) // oldest deleted
  })

  test("flushSync (crash path) still marks 'crashed' — finalizeSync must not regress into it", () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("ses-crash", { prompt: "hi" })
    tracer.flushSync()
    const trace: TraceFile = JSON.parse(readFileSync(path.join(tmpDir, "ses-crash.json"), "utf-8"))
    expect(trace.summary.status).toBe("crashed")
  })
})

describe("TraceConsumer.flushSync", () => {
  test("synchronously finalizes every active session to disk", async () => {
    const consumer = new TraceConsumer({ exporters: [new FileExporter(tmpDir)] })
    // Drive a session into the consumer (creates a per-session Trace).
    await consumer.handleEvent({
      type: "message.updated",
      properties: { sessionID: "ses-c1", info: { id: "m1", sessionID: "ses-c1", role: "user" } },
    })
    await consumer.handleEvent({
      type: "message.part.updated",
      properties: { sessionID: "ses-c1", part: { id: "p1", sessionID: "ses-c1", messageID: "m1", type: "text", text: "hi" }, time: 1 },
    })

    consumer.flushSync() // synchronous — file must exist immediately after

    const filePath = path.join(tmpDir, "ses-c1.json")
    expect(existsSync(filePath)).toBe(true)
    const trace: TraceFile = JSON.parse(readFileSync(filePath, "utf-8"))
    expect(trace.sessionId).toBe("ses-c1")
    expect(trace.summary.status).toBe("completed")
  })
})
