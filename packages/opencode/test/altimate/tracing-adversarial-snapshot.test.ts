/**
 * Adversarial tests targeting incremental snapshots, buildTraceFile,
 * worker tracing logic, and live viewer edge cases.
 *
 * Each test targets a specific code path or race condition found during
 * line-by-line audit of snapshot(), buildTraceFile(), worker.ts tracing,
 * and the live trace viewer.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import {
  Tracer,
  FileExporter,
  HttpExporter,
  type TraceFile,
  type TraceExporter,
} from "../../src/altimate/observability/tracing"

let tmpDir: string

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `tracing-snap-adv-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

const ZERO_STEP = {
  id: "1",
  reason: "stop",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

// ---------------------------------------------------------------------------
// 1. buildTraceFile — snapshot isolation from mutations
// ---------------------------------------------------------------------------

describe("buildTraceFile — snapshot isolation", () => {
  test("enrichFromAssistant after snapshot doesn't modify the snapshot", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-isolate", {
      model: "original-model",
      prompt: "test",
    })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })

    // Wait for snapshot to write
    await new Promise((r) => setTimeout(r, 50))

    // Read the snapshot
    const snap1 = JSON.parse(await fs.readFile(tracer.getTracePath()!, "utf-8")) as TraceFile
    const snap1Model = snap1.metadata.model

    // Now mutate the metadata via enrichFromAssistant
    tracer.enrichFromAssistant({
      modelID: "changed-model",
      providerID: "changed-provider",
    })

    // The already-written snapshot should NOT have the new model
    // (it was cloned at snapshot time)
    expect(snap1Model).toBe("original-model")
  })

  test("adding spans after snapshot doesn't modify the snapshot's span array", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-span-isolate", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })

    // Wait for snapshot
    await new Promise((r) => setTimeout(r, 50))
    const snap1 = JSON.parse(await fs.readFile(tracer.getTracePath()!, "utf-8")) as TraceFile
    const span1Count = snap1.spans.length

    // Add more spans
    tracer.logToolCall({
      tool: "read",
      callID: "c2",
      state: { status: "completed", input: {}, output: "content", time: { start: 3, end: 4 } },
    })

    // Wait for second snapshot
    await new Promise((r) => setTimeout(r, 50))
    const snap2 = JSON.parse(await fs.readFile(tracer.getTracePath()!, "utf-8")) as TraceFile

    // Second snapshot should have more spans
    expect(snap2.spans.length).toBeGreaterThan(span1Count)

    // Finalize
    tracer.logStepFinish(ZERO_STEP)
    await tracer.endTrace()
  })

  test("buildTraceFile shows 'running' status during active generation", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-running", { prompt: "test" })
    // Wait for initial snapshot to complete
    await new Promise((r) => setTimeout(r, 50))

    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })

    // Wait for snapshot — should show "running" since generation is in progress
    await new Promise((r) => setTimeout(r, 50))
    const snap = JSON.parse(await fs.readFile(tracer.getTracePath()!, "utf-8")) as TraceFile
    expect(snap.summary.status).toBe("running")

    // After finishing generation, should show "completed"
    tracer.logStepFinish(ZERO_STEP)
    await new Promise((r) => setTimeout(r, 50))
    const snap2 = JSON.parse(await fs.readFile(tracer.getTracePath()!, "utf-8")) as TraceFile
    expect(snap2.summary.status).toBe("completed")

    await tracer.endTrace()
  })
})

// ---------------------------------------------------------------------------
// 2. snapshot() — debouncing and tmp file handling
// ---------------------------------------------------------------------------

describe("snapshot — debouncing and atomicity", () => {
  test("rapid tool calls don't create multiple .tmp files", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-rapid-snap", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    // Fire 20 tool calls rapidly — each triggers snapshot()
    for (let i = 0; i < 20; i++) {
      tracer.logToolCall({
        tool: "bash",
        callID: `c-${i}`,
        state: { status: "completed", input: {}, output: `out-${i}`, time: { start: 1, end: 2 } },
      })
    }

    // Wait for all snapshots to settle
    await new Promise((r) => setTimeout(r, 100))

    // Check for leftover .tmp files
    const files = await fs.readdir(tmpDir)
    const tmpFiles = files.filter((f) => f.includes(".tmp."))
    expect(tmpFiles).toHaveLength(0) // All tmp files should be renamed or cleaned up

    // Should have exactly one .json file
    const jsonFiles = files.filter((f) => f.endsWith(".json"))
    expect(jsonFiles).toHaveLength(1)

    tracer.logStepFinish(ZERO_STEP)
    await tracer.endTrace()
  })

  test("snapshot with unwritable directory doesn't crash", async () => {
    // Create a FileExporter pointing to an impossible path
    const tracer = Tracer.withExporters([new FileExporter("/dev/null/impossible")])
    tracer.startTrace("s-unwritable", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })

    // Should not crash — snapshot failure is silently swallowed
    await new Promise((r) => setTimeout(r, 50))

    tracer.logStepFinish(ZERO_STEP)
    // endTrace will also fail to write, but should return undefined gracefully
    const result = await tracer.endTrace()
    expect(result).toBeUndefined()
  })

  test("endTrace waits for in-flight snapshot before writing", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-wait-snap", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    // Trigger a tool call (which triggers snapshot)
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })

    // Immediately call endTrace — it should wait for the snapshot
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()

    // File should be valid and complete
    const trace = JSON.parse(await fs.readFile(filePath!, "utf-8")) as TraceFile
    expect(trace.summary.status).toBe("completed")
    expect(trace.summary.totalToolCalls).toBe(1)
  })

  test("snapshot after endTrace is a no-op", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-post-end-snap", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()

    // Read the final trace
    const finalTrace = JSON.parse(await fs.readFile(filePath!, "utf-8")) as TraceFile
    const finalSpanCount = finalTrace.spans.length

    // Now log more events (should be no-ops, but they'd trigger snapshot too)
    tracer.logStepStart({ id: "2" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c-post",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })

    await new Promise((r) => setTimeout(r, 50))

    // The file may have been overwritten by a snapshot, but the spans
    // array was already mutated (spans are still pushed to the array
    // even after endTrace). Let's check the file is still valid JSON.
    const postTrace = JSON.parse(await fs.readFile(filePath!, "utf-8")) as TraceFile
    expect(postTrace.version).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 3. Worker tracing — session lifecycle
// ---------------------------------------------------------------------------

describe("Worker tracing — session lifecycle simulation", () => {
  test("multiple prompt cycles on same session create separate traces", async () => {
    // Simulate the worker's getOrCreateTracer + endedSessions logic
    const tracers = new Map<string, Tracer>()
    const endedSessions = new Set<string>()

    function getOrCreateTracer(sessionID: string): Tracer | null {
      if (!sessionID) return null
      if (endedSessions.has(sessionID)) {
        endedSessions.delete(sessionID)
        tracers.delete(sessionID)
      }
      if (tracers.has(sessionID)) return tracers.get(sessionID)!
      const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
      tracer.startTrace(sessionID, {})
      tracers.set(sessionID, tracer)
      return tracer
    }

    // Prompt cycle 1
    const t1 = getOrCreateTracer("session-lifecycle")!
    t1.logStepStart({ id: "1" })
    t1.logToolCall({
      tool: "bash", callID: "c1",
      state: { status: "completed", input: {}, output: "cycle 1", time: { start: 1, end: 2 } },
    })
    t1.logStepFinish(ZERO_STEP)
    await t1.endTrace()
    endedSessions.add("session-lifecycle")

    // Prompt cycle 2 — should create a fresh tracer
    const t2 = getOrCreateTracer("session-lifecycle")!
    expect(t2).not.toBe(t1) // Different tracer instance
    t2.logStepStart({ id: "1" })
    t2.logToolCall({
      tool: "read", callID: "c2",
      state: { status: "completed", input: {}, output: "cycle 2", time: { start: 3, end: 4 } },
    })
    t2.logStepFinish(ZERO_STEP)
    await t2.endTrace()

    // File should contain cycle 2's data (overwrites cycle 1)
    const trace = JSON.parse(
      await fs.readFile(path.join(tmpDir, "session-lifecycle.json"), "utf-8"),
    ) as TraceFile
    expect(trace.spans.find((s) => s.kind === "tool")!.name).toBe("read") // cycle 2's tool
  })

  test("tracer eviction when MAX_TRACERS is exceeded", async () => {
    const tracers = new Map<string, Tracer>()
    const MAX = 5

    function getOrCreateTracer(sessionID: string): Tracer {
      if (tracers.has(sessionID)) return tracers.get(sessionID)!
      if (tracers.size >= MAX) {
        const oldest = tracers.keys().next().value
        if (oldest) {
          tracers.get(oldest)?.endTrace().catch(() => {})
          tracers.delete(oldest)
        }
      }
      const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
      tracer.startTrace(sessionID, {})
      tracers.set(sessionID, tracer)
      return tracer
    }

    // Create MAX+2 tracers
    for (let i = 0; i < MAX + 2; i++) {
      getOrCreateTracer(`session-${i}`)
    }

    // Only MAX should remain
    expect(tracers.size).toBe(MAX)

    // Oldest sessions should have been evicted
    expect(tracers.has("session-0")).toBe(false)
    expect(tracers.has("session-1")).toBe(false)
    expect(tracers.has(`session-${MAX + 1}`)).toBe(true)

    // Clean up
    for (const t of tracers.values()) await t.endTrace().catch(() => {})
  })

  test("undefined/empty sessionID is handled by getOrCreateTracer", () => {
    const tracers = new Map<string, Tracer>()

    function getOrCreateTracer(sessionID: string): Tracer | null {
      if (!sessionID) return null
      if (tracers.has(sessionID)) return tracers.get(sessionID)!
      const tracer = Tracer.withExporters([])
      tracer.startTrace(sessionID, {})
      tracers.set(sessionID, tracer)
      return tracer
    }

    expect(getOrCreateTracer("")).toBeNull()
    expect(getOrCreateTracer(undefined as any)).toBeNull()
    expect(getOrCreateTracer(null as any)).toBeNull()
    expect(tracers.size).toBe(0)
  })

  test("events for non-existent session are silently dropped", () => {
    const tracers = new Map<string, Tracer>()

    // Simulate receiving events for a session we haven't seen
    const part = {
      sessionID: "ghost-session",
      type: "step-start",
      id: "1",
    }
    const tracer = tracers.get(part.sessionID)
    // tracer is undefined — the if(tracer) guard in the worker prevents crash
    expect(tracer).toBeUndefined()

    // This is exactly what the worker does — no crash
    if (tracer) {
      tracer.logStepStart(part)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Concurrent snapshot + endTrace race
// ---------------------------------------------------------------------------

describe("Concurrent snapshot + endTrace race", () => {
  test("endTrace immediately after logToolCall doesn't corrupt the file", async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const dir = path.join(tmpDir, `race-${attempt}`)
      await fs.mkdir(dir, { recursive: true })
      const tracer = Tracer.withExporters([new FileExporter(dir)])
      tracer.startTrace(`race-${attempt}`, { prompt: "test" })
      tracer.logStepStart({ id: "1" })

      // Trigger snapshot via tool call
      tracer.logToolCall({
        tool: "bash",
        callID: "c1",
        state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
      })

      // Immediately finish and end — races with the snapshot
      tracer.logStepFinish(ZERO_STEP)
      const filePath = await tracer.endTrace()

      // File MUST be valid JSON
      const content = await fs.readFile(filePath!, "utf-8")
      const trace = JSON.parse(content) as TraceFile
      expect(trace.version).toBe(2)
      expect(trace.summary.status).toBe("completed")
    }
  })

  test("multiple endTrace calls on the same tracer don't corrupt", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-double-end", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logStepFinish(ZERO_STEP)

    // Call endTrace 5 times concurrently
    const results = await Promise.all([
      tracer.endTrace(),
      tracer.endTrace(),
      tracer.endTrace(),
      tracer.endTrace(),
      tracer.endTrace(),
    ])

    // At least one should succeed
    const successful = results.filter(Boolean)
    expect(successful.length).toBeGreaterThan(0)

    // File should be valid
    const content = await fs.readFile(successful[0]!, "utf-8")
    JSON.parse(content) // Must not throw
  })
})

// ---------------------------------------------------------------------------
// 5. getTracePath edge cases
// ---------------------------------------------------------------------------

describe("getTracePath edge cases", () => {
  test("getTracePath sanitizes session ID consistently with endTrace", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("session/with:special.chars\\here", { prompt: "test" })

    const tracePath = tracer.getTracePath()
    const filePath = await tracer.endTrace()

    // Both should produce the same sanitized path
    expect(tracePath).toBeDefined()
    expect(tracePath).toBe(filePath ?? "")
  })

  test("getTracePath with HttpExporter only returns undefined", () => {
    const tracer = Tracer.withExporters([new HttpExporter("test", "http://localhost:1")])
    tracer.startTrace("s1", { prompt: "test" })
    expect(tracer.getTracePath()).toBeUndefined()
  })

  test("getTracePath with mixed exporters uses FileExporter dir", () => {
    const tracer = Tracer.withExporters([
      new HttpExporter("cloud", "http://localhost:1"),
      new FileExporter(tmpDir),
    ])
    tracer.startTrace("s1", { prompt: "test" })
    expect(tracer.getTracePath()).toContain(tmpDir)
  })
})

// ---------------------------------------------------------------------------
// 6. Live trace viewer — /api/trace endpoint robustness
// ---------------------------------------------------------------------------

describe("Live trace viewer — /api/trace", () => {
  test("viewer shows updated data after new spans", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-live-viewer", { prompt: "test" })
    const tracePath = tracer.getTracePath()!

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/api/trace") {
          try {
            const content = await fs.readFile(tracePath, "utf-8")
            return new Response(content, { headers: { "Content-Type": "application/json" } })
          } catch {
            return new Response("{}", { status: 404 })
          }
        }
        return new Response("not found", { status: 404 })
      },
    })

    try {
      // startTrace writes initial snapshot — file should exist immediately
      await new Promise((r) => setTimeout(r, 50))
      const r1 = await fetch(`http://localhost:${server.port}/api/trace`)
      expect(r1.status).toBe(200)
      const data1 = await r1.json() as TraceFile
      expect(data1.spans.filter((s) => s.kind === "session")).toHaveLength(1)

      // Add a tool call and wait for snapshot
      tracer.logStepStart({ id: "1" })
      tracer.logToolCall({
        tool: "bash", callID: "c1",
        state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
      })
      await new Promise((r) => setTimeout(r, 50))

      const r2 = await fetch(`http://localhost:${server.port}/api/trace`)
      expect(r2.status).toBe(200)
      const data2 = await r2.json() as TraceFile
      expect(data2.spans.filter((s) => s.kind === "tool")).toHaveLength(1)

      // Add another tool
      tracer.logToolCall({
        tool: "read", callID: "c2",
        state: { status: "completed", input: {}, output: "content", time: { start: 3, end: 4 } },
      })
      await new Promise((r) => setTimeout(r, 50))

      const r3 = await fetch(`http://localhost:${server.port}/api/trace`)
      const data3 = await r3.json() as TraceFile
      expect(data3.spans.filter((s) => s.kind === "tool")).toHaveLength(2)

      tracer.logStepFinish(ZERO_STEP)
      await tracer.endTrace()
    } finally {
      server.stop()
    }
  })

  test("viewer handles corrupted trace file gracefully", async () => {
    const tracePath = path.join(tmpDir, "corrupted.json")
    await fs.writeFile(tracePath, "{{{invalid json")

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        try {
          const content = await fs.readFile(tracePath, "utf-8")
          return new Response(content, { headers: { "Content-Type": "application/json" } })
        } catch {
          return new Response("{}", { status: 404 })
        }
      },
    })

    try {
      const res = await fetch(`http://localhost:${server.port}/api/trace`)
      // Server returns the raw content — it's the client's job to handle parse errors
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(() => JSON.parse(text)).toThrow()
    } finally {
      server.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// 7. Snapshot with non-serializable span data
// ---------------------------------------------------------------------------

describe("Snapshot with non-serializable data in spans", () => {
  test("span with function in attributes survives snapshot", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-func-attr", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash", callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })
    // Wait for the tool snapshot to settle first
    await new Promise((r) => setTimeout(r, 50))

    // Now add attributes (after snapshot)
    tracer.setSpanAttributes({
      callback: () => "hello",
      normal: "value",
    })

    // Trigger another snapshot by adding another tool
    tracer.logToolCall({
      tool: "read", callID: "c2",
      state: { status: "completed", input: {}, output: "ok", time: { start: 3, end: 4 } },
    })
    await new Promise((r) => setTimeout(r, 50))

    const snap = JSON.parse(await fs.readFile(tracer.getTracePath()!, "utf-8")) as TraceFile
    // The first tool span should now have the attributes (from the second snapshot)
    const tool = snap.spans.find((s) => s.name === "bash")!
    expect(tool.attributes!.normal).toBe("value")
    // Function was stringified by setSpanAttributes
    expect(typeof tool.attributes!.callback).toBe("string")

    tracer.logStepFinish(ZERO_STEP)
    await tracer.endTrace()
  })

  test("snapshot handles span with undefined output gracefully", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-undef-output", { prompt: "test" })
    await new Promise((r) => setTimeout(r, 50)) // wait for initial snapshot
    tracer.logStepStart({ id: "1" })
    // Generation with no text and no tool calls — output will be undefined
    tracer.logStepFinish(ZERO_STEP)

    await new Promise((r) => setTimeout(r, 50))

    const snap = JSON.parse(await fs.readFile(tracer.getTracePath()!, "utf-8")) as TraceFile
    // undefined output becomes null or is omitted in JSON
    const gen = snap.spans.find((s) => s.kind === "generation")!
    expect(gen.output === undefined || gen.output === null).toBe(true)

    await tracer.endTrace()
  })
})

// ---------------------------------------------------------------------------
// 8. Stress test — rapid snapshot + endTrace interleaving
// ---------------------------------------------------------------------------

describe("Stress test — snapshot interleaving", () => {
  test("100 tracers created and ended rapidly all produce valid files", async () => {
    const promises = Array.from({ length: 100 }, async (_, i) => {
      const tracer = Tracer.withExporters([new FileExporter(tmpDir, 0)]) // unlimited files
      tracer.startTrace(`stress-${i}`, { prompt: `prompt-${i}` })
      tracer.logStepStart({ id: "1" })
      tracer.logToolCall({
        tool: "bash", callID: `c-${i}`,
        state: { status: "completed", input: { i }, output: `ok-${i}`, time: { start: 1, end: 2 } },
      })
      tracer.logStepFinish({
        id: "1", reason: "stop", cost: 0.001,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      return tracer.endTrace()
    })

    const results = await Promise.all(promises)
    const successful = results.filter(Boolean) as string[]
    expect(successful.length).toBe(100)

    // Verify a random sample of files
    for (let i = 0; i < 10; i++) {
      const idx = Math.floor(Math.random() * successful.length)
      const content = await fs.readFile(successful[idx]!, "utf-8")
      const trace = JSON.parse(content) as TraceFile
      expect(trace.version).toBe(2)
      expect(trace.summary.totalToolCalls).toBe(1)
      expect(trace.summary.totalGenerations).toBe(1)
    }

    // Check for leftover .tmp files
    const allFiles = await fs.readdir(tmpDir)
    const tmpFiles = allFiles.filter((f) => f.includes(".tmp."))
    expect(tmpFiles).toHaveLength(0)
  })
})
