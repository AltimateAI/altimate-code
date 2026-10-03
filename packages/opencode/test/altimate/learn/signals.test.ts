// altimate_change - new file
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
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
  test("records the documented fields under the default named lesson store", async () => {
    const s = await Signals.appendSignal(root, { ...base, messageID: "msg_1", text: "no, use ref()" })
    expect(s).toMatchObject({ kind: "user_correction", sessionID: "ses_1", messageID: "msg_1", text: "no, use ref()", status: "open" })
    expect(s!.id).toStartWith("sig_")
    expect(Number.isNaN(Date.parse(s!.at))).toBe(false)
    const raw = await fs.readFile(path.join(root, ".altimate-code", "learn", "team-playbook", "signals.jsonl"), "utf8")
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

  test("list filters by session; a corrupt line is quarantined once", async () => {
    await Signals.appendSignal(root, { ...base, messageID: "m1", text: "a" })
    await Signals.appendSignal(root, { ...base, sessionID: "ses_2", messageID: "m1", text: "b" })
    await fs.appendFile(Signals.signalsFile(root), "not json\n")
    expect((await Signals.listSignals(root, { session: "ses_2" })).map((s) => s.text)).toEqual(["b"])
    expect(await Signals.readSignals(root)).toHaveLength(2)
    const file = Signals.signalsFile(root)
    expect((await fs.readdir(path.dirname(file))).filter((name) => name.startsWith("signals.jsonl.malformed-"))).toHaveLength(1)
    expect(await fs.readFile(file, "utf8")).not.toContain("not json")
  })

  test("interrupted named signal repair preserves valid rows and reuses its backup", async () => {
    const name = "backend-rules"
    const signal = (await Signals.appendSignal(root, { ...base, text: "Use explicit columns." }, name))!
    const file = Signals.signalsFile(root, name)
    await fs.appendFile(file, "not json\n")
    const before = await fs.readFile(file, "utf8")
    const rename = fs.rename
    const failure = spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[1]) === file) throw new Error("interrupted signal repair")
      return rename(...args)
    })
    try {
      await expect(Signals.readSignals(root, name)).rejects.toThrow("interrupted signal repair")
      expect(await fs.readFile(file, "utf8")).toBe(before)
    } finally { failure.mockRestore() }
    expect(await Signals.readSignals(root, name)).toEqual([signal])
    const backups = (await fs.readdir(path.dirname(file))).filter((name) => name.startsWith("signals.jsonl.malformed-"))
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(path.join(path.dirname(file), backups[0]), "utf8")).toBe(before)
    expect((await fs.stat(path.join(path.dirname(file), backups[0]))).mode & 0o777).toBe(0o600)
  })

  test("missing file reads as empty", async () => {
    expect(await Signals.readSignals(root)).toEqual([])
    expect(await fs.readdir(root)).toEqual([])
  })

  test("custom stores have independent append, read, filter and consumption", async () => {
    const custom = "backend-rules"
    const original = (await Signals.appendSignal(root, { ...base, text: "Use explicit columns." }))!
    const named = (await Signals.appendSignal(root, { ...base, text: "Use explicit columns." }, custom))!
    expect(named.id).not.toBe(original.id)
    expect(await Signals.readSignals(root, custom)).toEqual([named])
    expect(await Signals.consumeSignals(root, [named.id], "reflect@named", custom)).toBe(1)
    expect(await Signals.listSignals(root, {}, custom)).toEqual([])
    expect(await Signals.listSignals(root)).toEqual([original])
    expect(await Signals.listSignals(root, { all: true }, custom)).toHaveLength(1)
  })

  test("legacy project signals migrate only into the default store, once", async () => {
    const signal = (await Signals.appendSignal(root, { ...base, text: "Use explicit columns." }))!
    const legacy = path.join(root, ".altimate-code", "learn", "signals.jsonl")
    await fs.rename(Signals.signalsFile(root), legacy)
    expect(await Signals.readSignals(root, "backend-rules")).toEqual([])
    expect(await Bun.file(legacy).exists()).toBe(true)
    expect(await Signals.readSignals(root)).toEqual([signal])
    expect(await Bun.file(legacy).exists()).toBe(false)
    expect(await Signals.readSignals(root)).toEqual([signal])
    expect(await Signals.readSignals(root, "backend-rules")).toEqual([])
  })

  test("malformed legacy signals are quarantined once while valid records survive", async () => {
    const signal = (await Signals.appendSignal(root, { ...base, text: "Use explicit columns." }))!
    const legacy = path.join(root, ".altimate-code", "learn", "signals.jsonl")
    await fs.rename(Signals.signalsFile(root), legacy)
    await fs.appendFile(legacy, 'not json\n{"id":"broken","text":"missing fields"}\n')
    expect(await Signals.readSignals(root)).toEqual([signal])
    expect(await Signals.readSignals(root)).toEqual([signal])
    const backups = (await fs.readdir(path.dirname(legacy))).filter((name) => name.startsWith("signals.jsonl.malformed-"))
    expect(backups).toHaveLength(1)
    expect(await fs.readFile(path.join(path.dirname(legacy), backups[0]), "utf8")).toContain("not json")
  })

  test("interrupted legacy import merges by identity and preserves newer consumption on rerun", async () => {
    const signal = (await Signals.appendSignal(root, { ...base, text: "Use explicit columns." }))!
    const legacy = path.join(root, ".altimate-code", "learn", "signals.jsonl")
    // Destination already written, legacy removal interrupted. A later consumer has changed state.
    await Signals.consumeSignals(root, [signal.id], "reflect@newer")
    await fs.writeFile(legacy, JSON.stringify(signal) + "\n")
    const imported = await Signals.readSignals(root)
    expect(imported).toHaveLength(1)
    expect(imported[0]).toMatchObject({ id: signal.id, status: "consumed", consumedBy: "reflect@newer" })
    expect(await Bun.file(legacy).exists()).toBe(false)
    expect(await Signals.readSignals(root)).toEqual(imported)
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
