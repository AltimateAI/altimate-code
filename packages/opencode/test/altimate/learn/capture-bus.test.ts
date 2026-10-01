// altimate_change - new file
//
// Integration: real Session writes publish on the Bus; the capture subscription started for the instance
// records signals into <projectRoot>/.altimate-code/learn/signals.jsonl. Capture is opt-in.
import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { MessageID, PartID } from "../../../src/session/schema"
import { ProviderID, ModelID } from "../../../src/provider/schema"
import { startCapture, flushCapture } from "../../../src/altimate/learn/capture"
import * as Signals from "../../../src/altimate/learn/signals"
import { tmpdir } from "../../fixture/fixture"

const saved = process.env["ALTIMATE_LEARN_CAPTURE"]
afterEach(() => {
  if (saved === undefined) delete process.env["ALTIMATE_LEARN_CAPTURE"]
  else process.env["ALTIMATE_LEARN_CAPTURE"] = saved
})

const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test") }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function user(sessionID: Session.Info["id"], text: string) {
  const id = MessageID.ascending()
  await Session.updateMessage({ id, sessionID, role: "user", time: { created: Date.now() }, agent: "build", model, tools: {} } as never)
  await Session.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "text", text } as never)
  return id
}

async function assistant(sessionID: Session.Info["id"], parentID: string, completed = true) {
  const id = MessageID.ascending()
  await Session.updateMessage({
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now(), completed: completed ? Date.now() : undefined },
    parentID,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as never)
  return id
}

async function failedTool(sessionID: Session.Info["id"], messageID: string, n: number) {
  await Session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "tool",
    callID: `call_${n}`,
    tool: "bash",
    state: { status: "error", input: {}, error: `exit ${n}`, time: { start: 1, end: 2 } },
  } as never)
}

async function settle(root: string, want: number) {
  for (let i = 0; i < 60; i++) {
    await flushCapture()
    if ((await Signals.readSignals(root)).length >= want) return
    await sleep(50)
  }
}

describe("capture over the real session bus", () => {
  test("records a correction (not the first prompt) and a tool-retry episode", async () => {
    process.env["ALTIMATE_LEARN_CAPTURE"] = "1"
    await using dir = await tmpdir({ git: true })
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        await startCapture({ directory: Instance.directory, worktree: Instance.worktree })
        const session = await Session.create({})
        const u1 = await user(session.id, "no, create the file with select * from orders")
        const a1 = await assistant(session.id, u1)
        for (let i = 1; i <= 3; i++) await failedTool(session.id, a1, i)
        await user(session.id, "no, we never use select *; always list columns explicitly")
        await settle(dir.path, 2)

        const signals = await Signals.readSignals(dir.path)
        const kinds = signals.map((s) => s.kind).sort()
        expect(kinds).toEqual(["tool_retry", "user_correction"])
        const correction = signals.find((s) => s.kind === "user_correction")!
        expect(correction.text).toContain("never use select *")
        expect(correction.sessionID).toBe(session.id)
        expect(signals.find((s) => s.kind === "tool_retry")!.text).toContain("`bash` failed 3 consecutive times")
      },
    })
  })

  test("is off by default: nothing is recorded", async () => {
    delete process.env["ALTIMATE_LEARN_CAPTURE"]
    await using dir = await tmpdir({ git: true })
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        await startCapture({ directory: Instance.directory, worktree: Instance.worktree })
        const session = await Session.create({})
        const u1 = await user(session.id, "create a file")
        await assistant(session.id, u1)
        await user(session.id, "that's wrong, we never do that")
        await sleep(300)
        await flushCapture()
        expect(await Signals.readSignals(dir.path)).toEqual([])
      },
    })
  })
})
