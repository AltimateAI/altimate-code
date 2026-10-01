// altimate_change - new file
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as Signals from "../../../src/altimate/learn/signals"

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-signals-"))
})
afterEach(() => fs.rm(root, { recursive: true, force: true }))

const base = { kind: "user_correction", sessionID: "ses_1", reason: "r" } as const

describe("signal store", () => {
  test("records the documented fields under .altimate-code/learn/signals.jsonl", async () => {
    const s = await Signals.appendSignal(root, { ...base, messageID: "msg_1", text: "no, use ref()" })
    expect(s).toMatchObject({ kind: "user_correction", sessionID: "ses_1", messageID: "msg_1", text: "no, use ref()", status: "open" })
    expect(s!.id).toStartWith("sig_")
    expect(Number.isNaN(Date.parse(s!.at))).toBe(false)
    const raw = await fs.readFile(path.join(root, ".altimate-code", "learn", "signals.jsonl"), "utf8")
    expect(JSON.parse(raw.trim())).toEqual(s as unknown as Record<string, unknown>)
  })

  test("redacts secrets and clips to 2000 chars", async () => {
    const s = await Signals.appendSignal(root, {
      ...base,
      messageID: "m",
      text: "key sk-abcdef1234567890XYZ " + "z".repeat(5000),
    })
    expect(s!.text).not.toContain("sk-abcdef1234567890XYZ")
    expect(s!.text.length).toBeLessThanOrEqual(Signals.SIGNAL_TEXT_CAP)
  })

  test("dedupes on (session, message, kind)", async () => {
    expect(await Signals.appendSignal(root, { ...base, messageID: "m1", text: "a" })).toBeDefined()
    expect(await Signals.appendSignal(root, { ...base, messageID: "m1", text: "different text" })).toBeUndefined()
    expect(await Signals.appendSignal(root, { ...base, messageID: "m2", text: "a" })).toBeDefined()
    expect(await Signals.appendSignal(root, { ...base, sessionID: "ses_2", messageID: "m1", text: "a" })).toBeDefined()
    expect(await Signals.appendSignal(root, { ...base, kind: "tool_retry", messageID: "m1", text: "a" })).toBeDefined()
    expect(await Signals.readSignals(root)).toHaveLength(4)
  })

  test("without a message id the content identifies the signal", async () => {
    const ci = { kind: "ci", sessionID: "external", reason: "r" } as const
    expect(await Signals.appendSignal(root, { ...ci, text: "build failed" })).toBeDefined()
    expect(await Signals.appendSignal(root, { ...ci, text: "build failed" })).toBeUndefined()
    expect(await Signals.appendSignal(root, { ...ci, text: "lint failed" })).toBeDefined()
  })

  test("concurrent appends of the same signal record it once", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => Signals.appendSignal(root, { ...base, messageID: "same", text: "x" })),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await Signals.readSignals(root)).toHaveLength(1)
  })

  test("empty text is not recorded", async () => {
    expect(await Signals.appendSignal(root, { ...base, messageID: "m", text: "   " })).toBeUndefined()
    expect(await Signals.readSignals(root)).toEqual([])
  })

  test("consume marks open signals once and keeps the rest untouched", async () => {
    const a = (await Signals.appendSignal(root, { ...base, messageID: "m1", text: "a" }))!
    const b = (await Signals.appendSignal(root, { ...base, messageID: "m2", text: "b" }))!
    expect(await Signals.consumeSignals(root, [a.id], "reflect@t1")).toBe(1)
    expect(await Signals.consumeSignals(root, [a.id], "reflect@t2")).toBe(0)
    const all = await Signals.readSignals(root)
    expect(all.find((s) => s.id === a.id)).toMatchObject({ status: "consumed", consumedBy: "reflect@t1" })
    expect(all.find((s) => s.id === b.id)).toMatchObject({ status: "open" })
    expect((await Signals.listSignals(root)).map((s) => s.id)).toEqual([b.id])
    expect(await Signals.listSignals(root, { all: true })).toHaveLength(2)
  })

  test("list filters by session; a corrupt line is skipped", async () => {
    await Signals.appendSignal(root, { ...base, messageID: "m1", text: "a" })
    await Signals.appendSignal(root, { ...base, sessionID: "ses_2", messageID: "m1", text: "b" })
    await fs.appendFile(Signals.signalsFile(root), "not json\n")
    expect((await Signals.listSignals(root, { session: "ses_2" })).map((s) => s.text)).toEqual(["b"])
    expect(await Signals.readSignals(root)).toHaveLength(2)
  })

  test("missing file reads as empty", async () => {
    expect(await Signals.readSignals(root)).toEqual([])
  })

  test("pendingSessions keeps first-seen order and ignores consumed", async () => {
    const x = (await Signals.appendSignal(root, { ...base, sessionID: "s2", messageID: "m", text: "x" }))!
    await Signals.appendSignal(root, { ...base, sessionID: "s1", messageID: "m", text: "y" })
    await Signals.appendSignal(root, { ...base, sessionID: "s2", messageID: "n", text: "z" })
    expect(Signals.pendingSessions(await Signals.readSignals(root))).toEqual(["s2", "s1"])
    await Signals.consumeSignals(root, [x.id], "c")
    const rest = await Signals.readSignals(root)
    await Signals.consumeSignals(root, rest.filter((s) => s.sessionID === "s2").map((s) => s.id), "c")
    expect(Signals.pendingSessions(await Signals.readSignals(root))).toEqual(["s1"])
  })
})

describe("feedbackFromSignals", () => {
  const sig = (kind: Signals.SignalKind, text: string) =>
    ({ id: "i", kind, sessionID: "s", text, reason: "", at: "", status: "open" }) as Signals.Signal

  test("user kind when any user correction, text prefixed with each kind", () => {
    const f = Signals.feedbackFromSignals([sig("tool_retry", "t"), sig("user_correction", "u")])
    expect(f.kind).toBe("user")
    expect(f.text).toBe("[tool_retry] t\n\n[user_correction] u")
  })
  test("ci for tool retries", () => {
    expect(Signals.feedbackFromSignals([sig("tool_retry", "t"), sig("review", "r")]).kind).toBe("ci")
  })
  test("otherwise the signal's own kind", () => {
    expect(Signals.feedbackFromSignals([sig("review", "r")]).kind).toBe("review")
    expect(Signals.feedbackFromSignals([sig("ci", "c")]).kind).toBe("ci")
  })
})
