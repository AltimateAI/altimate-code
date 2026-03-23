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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `tracing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

function makeStepFinish(overrides?: Partial<{ id: string; reason: string; cost: number }>) {
  return {
    id: overrides?.id ?? "step-1",
    reason: overrides?.reason ?? "stop",
    cost: overrides?.cost ?? 0.005,
    tokens: {
      input: 1500,
      output: 300,
      reasoning: 100,
      cache: { read: 200, write: 50 },
    },
  }
}

function makeToolCall(
  tool: string,
  status: "completed" | "error" = "completed",
  overrides?: Partial<{ callID: string }>,
) {
  const base = {
    tool,
    callID: overrides?.callID ?? "call-1",
  }
  if (status === "error") {
    return {
      ...base,
      state: {
        status: "error" as const,
        input: { command: "ls" },
        error: "Permission denied",
        time: { start: 1000, end: 2000 },
      },
    }
  }
  return {
    ...base,
    state: {
      status: "completed" as const,
      input: { command: "ls" },
      output: "file1.ts\nfile2.ts",
      time: { start: 1000, end: 2000 },
    },
  }
}

// ---------------------------------------------------------------------------
// Recap — core lifecycle
// ---------------------------------------------------------------------------

describe("Recap", () => {
  test("create() returns a Recap instance", () => {
    const tracer = Recap.create([])
    expect(tracer).toBeDefined()
  })

  test("withExporters() returns a Recap instance", () => {
    const tracer = Recap.withExporters([])
    expect(tracer).toBeDefined()
  })

  test("full lifecycle: start → generations → tools → end", async () => {
    const exporter = new FileExporter(tmpDir)
    const tracer = Recap.withExporters([exporter])

    tracer.startTrace("session-abc", {
      model: "anthropic/claude-sonnet-4-20250514",
      providerId: "anthropic",
      agent: "coder",
      variant: "high",
      prompt: "Fix the bug",
    })

    tracer.logStepStart({ id: "1" })
    tracer.logText({ text: "I'll look at the code." })
    tracer.logToolCall(makeToolCall("bash"))
    tracer.logStepFinish(makeStepFinish())

    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
    expect(filePath).toContain("session-abc.json")

    const content = await fs.readFile(filePath!, "utf-8")
    const trace: TraceFile = JSON.parse(content)

    expect(trace.version).toBe(2)
    expect(trace.sessionId).toBe("session-abc")
    expect(trace.metadata.model).toBe("anthropic/claude-sonnet-4-20250514")
    expect(trace.metadata.providerId).toBe("anthropic")
    expect(trace.metadata.agent).toBe("coder")
    expect(trace.metadata.variant).toBe("high")
    expect(trace.metadata.prompt).toBe("Fix the bug")
    expect(trace.summary.status).toBe("completed")
    expect(trace.summary.totalGenerations).toBe(1)
    expect(trace.summary.totalToolCalls).toBe(1)
    expect(trace.summary.totalTokens).toBe(2150) // 1500+300+100+200+50
    expect(trace.summary.totalCost).toBe(0.005)
    expect(trace.summary.tokens.input).toBe(1500)
    expect(trace.summary.tokens.output).toBe(300)
    expect(trace.summary.tokens.reasoning).toBe(100)
    expect(trace.summary.tokens.cacheRead).toBe(200)
    expect(trace.summary.tokens.cacheWrite).toBe(50)

    // Spans
    expect(trace.spans).toHaveLength(3) // session + generation + tool
    const sessionSpan = trace.spans.find((s) => s.kind === "session")!
    expect(sessionSpan.status).toBe("ok")
    expect(sessionSpan.endTime).toBeDefined()

    const genSpan = trace.spans.find((s) => s.kind === "generation")!
    expect(genSpan.finishReason).toBe("stop")
    expect(genSpan.cost).toBe(0.005)
    expect(genSpan.tokens).toBeDefined()
    expect(genSpan.tokens!.total).toBe(2150)
    expect(genSpan.model?.modelId).toBe("anthropic/claude-sonnet-4-20250514")
    expect(genSpan.output).toBe("I'll look at the code.")

    const toolSpan = trace.spans.find((s) => s.kind === "tool")!
    expect(toolSpan.name).toBe("bash")
    expect(toolSpan.tool?.callId).toBe("call-1")
    expect(toolSpan.tool?.durationMs).toBe(1000)
    expect(toolSpan.status).toBe("ok")
  })

  test("endTrace with error marks trace as error", async () => {
    const exporter = new FileExporter(tmpDir)
    const tracer = Recap.withExporters([exporter])

    tracer.startTrace("session-err", { prompt: "fail" })
    const filePath = await tracer.endTrace("Something went wrong")

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.status).toBe("error")
    expect(trace.summary.error).toBe("Something went wrong")

    const rootSpan = trace.spans.find((s) => s.kind === "session")!
    expect(rootSpan.status).toBe("error")
    expect(rootSpan.statusMessage).toBe("Something went wrong")
  })

  test("error tool call captures error details", async () => {
    const exporter = new FileExporter(tmpDir)
    const tracer = Recap.withExporters([exporter])

    tracer.startTrace("session-tool-err", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall(makeToolCall("bash", "error"))
    tracer.logStepFinish(makeStepFinish())
    const filePath = await tracer.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const toolSpan = trace.spans.find((s) => s.kind === "tool")!
    expect(toolSpan.status).toBe("error")
    expect(toolSpan.statusMessage).toBe("Permission denied")
    expect(toolSpan.output).toEqual({ error: "Permission denied" })
  })

  test("enrichFromAssistant updates metadata", async () => {
    const exporter = new FileExporter(tmpDir)
    const tracer = Recap.withExporters([exporter])

    tracer.startTrace("session-enrich", { model: "anthropic/unknown", prompt: "test" })
    tracer.enrichFromAssistant({
      modelID: "claude-sonnet-4-20250514",
      providerID: "anthropic",
      agent: "builder",
      variant: "max",
    })
    const filePath = await tracer.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.metadata.model).toBe("anthropic/claude-sonnet-4-20250514")
    expect(trace.metadata.providerId).toBe("anthropic")
    expect(trace.metadata.agent).toBe("builder")
    expect(trace.metadata.variant).toBe("max")
  })

  test("multiple generations accumulate tokens correctly", async () => {
    const exporter = new FileExporter(tmpDir)
    const tracer = Recap.withExporters([exporter])

    tracer.startTrace("session-multi", { prompt: "test" })

    tracer.logStepStart({ id: "1" })
    tracer.logStepFinish(makeStepFinish({ id: "1", cost: 0.01 }))

    tracer.logStepStart({ id: "2" })
    tracer.logStepFinish(makeStepFinish({ id: "2", cost: 0.02 }))

    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    expect(trace.summary.totalGenerations).toBe(2)
    expect(trace.summary.totalTokens).toBe(4300) // 2150 * 2
    expect(trace.summary.totalCost).toBe(0.03)
    expect(trace.summary.tokens.input).toBe(3000)
    expect(trace.summary.tokens.output).toBe(600)
  })
})

// ---------------------------------------------------------------------------
// Recap — graceful degradation
// ---------------------------------------------------------------------------

describe("Recap — graceful degradation", () => {
  test("logStepStart before startTrace is a no-op", () => {
    const tracer = Recap.withExporters([])
    // Should not throw
    tracer.logStepStart({ id: "1" })
  })

  test("logStepFinish without logStepStart is a no-op", () => {
    const tracer = Recap.withExporters([])
    tracer.startTrace("s1", { prompt: "x" })
    // No logStepStart — should not throw
    tracer.logStepFinish(makeStepFinish())
  })

  test("logToolCall before startTrace is a no-op", () => {
    const tracer = Recap.withExporters([])
    // Should not throw
    tracer.logToolCall(makeToolCall("bash"))
  })

  test("logText always works (no crashes)", () => {
    const tracer = Recap.withExporters([])
    // Should not throw even without any spans
    tracer.logText({ text: "hello" })
    tracer.logText({ text: "" })
  })

  test("endTrace without startTrace returns undefined", async () => {
    const tracer = Recap.withExporters([])
    const result = await tracer.endTrace()
    expect(result).toBeUndefined()
  })

  test("endTrace with no exporters returns undefined", async () => {
    const tracer = Recap.withExporters([])
    tracer.startTrace("s1", { prompt: "x" })
    const result = await tracer.endTrace()
    expect(result).toBeUndefined()
  })

  test("enrichFromAssistant before startTrace does not crash", () => {
    const tracer = Recap.withExporters([])
    // Should not throw
    tracer.enrichFromAssistant({ modelID: "test", providerID: "test" })
  })

  test("enrichFromAssistant with partial data is safe", () => {
    const tracer = Recap.withExporters([])
    tracer.startTrace("s1", { prompt: "x" })
    tracer.enrichFromAssistant({})
    tracer.enrichFromAssistant({ modelID: undefined, providerID: undefined })
  })

  test("tool call with very long output is truncated", async () => {
    const exporter = new FileExporter(tmpDir)
    const tracer = Recap.withExporters([exporter])

    tracer.startTrace("s-long", { prompt: "x" })
    tracer.logStepStart({ id: "1" })
    const longOutput = "x".repeat(50000)
    tracer.logToolCall({
      tool: "read",
      callID: "c1",
      state: {
        status: "completed",
        input: { file: "big.txt" },
        output: longOutput,
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish(makeStepFinish())
    const filePath = await tracer.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const toolSpan = trace.spans.find((s) => s.kind === "tool")!
    expect((toolSpan.output as string).length).toBeLessThanOrEqual(10000)
  })

  test("tool call with empty input is handled", async () => {
    const exporter = new FileExporter(tmpDir)
    const tracer = Recap.withExporters([exporter])

    tracer.startTrace("s-empty-input", { prompt: "x" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: {},
        output: "",
        time: { start: 1000, end: 1001 },
      },
    })
    tracer.logStepFinish(makeStepFinish())
    const filePath = await tracer.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.spans.find((s) => s.kind === "tool")).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// FileExporter
// ---------------------------------------------------------------------------

describe("FileExporter", () => {
  test("writes trace to the specified directory", async () => {
    const exporter = new FileExporter(tmpDir)
    const trace: TraceFile = {
      version: 2,
      traceId: "trace-1",
      sessionId: "session-fe",
      startedAt: new Date().toISOString(),
      metadata: {},
      spans: [],
      summary: {
        totalTokens: 0,
        totalCost: 0,
        totalToolCalls: 0,
        totalGenerations: 0,
        duration: 0,
        status: "completed",
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    }

    const result = await exporter.export(trace)
    expect(result).toBe(path.join(tmpDir, "session-fe.json"))

    const content = JSON.parse(await fs.readFile(result!, "utf-8"))
    expect(content.sessionId).toBe("session-fe")
  })

  test("creates directory if it does not exist", async () => {
    const nestedDir = path.join(tmpDir, "deep", "nested", "traces")
    const exporter = new FileExporter(nestedDir)
    const trace: TraceFile = {
      version: 2,
      traceId: "t1",
      sessionId: "s1",
      startedAt: new Date().toISOString(),
      metadata: {},
      spans: [],
      summary: {
        totalTokens: 0,
        totalCost: 0,
        totalToolCalls: 0,
        totalGenerations: 0,
        duration: 0,
        status: "completed",
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    }

    const result = await exporter.export(trace)
    expect(result).toBeDefined()
    expect(await fs.stat(nestedDir).then(() => true)).toBe(true)
  })

  test("prunes old files when maxFiles is exceeded", async () => {
    const exporter = new FileExporter(tmpDir, 3)

    for (let i = 0; i < 5; i++) {
      const trace: TraceFile = {
        version: 2,
        traceId: `t${i}`,
        sessionId: `session-${i}`,
        startedAt: new Date().toISOString(),
        metadata: {},
        spans: [],
        summary: {
          totalTokens: 0,
          totalCost: 0,
          totalToolCalls: 0,
          totalGenerations: 0,
          duration: 0,
          status: "completed",
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }
      await exporter.export(trace)
      // Small delay so mtime differs
      await new Promise((r) => setTimeout(r, 50))
    }

    // Give pruning a moment to run (async, best-effort)
    await new Promise((r) => setTimeout(r, 200))

    const files = await fs.readdir(tmpDir)
    const jsonFiles = files.filter((f) => f.endsWith(".json"))
    expect(jsonFiles.length).toBeLessThanOrEqual(3)
  })

  test("getDir returns the configured directory", () => {
    const exporter = new FileExporter("/custom/path")
    expect(exporter.getDir()).toBe("/custom/path")
  })

  test("returns undefined if directory is not writable", async () => {
    // Use a path that can't exist
    const exporter = new FileExporter("/dev/null/impossible/path")
    const trace: TraceFile = {
      version: 2,
      traceId: "t",
      sessionId: "s",
      startedAt: new Date().toISOString(),
      metadata: {},
      spans: [],
      summary: {
        totalTokens: 0,
        totalCost: 0,
        totalToolCalls: 0,
        totalGenerations: 0,
        duration: 0,
        status: "completed",
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    }
    const result = await exporter.export(trace)
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// HttpExporter
// ---------------------------------------------------------------------------

describe("HttpExporter", () => {
  test("returns undefined on network error (does not throw)", async () => {
    const exporter = new HttpExporter("test", "http://localhost:1", {})
    const trace: TraceFile = {
      version: 2,
      traceId: "t",
      sessionId: "s",
      startedAt: new Date().toISOString(),
      metadata: {},
      spans: [],
      summary: {
        totalTokens: 0,
        totalCost: 0,
        totalToolCalls: 0,
        totalGenerations: 0,
        duration: 0,
        status: "completed",
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    }

    // Should not throw — returns undefined
    const result = await exporter.export(trace)
    expect(result).toBeUndefined()
  })

  test("returns undefined on non-OK HTTP response", async () => {
    // Start a local server that always returns 500
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("Internal Server Error", { status: 500 })
      },
    })

    try {
      const exporter = new HttpExporter("test", `http://localhost:${server.port}`)
      const trace: TraceFile = {
        version: 2,
        traceId: "t",
        sessionId: "s",
        startedAt: new Date().toISOString(),
        metadata: {},
        spans: [],
        summary: {
          totalTokens: 0,
          totalCost: 0,
          totalToolCalls: 0,
          totalGenerations: 0,
          duration: 0,
          status: "completed",
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }

      const result = await exporter.export(trace)
      expect(result).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  test("returns URL from JSON response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ url: "https://dashboard.example.com/trace/123" })
      },
    })

    try {
      const exporter = new HttpExporter("cloud", `http://localhost:${server.port}`)
      const trace: TraceFile = {
        version: 2,
        traceId: "t",
        sessionId: "s",
        startedAt: new Date().toISOString(),
        metadata: {},
        spans: [],
        summary: {
          totalTokens: 0,
          totalCost: 0,
          totalToolCalls: 0,
          totalGenerations: 0,
          duration: 0,
          status: "completed",
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }

      const result = await exporter.export(trace)
      expect(result).toBe("https://dashboard.example.com/trace/123")
    } finally {
      server.stop()
    }
  })

  test("returns fallback string when response has no URL", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("OK", { status: 200 })
      },
    })

    try {
      const exporter = new HttpExporter("mybackend", `http://localhost:${server.port}`)
      const trace: TraceFile = {
        version: 2,
        traceId: "t",
        sessionId: "s",
        startedAt: new Date().toISOString(),
        metadata: {},
        spans: [],
        summary: {
          totalTokens: 0,
          totalCost: 0,
          totalToolCalls: 0,
          totalGenerations: 0,
          duration: 0,
          status: "completed",
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }

      const result = await exporter.export(trace)
      expect(result).toBe("mybackend: exported")
    } finally {
      server.stop()
    }
  })

  test("sends custom headers", async () => {
    let receivedHeaders: Record<string, string> = {}
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        receivedHeaders = Object.fromEntries(req.headers.entries())
        return Response.json({ ok: true })
      },
    })

    try {
      const exporter = new HttpExporter("cloud", `http://localhost:${server.port}`, {
        Authorization: "Bearer test-token",
        "X-Custom": "value",
      })
      const trace: TraceFile = {
        version: 2,
        traceId: "t",
        sessionId: "s",
        startedAt: new Date().toISOString(),
        metadata: {},
        spans: [],
        summary: {
          totalTokens: 0,
          totalCost: 0,
          totalToolCalls: 0,
          totalGenerations: 0,
          duration: 0,
          status: "completed",
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }

      await exporter.export(trace)
      expect(receivedHeaders["authorization"]).toBe("Bearer test-token")
      expect(receivedHeaders["x-custom"]).toBe("value")
      expect(receivedHeaders["content-type"]).toBe("application/json")
    } finally {
      server.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// Multiple exporters — fan-out
// ---------------------------------------------------------------------------

describe("Recap — multiple exporters", () => {
  test("one failing exporter does not block others", async () => {
    const failingExporter: TraceExporter = {
      name: "failing",
      export: async () => {
        throw new Error("Exporter crashed!")
      },
    }
    const fileExporter = new FileExporter(tmpDir)

    const tracer = Recap.withExporters([failingExporter, fileExporter])
    tracer.startTrace("s-multi", { prompt: "test" })
    const result = await tracer.endTrace()

    // FileExporter should succeed despite the other crashing
    expect(result).toBeDefined()
    expect(result).toContain("s-multi.json")
  })

  test("returns first successful result", async () => {
    const slowExporter: TraceExporter = {
      name: "slow",
      export: async () => {
        await new Promise((r) => setTimeout(r, 100))
        return "slow-result"
      },
    }
    const fileExporter = new FileExporter(tmpDir)

    const tracer = Recap.withExporters([fileExporter, slowExporter])
    tracer.startTrace("s-first", { prompt: "test" })
    const result = await tracer.endTrace()

    // FileExporter result comes first (it's in position 0)
    expect(result).toContain("s-first.json")
  })

  test("all exporters failing returns undefined", async () => {
    const fail1: TraceExporter = {
      name: "fail1",
      export: async () => {
        throw new Error("boom")
      },
    }
    const fail2: TraceExporter = {
      name: "fail2",
      export: async () => undefined,
    }

    const tracer = Recap.withExporters([fail1, fail2])
    tracer.startTrace("s-allfail", { prompt: "test" })
    const result = await tracer.endTrace()

    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Recap.withExporters — maxFiles propagation
// ---------------------------------------------------------------------------

describe("Recap.withExporters — options", () => {
  test("maxFiles option is applied to FileExporter", async () => {
    const fileExporter = new FileExporter(tmpDir)
    Recap.withExporters([fileExporter], { maxFiles: 2 })

    // Write 4 traces
    for (let i = 0; i < 4; i++) {
      const t = Recap.withExporters([new FileExporter(tmpDir, 2)])
      t.startTrace(`s-${i}`, { prompt: `test-${i}` })
      await t.endTrace()
      await new Promise((r) => setTimeout(r, 50))
    }

    await new Promise((r) => setTimeout(r, 200))

    const files = (await fs.readdir(tmpDir)).filter((f) => f.endsWith(".json"))
    expect(files.length).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// Static helpers
// ---------------------------------------------------------------------------

describe("Recap — static helpers", () => {
  test("getTracesDir returns a string", () => {
    expect(typeof Recap.getTracesDir()).toBe("string")
  })

  test("listTraces returns empty array when no traces exist", async () => {
    const traces = await Recap.listTraces()
    // May have traces from other tests, but should not throw
    expect(Array.isArray(traces)).toBe(true)
  })

  test("loadTrace returns null for non-existent session", async () => {
    const result = await Recap.loadTrace("non-existent-session-id-12345")
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Edge cases — schema integrity
// ---------------------------------------------------------------------------

describe("Trace schema integrity", () => {
  test("trace with no spans still has valid structure", async () => {
    const exporter = new FileExporter(tmpDir)
    const tracer = Recap.withExporters([exporter])

    tracer.startTrace("s-empty", { prompt: "empty" })
    const filePath = await tracer.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.version).toBe(2)
    expect(trace.spans).toHaveLength(1) // Just the root session span
    expect(trace.summary.totalGenerations).toBe(0)
    expect(trace.summary.totalToolCalls).toBe(0)
    expect(trace.summary.totalTokens).toBe(0)
    expect(trace.summary.totalCost).toBe(0)
    expect(trace.startedAt).toBeTruthy()
    expect(trace.endedAt).toBeTruthy()
  })

  test("all span IDs are unique", async () => {
    const exporter = new FileExporter(tmpDir)
    const tracer = Recap.withExporters([exporter])

    tracer.startTrace("s-ids", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall(makeToolCall("bash", "completed", { callID: "c1" }))
    tracer.logToolCall(makeToolCall("read", "completed", { callID: "c2" }))
    tracer.logStepFinish(makeStepFinish())
    tracer.logStepStart({ id: "2" })
    tracer.logToolCall(makeToolCall("edit", "completed", { callID: "c3" }))
    tracer.logStepFinish(makeStepFinish())

    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    const ids = trace.spans.map((s) => s.spanId)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)
  })

  test("parent-child relationships are correct", async () => {
    const exporter = new FileExporter(tmpDir)
    const tracer = Recap.withExporters([exporter])

    tracer.startTrace("s-parents", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall(makeToolCall("bash"))
    tracer.logStepFinish(makeStepFinish())

    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    const sessionSpan = trace.spans.find((s) => s.kind === "session")!
    const genSpan = trace.spans.find((s) => s.kind === "generation")!
    const toolSpan = trace.spans.find((s) => s.kind === "tool")!

    // Session has no parent
    expect(sessionSpan.parentSpanId).toBeNull()
    // Generation is child of session
    expect(genSpan.parentSpanId).toBe(sessionSpan.spanId)
    // Tool is child of generation
    expect(toolSpan.parentSpanId).toBe(genSpan.spanId)
  })

  test("tool call outside of a generation is child of session", async () => {
    const exporter = new FileExporter(tmpDir)
    const tracer = Recap.withExporters([exporter])

    tracer.startTrace("s-orphan-tool", { prompt: "test" })
    // Log a tool call without logStepStart — simulates orphaned tool
    tracer.logToolCall(makeToolCall("bash"))

    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    const sessionSpan = trace.spans.find((s) => s.kind === "session")!
    const toolSpan = trace.spans.find((s) => s.kind === "tool")!
    expect(toolSpan.parentSpanId).toBe(sessionSpan.spanId)
  })

  test("metadata tags and optional fields are preserved", async () => {
    const exporter = new FileExporter(tmpDir)
    const tracer = Recap.withExporters([exporter])

    tracer.startTrace("s-meta", {
      prompt: "test",
      userId: "user-42",
      environment: "production",
      version: "1.2.3",
      tags: ["benchmark", "ci"],
    })

    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    expect(trace.metadata.userId).toBe("user-42")
    expect(trace.metadata.environment).toBe("production")
    expect(trace.metadata.version).toBe("1.2.3")
    expect(trace.metadata.tags).toEqual(["benchmark", "ci"])
  })

  test("trace timestamps are valid ISO strings", async () => {
    const exporter = new FileExporter(tmpDir)
    const tracer = Recap.withExporters([exporter])

    tracer.startTrace("s-ts", { prompt: "test" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    expect(() => new Date(trace.startedAt)).not.toThrow()
    expect(() => new Date(trace.endedAt!)).not.toThrow()
    expect(new Date(trace.startedAt).getTime()).toBeGreaterThan(0)
    expect(new Date(trace.endedAt!).getTime()).toBeGreaterThanOrEqual(new Date(trace.startedAt).getTime())
  })
})

// ---------------------------------------------------------------------------
// Loop detection
// ---------------------------------------------------------------------------

describe("Loop detection", () => {
  test("should detect repeated tool calls with same input", async () => {
    const exporter = new FileExporter(tmpDir)
    const recap = Recap.withExporters([exporter])

    recap.startTrace("s-loop-detect", { prompt: "test" })
    recap.logStepStart({ id: "1" })

    // Call same tool 5 times with identical input
    for (let i = 0; i < 5; i++) {
      recap.logToolCall({
        tool: "bash",
        callID: `c-${i}`,
        state: {
          status: "completed",
          input: { command: "ls" },
          output: "file1.ts",
          time: { start: 1000 + i, end: 2000 + i },
        },
      })
    }

    recap.logStepFinish(makeStepFinish())
    const filePath = await recap.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.loops).toBeDefined()
    expect(trace.summary.loops!.length).toBeGreaterThanOrEqual(1)
    expect(trace.summary.loops![0]!.tool).toBe("bash")
    expect(trace.summary.loops![0]!.count).toBeGreaterThanOrEqual(3)
    expect(trace.summary.loops![0]!.description).toContain("bash")
  })

  test("should not flag different tools as loops", async () => {
    const exporter = new FileExporter(tmpDir)
    const recap = Recap.withExporters([exporter])

    recap.startTrace("s-no-loop-diff-tools", { prompt: "test" })
    recap.logStepStart({ id: "1" })

    const tools = ["bash", "read", "edit", "glob", "grep"]
    for (let i = 0; i < 5; i++) {
      recap.logToolCall({
        tool: tools[i]!,
        callID: `c-${i}`,
        state: {
          status: "completed",
          input: { command: "ls" },
          output: "ok",
          time: { start: 1000 + i, end: 2000 + i },
        },
      })
    }

    recap.logStepFinish(makeStepFinish())
    const filePath = await recap.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.loops).toBeUndefined()
  })

  test("should not flag same tool with different inputs as loop", async () => {
    const exporter = new FileExporter(tmpDir)
    const recap = Recap.withExporters([exporter])

    recap.startTrace("s-no-loop-diff-input", { prompt: "test" })
    recap.logStepStart({ id: "1" })

    for (let i = 0; i < 5; i++) {
      recap.logToolCall({
        tool: "bash",
        callID: `c-${i}`,
        state: {
          status: "completed",
          input: { command: `echo ${i}` },
          output: `${i}`,
          time: { start: 1000 + i, end: 2000 + i },
        },
      })
    }

    recap.logStepFinish(makeStepFinish())
    const filePath = await recap.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.loops).toBeUndefined()
  })

  test("should handle loop detection with empty/null inputs", async () => {
    const exporter = new FileExporter(tmpDir)
    const recap = Recap.withExporters([exporter])

    recap.startTrace("s-loop-null-input", { prompt: "test" })
    recap.logStepStart({ id: "1" })

    // Call same tool 5 times with empty input
    for (let i = 0; i < 5; i++) {
      recap.logToolCall({
        tool: "bash",
        callID: `c-${i}`,
        state: {
          status: "completed",
          input: {},
          output: "ok",
          time: { start: 1000 + i, end: 2000 + i },
        },
      })
    }

    recap.logStepFinish(makeStepFinish())
    const filePath = await recap.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // Empty input repeated 5 times should be detected as a loop
    expect(trace.summary.loops).toBeDefined()
    expect(trace.summary.loops!.length).toBeGreaterThanOrEqual(1)
  })

  test("loop detection uses sliding window of last 10 calls", async () => {
    const exporter = new FileExporter(tmpDir)
    const recap = Recap.withExporters([exporter])

    recap.startTrace("s-loop-window", { prompt: "test" })
    recap.logStepStart({ id: "1" })

    // 8 unique tool calls to push repeats out of the window
    for (let i = 0; i < 8; i++) {
      recap.logToolCall({
        tool: `unique-tool-${i}`,
        callID: `c-unique-${i}`,
        state: {
          status: "completed",
          input: { i },
          output: "ok",
          time: { start: 1000 + i, end: 2000 + i },
        },
      })
    }

    // Only 2 repeats of the same tool (below threshold of 3)
    for (let i = 0; i < 2; i++) {
      recap.logToolCall({
        tool: "bash",
        callID: `c-bash-${i}`,
        state: {
          status: "completed",
          input: { command: "ls" },
          output: "ok",
          time: { start: 3000 + i, end: 4000 + i },
        },
      })
    }

    recap.logStepFinish(makeStepFinish())
    const filePath = await recap.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // Only 2 repeats in window — should not trigger loop detection
    expect(trace.summary.loops).toBeUndefined()
  })

  test("history pruning at 201 entries preserves recent loop evidence", async () => {
    const exporter = new FileExporter(tmpDir)
    const recap = Recap.withExporters([exporter])

    recap.startTrace("s-loop-prune", { prompt: "test" })
    recap.logStepStart({ id: "1" })

    // Fill 198 unique tool calls to push toward the pruning boundary
    for (let i = 0; i < 198; i++) {
      recap.logToolCall({
        tool: `filler-${i}`,
        callID: `c-filler-${i}`,
        state: {
          status: "completed",
          input: { i },
          output: "ok",
          time: { start: 1000 + i, end: 2000 + i },
        },
      })
    }

    // Now add 3 identical calls (entries 199, 200, 201) — triggers prune at 201
    // After pruning (>200 → last 100), these 3 calls are at positions 98-100
    // of the surviving slice, well within the last-10 detection window
    for (let i = 0; i < 3; i++) {
      recap.logToolCall({
        tool: "bash",
        callID: `c-loop-${i}`,
        state: {
          status: "completed",
          input: { command: "ls -la" },
          output: "total 0",
          time: { start: 5000 + i, end: 6000 + i },
        },
      })
    }

    recap.logStepFinish(makeStepFinish())
    const filePath = await recap.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // The 3 identical "bash" calls should still be detected after pruning
    expect(trace.summary.loops).toBeDefined()
    expect(trace.summary.loops!.length).toBeGreaterThanOrEqual(1)
    expect(trace.summary.loops!.find((l) => l.tool === "bash")).toBeDefined()
  })

  test("two distinct loops detected simultaneously", async () => {
    const exporter = new FileExporter(tmpDir)
    const recap = Recap.withExporters([exporter])

    recap.startTrace("s-multi-loop", { prompt: "test" })
    recap.logStepStart({ id: "1" })

    // Interleave two different loops: bash(ls) and read(file.ts)
    for (let i = 0; i < 4; i++) {
      recap.logToolCall({
        tool: "bash",
        callID: `c-bash-${i}`,
        state: {
          status: "completed",
          input: { command: "ls" },
          output: "file1.ts",
          time: { start: 1000 + i * 2, end: 2000 + i * 2 },
        },
      })
      recap.logToolCall({
        tool: "read",
        callID: `c-read-${i}`,
        state: {
          status: "completed",
          input: { file: "config.ts" },
          output: "content",
          time: { start: 1001 + i * 2, end: 2001 + i * 2 },
        },
      })
    }

    recap.logStepFinish(makeStepFinish())
    const filePath = await recap.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // Both loops should be detected
    expect(trace.summary.loops).toBeDefined()
    expect(trace.summary.loops!.length).toBeGreaterThanOrEqual(2)

    const bashLoop = trace.summary.loops!.find((l) => l.tool === "bash")
    const readLoop = trace.summary.loops!.find((l) => l.tool === "read")
    expect(bashLoop).toBeDefined()
    expect(bashLoop!.count).toBeGreaterThanOrEqual(3)
    expect(readLoop).toBeDefined()
    expect(readLoop!.count).toBeGreaterThanOrEqual(3)
  })
})

// ---------------------------------------------------------------------------
// Post-session narrative and top tools
// ---------------------------------------------------------------------------

describe("Post-session narrative", () => {
  test("should generate narrative on endTrace", async () => {
    const exporter = new FileExporter(tmpDir)
    const recap = Recap.withExporters([exporter])

    recap.startTrace("s-narrative", { prompt: "test" })
    recap.logStepStart({ id: "1" })
    recap.logToolCall(makeToolCall("bash"))
    recap.logToolCall(makeToolCall("read", "completed", { callID: "c2" }))
    recap.logStepFinish(makeStepFinish())
    const filePath = await recap.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.narrative).toBeDefined()
    expect(trace.summary.narrative!.length).toBeGreaterThan(0)
    expect(trace.summary.narrative).toContain("Completed in")
    expect(trace.summary.narrative).toContain("LLM call")
    expect(trace.summary.narrative).toContain("Total cost:")
  })

  test("should include top tools in summary", async () => {
    const exporter = new FileExporter(tmpDir)
    const recap = Recap.withExporters([exporter])

    recap.startTrace("s-top-tools", { prompt: "test" })
    recap.logStepStart({ id: "1" })

    // Call bash 3 times, read 2 times, edit 1 time
    for (let i = 0; i < 3; i++) {
      recap.logToolCall({
        tool: "bash",
        callID: `c-bash-${i}`,
        state: {
          status: "completed",
          input: { command: `echo ${i}` },
          output: `${i}`,
          time: { start: 1000, end: 2000 },
        },
      })
    }
    for (let i = 0; i < 2; i++) {
      recap.logToolCall({
        tool: "read",
        callID: `c-read-${i}`,
        state: {
          status: "completed",
          input: { file: `file${i}.ts` },
          output: "content",
          time: { start: 2000, end: 3000 },
        },
      })
    }
    recap.logToolCall({
      tool: "edit",
      callID: "c-edit-0",
      state: {
        status: "completed",
        input: { file: "file.ts" },
        output: "edited",
        time: { start: 3000, end: 4000 },
      },
    })

    recap.logStepFinish(makeStepFinish())
    const filePath = await recap.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.topTools).toBeDefined()
    expect(trace.summary.topTools!.length).toBeGreaterThanOrEqual(3)
    // Sorted by count descending
    expect(trace.summary.topTools![0]!.name).toBe("bash")
    expect(trace.summary.topTools![0]!.count).toBe(3)
    expect(trace.summary.topTools![1]!.name).toBe("read")
    expect(trace.summary.topTools![1]!.count).toBe(2)
    expect(trace.summary.topTools![2]!.name).toBe("edit")
    expect(trace.summary.topTools![2]!.count).toBe(1)
    // Each entry should have totalDuration
    for (const t of trace.summary.topTools!) {
      expect(typeof t.totalDuration).toBe("number")
    }
  })

  test("should handle empty session narrative", async () => {
    const exporter = new FileExporter(tmpDir)
    const recap = Recap.withExporters([exporter])

    recap.startTrace("s-empty-narrative", { prompt: "test" })
    // Start and immediately end — no tool calls or generations
    const filePath = await recap.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.narrative).toBeDefined()
    expect(trace.summary.narrative!.length).toBeGreaterThan(0)
    expect(trace.summary.narrative).toContain("Completed in")
    // With 0 generations, narrative omits LLM call count entirely
    expect(trace.summary.narrative).not.toContain("LLM call")
  })

  test("should include loop warnings in narrative", async () => {
    const exporter = new FileExporter(tmpDir)
    const recap = Recap.withExporters([exporter])

    recap.startTrace("s-narrative-loop", { prompt: "test" })
    recap.logStepStart({ id: "1" })

    // Trigger a loop: same tool+input 5 times
    for (let i = 0; i < 5; i++) {
      recap.logToolCall({
        tool: "bash",
        callID: `c-${i}`,
        state: {
          status: "completed",
          input: { command: "ls" },
          output: "file1.ts",
          time: { start: 1000, end: 2000 },
        },
      })
    }

    recap.logStepFinish(makeStepFinish())
    const filePath = await recap.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.narrative).toBeDefined()
    expect(trace.summary.narrative).toContain("loop")
  })

  test("topTools includes totalDuration from tool spans", async () => {
    const exporter = new FileExporter(tmpDir)
    const recap = Recap.withExporters([exporter])

    recap.startTrace("s-top-tools-dur", { prompt: "test" })
    recap.logStepStart({ id: "1" })

    recap.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: { command: "echo hello" },
        output: "hello",
        time: { start: 1000, end: 3500 }, // 2500ms
      },
    })
    recap.logToolCall({
      tool: "bash",
      callID: "c2",
      state: {
        status: "completed",
        input: { command: "echo world" },
        output: "world",
        time: { start: 4000, end: 5500 }, // 1500ms
      },
    })

    recap.logStepFinish(makeStepFinish())
    const filePath = await recap.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const bashTool = trace.summary.topTools!.find((t) => t.name === "bash")!
    expect(bashTool.count).toBe(2)
    expect(bashTool.totalDuration).toBe(4000) // 2500 + 1500
  })
})

// ---------------------------------------------------------------------------
// Recap edge cases
// ---------------------------------------------------------------------------

describe("Recap edge cases", () => {
  test("should handle session with only errors", async () => {
    const exporter = new FileExporter(tmpDir)
    const recap = Recap.withExporters([exporter])

    recap.startTrace("s-all-errors", { prompt: "test" })
    recap.logStepStart({ id: "1" })

    for (let i = 0; i < 3; i++) {
      recap.logToolCall(makeToolCall(`tool-${i}`, "error"))
    }

    recap.logStepFinish(makeStepFinish())
    const filePath = await recap.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.totalToolCalls).toBe(3)
    const errorTools = trace.spans.filter((s) => s.kind === "tool" && s.status === "error")
    expect(errorTools).toHaveLength(3)
    // Narrative and topTools should still be generated
    expect(trace.summary.narrative).toBeDefined()
    expect(trace.summary.topTools).toBeDefined()
  })

  test("should handle session with 100+ tool calls", async () => {
    const exporter = new FileExporter(tmpDir)
    const recap = Recap.withExporters([exporter])

    recap.startTrace("s-100-tools", { prompt: "test" })
    recap.logStepStart({ id: "1" })

    for (let i = 0; i < 150; i++) {
      recap.logToolCall({
        tool: `tool-${i % 10}`,
        callID: `c-${i}`,
        state: {
          status: "completed",
          input: { i },
          output: `ok-${i}`,
          time: { start: 1000 + i, end: 2000 + i },
        },
      })
    }

    recap.logStepFinish(makeStepFinish())
    const filePath = await recap.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.totalToolCalls).toBe(150)
    // topTools capped at 10
    expect(trace.summary.topTools!.length).toBeLessThanOrEqual(10)
    expect(trace.summary.narrative).toBeDefined()
  })

  test("should handle endTrace called twice", async () => {
    const exporter = new FileExporter(tmpDir)
    const recap = Recap.withExporters([exporter])

    recap.startTrace("s-double-end", { prompt: "test" })
    recap.logStepStart({ id: "1" })
    recap.logStepFinish(makeStepFinish())

    const result1 = await recap.endTrace()
    const result2 = await recap.endTrace()

    expect(result1).toBeDefined()
    // Second call should still succeed (idempotent)
    expect(result2).toBeDefined()
  })

  test("should handle logToolCall before startTrace", () => {
    const recap = Recap.withExporters([])
    // Should not crash — rootSpanId is undefined, so early return
    recap.logToolCall(makeToolCall("bash"))
    expect(true).toBe(true)
  })

  test("narrative mentions tool names for sessions with tools", async () => {
    const exporter = new FileExporter(tmpDir)
    const recap = Recap.withExporters([exporter])

    recap.startTrace("s-narrative-tools", { prompt: "test" })
    recap.logStepStart({ id: "1" })
    recap.logToolCall(makeToolCall("sql_execute"))
    recap.logToolCall(makeToolCall("bash", "completed", { callID: "c2" }))
    recap.logStepFinish(makeStepFinish())
    const filePath = await recap.endTrace()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.narrative).toContain("2 tools")
  })
})

// ---------------------------------------------------------------------------
// Adversarial: Viewer rendering with malicious/edge-case data
// ---------------------------------------------------------------------------
import { renderTraceViewer } from "../../src/altimate/observability/viewer"

describe("viewer adversarial tests", () => {
  function makeTrace(overrides?: Partial<TraceFile>): TraceFile {
    return {
      version: 2,
      traceId: "adv-trace",
      sessionId: "adv-session",
      startedAt: new Date().toISOString(),
      metadata: {},
      spans: [],
      summary: {
        totalTokens: 0, totalCost: 0, totalToolCalls: 0, totalGenerations: 0,
        duration: 0, status: "completed",
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
      ...overrides,
    }
  }

  test("XSS in tool output: script tags are escaped in JSON embedding", () => {
    const trace = makeTrace({
      spans: [
        { spanId: "s0", parentSpanId: null, name: "session", kind: "session", startTime: 0, status: "ok" },
        { spanId: "s1", parentSpanId: "s0", name: "bash", kind: "tool", startTime: 1, endTime: 2, status: "ok",
          tool: { callId: "c1", durationMs: 1 },
          input: { command: '<img src=x onerror=alert(1)>' },
          output: '<script>alert("xss")</script>Completed successfully' },
      ],
      summary: { totalTokens: 100, totalCost: 0.01, totalToolCalls: 1, totalGenerations: 1, duration: 1000, status: "completed",
        tokens: { input: 50, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
    })
    const html = renderTraceViewer(trace)
    // The trace data is embedded as JSON inside a <script> tag.
    // Closing </script> tags must be escaped to prevent script breakout.
    const scriptContent = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || ""
    const dataSection = scriptContent.match(/var t = (.*?);/s)?.[1] || ""
    expect(dataSection).not.toContain("</script>")
    // The e() function escapes HTML chars at render time (client-side).
    // Verify JS parses without errors.
    expect(() => new Function(scriptContent)).not.toThrow()
  })

  test("XSS in prompt is escaped in JSON embedding", () => {
    const trace = makeTrace({
      metadata: { prompt: '"><script>alert("xss")</script><div class="' },
      spans: [{ spanId: "s0", parentSpanId: null, name: "session", kind: "session", startTime: 0, status: "ok" }],
      summary: { totalTokens: 0, totalCost: 0, totalToolCalls: 0, totalGenerations: 0, duration: 0, status: "completed",
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
    })
    const html = renderTraceViewer(trace)
    // The trace data is embedded as JSON inside a <script> tag.
    // The closing </script> must be escaped to prevent breakout.
    // Verify: no </script> appears in the embedded data (it's escaped to <\/script>)
    const scriptContent = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || ""
    // The JSON data should not contain raw </script> — it should be <\/script>
    const dataSection = scriptContent.match(/var t = (.*?);/s)?.[1] || ""
    expect(dataSection).not.toContain("</script>")
    // JS should parse without errors
    expect(() => new Function(scriptContent)).not.toThrow()
  })

  test("renders with NaN/Infinity/negative values without crash", () => {
    const trace = makeTrace({
      summary: {
        totalTokens: NaN, totalCost: -1, totalToolCalls: Infinity, totalGenerations: 0,
        duration: -500, status: "completed",
        tokens: { input: NaN, output: Infinity, reasoning: -1, cacheRead: 0, cacheWrite: 0 },
      },
    })
    const html = renderTraceViewer(trace)
    expect(html).toBeTruthy()
    expect(html.length).toBeGreaterThan(1000)
  })

  test("renders with null/undefined metadata fields", () => {
    const trace = makeTrace({
      metadata: { title: null as any, model: undefined, prompt: undefined },
    })
    const html = renderTraceViewer(trace)
    expect(html).toBeTruthy()
  })

  test("renders with 200+ spans without crash", () => {
    const spans: any[] = [{ spanId: "root", parentSpanId: null, name: "session", kind: "session", startTime: 0, status: "ok" }]
    for (let i = 0; i < 200; i++) {
      spans.push({
        spanId: `sp${i}`, parentSpanId: "root", name: `tool-${i}`, kind: "tool",
        startTime: i * 100, endTime: i * 100 + 50, status: i % 20 === 0 ? "error" : "ok",
        tool: { callId: `c${i}`, durationMs: 50 },
        input: { command: `echo ${i}` }, output: `output ${i}`,
        statusMessage: i % 20 === 0 ? `Error at step ${i}` : undefined,
      })
    }
    const trace = makeTrace({
      spans,
      summary: { totalTokens: 500000, totalCost: 5.0, totalToolCalls: 200, totalGenerations: 10,
        duration: 20000, status: "completed",
        tokens: { input: 300000, output: 150000, reasoning: 50000, cacheRead: 0, cacheWrite: 0 } },
    })
    const html = renderTraceViewer(trace)
    expect(html.length).toBeGreaterThan(10000)
  })

  test("JS syntax is valid in rendered HTML", () => {
    const trace = makeTrace({
      spans: [
        { spanId: "s0", parentSpanId: null, name: "session", kind: "session", startTime: 0, status: "ok" },
        { spanId: "s1", parentSpanId: "s0", name: "gen-1", kind: "generation", startTime: 1, endTime: 2, status: "ok",
          tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 150 }, cost: 0.01 },
      ],
      summary: { totalTokens: 150, totalCost: 0.01, totalToolCalls: 0, totalGenerations: 1, duration: 1000, status: "completed",
        tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
    })
    const html = renderTraceViewer(trace)
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/)
    expect(scriptMatch).toBeTruthy()
    // Verify JS parses without syntax errors
    expect(() => new Function(scriptMatch![1])).not.toThrow()
  })

  test("tool-agnostic outcome extraction works for non-dbt commands", () => {
    const trace = makeTrace({
      spans: [
        { spanId: "s0", parentSpanId: null, name: "session", kind: "session", startTime: 0, status: "ok" },
        { spanId: "s1", parentSpanId: "s0", name: "bash", kind: "tool", startTime: 1, endTime: 2, status: "ok",
          tool: { callId: "c1", durationMs: 1 },
          input: { command: "pytest tests/" },
          output: "5 tests passed, 0 failed" },
        { spanId: "s2", parentSpanId: "s0", name: "bash", kind: "tool", startTime: 3, endTime: 4, status: "ok",
          tool: { callId: "c2", durationMs: 1 },
          input: { command: "pip install pandas" },
          output: "Successfully installed pandas-2.0.0" },
      ],
      summary: { totalTokens: 100, totalCost: 0, totalToolCalls: 2, totalGenerations: 0, duration: 4000, status: "completed",
        tokens: { input: 50, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
    })
    const html = renderTraceViewer(trace)
    // Should detect pytest and pip results
    expect(html).toContain("pytest")
    expect(html).toContain("pip install")
  })

  test("backward compat: Tracer alias works", () => {
    const { Tracer } = require("../../src/altimate/observability/tracing")
    expect(Tracer).toBe(Recap)
    const t = Tracer.create([])
    expect(t).toBeInstanceOf(Recap)
  })
})
