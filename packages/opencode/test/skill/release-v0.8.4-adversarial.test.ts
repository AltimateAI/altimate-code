/**
 * Adversarial coverage for the v0.8.4 release.
 *
 * v0.8.4 ships one user-facing fix (#895): session traces no longer lose their
 * data after each agent turn. The mechanism is `Trace.rehydrateFromFile` (load
 * the rich on-disk trace on cache miss instead of clobbering it), per-turn
 * `logUserMessage` spans feeding the chat tab, and marking in-flight generation
 * spans interrupted on reconstruction. The release-review follow-up reworded the
 * interrupt `statusMessage` so a recorder restart isn't read as an agent failure.
 *
 * The happy-path and edge behavior is covered in `tracing-rehydrate.test.ts` and
 * `worker-trace-clearing.test.ts`. This file is strictly adversarial: malformed /
 * type-confused on-disk files, path traversal, prototype pollution, boundary
 * truncation, and `</script>` breakout through the new user-message → viewer path.
 */

import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import {
  Trace,
  FileExporter,
  USER_MESSAGE_INPUT_MAX_CHARS,
  type TraceFile,
} from "../../src/altimate/observability/tracing"
import { renderTraceViewer } from "../../src/altimate/observability/viewer"
import { tmpdir } from "../fixture/fixture"

function makeTrace(dir: string) {
  return Trace.withExporters([new FileExporter(dir)])
}

function safeName(sessionId: string) {
  return sessionId.replace(/[/\\.:]/g, "_") || "unknown"
}

async function readTraceFile(dir: string, sessionId: string): Promise<TraceFile> {
  const filePath = path.join(dir, `${safeName(sessionId)}.json`)
  return JSON.parse(await fs.readFile(filePath, "utf-8"))
}

// Write a raw string to the on-disk path `rehydrateFromFile` would read for `sessionId`.
async function stageRaw(dir: string, sessionId: string, raw: string) {
  await fs.writeFile(path.join(dir, `${safeName(sessionId)}.json`), raw)
}

describe("v0.8.4 adversarial — rehydrateFromFile rejects malformed input without throwing", () => {
  test("truncated / non-JSON file returns false, does not throw", async () => {
    await using tmp = await tmpdir()
    const id = "ses_corrupt_json"
    await stageRaw(tmp.path, id, '{ "spans": [ this is not valid json')
    const trace = makeTrace(tmp.path)
    // Must not throw — a torn/garbage file during a postmortem must degrade
    // to "no rehydrate", never crash the worker event loop.
    expect(await trace.rehydrateFromFile(id)).toBe(false)
  })

  test("empty file returns false", async () => {
    await using tmp = await tmpdir()
    const id = "ses_empty_file"
    await stageRaw(tmp.path, id, "")
    expect(await makeTrace(tmp.path).rehydrateFromFile(id)).toBe(false)
  })

  test("spans is not an array (type confusion) returns false", async () => {
    await using tmp = await tmpdir()
    const id = "ses_spans_not_array"
    await stageRaw(
      tmp.path,
      id,
      JSON.stringify({ version: 2, traceId: "t", sessionId: id, metadata: {}, spans: "definitely-not-an-array" }),
    )
    expect(await makeTrace(tmp.path).rehydrateFromFile(id)).toBe(false)
  })

  test("empty spans array returns false", async () => {
    await using tmp = await tmpdir()
    const id = "ses_empty_spans"
    await stageRaw(tmp.path, id, JSON.stringify({ version: 2, traceId: "t", sessionId: id, metadata: {}, spans: [] }))
    expect(await makeTrace(tmp.path).rehydrateFromFile(id)).toBe(false)
  })

  test("spans present but no session root span returns false", async () => {
    await using tmp = await tmpdir()
    const id = "ses_no_root"
    // parentSpanId is null but kind is "generation", not "session" — there is no
    // valid root, so reconstruction must refuse rather than build a headless trace.
    await stageRaw(
      tmp.path,
      id,
      JSON.stringify({
        version: 2,
        traceId: "t",
        sessionId: id,
        metadata: {},
        spans: [{ spanId: "g", parentSpanId: null, name: "gen", kind: "generation", startTime: 0, status: "ok" }],
      }),
    )
    expect(await makeTrace(tmp.path).rehydrateFromFile(id)).toBe(false)
  })

  test("empty-string sessionId is handled gracefully (no throw, false)", async () => {
    await using tmp = await tmpdir()
    // "" sanitizes to "unknown"; no such file exists, so it returns false rather
    // than throwing on a degenerate id.
    expect(await makeTrace(tmp.path).rehydrateFromFile("")).toBe(false)
  })
})

describe("v0.8.4 adversarial — rehydrateFromFile injection resistance", () => {
  test("path-traversal sessionId cannot read a file outside the snapshot dir", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    // Plant a valid-looking trace OUTSIDE the snapshot dir, then try to reach it
    // via traversal. The sanitizer collapses / \ . : to _, so the lookup stays
    // inside the snapshot dir and finds nothing.
    const evil = "../../../../" + path.basename(outside.path) + "/ses_secret"
    await fs.writeFile(
      path.join(outside.path, "ses_secret.json"),
      JSON.stringify({
        version: 2,
        traceId: "t",
        sessionId: "ses_secret",
        metadata: { prompt: "SECRET" },
        spans: [{ spanId: "r", parentSpanId: null, name: "ses_secret", kind: "session", startTime: 0, status: "ok" }],
      }),
    )
    const trace = makeTrace(tmp.path)
    expect(await trace.rehydrateFromFile(evil)).toBe(false)
  })

  test("__proto__ payload in a trace file does not pollute Object.prototype", async () => {
    await using tmp = await tmpdir()
    const id = "ses_proto_pollution"
    // Hand-written so the literal `__proto__` key survives (JSON.stringify of a
    // normal object would not emit it). A tampered/hostile trace file must never
    // mutate the running process's prototype chain when reconstructed.
    const raw = `{
      "version": 2,
      "traceId": "t",
      "sessionId": "${id}",
      "metadata": { "__proto__": { "polluted": "yes" } },
      "spans": [
        { "spanId": "r", "parentSpanId": null, "name": "${id}", "kind": "session", "startTime": 0, "status": "ok",
          "__proto__": { "pollutedSpan": "yes" } }
      ]
    }`
    await stageRaw(tmp.path, id, raw)
    const trace = makeTrace(tmp.path)
    expect(await trace.rehydrateFromFile(id)).toBe(true)
    // No prototype pollution leaked into the global Object prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).pollutedSpan).toBeUndefined()
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe("v0.8.4 adversarial — interrupt status disambiguation (#895 review follow-up)", () => {
  test("rehydrated in-flight generation span is marked interrupted AND explicitly not-an-agent-failure", async () => {
    await using tmp = await tmpdir()
    const id = "ses_interrupt_msg"

    const original = makeTrace(tmp.path)
    original.startTrace(id, {})
    original.logStepStart({ id: "step-1" } as any) // opens a generation span
    original.logToolCall({ tool: "read", state: { status: "completed", input: { f: "a" } } } as any) // forces snapshot
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
    expect(gen?.status).toBe("error") // boundary stays visible in the waterfall
    const msg = String(gen?.statusMessage ?? "")
    // The reworded message must keep "interrupted" (the rehydrate behavioral
    // contract) and must spell out that this is a recorder restart, not a failure,
    // so an on-call reader doesn't chase a phantom incident.
    expect(msg).toMatch(/interrupted/i)
    expect(msg).toMatch(/not an agent failure/i)
    // Guard against regressing back to the old internal jargon.
    expect(msg).not.toMatch(/cache eviction/i)
  })
})

describe("v0.8.4 adversarial — logUserMessage boundary + chat-tab injection", () => {
  test("input is truncated at the cap boundary, not one char over", async () => {
    await using tmp = await tmpdir()
    const id = "ses_user_truncation"
    const trace = makeTrace(tmp.path)
    trace.startTrace(id, {})
    // Exactly at the cap: preserved verbatim (slice only fires for length > cap).
    trace.logUserMessage("a".repeat(USER_MESSAGE_INPUT_MAX_CHARS))
    // One over the cap: truncated to exactly the cap.
    trace.logUserMessage("b".repeat(USER_MESSAGE_INPUT_MAX_CHARS + 1))
    // Empty string: not recorded at all.
    trace.logUserMessage("")
    await trace.flush()

    const file = await readTraceFile(tmp.path, id)
    const userSpans = file.spans.filter((s) => s.kind === "user-message")
    expect(userSpans).toHaveLength(2)
    expect((userSpans[0] as any).input.length).toBe(USER_MESSAGE_INPUT_MAX_CHARS)
    expect((userSpans[1] as any).input.length).toBe(USER_MESSAGE_INPUT_MAX_CHARS)
    expect((userSpans[1] as any).input.endsWith("b")).toBe(true)
  })

  test("a </script> payload in a user message cannot break out of the viewer's embedded JSON", async () => {
    await using tmp = await tmpdir()
    const id = "ses_xss_breakout"
    const payload = "</script><img src=x onerror=alert(1)>"

    const trace = makeTrace(tmp.path)
    trace.startTrace(id, { prompt: payload })
    trace.logUserMessage(payload) // #895 added user-message spans to the chat tab
    trace.logToolCall({ tool: "read", state: { status: "completed", input: { f: "a" } } } as any)
    await trace.flush()

    const file = await readTraceFile(tmp.path, id)
    const html = renderTraceViewer(file)

    // The raw payload must never appear verbatim — that would close the inline
    // <script> and inject an <img onerror> into the page.
    expect(html).not.toContain("</script><img src=x onerror=alert(1)>")
    // It must instead appear in escaped form (the `<\/` replacement on the
    // embedded trace JSON), proving the data was neutralized, not dropped.
    expect(html).toContain("<\\/script>")
  })
})
