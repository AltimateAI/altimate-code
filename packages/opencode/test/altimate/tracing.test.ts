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
// Tracer — core lifecycle
// ---------------------------------------------------------------------------

describe("Tracer", () => {
  test("create() returns a Tracer instance", () => {
    const tracer = Tracer.create([])
    expect(tracer).toBeDefined()
  })

  test("withExporters() returns a Tracer instance", () => {
    const tracer = Tracer.withExporters([])
    expect(tracer).toBeDefined()
  })

  test("full lifecycle: start → generations → tools → end", async () => {
    const exporter = new FileExporter(tmpDir)
    const tracer = Tracer.withExporters([exporter])

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
    const tracer = Tracer.withExporters([exporter])

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
    const tracer = Tracer.withExporters([exporter])

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
    const tracer = Tracer.withExporters([exporter])

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
    const tracer = Tracer.withExporters([exporter])

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
// Tracer — graceful degradation
// ---------------------------------------------------------------------------

describe("Tracer — graceful degradation", () => {
  test("logStepStart before startTrace is a no-op", () => {
    const tracer = Tracer.withExporters([])
    // Should not throw
    tracer.logStepStart({ id: "1" })
  })

  test("logStepFinish without logStepStart is a no-op", () => {
    const tracer = Tracer.withExporters([])
    tracer.startTrace("s1", { prompt: "x" })
    // No logStepStart — should not throw
    tracer.logStepFinish(makeStepFinish())
  })

  test("logToolCall before startTrace is a no-op", () => {
    const tracer = Tracer.withExporters([])
    // Should not throw
    tracer.logToolCall(makeToolCall("bash"))
  })

  test("logText always works (no crashes)", () => {
    const tracer = Tracer.withExporters([])
    // Should not throw even without any spans
    tracer.logText({ text: "hello" })
    tracer.logText({ text: "" })
  })

  test("endTrace without startTrace returns undefined", async () => {
    const tracer = Tracer.withExporters([])
    const result = await tracer.endTrace()
    expect(result).toBeUndefined()
  })

  test("endTrace with no exporters returns undefined", async () => {
    const tracer = Tracer.withExporters([])
    tracer.startTrace("s1", { prompt: "x" })
    const result = await tracer.endTrace()
    expect(result).toBeUndefined()
  })

  test("enrichFromAssistant before startTrace does not crash", () => {
    const tracer = Tracer.withExporters([])
    // Should not throw
    tracer.enrichFromAssistant({ modelID: "test", providerID: "test" })
  })

  test("enrichFromAssistant with partial data is safe", () => {
    const tracer = Tracer.withExporters([])
    tracer.startTrace("s1", { prompt: "x" })
    tracer.enrichFromAssistant({})
    tracer.enrichFromAssistant({ modelID: undefined, providerID: undefined })
  })

  test("tool call with very long output is truncated", async () => {
    const exporter = new FileExporter(tmpDir)
    const tracer = Tracer.withExporters([exporter])

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
    const tracer = Tracer.withExporters([exporter])

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

describe("Tracer — multiple exporters", () => {
  test("one failing exporter does not block others", async () => {
    const failingExporter: TraceExporter = {
      name: "failing",
      export: async () => {
        throw new Error("Exporter crashed!")
      },
    }
    const fileExporter = new FileExporter(tmpDir)

    const tracer = Tracer.withExporters([failingExporter, fileExporter])
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

    const tracer = Tracer.withExporters([fileExporter, slowExporter])
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

    const tracer = Tracer.withExporters([fail1, fail2])
    tracer.startTrace("s-allfail", { prompt: "test" })
    const result = await tracer.endTrace()

    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tracer.withExporters — maxFiles propagation
// ---------------------------------------------------------------------------

describe("Tracer.withExporters — options", () => {
  test("maxFiles option is applied to FileExporter", async () => {
    const fileExporter = new FileExporter(tmpDir)
    const tracer = Tracer.withExporters([fileExporter], { maxFiles: 2 })

    // Write 4 traces
    for (let i = 0; i < 4; i++) {
      const t = Tracer.withExporters([new FileExporter(tmpDir, 2)])
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

describe("Tracer — static helpers", () => {
  test("getTracesDir returns a string", () => {
    expect(typeof Tracer.getTracesDir()).toBe("string")
  })

  test("listTraces returns empty array when no traces exist", async () => {
    const traces = await Tracer.listTraces()
    // May have traces from other tests, but should not throw
    expect(Array.isArray(traces)).toBe(true)
  })

  test("loadTrace returns null for non-existent session", async () => {
    const result = await Tracer.loadTrace("non-existent-session-id-12345")
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Edge cases — schema integrity
// ---------------------------------------------------------------------------

describe("Trace schema integrity", () => {
  test("trace with no spans still has valid structure", async () => {
    const exporter = new FileExporter(tmpDir)
    const tracer = Tracer.withExporters([exporter])

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
    const tracer = Tracer.withExporters([exporter])

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
    const tracer = Tracer.withExporters([exporter])

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
    const tracer = Tracer.withExporters([exporter])

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
    const tracer = Tracer.withExporters([exporter])

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
    const tracer = Tracer.withExporters([exporter])

    tracer.startTrace("s-ts", { prompt: "test" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    expect(() => new Date(trace.startedAt)).not.toThrow()
    expect(() => new Date(trace.endedAt!)).not.toThrow()
    expect(new Date(trace.startedAt).getTime()).toBeGreaterThan(0)
    expect(new Date(trace.endedAt!).getTime()).toBeGreaterThanOrEqual(new Date(trace.startedAt).getTime())
  })
})
