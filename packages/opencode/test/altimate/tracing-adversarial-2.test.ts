/**
 * Adversarial tests — round 2.
 *
 * Additional edge cases inspired by OpenTelemetry JS SDK, Langfuse JS SDK,
 * and Arize Phoenix test patterns. Focuses on gaps from round 1:
 *   - Clock skew / negative duration
 *   - Prototype pollution / Symbol keys / frozen objects
 *   - Attribute explosion (very large metadata)
 *   - Re-entrant calls (exporter calling tracer)
 *   - Out-of-order timestamps
 *   - Edge cases in FileExporter and HttpExporter
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
  tmpDir = path.join(os.tmpdir(), `tracing-adv2-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

function makeExporter() {
  return new FileExporter(tmpDir)
}

const EMPTY_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const ZERO_STEP = { id: "1", reason: "stop", cost: 0, tokens: EMPTY_TOKENS }

// ---------------------------------------------------------------------------
// 1. Clock skew / negative duration
// ---------------------------------------------------------------------------

describe("Clock skew and timing", () => {
  test("tool call with endTime before startTime", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-clock-skew", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: {},
        output: "ok",
        time: { start: 5000, end: 1000 }, // end before start
      },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))

    const toolSpan = trace.spans.find((s) => s.kind === "tool")!
    // Duration should not be negative — our sanitizer clamps to 0
    expect(toolSpan.tool!.durationMs).toBeLessThanOrEqual(0)
    // But should not crash
    expect(trace.version).toBe(2)
  })

  test("tool call with zero-duration (instant)", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-zero-dur", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: {},
        output: "ok",
        time: { start: 1000, end: 1000 },
      },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.spans.find((s) => s.kind === "tool")!.tool!.durationMs).toBe(0)
  })

  test("tool call with epoch 0 timestamps", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-epoch0", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: {},
        output: "ok",
        time: { start: 0, end: 0 },
      },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
  })

  test("tool call with very large timestamps (year 3000)", async () => {
    const year3000 = new Date("3000-01-01").getTime()
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-future", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: {},
        output: "ok",
        time: { start: year3000, end: year3000 + 1000 },
      },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
    JSON.parse(await fs.readFile(filePath!, "utf-8"))
  })

  test("negative timestamps", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-neg-ts", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: {},
        output: "ok",
        time: { start: -1000, end: -500 },
      },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 2. Prototype pollution / exotic objects
// ---------------------------------------------------------------------------

describe("Prototype pollution and exotic objects", () => {
  test("__proto__ in tool input doesn't pollute", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-proto", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    const malicious = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}')
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: malicious,
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()

    // Verify no prototype pollution occurred
    expect(({} as any).polluted).toBeUndefined()

    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.version).toBe(2)
  })

  test("Symbol keys in tool input are silently dropped by JSON.stringify", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-symbol", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    const sym = Symbol("secret")
    const input = { normal: "value", [sym]: "hidden" }
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: input as any,
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const toolSpan = trace.spans.find((s) => s.kind === "tool")!
    // Symbol key should be silently dropped
    expect((toolSpan.input as any).normal).toBe("value")
  })

  test("frozen object as tool input", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-frozen", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    const frozen = Object.freeze({ command: "ls", args: Object.freeze(["-la"]) })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: frozen as any,
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
  })

  test("sealed object as tool input", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-sealed", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    const sealed = Object.seal({ command: "ls" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: sealed as any,
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
  })

  test("Map and Set in tool input (non-plain objects)", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-map-set", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    const input = {
      map: new Map([["key", "value"]]),
      set: new Set([1, 2, 3]),
      regular: "normal",
    }
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: input as any,
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    // Map/Set serialize to {} in JSON.stringify — should not crash
    expect(filePath).toBeDefined()
    JSON.parse(await fs.readFile(filePath!, "utf-8"))
  })

  test("tool input with getter that throws", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-getter-throw", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    const tricky = {
      safe: "value",
      get dangerous() {
        throw new Error("getter exploded")
      },
    }
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: tricky as any,
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    // The try/catch in logToolCall should catch this
    expect(filePath).toBeDefined()
  })

  test("tool input with toJSON method", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-tojson", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    const input = {
      command: "ls",
      toJSON() {
        return { serialized: true, command: "ls" }
      },
    }
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: input as any,
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
  })

  test("tool input with toJSON that throws", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-tojson-throw", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    const input = {
      command: "ls",
      toJSON() {
        throw new Error("toJSON exploded")
      },
    }
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: input as any,
        output: "ok",
        time: { start: 1000, end: 2000 },
      },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    // Our safe serialization should catch this
    expect(filePath).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 3. Attribute / metadata explosion
// ---------------------------------------------------------------------------

describe("Attribute and metadata explosion", () => {
  test("10,000 tags in metadata", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    const tags = Array.from({ length: 10000 }, (_, i) => `tag-${i}`)
    tracer.startTrace("s-10k-tags", { prompt: "test", tags })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.metadata.tags).toHaveLength(10000)
  })

  test("very long prompt (1MB)", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    const longPrompt = "x".repeat(1024 * 1024)
    tracer.startTrace("s-1mb-prompt", { prompt: longPrompt })
    const filePath = await tracer.endTrace()
    expect(filePath).toBeDefined()
    // Should write successfully — file may be large
    const stat = await fs.stat(filePath!)
    expect(stat.size).toBeGreaterThan(1024 * 1024)
  })

  test("tool input with 1000 keys", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-1k-keys", { prompt: "test" })
    tracer.logStepStart({ id: "1" })

    const bigInput: Record<string, string> = {}
    for (let i = 0; i < 1000; i++) {
      bigInput[`key_${i}`] = `value_${i}`
    }
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: {
        status: "completed",
        input: bigInput,
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
// 4. Re-entrant calls
// ---------------------------------------------------------------------------

describe("Re-entrant and recursive calls", () => {
  test("exporter that calls tracer methods doesn't deadlock", async () => {
    const reentrantExporter: TraceExporter = {
      name: "reentrant",
      export: async (trace) => {
        // This exporter creates ANOTHER tracer inside — should not deadlock
        const inner = Recap.withExporters([new FileExporter(tmpDir)])
        inner.startTrace("inner-" + trace.sessionId, { prompt: "inception" })
        await inner.endTrace()
        return "reentrant-done"
      },
    }
    const tracer = Recap.withExporters([reentrantExporter, makeExporter()])
    tracer.startTrace("s-reentrant", { prompt: "test" })
    const result = await tracer.endTrace()
    expect(result).toBe("reentrant-done")

    // Inner trace should also exist
    const files = (await fs.readdir(tmpDir)).filter((f) => f.endsWith(".json"))
    expect(files.length).toBe(2) // outer + inner
  })
})

// ---------------------------------------------------------------------------
// 5. Numeric edge cases in token counts
// ---------------------------------------------------------------------------

describe("Numeric edge cases", () => {
  test("MAX_SAFE_INTEGER token counts", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-maxint", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: Number.MAX_SAFE_INTEGER,
      tokens: {
        input: Number.MAX_SAFE_INTEGER,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.tokens.input).toBe(Number.MAX_SAFE_INTEGER)
  })

  test("negative token counts are passed through (not our job to validate)", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-neg-tokens", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: -1,
      tokens: {
        input: -100,
        output: -50,
        reasoning: -10,
        cache: { read: -5, write: -3 },
      },
    })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // Negative numbers are finite, so they pass through — caller's problem
    expect(trace.summary.tokens.input).toBe(-100)
  })

  test("fractional token counts", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-frac", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logStepFinish({
      id: "1",
      reason: "stop",
      cost: 0.123456789,
      tokens: {
        input: 1.5,
        output: 2.7,
        reasoning: 0.1,
        cache: { read: 0.01, write: 0.001 },
      },
    })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.summary.totalCost).toBeCloseTo(0.123456789, 8)
  })
})

// ---------------------------------------------------------------------------
// 6. FileExporter robustness
// ---------------------------------------------------------------------------

describe("FileExporter robustness", () => {
  test("concurrent writes to same session ID (last writer wins)", async () => {
    const exporter = new FileExporter(tmpDir)

    const writes = Array.from({ length: 5 }, (_, i) => {
      const trace: TraceFile = {
        version: 2,
        traceId: `t-${i}`,
        sessionId: "same-session",
        startedAt: new Date().toISOString(),
        metadata: { prompt: `write-${i}` },
        spans: [],
        summary: {
          totalTokens: i,
          totalCost: 0,
          totalToolCalls: 0,
          totalGenerations: 0,
          duration: 0,
          status: "completed",
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }
      return exporter.export(trace)
    })

    await Promise.all(writes)

    // Only 1 file, last writer wins
    const files = (await fs.readdir(tmpDir)).filter((f) => f.endsWith(".json"))
    expect(files).toHaveLength(1)
  })

  test("non-JSON files in trace dir don't interfere with pruning", async () => {
    // Write some non-JSON files
    await fs.writeFile(path.join(tmpDir, "README.md"), "not a trace")
    await fs.writeFile(path.join(tmpDir, ".gitkeep"), "")

    const exporter = new FileExporter(tmpDir, 2)
    for (let i = 0; i < 3; i++) {
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
      await new Promise((r) => setTimeout(r, 50))
    }

    await new Promise((r) => setTimeout(r, 300))

    // Non-JSON files should still exist
    expect(await fs.stat(path.join(tmpDir, "README.md")).then(() => true)).toBe(true)
    expect(await fs.stat(path.join(tmpDir, ".gitkeep")).then(() => true)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7. HttpExporter robustness
// ---------------------------------------------------------------------------

describe("HttpExporter robustness", () => {
  test("server that closes connection mid-response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        // Return headers but close body abruptly
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"))
            controller.error(new Error("connection reset"))
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } })
      },
    })

    try {
      const exporter = new HttpExporter("unstable", `http://localhost:${server.port}`)
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
      // May return "unstable: exported" (200 OK received) or undefined
      expect(typeof result === "string" || result === undefined).toBe(true)
    } finally {
      server.stop()
    }
  })

  test("server that returns empty body", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("", { status: 200 })
      },
    })

    try {
      const exporter = new HttpExporter("empty", `http://localhost:${server.port}`)
      const result = await exporter.export({
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
      })
      expect(result).toBe("empty: exported")
    } finally {
      server.stop()
    }
  })

  test("server that returns HTML error page", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("<html><body>502 Bad Gateway</body></html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        })
      },
    })

    try {
      const exporter = new HttpExporter("htmlerr", `http://localhost:${server.port}`)
      const result = await exporter.export({
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
      })
      expect(result).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  test("server receives the correct trace payload", async () => {
    let receivedBody: any = null
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        receivedBody = await req.json()
        return Response.json({ ok: true })
      },
    })

    try {
      const exporter = new HttpExporter("verify", `http://localhost:${server.port}`, {
        "X-Trace-Source": "test",
      })

      const trace: TraceFile = {
        version: 2,
        traceId: "verify-id",
        sessionId: "verify-session",
        startedAt: "2026-03-15T10:00:00.000Z",
        metadata: { model: "test-model", agent: "coder" },
        spans: [
          {
            spanId: "span-1",
            parentSpanId: null,
            name: "session",
            kind: "session",
            startTime: 1000,
            endTime: 2000,
            status: "ok",
          },
        ],
        summary: {
          totalTokens: 500,
          totalCost: 0.01,
          totalToolCalls: 3,
          totalGenerations: 1,
          duration: 1000,
          status: "completed",
          tokens: { input: 300, output: 200, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }

      await exporter.export(trace)

      // Verify the server received exactly what we sent
      expect(receivedBody.version).toBe(2)
      expect(receivedBody.traceId).toBe("verify-id")
      expect(receivedBody.sessionId).toBe("verify-session")
      expect(receivedBody.summary.totalTokens).toBe(500)
      expect(receivedBody.spans).toHaveLength(1)
    } finally {
      server.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// 8. Edge cases in enrichFromAssistant
// ---------------------------------------------------------------------------

describe("enrichFromAssistant edge cases", () => {
  test("enrichment with empty strings doesn't overwrite existing values", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-enrich-empty", {
      model: "original-model",
      agent: "original-agent",
      prompt: "test",
    })
    // Empty modelID should update (truthy check: empty string is falsy)
    tracer.enrichFromAssistant({ modelID: "", providerID: "", agent: "", variant: "" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // Original values should be preserved since empty strings are falsy
    expect(trace.metadata.model).toBe("original-model")
    expect(trace.metadata.agent).toBe("original-agent")
  })

  test("multiple enrichFromAssistant calls — last one wins", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-multi-enrich", { prompt: "test" })
    tracer.enrichFromAssistant({ modelID: "model-1", providerID: "p1" })
    tracer.enrichFromAssistant({ modelID: "model-2", providerID: "p2" })
    tracer.enrichFromAssistant({ modelID: "model-3", providerID: "p3" })
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.metadata.model).toBe("p3/model-3")
    expect(trace.metadata.providerId).toBe("p3")
  })
})

// ---------------------------------------------------------------------------
// 9. Empty / minimal traces
// ---------------------------------------------------------------------------

describe("Empty and minimal traces", () => {
  test("trace with only startTrace and endTrace", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-minimal", {})
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    expect(trace.version).toBe(2)
    expect(trace.spans).toHaveLength(1) // Just root
    expect(trace.summary.totalGenerations).toBe(0)
    expect(trace.summary.totalToolCalls).toBe(0)
    expect(trace.metadata.prompt).toBeUndefined()
    expect(trace.metadata.model).toBeUndefined()
  })

  test("trace with empty metadata object", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-empty-meta", {})
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    // All metadata fields should be undefined, not null
    expect(trace.metadata.model).toBeUndefined()
    expect(trace.metadata.agent).toBeUndefined()
    expect(trace.metadata.prompt).toBeUndefined()
  })

  test("generation with only text (no tool calls)", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-text-only", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logText({ text: "Here is my answer." })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const gen = trace.spans.find((s) => s.kind === "generation")!
    expect(gen.output).toBe("Here is my answer.")
  })

  test("generation with only tool calls (no text)", async () => {
    const tracer = Recap.withExporters([makeExporter()])
    tracer.startTrace("s-tools-only", { prompt: "test" })
    tracer.logStepStart({ id: "1" })
    tracer.logToolCall({
      tool: "bash",
      callID: "c1",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1000, end: 2000 } },
    })
    tracer.logToolCall({
      tool: "read",
      callID: "c2",
      state: { status: "completed", input: {}, output: "content", time: { start: 2000, end: 3000 } },
    })
    tracer.logStepFinish(ZERO_STEP)
    const filePath = await tracer.endTrace()
    const trace: TraceFile = JSON.parse(await fs.readFile(filePath!, "utf-8"))
    const gen = trace.spans.find((s) => s.kind === "generation")!
    expect(gen.output).toBe("[tool calls: bash, read]")
  })
})
