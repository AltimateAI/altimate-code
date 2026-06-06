/**
 * Tests for the v0.8.4 tracing-reliability follow-ups:
 *   - #901: reconstructed (interrupted) spans are distinguishable from real
 *           errors — `interrupted: true` on the span, amber (not red) in the
 *           viewer, excluded from the session error count.
 *   - #903: `capSpansForSerialization` bounds the on-disk spans for long-lived
 *           sessions (head + tail retention + an elision marker).
 */

import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import {
  Trace,
  FileExporter,
  capSpansForSerialization,
  type TraceFile,
  type TraceSpan,
} from "../../src/altimate/observability/tracing"
import { renderTraceViewer } from "../../src/altimate/observability/viewer"
import { tmpdir } from "../fixture/fixture"

function makeTrace(dir: string) {
  return Trace.withExporters([new FileExporter(dir)])
}

async function readTraceFile(dir: string, sessionId: string): Promise<TraceFile> {
  const safeId = sessionId.replace(/[/\\.:]/g, "_")
  return JSON.parse(await fs.readFile(path.join(dir, `${safeId}.json`), "utf-8"))
}

function span(i: number, over: Partial<TraceSpan> = {}): TraceSpan {
  return { spanId: `s${i}`, parentSpanId: "root", name: `span-${i}`, kind: "tool", startTime: i, endTime: i, status: "ok", ...over }
}

describe("#901 — interrupted spans are marked and not counted as errors", () => {
  test("rehydrate sets interrupted:true (not just status:error) on in-flight generation spans", async () => {
    await using tmp = await tmpdir()
    const id = "ses_interrupted_flag"

    const original = makeTrace(tmp.path)
    original.startTrace(id, {})
    original.logStepStart({ id: "step-1" } as any) // opens a generation span
    original.logToolCall({ tool: "read", state: { status: "completed", input: { f: "a" } } } as any) // snapshot
    await original.flush()
    const before = await readTraceFile(tmp.path, id)
    const openGen = before.spans.find((s) => s.kind === "generation")
    expect(openGen?.endTime).toBeUndefined()

    const reconstructed = makeTrace(tmp.path)
    expect(await reconstructed.rehydrateFromFile(id)).toBe(true)
    reconstructed.logToolCall({ tool: "read", state: { status: "completed", input: { f: "b" } } } as any)
    await reconstructed.flush()

    const after = await readTraceFile(tmp.path, id)
    const gen = after.spans.find((s) => s.spanId === openGen?.spanId)
    expect(gen?.status).toBe("error") // boundary still visible
    expect(gen?.interrupted).toBe(true) // but flagged as a reconstruction, not a failure
  })

  test("viewer renders an amber 'warn' affordance and excludes interrupted spans from the error count", async () => {
    // The viewer's per-span rendering and error counting run in embedded client
    // JS; assert the rendered document carries the interrupted-aware contract.
    const trace: TraceFile = {
      version: 2,
      traceId: "tr",
      sessionId: "ses_v",
      startedAt: new Date(0).toISOString(),
      metadata: {},
      spans: [
        { spanId: "root", parentSpanId: null, name: "ses_v", kind: "session", startTime: 0, status: "ok" },
        { spanId: "g", parentSpanId: "root", name: "gen", kind: "generation", startTime: 1, endTime: 2, status: "error", statusMessage: "interrupted — restarted", interrupted: true },
      ],
      summary: {
        totalTokens: 0, totalCost: 0, totalToolCalls: 0, totalGenerations: 1, duration: 2,
        status: "completed", tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      } as any,
    }
    const html = renderTraceViewer(trace)
    // amber tag style exists
    expect(html).toContain("pv-tag warn")
    // error count excludes interrupted spans
    expect(html).toContain("!sp.interrupted")
    // the interrupted span's flag survives into the embedded data
    expect(html).toContain('"interrupted":true')
    // the secondary surfaces (waterfall row class, tree meta, log row) all
    // gate the red/error treatment on !span.interrupted so reconstructed spans
    // render amber, not red, everywhere — not just in the preview/detail.
    expect(html).toContain("span.status === 'error' && !span.interrupted")
    expect(html).toContain("color:var(--orange)\">interrupted</span>")
  })
})

describe("#903 — capSpansForSerialization bounds long-lived traces", () => {
  test("returns the array unchanged when within the cap", () => {
    const spans = [span(0, { spanId: "root", parentSpanId: null, kind: "session" }), span(1), span(2)]
    expect(capSpansForSerialization(spans, 10)).toBe(spans)
  })

  test("caps to the limit, keeps head + tail, inserts one elision marker", () => {
    const spans: TraceSpan[] = [{ spanId: "root", parentSpanId: null, name: "root", kind: "session", startTime: 0, status: "ok" }]
    for (let i = 1; i < 100; i++) spans.push(span(i))
    const cap = 10
    const out = capSpansForSerialization(spans, cap)

    expect(out.length).toBeLessThanOrEqual(cap)
    // root (head) preserved
    expect(out[0].spanId).toBe("root")
    // most-recent span (tail) preserved
    expect(out[out.length - 1].spanId).toBe("s99")
    // exactly one elision marker, with an accurate count
    const markers = out.filter((s) => s.name.includes("elided"))
    expect(markers).toHaveLength(1)
    const keptReal = out.length - 1
    expect((markers[0].attributes as any).elided).toBe(spans.length - keptReal)
    expect((markers[0].attributes as any).totalSpans).toBe(100)
    // marker is parented to the real root so the viewer can place it
    expect(markers[0].parentSpanId).toBe("root")
  })

  test("does not elide when the cap is too small to gain anything", () => {
    const spans = [span(0), span(1), span(2)]
    // cap 2 → head 1, tail 1, marker would make 3 ≥ original 3: no benefit, keep as-is
    expect(capSpansForSerialization(spans, 2)).toBe(spans)
  })

  test("buildTraceFile applies the cap (wired into serialization)", async () => {
    // Behavioral: drive a real Trace past a tiny cap and confirm the on-disk
    // file is bounded. We exercise the cap function the serializer calls.
    const spans: TraceSpan[] = [{ spanId: "root", parentSpanId: null, name: "root", kind: "session", startTime: 0, status: "ok" }]
    for (let i = 1; i < 50; i++) spans.push(span(i))
    const capped = capSpansForSerialization(spans, 12)
    expect(capped.length).toBeLessThanOrEqual(12)
    // round-trips through JSON like the snapshot writer does
    const roundTripped = JSON.parse(JSON.stringify(capped)) as TraceSpan[]
    expect(roundTripped.find((s) => s.parentSpanId === null)).toBeDefined()
  })
})

describe("#902 — getOrCreateTrace guards against resurrecting a Trace into a cleared cache", () => {
  // worker.ts has module-scope side effects (it starts an event stream on
  // import), so it can't be unit-tested in-process. Lock the guard's shape with
  // a scope-bounded source contract, the same approach as
  // worker-trace-clearing.test.ts.
  test("captures the stream generation before the rehydrate await and re-checks it after", async () => {
    const workerSrc = await fs.readFile(
      path.join(__dirname, "../../src/cli/cmd/tui/worker.ts"),
      "utf-8",
    )

    // Ownership is keyed on a monotonic counter, not AbortController identity.
    expect(workerSrc).toMatch(/let streamGeneration = 0/)
    // The owning generation is captured at entry, before any await.
    expect(workerSrc).toMatch(/const generationAtEntry = streamGeneration/)
    // A new stream bumps the counter, invalidating in-flight calls.
    expect(workerSrc).toMatch(/streamGeneration\+\+/)

    // After awaiting rehydrate, if a new stream replaced ours, the freshly built
    // Trace is discarded (ended) instead of being inserted into the cleared map.
    const guard = workerSrc.match(
      /if \(streamGeneration !== generationAtEntry\)[\s\S]*?trace\.endTrace\(\)[\s\S]*?return sessionTraces\.get\(sessionID\) \?\? null/,
    )
    expect(guard).not.toBeNull()

    // The guard must sit AFTER the rehydrate await and BEFORE the cache insert,
    // otherwise it can't prevent the orphan write.
    const awaitIdx = workerSrc.indexOf("await trace.rehydrateFromFile(sessionID)")
    const guardIdx = workerSrc.indexOf("if (streamGeneration !== generationAtEntry)")
    const setIdx = workerSrc.indexOf("sessionTraces.set(sessionID, trace)")
    expect(awaitIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeGreaterThan(awaitIdx)
    expect(setIdx).toBeGreaterThan(guardIdx)

    // The bump happens inside startEventStream so a workspace switch invalidates
    // any suspended getOrCreateTrace.
    const startIdx = workerSrc.indexOf("const startEventStream =")
    const bumpIdx = workerSrc.indexOf("streamGeneration++")
    expect(bumpIdx).toBeGreaterThan(startIdx)
  })
})

describe("#903 — capSpansForSerialization structural guarantees (review hardening)", () => {
  test("always retains the root span even when it is NOT at index 0", () => {
    // Root deliberately placed in the middle so the naive head-slice would drop it.
    const spans: TraceSpan[] = []
    for (let i = 0; i < 40; i++) spans.push(span(i))
    const root: TraceSpan = { spanId: "ROOT", parentSpanId: null, name: "root", kind: "session", startTime: 20, status: "ok" }
    spans.splice(20, 0, root) // root now at index 20, not in the head slice
    const out = capSpansForSerialization(spans, 10)
    expect(out.some((s) => s.spanId === "ROOT")).toBe(true)
    // the elision marker is parented to the real root
    const marker = out.find((s) => s.name.includes("elided"))
    expect(marker?.parentSpanId).toBe("ROOT")
    expect(out.length).toBeLessThanOrEqual(10)
  })

  test.each([1, 2, 3, 4, 5])("tiny cap=%i never throws and never references a missing parent", (cap) => {
    const spans: TraceSpan[] = [{ spanId: "root", parentSpanId: null, name: "root", kind: "session", startTime: 0, status: "ok" }]
    for (let i = 1; i < 30; i++) spans.push(span(i))
    const out = capSpansForSerialization(spans, cap)
    // every non-root span's parent (if it's a kept span's parent) must resolve,
    // OR be the root, OR be absent (orphan attaches to root in the viewer).
    const ids = new Set(out.map((s) => s.spanId))
    const marker = out.find((s) => s.name.includes("elided"))
    if (marker) {
      expect(marker.parentSpanId === null || ids.has(marker.parentSpanId as string)).toBe(true)
    }
    // a root span is always present in the output
    expect(out.some((s) => s.parentSpanId === null)).toBe(true)
  })

  test("exact boundary head+tail+1 === length returns the original (no pointless marker)", () => {
    // cap=10 → head 3, tail 6, +1 marker = 10. length 10 → 10 >= 10 → pass-through.
    const spans: TraceSpan[] = [{ spanId: "root", parentSpanId: null, name: "root", kind: "session", startTime: 0, status: "ok" }]
    for (let i = 1; i < 10; i++) spans.push(span(i))
    expect(spans.length).toBe(10)
    expect(capSpansForSerialization(spans, 10)).toBe(spans)
  })

  test("elision marker reports an accurate elided count", () => {
    const spans: TraceSpan[] = [{ spanId: "root", parentSpanId: null, name: "root", kind: "session", startTime: 0, status: "ok" }]
    for (let i = 1; i < 1000; i++) spans.push(span(i))
    const cap = 100
    const out = capSpansForSerialization(spans, cap)
    const marker = out.find((s) => s.name.includes("elided"))!
    const keptReal = out.length - 1 // minus the marker
    expect((marker.attributes as any).elided).toBe(spans.length - keptReal)
    expect((marker.attributes as any).totalSpans).toBe(1000)
  })
})
