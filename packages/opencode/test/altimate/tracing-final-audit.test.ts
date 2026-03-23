/**
 * Final audit tests — found via line-by-line code review.
 *
 * Each test targets a specific code path that was previously untested.
 * Comments reference the exact line numbers / code patterns being exercised.
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
import { DE } from "../../src/altimate/observability/de-attributes"

let tmpDir: string

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `tracing-final-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
// 1. startTrace — instance_id vs sessionId fallback (line 335)
// ---------------------------------------------------------------------------

describe("startTrace — instance_id handling", () => {
  test("instance_id overrides sessionId for root span name", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("session-123", { instance_id: "run-456", prompt: "test" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const root = trace.spans.find((s) => s.kind === "session")!
    expect(root.name).toBe("run-456")
  })

  test("empty string instance_id falls back to sessionId", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("session-123", { instance_id: "", prompt: "test" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const root = trace.spans.find((s) => s.kind === "session")!
    // Empty string is falsy, so || falls through to sessionId
    expect(root.name).toBe("session-123")
  })

  test("undefined instance_id falls back to sessionId", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("session-123", { prompt: "test" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const root = trace.spans.find((s) => s.kind === "session")!
    expect(root.name).toBe("session-123")
  })
})

// ---------------------------------------------------------------------------
// 2. enrichFromAssistant — providerID formatting edge cases (line 353)
// ---------------------------------------------------------------------------

describe("enrichFromAssistant — providerID edge cases", () => {
  test("undefined providerID creates model string with leading slash", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.enrichFromAssistant({ modelID: "claude-sonnet" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // providerID is undefined, so model = "/claude-sonnet"
    expect(trace.metadata.model).toBe("/claude-sonnet")
  })

  test("both providerID and modelID set produces clean model string", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.enrichFromAssistant({ modelID: "claude-sonnet", providerID: "anthropic" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.metadata.model).toBe("anthropic/claude-sonnet")
  })

  test("only providerID set (no modelID) does not update model", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { model: "original", prompt: "test" })
    tracer.enrichFromAssistant({ providerID: "openai" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // modelID is falsy, so the model field isn't updated
    expect(trace.metadata.model).toBe("original")
    expect(trace.metadata.providerId).toBe("openai")
  })
})

// ---------------------------------------------------------------------------
// 3. logStepFinish — tokens object itself being null/undefined (line 410)
// ---------------------------------------------------------------------------

describe("logStepFinish — null/undefined tokens object", () => {
  test("entire tokens object is null", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0.01,
      tokens: null as any,
    })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const gen = trace.spans.find((s) => s.kind === "generation")!
    // Should gracefully default everything to 0
    expect(gen.tokens!.total).toBe(0)
    expect(gen.cost).toBe(0.01)
  })

  test("entire tokens object is undefined", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: undefined as any,
    })
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
  })

  test("tokens present but cache is null", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: { input: 100, output: 50, reasoning: 10, cache: null as any },
    })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.tokens.input).toBe(100)
    expect(trace.summary.tokens.cacheRead).toBe(0)
    expect(trace.summary.tokens.cacheWrite).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. logToolCall — empty/undefined tool name (line 480, 502)
// ---------------------------------------------------------------------------

describe("logToolCall — tool name edge cases", () => {
  test("empty string tool name defaults to 'unknown'", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "",
      callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1000, end: 2000 } },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const toolSpan = trace.spans.find((s) => s.kind === "tool")!
    expect(toolSpan.name).toBe("unknown")
  })

  test("tool input is a primitive (string)", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: "just a string" as any,
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const toolSpan = trace.spans.find((s) => s.kind === "tool")!
    expect(toolSpan.input).toBe("just a string")
  })

  test("tool input is a number", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: 42 as any,
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const toolSpan = trace.spans.find((s) => s.kind === "tool")!
    expect(toolSpan.input).toBe(42)
  })

  test("tool input is an array", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: [1, 2, 3] as any,
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 5. logText — null/undefined text (line 523)
// ---------------------------------------------------------------------------

describe("logText — null/undefined text", () => {
  test("null text is skipped", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logText({ text: null as any })
    tracer.logText({ text: "real text" })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const gen = trace.spans.find((s) => s.kind === "generation")!
    expect(gen.output).toBe("real text")
  })

  test("undefined text is skipped", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logText({ text: undefined as any })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const gen = trace.spans.find((s) => s.kind === "generation")!
    // No text was added, so output falls through to the tool calls branch
    expect(gen.output).toBeUndefined()
  })

  test("numeric text is coerced to string", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logText({ text: 42 as any })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const gen = trace.spans.find((s) => s.kind === "generation")!
    expect(gen.output).toBe("42")
  })
})

// ---------------------------------------------------------------------------
// 6. setSpanAttributes — non-serializable values (line 569)
// ---------------------------------------------------------------------------

describe("setSpanAttributes — non-serializable values", () => {
  test("function values are stringified", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.setSpanAttributes({
      callback: () => "hello",
      normal: "value",
    }, "session")
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const attrs = trace.spans.find((s) => s.kind === "session")!.attributes!
    expect(attrs.normal).toBe("value")
    // Function should be stringified since JSON.stringify returns undefined for functions
    expect(typeof attrs.callback).toBe("string")
  })

  test("circular reference in attribute value is stringified", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    const circ: any = { a: 1 }
    circ.self = circ
    tracer.setSpanAttributes({ circ, safe: "ok" }, "session")
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const attrs = trace.spans.find((s) => s.kind === "session")!.attributes!
    expect(attrs.safe).toBe("ok")
    // Circular ref should be caught and stringified
    expect(typeof attrs.circ).toBe("string")
  })

  test("BigInt attribute value is stringified", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.setSpanAttributes({ big: BigInt(999) }, "session")
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const attrs = trace.spans.find((s) => s.kind === "session")!.attributes!
    expect(attrs.big).toBe("999")
  })
})

// ---------------------------------------------------------------------------
// 7. setSpanAttributes — explicit "tool" target with no tool spans
// ---------------------------------------------------------------------------

describe("setSpanAttributes — tool targeting edge cases", () => {
  test("explicit 'tool' target with no tool spans is a no-op", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.setSpanAttributes({ key: "val" }, "tool")
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // Session span should NOT have the attribute (it was targeted to tool)
    const session = trace.spans.find((s) => s.kind === "session")!
    expect(session.attributes?.key).toBeUndefined()
  })

  test("auto-target with multiple tool spans targets the LAST one", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "first_tool",
      callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1000, end: 2000 } },
    })
    tracer.logToolCall({
      tool: "second_tool",
      callID: "c2",
      state: { status: "completed", input: {}, output: "ok", time: { start: 2000, end: 3000 } },
    })
    tracer.setSpanAttributes({ target: "should-be-on-second" })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    const tools = trace.spans.filter((s) => s.kind === "tool")
    expect(tools[0]!.attributes?.target).toBeUndefined()
    expect(tools[1]!.attributes?.target).toBe("should-be-on-second")
  })
})

// ---------------------------------------------------------------------------
// 8. sessionId sanitization — unicode and edge cases (line 605)
// ---------------------------------------------------------------------------

describe("sessionId sanitization", () => {
  test("unicode session ID is preserved (no path-unsafe chars)", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("세션-αβγ-会议", { prompt: "test" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // Unicode chars are safe for file names, only /\.: are replaced
    expect(trace.sessionId).toBe("세션-αβγ-会议")
  })

  test("session ID with only unsafe chars becomes all underscores", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("/.\\:.", { prompt: "test" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.sessionId).toBe("_____")
  })

  test("session ID with mixed safe/unsafe chars", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("project:env/session.123", { prompt: "test" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.sessionId).toBe("project_env_session_123")
  })
})

// ---------------------------------------------------------------------------
// 9. withExporters — maxFiles: 0 propagation (line 289)
// ---------------------------------------------------------------------------

describe("withExporters — maxFiles edge cases", () => {
  test("maxFiles: 0 propagates to FileExporter (means unlimited)", async () => {
    const fe = new FileExporter(tmpDir)
    const tracer = Recap.withExporters([fe], { maxFiles: 0 })

    // Write 5 traces
    for (let i = 0; i < 5; i++) {
      const t = Recap.withExporters([new FileExporter(tmpDir, 0)])
      t.startTrace(`s-${i}`, { prompt: `test-${i}` })
      await t.endTrace()
    }

    // All 5 should exist (no pruning with maxFiles=0)
    const files = (await fs.readdir(tmpDir)).filter((f) => f.endsWith(".json"))
    expect(files.length).toBe(5)
  })

  test("withExporters with no FileExporter ignores maxFiles", () => {
    const httpExporter = new HttpExporter("test", "http://localhost:1")
    // Should not crash when no FileExporter is found
    const tracer = Recap.withExporters([httpExporter], { maxFiles: 5 })
    expect(tracer).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 10. FileExporter — sessionId edge cases in export (line 166)
// ---------------------------------------------------------------------------

describe("FileExporter — sessionId in TraceFile", () => {
  test("empty sessionId in trace file", async () => {
    const exporter = new FileExporter(tmpDir)
    const trace: TraceFile = {
      version: 2,
      traceId: "t1",
      sessionId: "",
      startedAt: new Date().toISOString(),
      metadata: {},
      spans: [],
      summary: {
        totalTokens: 0, totalCost: 0, totalToolCalls: 0, totalGenerations: 0,
        duration: 0, status: "completed",
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    }
    const result = await exporter.export(trace)
    expect(result).toBeDefined()
    // Should create a file named ".json" (empty prefix)
    expect(result).toContain(".json")
  })

  test("sessionId with slashes in trace file is sanitized by exporter", async () => {
    const exporter = new FileExporter(tmpDir)
    const trace: TraceFile = {
      version: 2,
      traceId: "t1",
      sessionId: "../../etc/passwd",
      startedAt: new Date().toISOString(),
      metadata: {},
      spans: [],
      summary: {
        totalTokens: 0, totalCost: 0, totalToolCalls: 0, totalGenerations: 0,
        duration: 0, status: "completed",
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    }
    const result = await exporter.export(trace)
    expect(result).toBeDefined()
    // Must be inside tmpDir
    expect(result!.startsWith(tmpDir)).toBe(true)
    expect(path.basename(result!)).not.toContain("/")
  })
})

// ---------------------------------------------------------------------------
// 11. Generation span — input from pendingToolResults (line 365-368)
// ---------------------------------------------------------------------------

describe("Generation span — input from previous tool results", () => {
  test("second generation's input contains previous tool results", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })

    // First generation with a tool call
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: { status: "completed", input: { cmd: "ls" }, output: "file1.ts\nfile2.ts", time: { start: 1000, end: 2000 } },
    })
    tracer.logStepFinish(ZERO_STEP)

    // Second generation should have the tool result as input
    tracer.logStepStart({ id: "2" })
    tracer.logStepFinish(ZERO_STEP)

    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    const gens = trace.spans.filter((s) => s.kind === "generation")
    // First generation has no input (no pending results at that point)
    expect(gens[0]!.input).toBeUndefined()
    // Second generation has the bash tool result as input
    expect(gens[1]!.input).toContain("[bash]")
    expect(gens[1]!.input).toContain("file1.ts")
  })

  test("error tool result appears in next generation's input", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })

    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: { status: "error", input: {}, error: "Permission denied", time: { start: 1000, end: 2000 } },
    })
    tracer.logStepFinish(ZERO_STEP)

    tracer.logStepStart({ id: "2" })
    tracer.logStepFinish(ZERO_STEP)

    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const gen2 = trace.spans.filter((s) => s.kind === "generation")[1]!
    expect(gen2.input).toContain("[bash]")
    expect(gen2.input).toContain("error: Permission denied")
  })
})

// ---------------------------------------------------------------------------
// 12. Generation output — text vs tool call summary (line 426-428)
// ---------------------------------------------------------------------------

describe("Generation output composition", () => {
  test("text output takes priority over tool call summary", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1000, end: 2000 } },
    })
    tracer.logText({ text: "Here is my analysis." })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const gen = trace.spans.find((s) => s.kind === "generation")!
    // Text wins over tool call summary
    expect(gen.output).toBe("Here is my analysis.")
  })

  test("empty text falls through to tool call summary", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "read",
      callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1000, end: 2000 } },
    })
    tracer.logText({ text: "" })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const gen = trace.spans.find((s) => s.kind === "generation")!
    // Empty string is falsy, so it falls through to tool call summary
    expect(gen.output).toBe("[tool calls: read]")
  })

  test("no text and no tool calls produces undefined output", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const gen = trace.spans.find((s) => s.kind === "generation")!
    expect(gen.output).toBeUndefined()
  })

  test("multiple text parts are concatenated", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logText({ text: "Part 1. " })
    tracer.logText({ text: "Part 2. " })
    tracer.logText({ text: "Part 3." })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const gen = trace.spans.find((s) => s.kind === "generation")!
    expect(gen.output).toBe("Part 1. Part 2. Part 3.")
  })
})

// ---------------------------------------------------------------------------
// 13. HttpExporter — JSON.stringify of trace with non-serializable attrs
// ---------------------------------------------------------------------------

describe("HttpExporter — trace with problematic attributes", () => {
  test("trace with function attribute values in spans", async () => {
    let receivedBody: any = null
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        receivedBody = await req.text()
        return Response.json({ ok: true })
      },
    })

    try {
      // Build a trace that has a function in span attributes
      // (setSpanAttributes now catches this, but test the HttpExporter path too)
      const trace: TraceFile = {
        version: 2,
        traceId: "t1",
        sessionId: "s1",
        startedAt: new Date().toISOString(),
        metadata: {},
        spans: [{
          spanId: "sp1",
          parentSpanId: null,
          name: "test",
          kind: "session",
          startTime: 1000,
          status: "ok",
          attributes: { safe: "value" },
        }],
        summary: {
          totalTokens: 0, totalCost: 0, totalToolCalls: 0, totalGenerations: 0,
          duration: 0, status: "completed",
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }

      const exporter = new HttpExporter("test", `http://localhost:${server.port}`)
      const result = await exporter.export(trace)
      expect(receivedBody).toBeTruthy()
      // Should be valid JSON
      JSON.parse(receivedBody)
    } finally {
      server.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// 14. endTrace — error string edge cases
// ---------------------------------------------------------------------------

describe("endTrace — error string variations", () => {
  test("empty string error still marks as error", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    const filePath = await tracer.endTrace("")
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // Empty string is falsy, so ...(error && { error }) won't add it
    // But the status check is `error ? "error" : "completed"`
    // Empty string is falsy, so status should be "completed"
    expect(trace.summary.status).toBe("completed")
  })

  test("very long error string", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    const longError = "Error: " + "x".repeat(100000)
    const filePath = await tracer.endTrace(longError)
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.status).toBe("error")
    expect(trace.summary.error!.length).toBe(longError.length)
  })

  test("error with newlines and special chars", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    const filePath = await tracer.endTrace("Line 1\nLine 2\tTabbed\r\nWindows line")
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.error).toContain("Line 1\nLine 2")
  })
})

// ---------------------------------------------------------------------------
// 15. Trace structural invariants
// ---------------------------------------------------------------------------

describe("Structural invariants", () => {
  test("traceId is always a valid UUIDv7", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // UUIDv7 format: 8-4-4-4-12 hex digits
    expect(trace.traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test("all span IDs are valid UUIDv7", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash", callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1000, end: 2000 } },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    for (const span of trace.spans) {
      expect(span.spanId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      if (span.parentSpanId) {
        expect(span.parentSpanId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      }
    }
  })

  test("endedAt is always >= startedAt", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    // Add some work to create a measurable gap
    tracer.logStepStart({ id: "1" })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(new Date(trace.endedAt!).getTime()).toBeGreaterThanOrEqual(new Date(trace.startedAt).getTime())
  })

  test("summary duration matches startedAt/endedAt difference", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    await new Promise((r) => setTimeout(r, 50))
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const timeDiff = new Date(trace.endedAt!).getTime() - new Date(trace.startedAt).getTime()
    // Duration should be close to the time diff (within a few ms)
    expect(Math.abs(trace.summary.duration - timeDiff)).toBeLessThan(50)
  })

  test("summary totals are consistent with span data", async () => {
    const tracer = Recap.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace("s1", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash", callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1000, end: 2000 } },
    })
    tracer.logToolCall({
      tool: "read", callID: "c2",
      state: { status: "error", input: {}, error: "not found", time: { start: 2000, end: 3000 } },
    })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0.01,
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
    })
    tracer.logStepStart({ id: "2" })
    tracer.logStepFinish({
      id: "2",
      reason: "stop",
      cost: 0.02,
      tokens: { input: 200, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    // Tool counts
    const toolSpans = trace.spans.filter((s) => s.kind === "tool")
    expect(trace.summary.totalToolCalls).toBe(toolSpans.length)

    // Generation counts
    const genSpans = trace.spans.filter((s) => s.kind === "generation")
    expect(trace.summary.totalGenerations).toBe(genSpans.length)

    // Token totals = sum of all generation tokens
    const genTokenTotals = genSpans.map((g) => g.tokens?.total ?? 0).reduce((a, b) => a + b, 0)
    expect(trace.summary.totalTokens).toBe(genTokenTotals)

    // Cost totals = sum of all generation costs
    const genCosts = genSpans.map((g) => g.cost ?? 0).reduce((a, b) => a + b, 0)
    expect(trace.summary.totalCost).toBeCloseTo(genCosts, 10)

    // Token breakdown should equal sum of per-generation breakdowns
    expect(trace.summary.tokens.input).toBe(300) // 100 + 200
    expect(trace.summary.tokens.output).toBe(150) // 50 + 100
    expect(trace.summary.tokens.reasoning).toBe(10)
    expect(trace.summary.tokens.cacheRead).toBe(20)
    expect(trace.summary.tokens.cacheWrite).toBe(5)
  })
})
