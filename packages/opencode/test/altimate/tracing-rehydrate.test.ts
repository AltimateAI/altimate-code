/**
 * Behavioral test for `Trace.rehydrateFromFile` and the worker's
 * cache-miss-rehydrates contract.
 *
 * The bug being guarded against: when the in-memory `Trace` instance for a
 * session is destroyed (worker restart, MAX_TRACES eviction, the now-removed
 * per-turn idle finalize) and a new `Trace` is constructed for the same
 * `sessionID`, the fresh `this.spans = []` plus immediate `snapshot()` in
 * `startTrace` would clobber the rich on-disk `ses_<id>.json` with a 1-span
 * file. Symptom: waterfall view collapses to system-prompt; metadata.prompt
 * disappears.
 *
 * `rehydrateFromFile` is the defense-in-depth fix: on cache miss, load the
 * existing trace state instead of starting fresh.
 */

import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Trace, FileExporter, type TraceFile } from "../../src/altimate/observability/tracing"
import { tmpdir } from "../fixture/fixture"

function makeTrace(dir: string) {
  return Trace.withExporters([new FileExporter(dir)])
}

async function readTraceFile(dir: string, sessionId: string): Promise<TraceFile> {
  const safeId = sessionId.replace(/[/\\.:]/g, "_")
  const filePath = path.join(dir, `${safeId}.json`)
  return JSON.parse(await fs.readFile(filePath, "utf-8"))
}

describe("Trace.rehydrateFromFile + cache-miss rehydration", () => {
  test("rehydrate preserves spans, metadata, and counters when reconstructing on cache miss", async () => {
    await using tmp = await tmpdir()
    const sessionId = "ses_rehydrate_basic"

    // Phase 1: original Trace builds up rich state, then is discarded (simulating
    // a worker restart or MAX_TRACES eviction).
    const original = makeTrace(tmp.path)
    original.startTrace(sessionId, {
      title: "test session",
      prompt: "do the thing",
      model: "openai/gpt-5.5",
      providerId: "altimate-backend",
      agent: "builder",
    })
    // Simulate turn-1 activity: a few tool calls + some text.
    original.logToolCall({ tool: "read", state: { status: "completed", input: { f: "a" } } } as any)
    original.logToolCall({ tool: "grep", state: { status: "completed", input: { p: "x" } } } as any)
    original.logText({ text: "first response", time: { end: Date.now() } } as any)
    // Flush to disk so the file represents the cumulative state.
    await original.flush()

    const onDiskAfterPhase1 = await readTraceFile(tmp.path, sessionId)
    expect(onDiskAfterPhase1.spans.length).toBeGreaterThan(1)
    expect(onDiskAfterPhase1.metadata.prompt).toBe("do the thing")
    expect(onDiskAfterPhase1.metadata.title).toBe("test session")

    // Phase 2: drop the original (worker restart / eviction). Construct a fresh
    // Trace instance for the SAME sessionID. This is the path that, pre-fix,
    // would have called startTrace and clobbered the file.
    const reconstructed = makeTrace(tmp.path)
    const didRehydrate = await reconstructed.rehydrateFromFile(sessionId)

    expect(didRehydrate).toBe(true)

    // Without writing anything yet, the in-memory state must reflect what was
    // on disk: same spans, same metadata, same root id.
    const fileImmediatelyAfterRehydrate = await readTraceFile(tmp.path, sessionId)
    expect(fileImmediatelyAfterRehydrate.spans).toEqual(onDiskAfterPhase1.spans)
    expect(fileImmediatelyAfterRehydrate.metadata.prompt).toBe("do the thing")

    // Phase 3: log new activity on the reconstructed Trace and flush. The next
    // snapshot must preserve the old spans AND add the new ones — not overwrite.
    reconstructed.logToolCall({ tool: "edit", state: { status: "completed", input: { f: "b" } } } as any)
    await reconstructed.flush()

    const onDiskAfterPhase3 = await readTraceFile(tmp.path, sessionId)
    expect(onDiskAfterPhase3.spans.length).toBeGreaterThan(onDiskAfterPhase1.spans.length)
    // Old spans still there.
    for (const oldSpan of onDiskAfterPhase1.spans) {
      expect(onDiskAfterPhase3.spans.some((s) => s.spanId === oldSpan.spanId)).toBe(true)
    }
    // Metadata was preserved across the reconstruction.
    expect(onDiskAfterPhase3.metadata.prompt).toBe("do the thing")
    expect(onDiskAfterPhase3.metadata.title).toBe("test session")
    expect(onDiskAfterPhase3.metadata.model).toBe("openai/gpt-5.5")
  })

  test("rehydrate returns false when no on-disk trace exists (fresh session)", async () => {
    await using tmp = await tmpdir()
    const trace = makeTrace(tmp.path)
    const result = await trace.rehydrateFromFile("ses_does_not_exist")
    expect(result).toBe(false)
  })

  test("rehydrate preserves traceId across instance reconstruction", async () => {
    await using tmp = await tmpdir()
    // Without this, downstream trace consumers (viewer URL, OTLP exporters)
    // see a different traceId on every snapshot after rehydration — breaks
    // trace identity across instance lifetimes.
    const sessionId = "ses_traceid_preservation"
    const original = makeTrace(tmp.path)
    original.startTrace(sessionId, {})
    original.logToolCall({ tool: "read", state: { status: "completed", input: { f: "a" } } } as any)
    await original.flush()
    const beforeFile = await readTraceFile(tmp.path, sessionId)
    const originalTraceId = beforeFile.traceId
    expect(typeof originalTraceId).toBe("string")

    const reconstructed = makeTrace(tmp.path)
    expect(await reconstructed.rehydrateFromFile(sessionId)).toBe(true)
    reconstructed.logToolCall({ tool: "grep", state: { status: "completed", input: { p: "x" } } } as any)
    await reconstructed.flush()
    const afterFile = await readTraceFile(tmp.path, sessionId)
    expect(afterFile.traceId).toBe(originalTraceId)
  })

  test("rehydrate matches sessionIds containing sanitized characters", async () => {
    await using tmp = await tmpdir()
    // `buildTraceFile` writes the sanitized form (slashes/dots/colons → "_").
    // The match check needs to normalize before comparing, otherwise valid
    // files would be rejected for sessions with those characters.
    const sessionId = "ses_with/slash.and:colon"
    const safeId = sessionId.replace(/[/\\.:]/g, "_")
    // Write a valid file at the sanitized path with the sanitized sessionId
    // inside (mirrors what buildTraceFile actually does).
    await fs.writeFile(
      path.join(tmp.path, `${safeId}.json`),
      JSON.stringify({
        version: 2,
        traceId: "tr_x",
        sessionId: safeId,
        startedAt: new Date(0).toISOString(),
        endedAt: new Date(0).toISOString(),
        metadata: {},
        spans: [
          { spanId: "r", parentSpanId: null, name: safeId, kind: "session", startTime: 0, status: "ok" },
        ],
        summary: {
          totalTokens: 0,
          totalCost: 0,
          totalToolCalls: 0,
          totalGenerations: 0,
          duration: 0,
          status: "completed",
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }),
    )

    const trace = makeTrace(tmp.path)
    // Pass the RAW sessionId (with slashes/dots/colons). Pre-fix this would have
    // returned false because "ses_with/slash.and:colon" !== "ses_with_slash_and_colon".
    expect(await trace.rehydrateFromFile(sessionId)).toBe(true)
  })

  test("rehydrate returns false when on-disk trace is for a different session", async () => {
    await using tmp = await tmpdir()
    // Stage a mismatched file at the expected path for "session-A".
    await fs.writeFile(
      path.join(tmp.path, "ses_target.json"),
      JSON.stringify({
        version: 2,
        traceId: "x",
        sessionId: "ses_other",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        metadata: {},
        spans: [{ spanId: "r", parentSpanId: null, name: "ses_other", kind: "session", startTime: 0, status: "ok" }],
        summary: {
          totalTokens: 0,
          totalCost: 0,
          totalToolCalls: 0,
          totalGenerations: 0,
          duration: 0,
          status: "completed",
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }),
    )
    const trace = makeTrace(tmp.path)
    const result = await trace.rehydrateFromFile("ses_target")
    expect(result).toBe(false)
  })

  test("logUserMessage records each user turn as a span so the chat tab can interleave them", async () => {
    await using tmp = await tmpdir()
    const sessionId = "ses_user_messages"

    const trace = makeTrace(tmp.path)
    trace.startTrace(sessionId, {})
    trace.logUserMessage("first user message")
    trace.logToolCall({ tool: "read", state: { status: "completed", input: { f: "a" } } } as any)
    trace.logUserMessage("second user message")
    trace.logToolCall({ tool: "grep", state: { status: "completed", input: { p: "x" } } } as any)
    trace.logUserMessage("third user message")
    await trace.flush()

    const fileContent = await readTraceFile(tmp.path, sessionId)
    const userMessages = fileContent.spans.filter((s) => s.kind === "user-message")
    expect(userMessages).toHaveLength(3)
    expect((userMessages[0] as any).input).toBe("first user message")
    expect((userMessages[1] as any).input).toBe("second user message")
    expect((userMessages[2] as any).input).toBe("third user message")

    // Chronological order — user-message spans must precede each generation/tool
    // span that came after them, so the chat tab renders them in turn order.
    const allSpans = fileContent.spans
    const sortedByStart = [...allSpans].sort((a, b) => (a.startTime || 0) - (b.startTime || 0))
    expect(sortedByStart).toEqual(allSpans)
  })

  test("rehydrate marks any in-flight generation span as interrupted", async () => {
    // Without this, the transient state that `logStepStart` opened (currentGenerationSpanId,
    // generationText, generationToolCalls, pendingToolResults) is lost on reconstruction.
    // A later `step-finish` event for that turn would drop at the
    // `if (!this.currentGenerationSpanId) return` guard, and follow-up `logToolCall`
    // would mis-parent its span at the root. Marking open generation spans interrupted
    // makes the boundary visible and prevents the silent degrade.
    await using tmp = await tmpdir()
    const sessionId = "ses_inflight_gen"

    const original = makeTrace(tmp.path)
    original.startTrace(sessionId, {})
    // Open a generation span via logStepStart. `logStepStart` does not itself
    // snapshot to disk, so follow with a tool call (which does snapshot) to
    // force a flush of the open generation span. Do NOT call logStepFinish —
    // the point is to leave the generation span open on disk.
    original.logStepStart({ id: "step-1" } as any)
    original.logToolCall({ tool: "read", state: { status: "completed", input: { f: "a" } } } as any)
    await original.flush()
    const beforeFile = await readTraceFile(tmp.path, sessionId)
    const openGen = beforeFile.spans.find((s) => s.kind === "generation")
    expect(openGen).toBeDefined()
    expect(openGen?.endTime).toBeUndefined()

    const reconstructed = makeTrace(tmp.path)
    expect(await reconstructed.rehydrateFromFile(sessionId)).toBe(true)
    // Trigger a snapshot so the rehydrated state lands on disk.
    reconstructed.logToolCall({ tool: "read", state: { status: "completed", input: { f: "a" } } } as any)
    await reconstructed.flush()

    const afterFile = await readTraceFile(tmp.path, sessionId)
    const interruptedGen = afterFile.spans.find((s) => s.spanId === openGen?.spanId)
    expect(interruptedGen?.endTime).toBeDefined()
    expect(interruptedGen?.status).toBe("error")
    expect(interruptedGen?.statusMessage).toMatch(/interrupted/i)
  })

  test("rehydrate clears endTime on the root span so the trace renders as still in-progress", async () => {
    await using tmp = await tmpdir()
    const sessionId = "ses_endtime_clear"

    const original = makeTrace(tmp.path)
    original.startTrace(sessionId, {})
    original.logToolCall({ tool: "read", state: { status: "completed", input: { f: "a" } } } as any)
    await original.endTrace() // sets root endTime
    const ended = await readTraceFile(tmp.path, sessionId)
    const endedRoot = ended.spans.find((s) => s.parentSpanId === null)
    expect(endedRoot?.endTime).toBeDefined()

    const reconstructed = makeTrace(tmp.path)
    const ok = await reconstructed.rehydrateFromFile(sessionId)
    expect(ok).toBe(true)

    // Trigger a snapshot via a real span push so the disk file gets re-written.
    reconstructed.logToolCall({ tool: "grep", state: { status: "completed", input: { p: "x" } } } as any)
    await reconstructed.flush()

    const afterRehydrate = await readTraceFile(tmp.path, sessionId)
    const root = afterRehydrate.spans.find((s) => s.parentSpanId === null)
    // The trace must be re-openable: the root endTime is cleared so subsequent
    // turns don't render the trace as "completed" in the viewer.
    expect(root?.endTime).toBeUndefined()
  })
})
