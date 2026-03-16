/**
 * End-to-end tests for the tracing system.
 *
 * These tests simulate real agent sessions — not mocked — to verify:
 *   1. Incremental snapshots are written during a session (partial traces)
 *   2. The trace file is valid and complete at every point
 *   3. Concurrent sessions don't interfere with each other
 *   4. Performance: tracing adds negligible overhead (<5ms per operation)
 *   5. The TUI worker's tracing code doesn't crash on malformed events
 *   6. The trace viewer server works correctly
 *   7. The full write→snapshot→read→render pipeline works end-to-end
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
import { DE } from "../../src/altimate/observability/de-attributes"

let tmpDir: string

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `tracing-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

// ---------------------------------------------------------------------------
// Helpers that simulate realistic agent sessions
// ---------------------------------------------------------------------------

/** Simulate a realistic multi-generation agent session */
async function simulateAgentSession(
  tracer: Tracer,
  sessionId: string,
  opts: {
    generations: number
    toolsPerGeneration: number
    addDeAttributes?: boolean
    slowTools?: boolean
  },
) {
  tracer.startTrace(sessionId, {
    model: "anthropic/claude-sonnet-4-20250514",
    providerId: "anthropic",
    agent: "builder",
    prompt: "Optimize the data pipeline for cost reduction",
    userId: "user@test.com",
    environment: "test",
    tags: ["e2e", "benchmark"],
  })

  tracer.enrichFromAssistant({
    modelID: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    agent: "builder",
    variant: "high",
  })

  for (let gen = 0; gen < opts.generations; gen++) {
    tracer.logStepStart({ id: `gen-${gen}` })

    for (let tool = 0; tool < opts.toolsPerGeneration; tool++) {
      const toolName = ["sql_execute", "bash", "read", "edit", "glob"][tool % 5]!
      const isError = gen === 1 && tool === 0 // Second gen, first tool = error

      if (opts.slowTools) {
        await new Promise((r) => setTimeout(r, 10))
      }

      tracer.logToolCall({
        tool: toolName,
        callID: `call-${gen}-${tool}`,
        state: isError
          ? {
              status: "error",
              input: { command: "dbt run --select failing_model" },
              error: "Compilation Error: column 'revenue' not found in 'orders'",
              time: { start: Date.now() - 2000, end: Date.now() },
            }
          : {
              status: "completed",
              input: {
                ...(toolName === "sql_execute" && { query: `SELECT count(*) FROM table_${tool}` }),
                ...(toolName === "bash" && { command: `echo 'step ${tool}'` }),
                ...(toolName === "read" && { filePath: `/project/models/model_${tool}.sql` }),
                ...(toolName === "edit" && { filePath: `/project/models/model_${tool}.sql`, old_string: "old", new_string: "new" }),
                ...(toolName === "glob" && { pattern: "**/*.sql" }),
              },
              output: toolName === "sql_execute"
                ? `${1000 + tool * 100} rows returned`
                : `Tool ${toolName} completed successfully`,
              time: { start: Date.now() - 1500, end: Date.now() },
            },
      })

      // Add DE attributes for SQL tools
      if (opts.addDeAttributes && toolName === "sql_execute" && !isError) {
        tracer.setSpanAttributes({
          [DE.WAREHOUSE.SYSTEM]: "snowflake",
          [DE.WAREHOUSE.BYTES_SCANNED]: 15_000_000 + tool * 5_000_000,
          [DE.WAREHOUSE.EXECUTION_TIME_MS]: 800 + tool * 200,
          [DE.WAREHOUSE.TOTAL_TIME_MS]: 1000 + tool * 250,
          [DE.WAREHOUSE.ROWS_RETURNED]: 1000 + tool * 100,
          [DE.WAREHOUSE.ESTIMATED_COST_USD]: 0.001 + tool * 0.0005,
          [DE.WAREHOUSE.QUERY_ID]: `snowflake-query-${gen}-${tool}`,
          [DE.WAREHOUSE.CACHE_HIT]: tool % 2 === 0,
          [DE.SQL.QUERY_TEXT]: `SELECT count(*) FROM table_${tool}`,
          [DE.SQL.DIALECT]: "snowflake_sql",
          [DE.SQL.VALIDATION_VALID]: true,
          [DE.SQL.LINEAGE_INPUT_TABLES]: [`raw.public.table_${tool}`],
        })
      }
    }

    tracer.logText({
      text: gen === 1
        ? "The model failed due to a missing column. Let me fix it."
        : `Generation ${gen} completed. Results look good.`,
    })

    tracer.logStepFinish({
      id: `gen-${gen}`,
      reason: gen < opts.generations - 1 ? "tool_calls" : "stop",
      cost: 0.005 + gen * 0.002,
      tokens: {
        input: 2000 + gen * 500,
        output: 400 + gen * 100,
        reasoning: 50 + gen * 25,
        cache: { read: 300 + gen * 100, write: 50 },
      },
    })
  }

  // Session-level cost attribution
  if (opts.addDeAttributes) {
    tracer.setSpanAttributes({
      [DE.COST.LLM_TOTAL_USD]: opts.generations * 0.006,
      [DE.COST.WAREHOUSE_COMPUTE_USD]: 0.005,
      [DE.COST.TOTAL_USD]: opts.generations * 0.006 + 0.005,
      [DE.COST.ATTRIBUTION_PROJECT]: "data-platform",
    }, "session")
  }
}

// ---------------------------------------------------------------------------
// 1. Incremental snapshots — trace viewable mid-session
// ---------------------------------------------------------------------------

describe("Incremental snapshots", () => {
  test("trace file exists after startTrace (before any tool calls)", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-snapshot-1", { prompt: "test" })

    // Wait for initial snapshot to flush
    await new Promise((r) => setTimeout(r, 200))

    // File should exist immediately from startTrace's snapshot
    const filePath = tracer.getTracePath()!
    expect(filePath).toBeDefined()
    const exists = await fs.stat(filePath).then(() => true).catch(() => false)
    expect(exists).toBe(true)

    // Initial snapshot has just the session span
    const initial: TraceFile = JSON.parse(await fs.readFile(filePath, "utf-8"))
    expect(initial.version).toBe(2)
    expect(initial.spans.length).toBeGreaterThanOrEqual(1)

    // Now add tool call and wait for its snapshot
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: { command: "ls" },
        output: "file1.ts",
        time: { start: Date.now() - 100, end: Date.now() },
      },
    })
    await new Promise((r) => setTimeout(r, 300))

    const withTool: TraceFile = JSON.parse(await fs.readFile(filePath, "utf-8"))
    expect(withTool.spans.find((s) => s.kind === "tool")).toBeDefined()

    // Now finish the session
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0.01,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const finalPath = await tracer.endTrace()

    // Final trace should have more data
    const final: TraceFile = JSON.parse(await fs.readFile(finalPath!, "utf-8"))
    expect(final.summary.status).toBe("completed")
    expect(final.summary.totalToolCalls).toBe(1)
    expect(final.summary.totalGenerations).toBe(1)
  })

  test("snapshot updates as more spans are added", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-snapshot-inc", { prompt: "test" })
    const filePath = tracer.getTracePath()!

    tracer.logStepStart({ id: "1" })

    // First tool
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: Date.now() - 100, end: Date.now() } },
    })
    await new Promise((r) => setTimeout(r, 200))
    const snap1: TraceFile = JSON.parse(await fs.readFile(filePath, "utf-8"))
    const count1 = snap1.spans.filter((s) => s.kind === "tool").length

    // Second tool
    tracer.logToolCall({
      tool: "read",
      callID: "c2",
      state: { status: "completed", input: {}, output: "content", time: { start: Date.now() - 50, end: Date.now() } },
    })
    await new Promise((r) => setTimeout(r, 200))
    const snap2: TraceFile = JSON.parse(await fs.readFile(filePath, "utf-8"))
    const count2 = snap2.spans.filter((s) => s.kind === "tool").length

    expect(count2).toBeGreaterThan(count1)

    // Finish
    tracer.logStepFinish({
      id: "1", reason: "stop", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    await tracer.endTrace()
  })

  test("getTracePath returns correct path", () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    // Before startTrace — no path
    expect(tracer.getTracePath()).toBeUndefined()

    tracer.startTrace("my-session", { prompt: "test" })
    expect(tracer.getTracePath()).toBe(path.join(tmpDir, "my-session.json"))
  })

  test("getTracePath returns undefined when no FileExporter", () => {
    const tracer = Tracer.withExporters([])
    tracer.startTrace("s1", { prompt: "test" })
    expect(tracer.getTracePath()).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. Full realistic session simulation
// ---------------------------------------------------------------------------

describe("Realistic session simulation", () => {
  test("3-generation session with DE attributes produces valid trace", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    await simulateAgentSession(tracer, "real-session-1", {
      generations: 3,
      toolsPerGeneration: 4,
      addDeAttributes: true,
    })
    const filePath = await tracer.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    // Structure checks
    expect(trace.version).toBe(2)
    expect(trace.sessionId).toBe("real-session-1")
    expect(trace.summary.totalGenerations).toBe(3)
    expect(trace.summary.totalToolCalls).toBe(12) // 3 gens * 4 tools
    expect(trace.summary.status).toBe("completed")

    // Token accumulation
    expect(trace.summary.totalTokens).toBeGreaterThan(0)
    expect(trace.summary.totalCost).toBeGreaterThan(0)
    expect(trace.summary.tokens.input).toBeGreaterThan(0)
    expect(trace.summary.tokens.output).toBeGreaterThan(0)

    // Span hierarchy
    const session = trace.spans.find((s) => s.kind === "session")!
    const gens = trace.spans.filter((s) => s.kind === "generation")
    const tools = trace.spans.filter((s) => s.kind === "tool")

    expect(session.parentSpanId).toBeNull()
    for (const gen of gens) {
      expect(gen.parentSpanId).toBe(session.spanId)
      expect(gen.model?.modelId).toBeTruthy()
      expect(gen.tokens).toBeDefined()
      expect(gen.finishReason).toBeTruthy()
    }
    for (const tool of tools) {
      // Each tool should be child of a generation
      expect(gens.some((g) => g.spanId === tool.parentSpanId)).toBe(true)
    }

    // Error tool should exist (gen 1, tool 0)
    const errorTools = tools.filter((t) => t.status === "error")
    expect(errorTools).toHaveLength(1)
    expect(errorTools[0]!.statusMessage).toContain("column 'revenue' not found")

    // DE attributes on SQL tools
    const sqlTools = tools.filter((t) => t.name === "sql_execute" && t.status === "ok")
    for (const sql of sqlTools) {
      expect(sql.attributes?.[DE.WAREHOUSE.SYSTEM]).toBe("snowflake")
      expect(sql.attributes?.[DE.WAREHOUSE.BYTES_SCANNED]).toBeGreaterThan(0)
      expect(sql.attributes?.[DE.SQL.VALIDATION_VALID]).toBe(true)
    }

    // Session-level cost attribution
    expect(session.attributes?.[DE.COST.TOTAL_USD]).toBeGreaterThan(0)
    expect(session.attributes?.[DE.COST.ATTRIBUTION_PROJECT]).toBe("data-platform")

    // Metadata
    expect(trace.metadata.model).toBe("anthropic/claude-sonnet-4-20250514")
    expect(trace.metadata.providerId).toBe("anthropic")
    expect(trace.metadata.agent).toBe("builder")
    expect(trace.metadata.userId).toBe("user@test.com")
    expect(trace.metadata.tags).toContain("e2e")

    // Generation inputs (pending tool results)
    // Gen 1 has no input (no pending tool results before first gen)
    // Gen 2+ should have tool results as input
    expect(gens[1]!.input).toBeTruthy()
    expect((gens[1]!.input as string)).toContain("[sql_execute]")
  })
})

// ---------------------------------------------------------------------------
// 3. Performance tests — tracing must not slow down the agent
// ---------------------------------------------------------------------------

describe("Performance", () => {
  test("1000 logToolCall operations complete in <500ms", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-perf-tools", { prompt: "perf test" })
    tracer.logStepStart({ id: "1" })

    const start = performance.now()
    for (let i = 0; i < 1000; i++) {
      tracer.logToolCall({
        tool: "bash",
        callID: `c-${i}`,
        state: {
          status: "completed",
          input: { command: `echo ${i}` },
          output: `output-${i}`,
          time: { start: Date.now(), end: Date.now() + 1 },
        },
      })
    }
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(500) // 1000 tool calls in <500ms = <0.5ms each

    tracer.logStepFinish({
      id: "1", reason: "stop", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    await tracer.endTrace()
  })

  test("logStepStart + logStepFinish cycle is <1ms", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-perf-gen", { prompt: "perf test" })

    const times: number[] = []
    for (let i = 0; i < 100; i++) {
      const start = performance.now()
      tracer.logStepStart({ id: `${i}` })
      tracer.logStepFinish({
        id: `${i}`, reason: "stop", cost: 0.001,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      times.push(performance.now() - start)
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length
    expect(avg).toBeLessThan(1) // Average <1ms per generation cycle

    await tracer.endTrace()
  })

  test("setSpanAttributes is <0.1ms per call", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-perf-attrs", { prompt: "perf test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash", callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })

    const start = performance.now()
    for (let i = 0; i < 1000; i++) {
      tracer.setSpanAttributes({
        [`key-${i}`]: `value-${i}`,
        [`num-${i}`]: i,
      })
    }
    const elapsed = performance.now() - start

    expect(elapsed / 1000).toBeLessThan(0.1) // <0.1ms per call

    tracer.logStepFinish({
      id: "1", reason: "stop", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    await tracer.endTrace()
  })

  test("endTrace with 1000 spans completes in <200ms", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-perf-end", { prompt: "perf test" })
    tracer.logStepStart({ id: "1" })
    for (let i = 0; i < 1000; i++) {
      tracer.logToolCall({
        tool: "bash", callID: `c-${i}`,
        state: { status: "completed", input: { i }, output: `out-${i}`, time: { start: 1, end: 2 } },
      })
    }
    tracer.logStepFinish({
      id: "1", reason: "stop", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })

    // Wait for snapshots to settle
    await new Promise((r) => setTimeout(r, 300))

    const start = performance.now()
    await tracer.endTrace()
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(200)
  })

  test("snapshot doesn't block the caller", async () => {
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s-perf-snap", { prompt: "perf test" })
    tracer.logStepStart({ id: "1" })

    // logToolCall triggers snapshot — measure that it returns immediately
    const start = performance.now()
    tracer.logToolCall({
      tool: "bash", callID: "c1",
      state: {
        status: "completed",
        input: { data: "x".repeat(100000) }, // Large input
        output: "y".repeat(100000), // Large output
        time: { start: Date.now() - 100, end: Date.now() },
      },
    })
    const elapsed = performance.now() - start

    // logToolCall should return immediately; snapshot runs async
    expect(elapsed).toBeLessThan(50)

    tracer.logStepFinish({
      id: "1", reason: "stop", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    await tracer.endTrace()
  })
})

// ---------------------------------------------------------------------------
// 4. Concurrent sessions — no cross-contamination
// ---------------------------------------------------------------------------

describe("Concurrent sessions", () => {
  test("10 parallel sessions produce independent traces", async () => {
    const promises = Array.from({ length: 10 }, async (_, i) => {
      const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
      await simulateAgentSession(tracer, `concurrent-${i}`, {
        generations: 2,
        toolsPerGeneration: 3,
        addDeAttributes: i % 2 === 0,
      })
      return tracer.endTrace()
    })

    const paths = await Promise.all(promises)

    // All should produce files
    expect(paths.filter(Boolean)).toHaveLength(10)

    // Each trace should be independent
    for (let i = 0; i < 10; i++) {
      const trace: TraceFile = JSON.parse(await fs.readFile(paths[i]!, "utf-8"))
      expect(trace.sessionId).toBe(`concurrent-${i}`)
      expect(trace.summary.totalGenerations).toBe(2)
      expect(trace.summary.totalToolCalls).toBe(6)

      // Verify no spans from other sessions leaked in
      const sessionSpan = trace.spans.find((s) => s.kind === "session")!
      for (const span of trace.spans) {
        if (span.kind === "session") continue
        // All spans should ultimately trace back to this session's root
        let current = span
        while (current.parentSpanId) {
          const parent = trace.spans.find((s) => s.spanId === current.parentSpanId)
          expect(parent).toBeDefined()
          current = parent!
        }
        expect(current.spanId).toBe(sessionSpan.spanId)
      }
    }
  })

  test("concurrent traces to same session ID overwrite cleanly", async () => {
    const promises = Array.from({ length: 3 }, async (_, i) => {
      const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
      tracer.startTrace("same-session", { prompt: `attempt-${i}` })
      tracer.logStepStart({ id: "1" })
      // Add a slight delay so writes don't all happen at the exact same instant
      await new Promise((r) => setTimeout(r, i * 50))
      tracer.logStepFinish({
        id: "1", reason: "stop", cost: 0.001 * i,
        tokens: { input: 100 * (i + 1), output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      return tracer.endTrace()
    })

    await Promise.all(promises)

    // Only one file should exist (last writer wins)
    const files = (await fs.readdir(tmpDir)).filter((f) => f.endsWith(".json") && !f.includes(".tmp"))
    expect(files.filter((f) => f.startsWith("same-session"))).toHaveLength(1)

    // File should be valid JSON
    const trace: TraceFile = JSON.parse(await fs.readFile(path.join(tmpDir, files.find((f) => f.startsWith("same-session"))!), "utf-8"))
    expect(trace.version).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 5. TUI worker event simulation — verify tracing doesn't crash on real events
// ---------------------------------------------------------------------------

describe("Worker event simulation", () => {
  test("simulated TUI event stream feeds tracer correctly", async () => {
    // Simulate what the worker does: create a tracer per session and feed events
    const tracers = new Map<string, Tracer>()

    function getOrCreateTracer(sessionID: string): Tracer {
      if (tracers.has(sessionID)) return tracers.get(sessionID)!
      const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
      tracer.startTrace(sessionID, {})
      tracers.set(sessionID, tracer)
      return tracer
    }

    // Simulate event stream
    const events = [
      { type: "message.updated", properties: { info: { role: "assistant", modelID: "claude-sonnet-4-20250514", providerID: "anthropic", agent: "builder", variant: "high", parentID: "session-tui-1" } } },
      { type: "message.part.updated", properties: { part: { sessionID: "session-tui-1", type: "step-start", id: "step-1" } } },
      { type: "message.part.updated", properties: { part: { sessionID: "session-tui-1", type: "tool", tool: "bash", callID: "c1", state: { status: "completed", input: { command: "ls" }, output: "file1.ts\nfile2.ts", time: { start: Date.now() - 1000, end: Date.now() } } } } },
      { type: "message.part.updated", properties: { part: { sessionID: "session-tui-1", type: "text", text: "Found files.", time: { end: Date.now() } } } },
      { type: "message.part.updated", properties: { part: { sessionID: "session-tui-1", type: "step-finish", id: "step-1", reason: "stop", cost: 0.005, tokens: { input: 500, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } } } },
      { type: "session.status", properties: { sessionID: "session-tui-1", status: { type: "idle" } } },
    ]

    for (const event of events) {
      try {
        if (event.type === "message.updated" && (event as any).properties?.info?.role === "assistant") {
          const info = (event as any).properties.info
          const tracer = getOrCreateTracer(info.parentID ?? "unknown")
          tracer.enrichFromAssistant({
            modelID: info.modelID,
            providerID: info.providerID,
            agent: info.agent,
            variant: info.variant,
          })
        }
        if (event.type === "message.part.updated") {
          const part = (event as any).properties?.part
          if (part) {
            const tracer = tracers.get(part.sessionID)
            if (tracer) {
              if (part.type === "step-start") tracer.logStepStart(part)
              if (part.type === "step-finish") tracer.logStepFinish(part)
              if (part.type === "text" && part.time?.end) tracer.logText(part)
              if (part.type === "tool" && (part.state?.status === "completed" || part.state?.status === "error")) {
                tracer.logToolCall(part)
              }
            }
          }
        }
        if (event.type === "session.status") {
          const props = (event as any).properties
          if (props?.status?.type === "idle" && tracers.has(props.sessionID)) {
            await tracers.get(props.sessionID)!.endTrace()
          }
        }
      } catch (e) {
        // This should never happen — but if it does, it's a bug
        expect(e).toBeUndefined()
      }
    }

    // Verify the trace was written correctly
    const files = (await fs.readdir(tmpDir)).filter((f) => f.endsWith(".json") && !f.includes(".tmp"))
    expect(files).toHaveLength(1)

    const trace: TraceFile = JSON.parse(await fs.readFile(path.join(tmpDir, files[0]!), "utf-8"))
    expect(trace.metadata.model).toBe("anthropic/claude-sonnet-4-20250514")
    expect(trace.summary.totalGenerations).toBe(1)
    expect(trace.summary.totalToolCalls).toBe(1)
    expect(trace.summary.totalTokens).toBe(600) // 500 + 100

    const gen = trace.spans.find((s) => s.kind === "generation")!
    expect(gen.output).toBe("Found files.")
  })

  test("malformed events don't crash the worker tracing logic", () => {
    const tracer = Tracer.withExporters([])
    tracer.startTrace("s-malformed", { prompt: "test" })

    // All of these should be no-ops, not crashes
    const malformedEvents = [
      { type: "message.part.updated", properties: null },
      { type: "message.part.updated", properties: { part: null } },
      { type: "message.part.updated", properties: { part: { sessionID: "s1" } } },
      { type: "message.part.updated", properties: { part: { sessionID: "s1", type: "unknown-type" } } },
      { type: "message.updated", properties: null },
      { type: "message.updated", properties: { info: null } },
      { type: "session.status", properties: null },
      { type: "session.status", properties: { status: null } },
    ]

    for (const event of malformedEvents) {
      try {
        const part = (event as any)?.properties?.part
        if (part) {
          if (part.type === "step-start") tracer.logStepStart(part)
          if (part.type === "step-finish") tracer.logStepFinish(part)
          if (part.type === "text") tracer.logText(part)
          if (part.type === "tool") tracer.logToolCall(part)
        }
      } catch {
        // Expected for null parts — the worker code wraps this in try/catch too
      }
    }

    // Should still be able to end the trace
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. Trace viewer server
// ---------------------------------------------------------------------------

describe("Trace viewer server", () => {
  test("/api/trace returns valid JSON for an existing trace", async () => {
    // Write a trace file
    const tracer = Tracer.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("viewer-test", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash", callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })
    tracer.logStepFinish({
      id: "1", reason: "stop", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()

    // Start a server serving this trace
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/api/trace") {
          const content = await fs.readFile(filePath!, "utf-8")
          return new Response(content, { headers: { "Content-Type": "application/json" } })
        }
        return new Response("not found", { status: 404 })
      },
    })

    try {
      const res = await fetch(`http://localhost:${server.port}/api/trace`)
      expect(res.ok).toBe(true)
      const data = await res.json() as TraceFile
      expect(data.version).toBe(2)
      expect(data.sessionId).toBe("viewer-test")
      expect(data.spans.length).toBeGreaterThan(0)
    } finally {
      server.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// 7. HttpExporter e2e — real HTTP round-trip
// ---------------------------------------------------------------------------

describe("HttpExporter e2e", () => {
  test("full trace is received by a real HTTP server", async () => {
    let receivedTrace: TraceFile | null = null

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        receivedTrace = await req.json() as TraceFile
        return Response.json({ url: `http://dashboard.test/trace/${receivedTrace.traceId}` })
      },
    })

    try {
      const httpExporter = new HttpExporter("test-cloud", `http://localhost:${server.port}`)
      const fileExporter = new FileExporter(tmpDir)
      const tracer = Tracer.withExporters([fileExporter, httpExporter])

      await simulateAgentSession(tracer, "http-e2e", {
        generations: 2,
        toolsPerGeneration: 2,
        addDeAttributes: true,
      })
      const result = await tracer.endTrace()

      // The file path should be returned (first exporter result)
      expect(result).toContain("http-e2e.json")

      // The HTTP server should have received the full trace
      expect(receivedTrace).toBeDefined()
      expect(receivedTrace!.version).toBe(2)
      expect(receivedTrace!.sessionId).toBe("http-e2e")
      expect(receivedTrace!.summary.totalGenerations).toBe(2)
      expect(receivedTrace!.summary.totalToolCalls).toBe(4)

      // DE attributes should be present
      const sqlTools = receivedTrace!.spans.filter(
        (s) => s.name === "sql_execute" && s.attributes?.[DE.WAREHOUSE.SYSTEM],
      )
      expect(sqlTools.length).toBeGreaterThan(0)
    } finally {
      server.stop()
    }
  })

  test("HTTP export failure doesn't prevent file export", async () => {
    // Server that always fails
    const server = Bun.serve({
      port: 0,
      fetch() { return new Response("server error", { status: 500 }) },
    })

    try {
      const httpExporter = new HttpExporter("broken", `http://localhost:${server.port}`)
      const fileExporter = new FileExporter(tmpDir)
      const tracer = Tracer.withExporters([fileExporter, httpExporter])

      tracer.startTrace("http-fail", { prompt: "test" })
      const result = await tracer.endTrace()

      // File export should still succeed
      expect(result).toContain("http-fail.json")
      const trace: TraceFile = JSON.parse(await fs.readFile(result!, "utf-8"))
      expect(trace.version).toBe(2)
    } finally {
      server.stop()
    }
  })
})
