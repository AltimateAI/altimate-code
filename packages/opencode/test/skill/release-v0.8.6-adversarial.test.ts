/**
 * Adversarial tests for v0.8.6 — session traces in headless serve mode (#886)
 * and the release-review fixes (concurrent flush, session.deleted eviction,
 * reconnect resilience).
 *
 * Covers the FINAL shipping code, including the Step-5 release fixes:
 *   - TraceConsumer.handleEvent must never throw on hostile/malformed input
 *   - sessionID sanitization (no path traversal escaping the trace dir)
 *   - no prototype pollution from attacker-controlled event objects
 *   - type confusion (non-string text/title/status) is coerced, not fatal
 *   - the parentID-only session resolution fallback (previously untested)
 *   - flush() finalizes many sessions concurrently
 *   - session.deleted with malformed payloads is a safe no-op
 *   - subscribeTraceConsumer survives a throwing/empty event source, reconnects,
 *     and stop() is bounded + idempotent
 *
 * Determinism: file-visibility assertions poll via waitFor (snapshot/endTrace
 * writes are async + debounced) — no fixed sleeps. No mock.module().
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import {
  TraceConsumer,
  subscribeTraceConsumer,
  type TraceEventSource,
} from "../../src/altimate/observability/trace-consumer"
import { FileExporter, type TraceFile } from "../../src/altimate/observability/tracing"

let tmpDir: string

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `trace-adv-086-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

function makeConsumer() {
  return new TraceConsumer({ exporters: [new FileExporter(tmpDir)] })
}

async function waitFor<T>(read: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    try {
      const v = await read()
      if (predicate(v)) return v
    } catch {
      // not ready
    }
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met within timeout")
    await new Promise((r) => setTimeout(r, 10))
  }
}

function userMsg(sessionID: string, id: string, text: string) {
  const now = Date.now()
  return [
    { type: "message.updated", properties: { info: { id, sessionID, role: "user", time: { created: now } } } },
    {
      type: "message.part.updated",
      properties: { part: { sessionID, messageID: id, type: "text", text, time: { end: now } } },
    },
  ]
}

function toolEvent(sessionID: string, callID: string) {
  const now = Date.now()
  return {
    type: "message.part.updated",
    properties: {
      part: {
        sessionID,
        type: "tool",
        tool: "bash",
        callID,
        state: { status: "completed", input: { command: "ls" }, output: "ok", time: { start: now - 5, end: now } },
      },
    },
  }
}

describe("v0.8.6 adversarial — TraceConsumer hostile input", () => {
  test("malformed / hostile events never throw", async () => {
    const consumer = makeConsumer()
    const hostile: unknown[] = [
      null,
      undefined,
      0,
      "",
      [],
      { type: "message.updated", properties: { info: { sessionID: 123 } } }, // numeric sessionID
      { type: "message.part.updated", properties: { part: { sessionID: {}, type: "text", text: "x" } } }, // object sessionID
      { type: "message.part.updated", properties: { part: { sessionID: "s", type: "tool", state: null } } },
      { type: "session.updated", properties: { info: { id: "s" } } }, // missing title
      { type: "session.deleted", properties: {} }, // missing info
      { type: "session.deleted", properties: { info: {} } }, // missing id
      { type: "session.deleted", properties: { info: { id: "never-seen" } } }, // unknown session
      { type: "totally.unknown.event", properties: { foo: "bar" } },
    ]
    for (const e of hostile) {
      await expect(consumer.handleEvent(e)).resolves.toBeUndefined()
    }
    await consumer.flush()
  })

  test("sessionID path traversal cannot escape the trace directory", async () => {
    const consumer = makeConsumer()
    const evil = "../../../../tmp/pwned-" + Math.random().toString(36).slice(2)
    await consumer.handleEvent({
      type: "message.updated",
      properties: { info: { id: "u1", sessionID: evil, role: "user", time: { created: Date.now() } } },
    })
    await consumer.handleEvent(toolEvent(evil, "c1"))
    await consumer.flush()

    // No file may be written outside tmpDir. The id is sanitized (slashes/dots
    // replaced), so any file produced lives directly under tmpDir.
    const escaped = path.resolve("/tmp", path.basename(evil) + ".json")
    // The sanitized name replaces the leading ../ etc with underscores → it
    // must NOT exist at the traversal target.
    const traversed = path.resolve(tmpDir, evil + ".json")
    await expect(fs.access(traversed)).rejects.toBeDefined()
    await expect(fs.access(escaped)).rejects.toBeDefined()
    const files = await fs.readdir(tmpDir)
    for (const f of files) {
      expect(f.includes("/")).toBe(false)
      expect(f.includes("..")).toBe(false)
    }
  })

  test("prototype-pollution payload does not pollute Object.prototype", async () => {
    const consumer = makeConsumer()
    const payload = JSON.parse('{"type":"message.part.updated","properties":{"part":{"sessionID":"ses_pp","type":"text","messageID":"m","text":"hi","__proto__":{"polluted":"yes"}}}}')
    await consumer.handleEvent(payload)
    await consumer.handleEvent({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses_pp", type: "text", text: "hi", constructor: { prototype: { polluted2: true } } },
      },
    })
    await consumer.flush()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined()
  })

  test("type-confused fields are coerced, not fatal", async () => {
    const consumer = makeConsumer()
    const sid = "ses_typeconf"
    // user message whose summary.title is an object, text part whose text is a number
    await consumer.handleEvent({
      type: "message.updated",
      properties: {
        info: { id: "u1", sessionID: sid, role: "user", summary: { title: { nested: 1 } }, time: { created: Date.now() } },
      },
    })
    await consumer.handleEvent({
      type: "message.part.updated",
      properties: { part: { sessionID: sid, messageID: "u1", type: "text", text: 42 } },
    })
    // session.updated with a numeric title
    await consumer.handleEvent({ type: "session.updated", properties: { info: { id: sid, title: 999 } } })
    await consumer.flush()
    const trace = await waitFor(
      () => fs.readFile(path.join(tmpDir, `${sid}.json`), "utf8").then((r) => JSON.parse(r) as TraceFile),
      () => true,
    )
    // It wrote a valid file with string-coerced title.
    expect(typeof trace.metadata.title).toBe("string")
  })

  test("parentID-only assistant message resolves its session (fallback path)", async () => {
    const consumer = makeConsumer()
    const sid = "ses_parentid"
    // user message establishes the user-msg-id -> session mapping
    for (const e of userMsg(sid, "msg-user-1", "do it")) await consumer.handleEvent(e)
    // assistant message.updated WITHOUT sessionID, only parentID pointing at the user msg
    await consumer.handleEvent({
      type: "message.updated",
      properties: {
        info: {
          id: "msg-asst-1",
          parentID: "msg-user-1",
          role: "assistant",
          modelID: "gpt-4o",
          providerID: "openai",
          agent: "general",
          time: { created: Date.now() },
        },
      },
    })
    await consumer.flush()
    const trace = await waitFor(
      () => fs.readFile(path.join(tmpDir, `${sid}.json`), "utf8").then((r) => JSON.parse(r) as TraceFile),
      (t) => !!t.metadata.model,
    )
    // enrichFromAssistant ran via the parentID fallback → model populated.
    expect(trace.metadata.model).toBe("openai/gpt-4o")
  })

  test("flush() finalizes many concurrent sessions (parallel finalization)", async () => {
    const consumer = makeConsumer()
    const ids = Array.from({ length: 12 }, (_, i) => `ses_par_${i}`)
    for (const sid of ids) {
      for (const e of userMsg(sid, `u-${sid}`, "hi")) await consumer.handleEvent(e)
      await consumer.handleEvent(toolEvent(sid, `c-${sid}`))
    }
    await consumer.flush()
    for (const sid of ids) {
      const trace = await waitFor(
        () => fs.readFile(path.join(tmpDir, `${sid}.json`), "utf8").then((r) => JSON.parse(r) as TraceFile),
        (t) => t.summary.status === "completed",
      )
      expect(trace.summary.status).toBe("completed")
      expect(trace.summary.totalToolCalls).toBe(1)
    }
  })

  test("session.deleted evicts state; a later event re-creates from disk, not clobbering", async () => {
    const consumer = makeConsumer()
    const sid = "ses_del_recreate"
    for (const e of userMsg(sid, "u1", "first")) await consumer.handleEvent(e)
    await consumer.handleEvent(toolEvent(sid, "c1"))
    await consumer.handleEvent({ type: "session.deleted", properties: { info: { id: sid } } })
    const finalized = await waitFor(
      () => fs.readFile(path.join(tmpDir, `${sid}.json`), "utf8").then((r) => JSON.parse(r) as TraceFile),
      (t) => t.summary.status === "completed",
    )
    expect(finalized.summary.totalToolCalls).toBe(1)
    // A late event for the same (now-evicted) session must rehydrate the rich
    // on-disk trace, not overwrite it with an empty one.
    await consumer.handleEvent(toolEvent(sid, "c2"))
    await consumer.flush()
    const after = await waitFor(
      () => fs.readFile(path.join(tmpDir, `${sid}.json`), "utf8").then((r) => JSON.parse(r) as TraceFile),
      (t) => t.summary.totalToolCalls >= 2,
    )
    expect(after.summary.totalToolCalls).toBe(2)
  })
})

describe("v0.8.6 adversarial — subscribeTraceConsumer resilience", () => {
  function source(events: unknown[], opts?: { throwAfter?: number; holdUntilAbort?: AbortSignal }): TraceEventSource {
    async function* gen() {
      let i = 0
      for (const e of events) {
        yield e
        i++
        if (opts?.throwAfter !== undefined && i >= opts.throwAfter) throw new Error("adversarial disconnect")
      }
      const sig = opts?.holdUntilAbort
      if (sig) {
        await new Promise<void>((resolve) => {
          if (sig.aborted) return resolve()
          sig.addEventListener("abort", () => resolve(), { once: true })
        })
      }
    }
    return { stream: gen() }
  }

  test("survives repeated subscribe failures (undefined) then recovers and finalizes", async () => {
    const consumer = makeConsumer()
    let calls = 0
    const sub = subscribeTraceConsumer(
      { directory: tmpDir },
      {
        consumer,
        subscribe: async (signal) => {
          calls++
          // First two connects fail outright (undefined → backoff+retry).
          if (calls <= 2) return undefined
          // Third delivers a session, then holds open.
          if (calls === 3) {
            return source([...userMsg("ses_recover", "u1", "hi"), toolEvent("ses_recover", "c1")], {
              holdUntilAbort: signal,
            })
          }
          return source([], { holdUntilAbort: signal })
        },
      },
    )
    const trace = await waitFor(
      () => fs.readFile(path.join(tmpDir, "ses_recover.json"), "utf8").then((r) => JSON.parse(r) as TraceFile),
      (t) => t.summary.totalToolCalls >= 1,
    )
    expect(trace.summary.totalToolCalls).toBe(1)
    expect(calls).toBeGreaterThanOrEqual(3)
    await sub.stop()
  })

  test("a subscribe() that throws synchronously does not crash the loop", async () => {
    const consumer = makeConsumer()
    let calls = 0
    const sub = subscribeTraceConsumer(
      { directory: tmpDir },
      {
        consumer,
        subscribe: async (signal) => {
          calls++
          if (calls === 1) throw new Error("subscribe blew up")
          return source([...userMsg("ses_throw", "u1", "hi"), toolEvent("ses_throw", "c1")], {
            holdUntilAbort: signal,
          })
        },
      },
    )
    const trace = await waitFor(
      () => fs.readFile(path.join(tmpDir, "ses_throw.json"), "utf8").then((r) => JSON.parse(r) as TraceFile),
      (t) => t.summary.totalToolCalls >= 1,
    )
    expect(trace.summary.totalToolCalls).toBe(1)
    await sub.stop()
  })

  test("stop() is bounded and idempotent even if the stream never ends", async () => {
    const consumer = makeConsumer()
    const sub = subscribeTraceConsumer(
      { directory: tmpDir },
      {
        consumer,
        subscribe: async (signal) => source([...userMsg("ses_stop", "u1", "hi")], { holdUntilAbort: signal }),
      },
    )
    await waitFor(
      () => fs.readFile(path.join(tmpDir, "ses_stop.json"), "utf8").then((r) => JSON.parse(r) as TraceFile),
      () => true,
    )
    // First stop drains + flushes; second stop must be a harmless no-op.
    await sub.stop()
    await sub.stop()
    const trace = JSON.parse(await fs.readFile(path.join(tmpDir, "ses_stop.json"), "utf8")) as TraceFile
    expect(trace.summary.status).toBe("completed")
  })
})
