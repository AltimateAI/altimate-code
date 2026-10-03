// altimate_change - new file
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Capture, RETRY_THRESHOLD, ToolRetryTracker, type PartLike } from "../../../src/altimate/learn/capture"
import * as Signals from "../../../src/altimate/learn/signals"

const call = (id: string, tool: string, status: "error" | "completed" | "running", error = "boom", messageID = "m1") => ({
  id,
  messageID,
  tool,
  state: { status, error },
})

describe("ToolRetryTracker", () => {
  test("fires once when the same tool fails 3 times in a row", () => {
    const t = new ToolRetryTracker()
    expect(RETRY_THRESHOLD).toBe(3)
    expect(t.observe(call("1", "bash", "error"))).toBeUndefined()
    expect(t.observe(call("2", "bash", "error"))).toBeUndefined()
    expect(t.observe(call("3", "bash", "error", "last failure"))).toMatchObject({ tool: "bash", count: 3, error: "last failure" })
    // The episode continues: no second signal.
    expect(t.observe(call("4", "bash", "error"))).toBeUndefined()
    expect(t.observe(call("5", "bash", "error"))).toBeUndefined()
  })

  test("a success or a different tool breaks the streak", () => {
    const t = new ToolRetryTracker()
    t.observe(call("1", "bash", "error"))
    t.observe(call("2", "bash", "error"))
    expect(t.observe(call("3", "bash", "completed"))).toBeUndefined()
    expect(t.observe(call("4", "bash", "error"))).toBeUndefined()
    expect(t.observe(call("5", "read", "error"))).toBeUndefined()
    expect(t.observe(call("6", "bash", "error"))).toBeUndefined()
    expect(t.observe(call("7", "bash", "error"))).toBeUndefined()
    expect(t.observe(call("8", "bash", "error"))).toMatchObject({ count: 3 })
  })

  test("a new episode after a success is reported again", () => {
    const t = new ToolRetryTracker()
    for (const id of ["1", "2", "3"]) t.observe(call(id, "bash", "error"))
    t.observe(call("4", "bash", "completed"))
    t.observe(call("5", "bash", "error"))
    t.observe(call("6", "bash", "error"))
    expect(t.observe(call("7", "bash", "error", "again", "m9"))).toMatchObject({ messageID: "m9", error: "again" })
  })

  test("republished states of one call count once; non-terminal states are ignored", () => {
    const t = new ToolRetryTracker()
    t.observe(call("1", "bash", "error"))
    t.observe(call("1", "bash", "error"))
    t.observe(call("1", "bash", "error"))
    t.observe(call("2", "bash", "running"))
    expect(t.observe(call("2", "bash", "error"))).toBeUndefined()
    expect(t.observe(call("3", "bash", "error"))).toMatchObject({ count: 3 })
  })

  test("the last error is clipped", () => {
    const t = new ToolRetryTracker()
    t.observe(call("1", "x", "error"))
    t.observe(call("2", "x", "error"))
    expect(t.observe(call("3", "x", "error", "e".repeat(5000)))!.error.length).toBe(500)
  })

  test("bounds terminal part history while retaining recent duplicate protection", () => {
    const t = new ToolRetryTracker()
    for (let i = 0; i < 2048; i++) t.observe(call(`done${i}`, "bash", "completed"))
    expect(t["seen"].size).toBeLessThanOrEqual(1024)
    expect(t.observe(call("done2047", "bash", "error"))).toBeUndefined()
    expect(t.observe(call("new1", "bash", "error"))).toBeUndefined()
    expect(t.observe(call("new2", "bash", "error"))).toBeUndefined()
    expect(t.observe(call("new3", "bash", "error"))).toMatchObject({ count: 3 })
  })
})

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-capture-"))
})
afterEach(() => fs.rm(root, { recursive: true, force: true }))

function make(hasPrior: (s: string, m: string) => boolean | Promise<boolean> = () => true) {
  return new Capture({
    hasPriorAssistant: async (s, m) => hasPrior(s, m),
    record: (signal) => Signals.appendSignal(root, signal),
  })
}
const userMsg = (id: string, sessionID = "s1") => ({ id, sessionID, role: "user" })
const text = (messageID: string, t: string, extra: Partial<PartLike> = {}): PartLike => ({
  id: `p_${messageID}`,
  sessionID: "s1",
  messageID,
  type: "text",
  text: t,
  ...extra,
})

describe("Capture: user corrections", () => {
  test("a correction after a completed assistant message is recorded", async () => {
    const c = make()
    c.onMessage(userMsg("u2"))
    c.onPart(text("u2", "no, we never use select *; always list columns explicitly"))
    await c.flush()
    const [s] = await Signals.readSignals(root)
    expect(s).toMatchObject({ kind: "user_correction", sessionID: "s1", messageID: "u2", status: "open" })
    expect(s.text).toContain("never use select *")
  })

  test("the first prompt of a session is a task, not a correction", async () => {
    const c = make(() => false)
    c.onMessage(userMsg("u1"))
    c.onPart(text("u1", "no, don't use select * in the file you create"))
    await c.flush()
    expect(await Signals.readSignals(root)).toEqual([])
  })

  test("a completed assistant message seen on the bus counts without a lookup", async () => {
    let lookups = 0
    const c = make(() => {
      lookups++
      return false
    })
    c.onMessage({ id: "a1", sessionID: "s1", role: "assistant", time: { completed: 1 } })
    c.onMessage(userMsg("u2"))
    c.onPart(text("u2", "that's wrong"))
    await c.flush()
    expect(lookups).toBe(0)
    expect(await Signals.readSignals(root)).toHaveLength(1)
  })

  test("a still-running assistant message does not make the next user message a correction", async () => {
    const c = make(() => false)
    c.onMessage({ id: "a1", sessionID: "s1", role: "assistant", time: {} })
    c.onMessage(userMsg("u2"))
    c.onPart(text("u2", "that's wrong"))
    await c.flush()
    expect(await Signals.readSignals(root)).toEqual([])
  })

  test("non-corrections, synthetic and ignored parts, assistant text and unknown messages are skipped", async () => {
    const c = make()
    c.onMessage(userMsg("u2"))
    c.onMessage({ id: "a2", sessionID: "s1", role: "assistant", time: { completed: 1 } })
    c.onPart(text("u2", "thanks, LGTM"))
    c.onPart({ ...text("u2", "that's wrong"), id: "p_syn", synthetic: true })
    c.onPart({ ...text("u2", "that's wrong"), id: "p_ign", ignored: true })
    c.onPart(text("a2", "that's wrong"))
    c.onPart(text("never-announced", "that's wrong"))
    await c.flush()
    expect(await Signals.readSignals(root)).toEqual([])
  })

  test("republishing the same part records one signal", async () => {
    const c = make()
    c.onMessage(userMsg("u2"))
    for (let i = 0; i < 3; i++) c.onPart(text("u2", "that's wrong"))
    await c.flush()
    expect(await Signals.readSignals(root)).toHaveLength(1)
  })

  test("a failing store is swallowed", async () => {
    const c = new Capture({
      hasPriorAssistant: async () => true,
      record: async () => {
        throw new Error("disk full")
      },
    })
    c.onMessage(userMsg("u2"))
    expect(() => c.onPart(text("u2", "that's wrong"))).not.toThrow()
    await c.flush()
  })

  test("a failing history lookup is swallowed", async () => {
    const c = make(() => {
      throw new Error("db gone")
    })
    c.onMessage(userMsg("u2"))
    c.onPart(text("u2", "that's wrong"))
    await c.flush()
    expect(await Signals.readSignals(root)).toEqual([])
  })

  test("bounds user message and assistant session caches while keeping recent corrections", async () => {
    const c = make()
    for (let i = 0; i < 2048; i++) {
      c.onMessage(userMsg(`u${i}`, `s${i}`))
      c.onMessage({ id: `a${i}`, sessionID: `s${i}`, role: "assistant", time: { completed: 1 } })
    }
    expect(c["userMessages"].size).toBeLessThanOrEqual(1024)
    expect(c["sessionsWithAssistant"].size).toBeLessThanOrEqual(128)
    c.onPart(text("u2047", "that's wrong", { sessionID: "s2047" }))
    await c.flush()
    expect(await Signals.readSignals(root)).toHaveLength(1)
  })

  test("an evicted assistant session still uses history to classify a new correction", async () => {
    let lookups = 0
    const c = make(() => {
      lookups++
      return true
    })
    for (let i = 0; i < 129; i++) {
      c.onMessage({ id: `a${i}`, sessionID: `s${i}`, role: "assistant", time: { completed: 1 } })
    }
    c.onMessage(userMsg("returning", "s0"))
    c.onPart(text("returning", "that's wrong", { sessionID: "s0" }))
    await c.flush()
    expect(lookups).toBe(1)
    expect(await Signals.readSignals(root)).toHaveLength(1)
  })
})

describe("Capture: tool retries", () => {
  const tool = (id: string, status: string, error?: string, messageID = "a1"): PartLike => ({
    id,
    sessionID: "s1",
    messageID,
    type: "tool",
    tool: "dbt_run",
    state: { status, error },
  })

  test("records one tool_retry per episode with the tool name and last error", async () => {
    const c = make()
    for (const [i, err] of ["e1", "e2", "e3", "e4"].entries()) c.onPart(tool(`t${i}`, "error", err, `a${i}`))
    await c.flush()
    const signals = await Signals.readSignals(root)
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ kind: "tool_retry", sessionID: "s1", messageID: "a2" })
    expect(signals[0].text).toContain("`dbt_run`")
    expect(signals[0].text).toContain("3 consecutive")
    expect(signals[0].text).toContain("e3")
  })

  test("two failures then a success records nothing", async () => {
    const c = make()
    c.onPart(tool("t1", "error", "x"))
    c.onPart(tool("t2", "error", "x"))
    c.onPart(tool("t3", "completed"))
    c.onPart(tool("t4", "error", "x"))
    await c.flush()
    expect(await Signals.readSignals(root)).toEqual([])
  })

  test("sessions are tracked separately", async () => {
    const c = make()
    for (const [i, sid] of ["s1", "s2", "s1", "s2"].entries()) c.onPart({ ...tool(`t${i}`, "error", "x"), sessionID: sid })
    await c.flush()
    expect(await Signals.readSignals(root)).toEqual([])
  })

  test("distinct retry episodes in one message retain the triggering part identity", async () => {
    const c = make()
    for (const id of ["t1", "t2", "t3"]) c.onPart(tool(id, "error", "first"))
    c.onPart(tool("t4", "completed"))
    for (const id of ["t5", "t6", "t7"]) c.onPart(tool(id, "error", "second"))
    c.onPart(tool("t7", "error", "second"))
    await c.flush()
    const signals = await Signals.readSignals(root)
    expect(signals).toHaveLength(2)
    expect(signals.map((signal) => signal.partID).sort()).toEqual(["t3", "t7"])
  })

  test("bounds session trackers and preserves the most recently active retry streak", async () => {
    const c = make()
    for (let i = 0; i < 128; i++) c.onPart({ ...tool(`t${i}`, "error", "x"), sessionID: `s${i}` })
    c.onPart({ ...tool("active2", "error", "x"), sessionID: "s0" })
    c.onPart({ ...tool("overflow", "error", "x"), sessionID: "s128" })
    expect(c["trackers"].size).toBeLessThanOrEqual(128)
    c.onPart({ ...tool("active3", "error", "x"), sessionID: "s0" })
    await c.flush()
    expect(await Signals.readSignals(root)).toHaveLength(1)
  })
})
