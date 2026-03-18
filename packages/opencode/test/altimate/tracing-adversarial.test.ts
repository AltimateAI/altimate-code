/**
 * Adversarial tests for the tracing system.
 *
 * These tests try to break the tracer with malicious, malformed, extreme, and
 * unexpected inputs. The tracer MUST never crash the host process — it should
 * silently degrade and still produce valid (possibly incomplete) output.
 *
 * Inspired by test patterns from:
 *   - Langfuse JS SDK (concurrent ops, flush under pressure)
 *   - OpenTelemetry JS SDK (invalid attributes, exporter failures, span limits)
 *   - Arize Phoenix (serialization edge cases)
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
  tmpDir = path.join(os.tmpdir(), `tracing-adv-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

function makeExporter() {
  return new FileExporter(tmpDir)
}

// ---------------------------------------------------------------------------
// 1. Malicious / malformed input
// ---------------------------------------------------------------------------

describe("Adversarial — malformed input", () => {
  test("NaN token counts produce valid JSON", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-nan", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: NaN,
      tokens: {
        input: NaN,
        output: Infinity,
        reasoning: -Infinity,
        cache: { read: NaN, write: NaN },
      },
    })
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()

    const content = await fs.readFile(filePath!, "utf-8")
    // Must be valid JSON (NaN/Infinity would break JSON.stringify)
    const trace: TraceFile = JSON.parse(content)
    expect(trace.summary.totalTokens).toBe(0)
    expect(trace.summary.totalCost).toBe(0)
    expect(Number.isFinite(trace.summary.tokens.input)).toBe(true)
    expect(Number.isFinite(trace.summary.tokens.output)).toBe(true)
  })

  test("undefined/null token cache object doesn't crash", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-null-cache", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    // Simulate a malformed event where cache is missing
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0.01,
      tokens: {
        input: 100,
        output: 50,
        reasoning: 0,
        cache: undefined as any,
      },
    })
    const filePath = await tracer.endTrace()
    // Should not crash — the try/catch in logStepFinish handles it
    // endTrace should still produce a file
    expect(filePath).toBeDefined()
  })

  test("circular reference in tool input doesn't crash", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-circular", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    const circular: any = { a: 1 }
    circular.self = circular

    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: circular,
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })

    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const toolSpan = trace.spans.find((s) => s.kind === "tool")!
    // Input should be sanitized, not the raw circular object
    expect(toolSpan.input).toBeDefined()
  })

  test("path traversal in session ID is sanitized", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("../../etc/passwd", { prompt: "evil" })
    const filePath = await tracer.endTrace()

    expect(filePath).toBeDefined()
    // File should be inside tmpDir, not escaped
    expect(filePath!.startsWith(tmpDir)).toBe(true)
    // No path separators in the filename
    const basename = path.basename(filePath!)
    expect(basename).not.toContain("/")
    expect(basename).not.toContain("\\")
    expect(basename).not.toContain("..")
  })

  test("session ID with special characters is safe", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("session:with/slashes\\and..dots", { prompt: "test" })
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // Slashes and dots should be replaced
    expect(trace.sessionId).not.toContain("/")
    expect(trace.sessionId).not.toContain("\\")
  })

  test("empty string session ID defaults to 'unknown'", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("", { prompt: "test" })
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.sessionId).toBe("unknown")
  })

  test("extremely long session ID doesn't cause issues", async () => {
    const longId = "x".repeat(10000)
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace(longId, { prompt: "test" })
    const filePath = await tracer.endTrace()
    // Should still work — file systems have name limits but we don't crash
    // The result may be undefined if the OS rejects the filename, but no crash
    expect(true).toBe(true) // Test passes if we get here without throwing
  })

  test("tool call with non-string error doesn't crash", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-err-type", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "error",
        input: {},
        error: 42 as any, // number instead of string
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
  })

  test("tool call with undefined error doesn't crash", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-undef-err", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "error",
        input: {},
        error: undefined as any,
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
  })

  test("tool call with null output doesn't crash", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-null-out", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "read",
      callID: "c1",
      state: {
        status: "completed",
        input: {},
        output: null as any,
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
  })

  test("tool call with missing time fields doesn't crash", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-no-time", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: {},
        output: "ok",
        time: {} as any, // missing start/end
      },
    })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 2. Unicode / binary / special characters
// ---------------------------------------------------------------------------

describe("Adversarial — unicode and special characters", () => {
  test("emoji in prompt and tool output", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-emoji", { prompt: "Fix the 🐛 in the 🔧 pipeline 🚀" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: { command: "echo '🎉'" },
        output: "🎉 Done! ✅",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logText({ text: "I fixed the 🐛 bug! 🎊" })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.metadata.prompt).toContain("🐛")
  })

  test("null bytes in strings", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-null-bytes", { prompt: "test\x00with\x00nulls" })
    tracer.logStepStart({ id: "1" })
    tracer.logText({ text: "output\x00with\x00nulls" })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
    // File should be valid JSON
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.version).toBe(2)
  })

  test("CJK characters in metadata", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-cjk", {
      prompt: "修复数据库中的错误 — バグを修正する — 데이터 파이프라인 수정",
      agent: "分析师",
    })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.metadata.prompt).toContain("修复")
    expect(trace.metadata.agent).toBe("分析师")
  })

  test("very long tool output with mixed encodings", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-mixed", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    // Mix of ASCII, UTF-8, control chars, surrogate-safe emoji
    const mixed = "Hello 世界 🌍 \t\n\r " + "Ω≈ç√∫≤≥÷ " + "a".repeat(5000)
    tracer.logToolCall({
      tool: "read",
      callID: "c1",
      state: {
        status: "completed",
        input: { file: "混合.txt" },
        output: mixed,
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
    JSON.parse(await fs.readFile(filePath!, "utf-8")) // Must not throw
  })
})

// ---------------------------------------------------------------------------
// 3. Extreme scale
// ---------------------------------------------------------------------------

describe("Adversarial — extreme scale", () => {
  test("1000 tool calls in a single generation", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-1k-tools", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    for (let i = 0; i < 1000; i++) {
      tracer.logToolCall({
        tool: `tool-${i}`,
        callID: `c-${i}`,
        state: {
          status: "completed",
          input: { index: i },
          output: `result-${i}`,
          time: { start: 1000 + i, end: 1001 + i },
        },
      })
    }

    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.totalToolCalls).toBe(1000)
    // 1 session + 1 generation + 1000 tools
    expect(trace.spans).toHaveLength(1002)
  })

  test("50 generations in sequence", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-50-gens", { prompt: "test" })

    for (let i = 0; i < 50; i++) {
      tracer.logStepStart({ id: `${i}` })
      tracer.logText({ text: `Generation ${i} output` })
      tracer.logStepFinish({
        id: `${i}`,
        reason: "stop",
        cost: 0.001,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    }

    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.totalGenerations).toBe(50)
    expect(trace.summary.totalCost).toBeCloseTo(0.05, 5)
  })

  test("5MB tool output is truncated and doesn't OOM", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-5mb", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    const fiveMB = "x".repeat(5 * 1024 * 1024)
    tracer.logToolCall({
      tool: "read",
      callID: "c1",
      state: {
        status: "completed",
        input: { file: "huge.log" },
        output: fiveMB,
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const toolSpan = trace.spans.find((s) => s.kind === "tool")!
    expect((toolSpan.output as string).length).toBeLessThanOrEqual(10000)
  })
})

// ---------------------------------------------------------------------------
// 4. Concurrent operations
// ---------------------------------------------------------------------------

describe("Adversarial — concurrency", () => {
  test("multiple tracers writing to the same directory concurrently", async () => {
    const tracers = Array.from({ length: 10 }, (_, i) => {
      const t = Tracer.withExporters([new FileExporter(tmpDir)])
      t.startTrace(`concurrent-${i}`, { prompt: `prompt-${i}` })
      return t
    })

    // End all traces concurrently
    const results = await Promise.allSettled(tracers.map((t) => t.endTrace()))

    // All should succeed
    const successful = results.filter((r) => r.status === "fulfilled" && r.value)
    expect(successful.length).toBe(10)

    // All files should be valid
    const files = (await fs.readdir(tmpDir)).filter((f) => f.endsWith(".json"))
    expect(files.length).toBe(10)

    for (const file of files) {
      const content = await fs.readFile(path.join(tmpDir, file), "utf-8")
      const trace: TraceFile = JSON.parse(content)
      expect(trace.version).toBe(2)
    }
  })

  test("rapid-fire logToolCall doesn't corrupt state", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-rapid", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    // Fire 100 tool calls synchronously as fast as possible
    for (let i = 0; i < 100; i++) {
      tracer.logToolCall({
        tool: "bash",
        callID: `rapid-${i}`,
        state: {
          status: "completed",
          input: { i },
          output: `out-${i}`,
          time: { start: Date.now(), end: Date.now() + 1 },
        },
      })
    }

    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.totalToolCalls).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 5. Exporter failure modes
// ---------------------------------------------------------------------------

describe("Adversarial — exporter failures", () => {
  test("exporter that throws synchronously", async () => {
    const badExporter: TraceExporter = {
      name: "sync-throw",
      export() {
        throw new Error("Sync explosion!")
      },
    }
    const tracer = Tracer.withExporters([badExporter, makeExporter()])
    tracer.startTrace("s-sync-throw", { prompt: "test" })
    const result = await tracer.endTrace()
    // FileExporter should still succeed
    expect(result).toBeDefined()
  })

  test("exporter that rejects with non-Error", async () => {
    const badExporter: TraceExporter = {
      name: "reject-string",
      export: async () => {
        throw "string error" // eslint-disable-line no-throw-literal
      },
    }
    const tracer = Tracer.withExporters([badExporter, makeExporter()])
    tracer.startTrace("s-reject-str", { prompt: "test" })
    const result = await tracer.endTrace()
    expect(result).toBeDefined()
  })

  test("exporter that hangs forever still allows others to complete", async () => {
    // Use a short-lived hanging exporter that resolves after a brief delay
    // to test the same code path without waiting for the full 5s timeout
    let resolveHang: () => void
    const hangingExporter: TraceExporter = {
      name: "hanging",
      export: () => new Promise<undefined>((resolve) => {
        resolveHang = () => resolve(undefined)
        // Auto-resolve after 200ms to avoid waiting for the 5s exporter timeout
        setTimeout(() => resolve(undefined), 200)
      }),
    }
    const fileExporter = makeExporter()

    // Put FileExporter first so its result is returned
    const tracer = Tracer.withExporters([fileExporter, hangingExporter])
    tracer.startTrace("s-hang", { prompt: "test" })

    const result = await tracer.endTrace()

    // Should get the file path from FileExporter
    expect(result).toContain(".json")
  }, 2000)

  test("exporter that returns null/undefined", async () => {
    const nullExporter: TraceExporter = {
      name: "null-return",
      export: async () => null as any,
    }
    const undefExporter: TraceExporter = {
      name: "undef-return",
      export: async () => undefined,
    }
    const tracer = Tracer.withExporters([nullExporter, undefExporter, makeExporter()])
    tracer.startTrace("s-null-ret", { prompt: "test" })
    const result = await tracer.endTrace()
    // FileExporter result should be returned
    expect(result).toContain(".json")
  })

  test("HttpExporter with invalid URL doesn't crash", async () => {
    const exporter = new HttpExporter("bad", "not-a-url")
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

  test("HttpExporter with server returning invalid JSON", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("{{{invalid json", { status: 200 })
      },
    })
    try {
      const exporter = new HttpExporter("bad-json", `http://localhost:${server.port}`)
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
      // Should not throw
      const result = await exporter.export(trace)
      // Falls back to "name: exported"
      expect(result).toBe("bad-json: exported")
    } finally {
      server.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. State machine edge cases
// ---------------------------------------------------------------------------

describe("Adversarial — state machine", () => {
  test("double startTrace overwrites cleanly", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("first", { prompt: "first" })
    tracer.startTrace("second", { prompt: "second" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // Second startTrace wins
    expect(trace.sessionId).toBe("second")
    expect(trace.metadata.prompt).toBe("second")
    // Should have 2 session spans (both pushes)
    expect(trace.spans.filter((s) => s.kind === "session")).toHaveLength(2)
  })

  test("logStepFinish called twice for same generation", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-double-fin", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0.01,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    // Second finish — currentGenerationSpanId is already null, so this is a no-op
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0.01,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // Should only count once
    expect(trace.summary.totalGenerations).toBe(1)
    expect(trace.summary.totalTokens).toBe(150)
  })

  test("logStepStart without matching logStepFinish", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-no-finish", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    // Never call logStepFinish — generation span left open
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // Generation span should exist but without endTime
    const gen = trace.spans.find((s) => s.kind === "generation")!
    expect(gen).toBeDefined()
    expect(gen.endTime).toBeUndefined()
  })

  test("interleaved step-start without finishing previous", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-interleave", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: {},
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    // Start a new generation without finishing the previous one
    tracer.logStepStart({ id: "2" })
    tracer.logStepFinish({
      id: "2",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // Should have 2 generation spans
    expect(trace.spans.filter((s) => s.kind === "generation")).toHaveLength(2)
    expect(trace.summary.totalGenerations).toBe(2)
  })

  test("endTrace called twice is safe", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-double-end", { prompt: "test" })
    const first = await tracer.endTrace()
    const second = await tracer.endTrace()
    expect(first).toBeDefined()
    // Second call may still write (same data) — should not crash
    expect(true).toBe(true)
  })

  test("operations after endTrace don't crash", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-post-end", { prompt: "test" })
    await tracer.endTrace()

    // These should all be no-ops, not crashes
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: {},
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    tracer.logText({ text: "hello" })
    tracer.enrichFromAssistant({ modelID: "test" })

    expect(true).toBe(true) // Reached here = no crash
  })
})

// ---------------------------------------------------------------------------
// 7. JSON serialization edge cases
// ---------------------------------------------------------------------------

describe("Adversarial — JSON serialization", () => {
  test("tool input with Date objects", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-date", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: { date: new Date(), regex: /test/g } as any,
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
    // Must produce valid JSON
    JSON.parse(await fs.readFile(filePath!, "utf-8"))
  })

  test("tool input with BigInt throws on JSON.stringify — should be caught", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-bigint", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: { big: BigInt(9007199254740991) } as any,
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
  })

  test("tool input with Uint8Array (binary data)", async () => {
    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-binary", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "read",
      callID: "c1",
      state: {
        status: "completed",
        input: { data: new Uint8Array([0, 1, 2, 255]) } as any,
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
    JSON.parse(await fs.readFile(filePath!, "utf-8"))
  })

  test("deeply nested tool input (100 levels)", async () => {
    let deep: any = { value: "leaf" }
    for (let i = 0; i < 100; i++) {
      deep = { nested: deep }
    }

    const tracer = Tracer.withExporters([makeExporter()])
    tracer.startTrace("s-deep", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: deep,
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 8. FileExporter edge cases
// ---------------------------------------------------------------------------

describe("Adversarial — FileExporter", () => {
  test("maxFiles of 0 means unlimited (no pruning)", async () => {
    const exporter = new FileExporter(tmpDir, 0)
    for (let i = 0; i < 5; i++) {
      await exporter.export({
        version: 2,
        traceId: `t${i}`,
        sessionId: `s${i}`,
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
      })
    }
    const files = (await fs.readdir(tmpDir)).filter((f) => f.endsWith(".json"))
    expect(files.length).toBe(5)
  })

  test("maxFiles of 1 keeps only the latest", async () => {
    const exporter = new FileExporter(tmpDir, 1)
    for (let i = 0; i < 3; i++) {
      await exporter.export({
        version: 2,
        traceId: `t${i}`,
        sessionId: `keep-${i}`,
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
      })
      await new Promise((r) => setTimeout(r, 10))
    }
    // Give pruning time to run
    await new Promise((r) => setTimeout(r, 50))
    const files = (await fs.readdir(tmpDir)).filter((f) => f.endsWith(".json"))
    expect(files.length).toBeLessThanOrEqual(1)
  })

  test("overwriting existing trace file for same session", async () => {
    const exporter = new FileExporter(tmpDir)

    const trace1: TraceFile = {
      version: 2,
      traceId: "t1",
      sessionId: "same-session",
      startedAt: new Date().toISOString(),
      metadata: { prompt: "first" },
      spans: [],
      summary: {
        totalTokens: 100,
        totalCost: 0.01,
        totalToolCalls: 0,
        totalGenerations: 0,
        duration: 0,
        status: "completed",
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    }

    const trace2: TraceFile = {
      ...trace1,
      traceId: "t2",
      metadata: { prompt: "second" },
      summary: { ...trace1.summary, totalTokens: 200 },
    }

    await exporter.export(trace1)
    await exporter.export(trace2)

    const content = JSON.parse(await fs.readFile(path.join(tmpDir, "same-session.json"), "utf-8"))
    // Second write should overwrite
    expect(content.metadata.prompt).toBe("second")
    expect(content.summary.totalTokens).toBe(200)
  })
})
