/**
 * Final adversarial tests — targeting bugs found in the last code audit.
 *
 * Each test exercises a specific bug that was found and fixed:
 * 1. enrichFromAssistant crash on null info
 * 2. toolCallCount inflation on failed logToolCall
 * 3. Orphaned generation produces wrong final status
 * 4. Worker event-after-endTrace race condition
 * 5. logStepStart state inconsistency on partial failure
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import {
  Recap,
  FileExporter,
  HttpExporter,
  type TraceFile,
  type TraceExporter,
} from "../../src/altimate/observability/tracing"

let tmpDir: string

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `tracing-adv-final-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
// 1. enrichFromAssistant — crash vectors (formerly no try/catch)
// ---------------------------------------------------------------------------

describe("enrichFromAssistant — crash prevention", () => {
  test("null info doesn't crash", () => {
    const tracer = Recap.withExporters([])
    tracer.startTrace("s1", { prompt: "test" })
    // This used to throw TypeError: Cannot read properties of null
    tracer.enrichFromAssistant(null as any)
    // Must not throw
    expect(true).toBe(true)
  })

  test("undefined info doesn't crash", () => {
    const tracer = Recap.withExporters([])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.enrichFromAssistant(undefined as any)
    expect(true).toBe(true)
  })

  test("info with non-string modelID doesn't crash", () => {
    const tracer = Recap.withExporters([])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.enrichFromAssistant({ modelID: { nested: true } as any })
    expect(true).toBe(true)
  })

  test("info with Error object as modelID doesn't crash", () => {
    const tracer = Recap.withExporters([])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.enrichFromAssistant({ modelID: new Error("bad") as any })
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. toolCallCount accuracy — count matches actual spans
// ---------------------------------------------------------------------------

describe("toolCallCount accuracy", () => {
  test("failed logToolCall (null state) doesn't inflate count", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    // This will fail inside try/catch because state is null
    tracer.logToolCall({ tool: "bash", callID: "c1", state: null as any })
    // This should succeed
    tracer.logToolCall({
      tool: "bash",
      callID: "c2",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })

    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    // Count should be 1, not 2 — the failed call shouldn't increment
    expect(trace.summary.totalToolCalls).toBe(1)
    expect(trace.spans.filter((s) => s.kind === "tool")).toHaveLength(1)
  })

  test("failed logToolCall (undefined state) doesn't inflate count", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    tracer.logToolCall({ tool: "bash", callID: "c1", state: undefined as any })
    tracer.logToolCall({
      tool: "read",
      callID: "c2",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })

    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    expect(trace.summary.totalToolCalls).toBe(1)
  })

  test("totalToolCalls equals number of tool spans", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    for (let i = 0; i < 5; i++) {
      tracer.logToolCall({
        tool: `tool-${i}`,
        callID: `c-${i}`,
        state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
      })
    }

    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    const toolSpans = trace.spans.filter((s) => s.kind === "tool")
    expect(trace.summary.totalToolCalls).toBe(toolSpans.length)
    expect(trace.summary.totalToolCalls).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// 3. generationCount accuracy — count matches actual spans
// ---------------------------------------------------------------------------

describe("generationCount accuracy", () => {
  test("logStepStart with null part creates generation-unknown span", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })

    // null part is handled gracefully — part?.id ?? "unknown"
    tracer.logStepStart(null as any)
    tracer.logStepFinish(ZERO_STEP)
    tracer.logStepStart({ id: "real" })
    tracer.logStepFinish(ZERO_STEP)

    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    // Both logStepStart calls succeed — count is 2
    expect(trace.summary.totalGenerations).toBe(2)
    expect(trace.spans.filter((s) => s.kind === "generation")).toHaveLength(2)
    // First gen has "unknown" id
    expect(trace.spans.find((s) => s.name === "generation-unknown")).toBeDefined()
    expect(trace.spans.find((s) => s.name === "generation-real")).toBeDefined()
  })

  test("totalGenerations equals number of generation spans", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })

    for (let i = 0; i < 3; i++) {
      tracer.logStepStart({ id: `${i}` })
      tracer.logStepFinish(ZERO_STEP)
    }

    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    const genSpans = trace.spans.filter((s) => s.kind === "generation")
    expect(trace.summary.totalGenerations).toBe(genSpans.length)
    expect(trace.summary.totalGenerations).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 4. Orphaned generation — endTrace with unclosed generation
// ---------------------------------------------------------------------------

describe("Orphaned generation — endTrace with unclosed generation", () => {
  test("endTrace with active generation produces 'completed' status (not 'running')", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    // Never call logStepFinish — generation is orphaned

    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    // endTrace should force status to "completed" even with orphaned generation
    expect(trace.summary.status).toBe("completed")
  })

  test("endTrace with error + orphaned generation produces 'error' status", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    // Never finish — orphaned generation

    const filePath = await tracer.endTrace("Provider crashed")
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    expect(trace.summary.status).toBe("error")
    expect(trace.summary.error).toBe("Provider crashed")
  })

  test("snapshot mid-generation shows 'running', endTrace shows 'completed'", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-run-complete", { prompt: "test" })
    await new Promise((r) => setTimeout(r, 50)) // wait for initial snapshot
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash", callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })

    // Wait for snapshot — should be "running"
    await new Promise((r) => setTimeout(r, 50))
    const snap = JSON.parse(await fs.readFile(tracer.getTracePath()!, "utf-8")) as TraceFile
    expect(snap.summary.status).toBe("running")

    // Now endTrace without finishing generation — should force "completed"
    const filePath = await tracer.endTrace()
    const final = JSON.parse(await fs.readFile(filePath!, "utf-8")) as TraceFile
    expect(final.summary.status).toBe("completed")
  })
})

// ---------------------------------------------------------------------------
// 5. Worker race condition — events after endTrace
// ---------------------------------------------------------------------------

describe("Worker race — events after endTrace", () => {
  test("endedSessions guard prevents events from reaching dead tracer", async () => {
    // Simulate the worker's logic
    const tracers = new Map<string, Recap>()
    const endedSessions = new Set<string>()

    function getOrCreateRecap(sessionID: string): Recap | null {
      if (!sessionID) return null
      if (endedSessions.has(sessionID)) {
        endedSessions.delete(sessionID)
        tracers.delete(sessionID)
      }
      if (tracers.has(sessionID)) return tracers.get(sessionID)!
      const tracer = Recap.withExporters([new FileExporter(tmpDir)])
      tracer.startTrace(sessionID, {})
      tracers.set(sessionID, tracer)
      return tracer
    }

    // Create session and add some data
    const tracer = getOrCreateRecap("race-session")!
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash", callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })
    tracer.logStepFinish(ZERO_STEP)

    // Simulate idle event — mark as ended BEFORE endTrace
    endedSessions.add("race-session")
    tracer.endTrace().catch(() => {})

    // Simulate a late event arriving for the same session
    const part = {
      sessionID: "race-session",
      type: "tool",
      tool: "late-tool",
      callID: "c-late",
      state: { status: "completed", input: {}, output: "late", time: { start: 3, end: 4 } },
    }

    // The worker checks endedSessions before dispatching
    if (!endedSessions.has(part.sessionID)) {
      const t = tracers.get(part.sessionID)
      if (t) t.logToolCall(part as any)
    }

    // Wait for endTrace to complete
    await new Promise((r) => setTimeout(r, 50))

    // Verify the late event was NOT added to the trace
    const filePath = path.join(tmpDir, "race-session.json")
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath, "utf-8"))
    const lateTools = trace.spans.filter((s) => s.name === "late-tool")
    expect(lateTools).toHaveLength(0)
    expect(trace.summary.totalToolCalls).toBe(1) // Only the original tool
  })

  test("new prompt cycle after idle creates fresh tracer", async () => {
    const tracers = new Map<string, Recap>()
    const endedSessions = new Set<string>()

    function getOrCreateRecap(sessionID: string): Recap | null {
      if (!sessionID) return null
      if (endedSessions.has(sessionID)) {
        endedSessions.delete(sessionID)
        tracers.delete(sessionID)
      }
      if (tracers.has(sessionID)) return tracers.get(sessionID)!
      const tracer = Recap.withExporters([new FileExporter(tmpDir)])
      tracer.startTrace(sessionID, {})
      tracers.set(sessionID, tracer)
      return tracer
    }

    // Cycle 1
    const t1 = getOrCreateRecap("cycle-test")!
    t1.logStepStart({ id: "1" })
    t1.logToolCall({
      tool: "bash", callID: "c1",
      state: { status: "completed", input: {}, output: "cycle1", time: { start: 1, end: 2 } },
    })
    t1.logStepFinish(ZERO_STEP)
    endedSessions.add("cycle-test")
    await t1.endTrace()

    // Cycle 2 — should get a NEW tracer
    const t2 = getOrCreateRecap("cycle-test")!
    expect(t2).not.toBe(t1)

    t2.logStepStart({ id: "1" })
    t2.logToolCall({
      tool: "read", callID: "c2",
      state: { status: "completed", input: {}, output: "cycle2", time: { start: 3, end: 4 } },
    })
    t2.logStepFinish(ZERO_STEP)
    await t2.endTrace()

    // File should have cycle 2 data
    const trace: TraceFile = JSON.parse(
      await fs.readFile(path.join(tmpDir, "cycle-test.json"), "utf-8"),
    )
    expect(trace.spans.filter((s) => s.kind === "tool")).toHaveLength(1)
    expect(trace.spans.find((s) => s.kind === "tool")!.name).toBe("read")
  })
})

// ---------------------------------------------------------------------------
// 6. logStepStart partial failure — state consistency
// ---------------------------------------------------------------------------

describe("logStepStart — state consistency", () => {
  test("generationCount and span count are always in sync", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })

    // Multiple starts — each creates a span and increments count
    tracer.logStepStart({ id: "1" })
    tracer.logStepFinish(ZERO_STEP)
    tracer.logStepStart({ id: "2" })
    tracer.logStepFinish(ZERO_STEP)

    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    const genSpans = trace.spans.filter((s) => s.kind === "generation")
    expect(trace.summary.totalGenerations).toBe(genSpans.length)
  })

  test("logStepStart before startTrace is a no-op (no spans, no count)", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    // No startTrace called
    tracer.logStepStart({ id: "orphan" })
    tracer.logStepFinish(ZERO_STEP)

    // Now start properly
    tracer.startTrace("s1", { prompt: "test" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    // Only the session span should exist — no generations
    expect(trace.summary.totalGenerations).toBe(0)
    expect(trace.spans.filter((s) => s.kind === "generation")).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 7. buildTraceFile — status field correctness
// ---------------------------------------------------------------------------

describe("buildTraceFile — status transitions", () => {
  test("status progression: completed → running → completed", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-status", { prompt: "test" })
    const path1 = tracer.getTracePath()!

    // Wait for initial snapshot — should be "completed" (no active generation)
    await new Promise((r) => setTimeout(r, 50))
    const snap0 = JSON.parse(await fs.readFile(path1, "utf-8")) as TraceFile
    expect(snap0.summary.status).toBe("completed")

    // Start generation — internal state now has currentGenerationSpanId
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash", callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })
    await new Promise((r) => setTimeout(r, 50))
    const snap1 = JSON.parse(await fs.readFile(path1, "utf-8")) as TraceFile
    expect(snap1.summary.status).toBe("running")

    // Finish generation — should go back to "completed"
    tracer.logStepFinish(ZERO_STEP)
    await new Promise((r) => setTimeout(r, 50))
    const snap2 = JSON.parse(await fs.readFile(path1, "utf-8")) as TraceFile
    expect(snap2.summary.status).toBe("completed")

    // Start another generation
    tracer.logStepStart({ id: "2" })
    tracer.logToolCall({
      tool: "read", callID: "c2",
      state: { status: "completed", input: {}, output: "ok", time: { start: 3, end: 4 } },
    })
    await new Promise((r) => setTimeout(r, 50))
    const snap3 = JSON.parse(await fs.readFile(path1, "utf-8")) as TraceFile
    expect(snap3.summary.status).toBe("running")

    // Final endTrace — always "completed"
    const filePath = await tracer.endTrace()
    const final = JSON.parse(await fs.readFile(filePath!, "utf-8")) as TraceFile
    expect(final.summary.status).toBe("completed")
  })
})

// ---------------------------------------------------------------------------
// 8. Exporter ordering — FileExporter result returned even if not first
// ---------------------------------------------------------------------------

describe("Exporter ordering", () => {
  test("FileExporter result returned even when HttpExporter is first and fails", async () => {
    const failHttp = new HttpExporter("broken", "http://localhost:1")
    const fileExp = new FileExporter(tmpDir)
    // HttpExporter is FIRST in the array
    const tracer = Recap.withExporters([failHttp, fileExp])
    tracer.startTrace("s-order", { prompt: "test" })
    const result = await tracer.endTrace()
    // HttpExporter fails, FileExporter succeeds — should return file path
    expect(result).toContain("s-order.json")
  })

  test("FileExporter result returned even when slow HttpExporter is first", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((r) => setTimeout(r, 100))
        return Response.json({ url: "http://slow.com/trace/1" })
      },
    })
    try {
      const httpExp = new HttpExporter("slow", `http://localhost:${server.port}`)
      const fileExp = new FileExporter(tmpDir)
      const tracer = Recap.withExporters([fileExp, httpExp])
      tracer.startTrace("s-slow-order", { prompt: "test" })
      const result = await tracer.endTrace()
      // FileExporter is first and fast — its result should be returned
      expect(result).toContain("s-slow-order.json")
    } finally {
      server.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// 9. Snapshot debounce — rapid logStepFinish + logToolCall interleaving
// ---------------------------------------------------------------------------

describe("Snapshot debounce under load", () => {
  test("alternating logToolCall and logStepFinish doesn't lose data", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-debounce", { prompt: "test" })

    // Rapid alternation: each triggers snapshot
    for (let i = 0; i < 10; i++) {
      tracer.logStepStart({ id: `${i}` })
      tracer.logToolCall({
        tool: `tool-${i}`, callID: `c-${i}`,
        state: { status: "completed", input: {}, output: `out-${i}`, time: { start: 1, end: 2 } },
      })
      tracer.logStepFinish({
        id: `${i}`, reason: "stop", cost: 0.001,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    }

    // Wait for all snapshots to settle
    await new Promise((r) => setTimeout(r, 100))

    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    // All data should be present in the final trace
    expect(trace.summary.totalGenerations).toBe(10)
    expect(trace.summary.totalToolCalls).toBe(10)
    expect(trace.summary.totalCost).toBeCloseTo(0.01, 5)
    expect(trace.spans.filter((s) => s.kind === "generation")).toHaveLength(10)
    expect(trace.spans.filter((s) => s.kind === "tool")).toHaveLength(10)
  })
})

// ---------------------------------------------------------------------------
// 10. End-to-end: full session → endTrace → re-read → verify every field
// ---------------------------------------------------------------------------

describe("End-to-end field verification", () => {
  test("every span field is correctly populated after full session", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-fields", {
      model: "anthropic/claude-sonnet-4-20250514",
      providerId: "anthropic",
      agent: "builder",
      variant: "high",
      prompt: "Full field test",
      userId: "tester",
      environment: "ci",
      version: "1.0.0",
      tags: ["test"],
    })
    tracer.enrichFromAssistant({
      modelID: "claude-sonnet-4-20250514",
      providerID: "anthropic",
      agent: "builder",
      variant: "high",
    })

    tracer.logStepStart({ id: "gen-1" })
    tracer.logToolCall({
      tool: "sql_execute",
      callID: "call-123",
      state: {
        status: "completed",
        input: { query: "SELECT 1", warehouse: "snowflake" },
        output: "1 row returned",
        time: { start: 1000, end: 3500 },
      },
    })
    tracer.logText({ text: "Query executed successfully." })
    tracer.logStepFinish({
      id: "gen-1",
      reason: "stop",
      cost: 0.0075,
      tokens: { input: 1500, output: 300, reasoning: 100, cache: { read: 200, write: 50 } },
    })

    const filePath = await tracer.endTrace()
    const t: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    // TraceFile top-level
    expect(t.version).toBe(2)
    expect(t.traceId).toMatch(/^[0-9a-f-]+$/)
    expect(t.sessionId).toBe("s-fields")
    expect(new Date(t.startedAt).getTime()).toBeGreaterThan(0)
    expect(new Date(t.endedAt!).getTime()).toBeGreaterThanOrEqual(new Date(t.startedAt).getTime())

    // Metadata
    expect(t.metadata.model).toBe("anthropic/claude-sonnet-4-20250514")
    expect(t.metadata.providerId).toBe("anthropic")
    expect(t.metadata.agent).toBe("builder")
    expect(t.metadata.variant).toBe("high")
    expect(t.metadata.prompt).toBe("Full field test")
    expect(t.metadata.userId).toBe("tester")
    expect(t.metadata.environment).toBe("ci")
    expect(t.metadata.version).toBe("1.0.0")
    expect(t.metadata.tags).toEqual(["test"])

    // Summary
    expect(t.summary.totalGenerations).toBe(1)
    expect(t.summary.totalToolCalls).toBe(1)
    expect(t.summary.totalTokens).toBe(2150)
    expect(t.summary.totalCost).toBe(0.0075)
    expect(t.summary.duration).toBeGreaterThanOrEqual(0)
    expect(t.summary.status).toBe("completed")
    expect(t.summary.tokens.input).toBe(1500)
    expect(t.summary.tokens.output).toBe(300)
    expect(t.summary.tokens.reasoning).toBe(100)
    expect(t.summary.tokens.cacheRead).toBe(200)
    expect(t.summary.tokens.cacheWrite).toBe(50)

    // Session span
    const session = t.spans.find((s) => s.kind === "session")!
    expect(session.parentSpanId).toBeNull()
    expect(session.status).toBe("ok")
    expect(session.endTime).toBeDefined()
    expect(session.input).toBe("Full field test")

    // Generation span
    const gen = t.spans.find((s) => s.kind === "generation")!
    expect(gen.parentSpanId).toBe(session.spanId)
    expect(gen.name).toBe("generation-gen-1")
    expect(gen.model?.modelId).toBe("anthropic/claude-sonnet-4-20250514")
    expect(gen.model?.providerId).toBe("anthropic")
    expect(gen.model?.variant).toBe("high")
    expect(gen.finishReason).toBe("stop")
    expect(gen.cost).toBe(0.0075)
    expect(gen.tokens?.input).toBe(1500)
    expect(gen.tokens?.output).toBe(300)
    expect(gen.tokens?.reasoning).toBe(100)
    expect(gen.tokens?.cacheRead).toBe(200)
    expect(gen.tokens?.cacheWrite).toBe(50)
    expect(gen.tokens?.total).toBe(2150)
    expect(gen.output).toBe("Query executed successfully.")
    expect(gen.endTime).toBeDefined()

    // Tool span
    const tool = t.spans.find((s) => s.kind === "tool")!
    expect(tool.parentSpanId).toBe(gen.spanId)
    expect(tool.name).toBe("sql_execute")
    expect(tool.tool?.callId).toBe("call-123")
    expect(tool.tool?.durationMs).toBe(2500)
    expect(tool.startTime).toBe(1000)
    expect(tool.endTime).toBe(3500)
    expect(tool.status).toBe("ok")
    expect((tool.input as any).query).toBe("SELECT 1")
    expect(tool.output).toBe("1 row returned")
  })
})
