// altimate_change - new file
//
// Integration: real Session writes publish on the Bus; the capture subscription started for the instance
// records signals into <projectRoot>/.altimate-code/learn/team-playbook/signals.jsonl. Capture is opt-in.
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { MessageID, PartID } from "../../../src/session/schema"
import { ProviderID, ModelID } from "../../../src/provider/schema"
import { startCapture, flushCapture } from "../../../src/altimate/learn/capture"
import * as Signals from "../../../src/altimate/learn/signals"
import { tmpdir } from "../../fixture/fixture"
import { bootstrap } from "../../../src/cli/bootstrap"
import { autoReflectSession } from "../../../src/altimate/learn/auto"
import * as Reflect from "../../../src/altimate/learn/reflect"

const saved = process.env["ALTIMATE_LEARN_CAPTURE"]
const savedAuto = process.env["ALTIMATE_LEARN_AUTO"]
afterEach(async () => {
  await Instance.disposeAll()
  if (saved === undefined) delete process.env["ALTIMATE_LEARN_CAPTURE"]
  else process.env["ALTIMATE_LEARN_CAPTURE"] = saved
  if (savedAuto === undefined) delete process.env["ALTIMATE_LEARN_AUTO"]
  else process.env["ALTIMATE_LEARN_AUTO"] = savedAuto
})

const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test") }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function user(sessionID: Session.Info["id"], text: string, id = MessageID.ascending(), created = Date.now()) {
  await Session.updateMessage({ id, sessionID, role: "user", time: { created }, agent: "build", model, tools: {} } as never)
  await Session.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "text", text } as never)
  return id
}

async function assistant(sessionID: Session.Info["id"], parentID: string, completed = true, id = MessageID.ascending(), created = Date.now()) {
  await Session.updateMessage({
    id,
    sessionID,
    role: "assistant",
    time: { created, completed: completed ? created : undefined },
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
  test("a delayed history lookup uses stored order for arbitrary message IDs", async () => {
    process.env["ALTIMATE_LEARN_CAPTURE"] = "1"
    await using dir = await tmpdir({ git: true })
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        await startCapture({ directory: Instance.directory, worktree: Instance.worktree })
        const session = await Session.create({})
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const messages = Session.messages
        const lookup = spyOn(Session, "messages").mockImplementation(Object.assign(async (input: Parameters<typeof messages>[0]) => {
          entered.resolve()
          await release.promise
          return messages(input)
        }, messages))
        try {
          const first = await user(session.id, "Use explicit columns instead of select star.", MessageID.make("msg_delayed_zzz"), 100)
          await entered.promise
          await assistant(session.id, first, true, MessageID.make("msg_delayed_aaa"), 200)
          release.resolve()
          await flushCapture()
          expect(await Signals.readSignals(dir.path)).toEqual([])
        } finally {
          release.resolve()
          await flushCapture()
          lookup.mockRestore()
        }
      },
    })
  })

  test("history lookup captures corrections whose IDs sort before the prior assistant", async () => {
    process.env["ALTIMATE_LEARN_CAPTURE"] = "1"
    await using dir = await tmpdir({ git: true })
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({})
        const first = await user(session.id, "Create a file.", MessageID.make("msg_history_first"), 100)
        await assistant(session.id, first, true, MessageID.make("msg_history_zzz"), 200)
        await startCapture({ directory: Instance.directory, worktree: Instance.worktree })
        const correction = await user(session.id, "No, use explicit column names.", MessageID.make("msg_history_aaa"), 300)
        await settle(dir.path, 1)
        expect(await Signals.readSignals(dir.path)).toMatchObject([{ messageID: correction }])
      },
    })
  })

  test("disabled bootstrap never imports capture; config opt-in still starts it", async () => {
    const child = Bun.spawn([process.execPath, "test", path.join(import.meta.dir, "capture-bootstrap.fixture.ts")], {
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" })
  }, 30_000)

  for (const boundary of ["run-end", "instance disposal"] as const) {
    test(`capture-only ${boundary} waits for the final signal write`, async () => {
      process.env["ALTIMATE_LEARN_CAPTURE"] = "1"
      process.env["ALTIMATE_LEARN_AUTO"] = "0"
      await using dir = await tmpdir({ git: true })
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const rename = fs.rename
      const write = spyOn(fs, "rename").mockImplementation(async (...args) => {
        if (String(args[1]) === Signals.signalsFile(dir.path)) {
          entered.resolve()
          await release.promise
        }
        return rename(...args)
      })
      let pending: Promise<unknown> | undefined
      try {
        await Instance.provide({
          directory: dir.path,
          fn: async () => {
            await startCapture({ directory: Instance.directory, worktree: Instance.worktree })
            const session = await Session.create({})
            const initial = await user(session.id, "create a file")
            await assistant(session.id, initial)
            await user(session.id, "No, use explicit column names instead of select star.")
            await entered.promise
            let done = false
            pending = (boundary === "run-end" ? autoReflectSession(session.id) : Instance.dispose()).then(() => {
              done = true
            })
            await sleep(40)
            expect(done).toBe(false)
            release.resolve()
            await pending
            expect(await Signals.readSignals(dir.path)).toHaveLength(1)
          },
        })
      } finally {
        release.resolve()
        await pending
        await flushCapture()
        write.mockRestore()
      }
    })
  }

  test("bootstrap and run-end hooks leave learn untouched when learning is disabled", async () => {
    delete process.env["ALTIMATE_LEARN_CAPTURE"]
    delete process.env["ALTIMATE_LEARN_AUTO"]
    await using dir = await tmpdir({ git: true })
    const resolveModel = spyOn(Reflect, "providerGenerate").mockImplementation(() => {
      throw new Error("learning must not resolve a model when disabled")
    })
    try {
      await bootstrap(dir.path, async () => {
        const session = await Session.create({})
        const initial = await user(session.id, "create a file")
        await assistant(session.id, initial)
        await user(session.id, "No, use explicit column names instead of select star.")
        expect(await autoReflectSession(session.id)).toBeUndefined()
      })
      expect(resolveModel).not.toHaveBeenCalled()
      expect(await fs.stat(path.join(dir.path, ".altimate-code", "learn")).catch(() => undefined)).toBeUndefined()
    } finally {
      resolveModel.mockRestore()
    }
  })

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
