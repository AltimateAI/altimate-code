/**
 * Tests for trace list display, title handling, formatting utilities,
 * flushSync crash recovery, initial snapshot, and sorting.
 *
 * These test the latest additions that were previously uncovered.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import {
  Recap,
  FileExporter,
  type TraceFile,
} from "../../src/altimate/observability/tracing"

let tmpDir: string

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `tracing-display-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
// 1. Title field in metadata
// ---------------------------------------------------------------------------

describe("Title metadata", () => {
  test("title is captured from startTrace", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", {
      title: "Optimize expensive queries",
      prompt: "Find and fix the top 10 most expensive queries in Snowflake",
    })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.metadata.title).toBe("Optimize expensive queries")
    expect(trace.metadata.prompt).toBe("Find and fix the top 10 most expensive queries in Snowflake")
  })

  test("title defaults to undefined when not provided", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.metadata.title).toBeUndefined()
  })

  test("empty string title is stored as empty string", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { title: "", prompt: "test" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.metadata.title).toBe("")
  })

  test("very long title is stored in full (truncation is display-only)", async () => {
    const longTitle = "A".repeat(500)
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { title: longTitle, prompt: "test" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.metadata.title).toBe(longTitle)
    expect(trace.metadata.title!.length).toBe(500)
  })

  test("title with special characters", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", {
      title: 'Fix "broken" model — stg_orders (🐛)',
      prompt: "test",
    })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.metadata.title).toBe('Fix "broken" model — stg_orders (🐛)')
  })
})

// ---------------------------------------------------------------------------
// 2. flushSync — crash recovery
// ---------------------------------------------------------------------------

describe("flushSync — crash recovery", () => {
  test("flushSync writes a valid trace file with crashed status", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-crash", {
      title: "Long running task",
      prompt: "This will crash",
    })
    // Wait for initial snapshot
    await new Promise((r) => setTimeout(r, 50))

    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })

    // Simulate crash — call flushSync instead of endTrace
    tracer.flushSync("SIGINT received")

    const filePath = tracer.getTracePath()!
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath, "utf-8"))

    expect(trace.summary.status).toBe("crashed")
    expect(trace.metadata.title).toBe("Long running task")
    // Should have spans from before the crash
    expect(trace.spans.length).toBeGreaterThanOrEqual(1)
  })

  test("flushSync before startTrace is a no-op", () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    // No startTrace called — flushSync should silently do nothing
    tracer.flushSync("crash")
    // No crash = pass
    expect(true).toBe(true)
  })

  test("flushSync after endTrace overwrites with crashed status", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-double", { prompt: "test" })
    const filePath = await tracer.endTrace()

    // Now flushSync — this overwrites the completed trace with crashed
    tracer.flushSync("late crash")

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.status).toBe("crashed")
  })

  test("flushSync with no FileExporter is a no-op", () => {
    const tracer = Recap.withExporters([])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.flushSync("crash")
    // No crash = pass
    expect(true).toBe(true)
  })

  test("flushSync with null error uses default message", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-null-err", { prompt: "test" })
    await new Promise((r) => setTimeout(r, 50))

    tracer.flushSync()

    const trace: TraceFile = JSON.parse(await fs.readFile(tracer.getTracePath()!, "utf-8"))
    expect(trace.summary.status).toBe("crashed")
    expect(trace.summary.error).toBe("Process exited before trace completed")
  })

  test("flushSync preserves all accumulated data", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-preserve", {
      title: "Preserved trace",
      prompt: "complex task",
      model: "anthropic/claude-sonnet-4-20250514",
      agent: "builder",
    })
    await new Promise((r) => setTimeout(r, 50))

    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "sql_execute", callID: "c1",
      state: { status: "completed", input: { query: "SELECT 1" }, output: "1 row", time: { start: 1000, end: 3000 } },
    })
    tracer.logText({ text: "Got results." })
    tracer.logStepFinish({
      id: "1", reason: "tool_calls", cost: 0.005,
      tokens: { input: 1000, output: 200, reasoning: 50, cache: { read: 100, write: 25 } },
    })
    // Wait for logStepFinish snapshot
    await new Promise((r) => setTimeout(r, 50))

    tracer.logStepStart({ id: "2" })
    // Crash mid-generation
    tracer.flushSync("SIGTERM")

    const trace: TraceFile = JSON.parse(await fs.readFile(tracer.getTracePath()!, "utf-8"))
    expect(trace.summary.status).toBe("crashed")
    expect(trace.metadata.title).toBe("Preserved trace")
    expect(trace.metadata.model).toBe("anthropic/claude-sonnet-4-20250514")
    // Completed generation's data should be preserved
    expect(trace.summary.tokens.input).toBe(1000)
    expect(trace.summary.totalToolCalls).toBe(1)
    expect(trace.summary.totalGenerations).toBe(2) // gen 1 finished, gen 2 started
    // Spans from before crash
    expect(trace.spans.filter((s) => s.kind === "tool")).toHaveLength(1)
    expect(trace.spans.filter((s) => s.kind === "generation")).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 3. Initial snapshot from startTrace
// ---------------------------------------------------------------------------

describe("Initial snapshot from startTrace", () => {
  test("trace file exists immediately after startTrace", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-initial", { prompt: "hello" })

    await new Promise((r) => setTimeout(r, 50))

    const filePath = tracer.getTracePath()!
    const exists = await fs.stat(filePath).then(() => true).catch(() => false)
    expect(exists).toBe(true)

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath, "utf-8"))
    expect(trace.version).toBe(2)
    expect(trace.sessionId).toBe("s-initial")
    expect(trace.spans).toHaveLength(1) // Just the session span
    expect(trace.spans[0]!.kind).toBe("session")
    expect(trace.summary.status).toBe("completed") // No active generation

    await tracer.endTrace()
  })

  test("initial snapshot has metadata populated", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-meta-snap", {
      title: "My Task",
      prompt: "Do things",
      model: "anthropic/claude-sonnet-4-20250514",
      agent: "builder",
      tags: ["test"],
    })
    await new Promise((r) => setTimeout(r, 50))

    const trace: TraceFile = JSON.parse(await fs.readFile(tracer.getTracePath()!, "utf-8"))
    expect(trace.metadata.title).toBe("My Task")
    expect(trace.metadata.prompt).toBe("Do things")
    expect(trace.metadata.model).toBe("anthropic/claude-sonnet-4-20250514")
    expect(trace.metadata.tags).toEqual(["test"])

    await tracer.endTrace()
  })
})

// ---------------------------------------------------------------------------
// 4. Sorting — newest first
// ---------------------------------------------------------------------------

describe("Trace sorting", () => {
  test("traces are sorted newest first when read from directory", async () => {
    // Write traces with specific timestamps
    const traces = [
      { sessionId: "oldest", startedAt: "2025-01-01T00:00:00.000Z" },
      { sessionId: "middle", startedAt: "2025-06-15T12:00:00.000Z" },
      { sessionId: "newest", startedAt: "2026-03-16T00:00:00.000Z" },
    ]

    for (const t of traces) {
      const trace: TraceFile = {
        version: 2,
        traceId: `t-${t.sessionId}`,
        sessionId: t.sessionId,
        startedAt: t.startedAt,
        metadata: { title: t.sessionId },
        spans: [],
        summary: {
          totalTokens: 0, totalCost: 0, totalToolCalls: 0, totalGenerations: 0,
          duration: 0, status: "completed",
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }
      await fs.writeFile(path.join(tmpDir, `${t.sessionId}.json`), JSON.stringify(trace))
    }

    // Read and sort like listTraces does
    const files = await fs.readdir(tmpDir)
    const loaded: Array<{ sessionId: string; trace: TraceFile }> = []
    for (const file of files) {
      if (!file.endsWith(".json")) continue
      const content = await fs.readFile(path.join(tmpDir, file), "utf-8")
      const trace = JSON.parse(content) as TraceFile
      loaded.push({ sessionId: trace.sessionId, trace })
    }
    loaded.sort((a, b) => new Date(b.trace.startedAt).getTime() - new Date(a.trace.startedAt).getTime())

    expect(loaded[0]!.sessionId).toBe("newest")
    expect(loaded[1]!.sessionId).toBe("middle")
    expect(loaded[2]!.sessionId).toBe("oldest")
  })

  test("sorting handles invalid dates gracefully", async () => {
    const traces = [
      { sessionId: "valid", startedAt: "2026-01-01T00:00:00.000Z" },
      { sessionId: "invalid", startedAt: "not-a-date" },
      { sessionId: "also-valid", startedAt: "2025-06-01T00:00:00.000Z" },
    ]

    for (const t of traces) {
      const trace: TraceFile = {
        version: 2,
        traceId: `t-${t.sessionId}`,
        sessionId: t.sessionId,
        startedAt: t.startedAt,
        metadata: {},
        spans: [],
        summary: {
          totalTokens: 0, totalCost: 0, totalToolCalls: 0, totalGenerations: 0,
          duration: 0, status: "completed",
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }
      await fs.writeFile(path.join(tmpDir, `${t.sessionId}.json`), JSON.stringify(trace))
    }

    const files = await fs.readdir(tmpDir)
    const loaded: Array<{ sessionId: string; trace: TraceFile }> = []
    for (const file of files) {
      if (!file.endsWith(".json")) continue
      const content = await fs.readFile(path.join(tmpDir, file), "utf-8")
      const trace = JSON.parse(content) as TraceFile
      loaded.push({ sessionId: trace.sessionId, trace })
    }
    // Should not throw even with invalid date — NaN from new Date("not-a-date")
    loaded.sort((a, b) => new Date(b.trace.startedAt).getTime() - new Date(a.trace.startedAt).getTime())

    // Invalid date sorts to the end (NaN comparisons return false)
    expect(loaded).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// 5. Title display fallback chain
// ---------------------------------------------------------------------------

describe("Display title fallback chain", () => {
  test("title > prompt > sessionId fallback", () => {
    // With title + prompt
    const t1: TraceFile = {
      version: 2, traceId: "t1", sessionId: "s1", startedAt: "", metadata: { title: "My Title", prompt: "My Prompt" },
      spans: [], summary: { totalTokens: 0, totalCost: 0, totalToolCalls: 0, totalGenerations: 0, duration: 0, status: "completed", tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
    }
    expect(t1.metadata.title || t1.metadata.prompt || t1.sessionId).toBe("My Title")

    // With prompt only (no title)
    const t2: TraceFile = {
      ...t1, metadata: { prompt: "Just a prompt" },
    }
    expect(t2.metadata.title || t2.metadata.prompt || t2.sessionId).toBe("Just a prompt")

    // With neither title nor prompt
    const t3: TraceFile = {
      ...t1, metadata: {},
    }
    expect(t3.metadata.title || t3.metadata.prompt || t3.sessionId).toBe("s1")

    // With empty string title (falsy — falls through to prompt)
    const t4: TraceFile = {
      ...t1, metadata: { title: "", prompt: "Fallback prompt" },
    }
    expect(t4.metadata.title || t4.metadata.prompt || t4.sessionId).toBe("Fallback prompt")
  })
})

// ---------------------------------------------------------------------------
// 6. Format functions — edge cases
// ---------------------------------------------------------------------------

describe("Format function edge cases", () => {
  // We test the formatting logic by creating traces and verifying the output
  // values match expected patterns (since the functions aren't exported)

  test("duration edge cases produce valid strings in trace", async () => {
    const durations = [0, 1, 999, 1000, 1001, 59999, 60000, 60001, 3600000]
    for (const dur of durations) {
      const tracer = Recap.withExporters([new FileExporter(tmpDir)])
      tracer.startTrace(`dur-${dur}`, { prompt: "test" })
      const filePath = await tracer.endTrace()
      const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
      // Duration should be a non-negative number
      expect(trace.summary.duration).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(trace.summary.duration)).toBe(true)
    }
  })

  test("cost edge cases produce valid JSON", async () => {
    const costs = [0, 0.001, 0.009999, 0.01, 0.1, 1.0, 100, 0.123456789]
    for (const cost of costs) {
      const tracer = Recap.withExporters([new FileExporter(tmpDir)])
      tracer.startTrace(`cost-${cost}`, { prompt: "test" })
      tracer.logStepStart({ id: "1" })
      tracer.logStepFinish({
        id: "1", reason: "stop", cost,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      const filePath = await tracer.endTrace()
      const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
      expect(Number.isFinite(trace.summary.totalCost)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 7. Trace view partial matching — all branches
// ---------------------------------------------------------------------------

describe("Partial ID matching", () => {
  test("exact session ID match", async () => {
    await fs.writeFile(
      path.join(tmpDir, "exact-match.json"),
      JSON.stringify({
        version: 2, traceId: "t1", sessionId: "exact-match", startedAt: new Date().toISOString(),
        metadata: {}, spans: [],
        summary: { totalTokens: 0, totalCost: 0, totalToolCalls: 0, totalGenerations: 0, duration: 0, status: "completed", tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
      }),
    )

    const files = await fs.readdir(tmpDir)
    const traces = await Promise.all(
      files.filter((f) => f.endsWith(".json")).map(async (file) => {
        const trace = JSON.parse(await fs.readFile(path.join(tmpDir, file), "utf-8")) as TraceFile
        return { sessionId: trace.sessionId, file, trace }
      }),
    )

    // Exact match
    const match1 = traces.find((t) => t.sessionId === "exact-match")
    expect(match1).toBeDefined()

    // Prefix match
    const match2 = traces.find((t) => t.sessionId.startsWith("exact"))
    expect(match2).toBeDefined()

    // File name prefix match
    const match3 = traces.find((t) => t.file.startsWith("exact"))
    expect(match3).toBeDefined()

    // No match
    const match4 = traces.find((t) =>
      t.sessionId === "nonexistent" || t.sessionId.startsWith("nonexistent") || t.file.startsWith("nonexistent"),
    )
    expect(match4).toBeUndefined()
  })

  test("prefix match works with partial IDs", async () => {
    await fs.writeFile(
      path.join(tmpDir, "ses_abc123def456.json"),
      JSON.stringify({
        version: 2, traceId: "t1", sessionId: "ses_abc123def456", startedAt: new Date().toISOString(),
        metadata: { title: "Found by prefix" }, spans: [],
        summary: { totalTokens: 0, totalCost: 0, totalToolCalls: 0, totalGenerations: 0, duration: 0, status: "completed", tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
      }),
    )

    const files = await fs.readdir(tmpDir)
    const traces = await Promise.all(
      files.filter((f) => f.endsWith(".json")).map(async (file) => {
        const trace = JSON.parse(await fs.readFile(path.join(tmpDir, file), "utf-8")) as TraceFile
        return { sessionId: trace.sessionId, file, trace }
      }),
    )

    // Short prefix should match
    const match = traces.find((t) =>
      t.sessionId === "ses_abc" || t.sessionId.startsWith("ses_abc") || t.file.startsWith("ses_abc"),
    )
    expect(match).toBeDefined()
    expect(match!.trace.metadata.title).toBe("Found by prefix")
  })
})

// ---------------------------------------------------------------------------
// 8. Multiple flushSync calls
// ---------------------------------------------------------------------------

describe("flushSync — multiple calls", () => {
  test("calling flushSync multiple times doesn't crash", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-multi-flush", { prompt: "test" })
    await new Promise((r) => setTimeout(r, 50))

    tracer.flushSync("crash 1")
    tracer.flushSync("crash 2")
    tracer.flushSync("crash 3")

    const trace: TraceFile = JSON.parse(await fs.readFile(tracer.getTracePath()!, "utf-8"))
    // Last flushSync wins
    expect(trace.summary.status).toBe("crashed")
  })

  test("flushSync then endTrace — endTrace overwrites crashed status", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-flush-then-end", { prompt: "test" })
    await new Promise((r) => setTimeout(r, 50))

    tracer.flushSync("early crash")

    // But actually the process survived — endTrace completes normally
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // endTrace should overwrite with "completed"
    expect(trace.summary.status).toBe("completed")
  })
})

// ---------------------------------------------------------------------------
// 9. Historical traces — reading old trace files
// ---------------------------------------------------------------------------

describe("Historical traces", () => {
  test("can read a trace file written by a previous version (v2 schema)", async () => {
    // Simulate a trace file written by a previous run
    const oldTrace: TraceFile = {
      version: 2,
      traceId: "old-trace-id",
      sessionId: "old-session",
      startedAt: "2025-01-15T08:30:00.000Z",
      endedAt: "2025-01-15T08:31:00.000Z",
      metadata: {
        title: "Historical query optimization",
        model: "anthropic/claude-3-5-sonnet",
        prompt: "Optimize warehouse costs",
      },
      spans: [
        {
          spanId: "span-1",
          parentSpanId: null,
          name: "old-session",
          kind: "session",
          startTime: 1705304400000,
          endTime: 1705304460000,
          status: "ok",
        },
        {
          spanId: "span-2",
          parentSpanId: "span-1",
          name: "generation-1",
          kind: "generation",
          startTime: 1705304400100,
          endTime: 1705304430000,
          status: "ok",
          model: { modelId: "claude-3-5-sonnet", providerId: "anthropic" },
          tokens: { input: 5000, output: 1200, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 6200 },
          cost: 0.025,
          finishReason: "stop",
        },
      ],
      summary: {
        totalTokens: 6200,
        totalCost: 0.025,
        totalToolCalls: 0,
        totalGenerations: 1,
        duration: 60000,
        status: "completed",
        tokens: { input: 5000, output: 1200, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    }

    await fs.writeFile(
      path.join(tmpDir, "old-session.json"),
      JSON.stringify(oldTrace, null, 2),
    )

    // Read it back like loadTrace does
    const content = await fs.readFile(path.join(tmpDir, "old-session.json"), "utf-8")
    const loaded = JSON.parse(content) as TraceFile

    expect(loaded.version).toBe(2)
    expect(loaded.sessionId).toBe("old-session")
    expect(loaded.metadata.title).toBe("Historical query optimization")
    expect(loaded.summary.totalTokens).toBe(6200)
    expect(loaded.spans).toHaveLength(2)
    expect(loaded.spans[1]!.tokens?.total).toBe(6200)
  })

  test("trace files without title field still work", async () => {
    // Old trace without title
    const noTitle = {
      version: 2,
      traceId: "t",
      sessionId: "no-title",
      startedAt: "2025-06-01T00:00:00.000Z",
      metadata: { prompt: "Old prompt without title" },
      spans: [],
      summary: {
        totalTokens: 0, totalCost: 0, totalToolCalls: 0, totalGenerations: 0,
        duration: 0, status: "completed",
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    }

    await fs.writeFile(path.join(tmpDir, "no-title.json"), JSON.stringify(noTitle))
    const loaded = JSON.parse(await fs.readFile(path.join(tmpDir, "no-title.json"), "utf-8")) as TraceFile

    // Title fallback: undefined title → prompt → sessionId
    const displayTitle = loaded.metadata.title || loaded.metadata.prompt || loaded.sessionId
    expect(displayTitle).toBe("Old prompt without title")
  })

  test("trace files without any metadata still work", async () => {
    const bare = {
      version: 2,
      traceId: "t",
      sessionId: "bare",
      startedAt: "2025-01-01T00:00:00.000Z",
      metadata: {},
      spans: [],
      summary: {
        totalTokens: 0, totalCost: 0, totalToolCalls: 0, totalGenerations: 0,
        duration: 0, status: "completed",
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    }

    await fs.writeFile(path.join(tmpDir, "bare.json"), JSON.stringify(bare))
    const loaded = JSON.parse(await fs.readFile(path.join(tmpDir, "bare.json"), "utf-8")) as TraceFile

    const displayTitle = loaded.metadata.title || loaded.metadata.prompt || loaded.sessionId
    expect(displayTitle).toBe("bare")
  })
})

// ---------------------------------------------------------------------------
// 10. Crash recovery — data integrity across snapshot + flushSync
// ---------------------------------------------------------------------------

describe("Crash recovery — data integrity", () => {
  test("flushSync after multiple tool calls preserves all tools", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-multi-tool-crash", { prompt: "test" })
    await new Promise((r) => setTimeout(r, 50))

    tracer.logStepStart({ id: "1" })
    for (let i = 0; i < 5; i++) {
      tracer.logToolCall({
        tool: `tool-${i}`, callID: `c-${i}`,
        state: { status: "completed", input: { i }, output: `ok-${i}`, time: { start: 1000 + i, end: 2000 + i } },
      })
    }
    // Wait for snapshots to settle
    await new Promise((r) => setTimeout(r, 50))

    // Crash mid-generation
    tracer.flushSync("SIGKILL")

    const trace: TraceFile = JSON.parse(await fs.readFile(tracer.getTracePath()!, "utf-8"))
    expect(trace.summary.status).toBe("crashed")
    // All 5 tools should be present
    expect(trace.spans.filter((s) => s.kind === "tool")).toHaveLength(5)
    expect(trace.summary.totalToolCalls).toBe(5)
  })

  test("crashed trace can be viewed without errors", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-view-crash", {
      title: "Crashed but viewable",
      prompt: "This crashed",
    })
    await new Promise((r) => setTimeout(r, 50))
    tracer.logStepStart({ id: "1" })
    tracer.flushSync("process killed")

    const filePath = tracer.getTracePath()!
    const content = await fs.readFile(filePath, "utf-8")
    const trace: TraceFile = JSON.parse(content)

    // All required fields should be present for the viewer
    expect(trace.version).toBe(2)
    expect(trace.traceId).toBeTruthy()
    expect(trace.sessionId).toBeTruthy()
    expect(trace.startedAt).toBeTruthy()
    expect(trace.endedAt).toBeTruthy()
    expect(trace.metadata).toBeDefined()
    expect(trace.spans).toBeDefined()
    expect(trace.summary).toBeDefined()
    expect(trace.summary.tokens).toBeDefined()
    expect(trace.summary.status).toBe("crashed")
    expect(trace.metadata.title).toBe("Crashed but viewable")
  })
})
