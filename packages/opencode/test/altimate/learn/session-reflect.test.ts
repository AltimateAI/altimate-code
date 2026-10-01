// altimate_change - new file
//
// `reflect --session` from captured signals, with the model call and the session source stubbed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as Signals from "../../../src/altimate/learn/signals"
import * as Store from "../../../src/altimate/learn/store"
import { reflectSessionSignals } from "../../../src/altimate/learn/session-reflect"
import type { Generate } from "../../../src/altimate/learn/reflect"
import { autoReflectEnabled, captureEnabled } from "../../../src/altimate/learn/capture"
import { learnModel } from "../../../src/altimate/learn/auto"

const NAME = "team-playbook"
let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-session-"))
})
afterEach(() => fs.rm(root, { recursive: true, force: true }))

const source = async () => ({ prompts: ["create notes.sql"], calls: [] })
const addRule: Generate = async () => ({
  deltas: [{ op: "ADD", text: "List columns explicitly instead of using select star.", reason: "user correction" }],
})

async function seed(kind: Signals.SignalKind, text: string, session = "ses_1", messageID?: string) {
  return (await Signals.appendSignal(root, { kind, sessionID: session, messageID, text, reason: "r" }))!
}

describe("reflectSessionSignals", () => {
  test("no open signals: reports none, never resolves a model", async () => {
    let resolved = false
    const out = await reflectSessionSignals({
      root,
      name: NAME,
      sessionID: "ses_1",
      loadSource: source,
      getGenerate: async () => {
        resolved = true
        return addRule
      },
    })
    expect(out).toEqual({ status: "none" })
    expect(resolved).toBe(false)
  })

  test("uses the signals as feedback and consumes them on success", async () => {
    const a = await seed("user_correction", "no, never use select *", "ses_1", "m1")
    await seed("tool_retry", "Tool `bash` failed 3 consecutive times. Last error: boom", "ses_1", "m2")
    const other = await seed("user_correction", "unrelated session", "ses_2", "m3")
    let prompt = ""
    const generate: Generate = async (input) => {
      prompt = input.prompt
      return addRule(input)
    }
    const out = await reflectSessionSignals({ root, name: NAME, sessionID: "ses_1", loadSource: source, getGenerate: async () => generate })
    if (out.status !== "done") throw new Error("expected done")
    expect(out.kind).toBe("user")
    expect(prompt).toContain('<feedback kind="user"')
    expect(prompt).toContain("[user_correction] no, never use select *")
    expect(prompt).toContain("[tool_retry] Tool `bash` failed")
    expect(prompt).not.toContain("unrelated session")
    expect(out.result.curated.applied).toHaveLength(1)
    expect(await Store.readCandidate(root, NAME)).toContain("List columns explicitly")

    const all = await Signals.readSignals(root)
    const mine = all.filter((s) => s.sessionID === "ses_1")
    expect(mine.every((s) => s.status === "consumed" && s.consumedBy === `reflect@${out.result.history.ts}`)).toBe(true)
    expect(all.find((s) => s.id === other.id)!.status).toBe("open")
    expect(all.find((s) => s.id === a.id)!.consumedBy).toStartWith("reflect@")
    const history = (await fs.readFile(Store.paths(root, NAME).history, "utf8")).trim().split("\n").map((l) => JSON.parse(l))
    expect(history.at(-1)).toMatchObject({ action: "reflect", session: "ses_1", feedbackKind: "user" })
  })

  test("signals stay open when the model call fails", async () => {
    await seed("user_correction", "no, use ref()", "ses_1", "m1")
    const failing: Generate = async () => {
      throw new Error("model down")
    }
    await expect(
      reflectSessionSignals({ root, name: NAME, sessionID: "ses_1", loadSource: source, getGenerate: async () => failing }),
    ).rejects.toThrow("Model call failed")
    expect((await Signals.listSignals(root)).map((s) => s.status)).toEqual(["open"])
    expect(await Store.readCandidate(root, NAME)).toBeUndefined()
  })

  test("signals stay open when the reflector returns garbage", async () => {
    await seed("user_correction", "no, use ref()", "ses_1", "m1")
    await expect(
      reflectSessionSignals({ root, name: NAME, sessionID: "ses_1", loadSource: source, getGenerate: async () => async () => ({ nope: 1 }) }),
    ).rejects.toThrow()
    expect((await Signals.listSignals(root)).map((s) => s.status)).toEqual(["open"])
  })

  test("signals stay open when the session cannot be loaded", async () => {
    await seed("user_correction", "no, use ref()", "ses_gone", "m1")
    await expect(
      reflectSessionSignals({
        root,
        name: NAME,
        sessionID: "ses_gone",
        loadSource: async () => {
          throw new Error("Session not found")
        },
        getGenerate: async () => addRule,
      }),
    ).rejects.toThrow("Session not found")
    expect((await Signals.listSignals(root)).map((s) => s.status)).toEqual(["open"])
  })

  test("review and ci signals from an integration reflect without a local session", async () => {
    await seed("review", "Reviewer: models must have a unique test on the primary key.", Signals.EXTERNAL_SESSION)
    const out = await reflectSessionSignals({
      root,
      name: NAME,
      sessionID: Signals.EXTERNAL_SESSION,
      loadSource: async () => {
        throw new Error("Session not found")
      },
      getGenerate: async () => addRule,
    })
    if (out.status !== "done") throw new Error("expected done")
    expect(out.kind).toBe("review")
    expect(await Signals.listSignals(root)).toEqual([])
  })

  test("a no-op reflection still consumes (the model saw the signals)", async () => {
    await seed("user_correction", "no, use ref()", "ses_1", "m1")
    const out = await reflectSessionSignals({
      root,
      name: NAME,
      sessionID: "ses_1",
      loadSource: source,
      getGenerate: async () => async () => ({ deltas: [] }),
    })
    expect(out.status).toBe("done")
    expect(await Signals.listSignals(root)).toEqual([])
  })
})

describe("opt-in switches", () => {
  test("capture is off by default, on by config or env, and env 0 wins over config", () => {
    expect(captureEnabled(undefined, {})).toBe(false)
    expect(captureEnabled({ capture: true }, {})).toBe(true)
    expect(captureEnabled({}, { ALTIMATE_LEARN_CAPTURE: "1" })).toBe(true)
    expect(captureEnabled({ capture: true }, { ALTIMATE_LEARN_CAPTURE: "0" })).toBe(false)
  })

  test("auto-reflect requires capture", () => {
    expect(autoReflectEnabled({ auto_reflect: true }, {})).toBe(false)
    expect(autoReflectEnabled({ capture: true, auto_reflect: true }, {})).toBe(true)
    expect(autoReflectEnabled(undefined, { ALTIMATE_LEARN_CAPTURE: "1", ALTIMATE_LEARN_AUTO: "1" })).toBe(true)
    expect(autoReflectEnabled(undefined, { ALTIMATE_LEARN_AUTO: "1" })).toBe(false)
    expect(autoReflectEnabled({ capture: true }, {})).toBe(false)
  })

  test("learn model: env over config over default", () => {
    expect(learnModel(undefined, {})).toBeUndefined()
    expect(learnModel("a/b", {})).toBe("a/b")
    expect(learnModel("a/b", { ALTIMATE_LEARN_MODEL: "c/d" })).toBe("c/d")
  })
})
