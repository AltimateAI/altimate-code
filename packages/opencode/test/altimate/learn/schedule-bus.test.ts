// altimate_change - new file
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "../../../src/config/config"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { MessageID } from "../../../src/session/schema"
import { SessionStatus } from "../../../src/session/status"
import { ProviderID, ModelID } from "../../../src/provider/schema"
import { startCapture } from "../../../src/altimate/learn/capture"
import * as Auto from "../../../src/altimate/learn/auto"
import { appendSignal } from "../../../src/altimate/learn/signals"
import {
  Scheduler, drainScheduledReflections, shutdownScheduledReflections, startScheduler,
} from "../../../src/altimate/learn/schedule"
import { tmpdir } from "../../fixture/fixture"

const savedCapture = process.env.ALTIMATE_LEARN_CAPTURE
const savedAuto = process.env.ALTIMATE_LEARN_AUTO
beforeEach(() => {
  delete process.env.ALTIMATE_LEARN_CAPTURE
  delete process.env.ALTIMATE_LEARN_AUTO
})
afterEach(async () => {
  await Instance.disposeAll()
  if (savedCapture === undefined) delete process.env.ALTIMATE_LEARN_CAPTURE
  else process.env.ALTIMATE_LEARN_CAPTURE = savedCapture
  if (savedAuto === undefined) delete process.env.ALTIMATE_LEARN_AUTO
  else process.env.ALTIMATE_LEARN_AUTO = savedAuto
})

const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test") }

async function start() {
  expect((await Config.get()).learn).toMatchObject({ capture: true, auto_reflect: true })
  await startCapture(Instance.current)
  await startScheduler(Instance.current)
}

describe("reflection scheduler over the real session bus", () => {
  test("maps user messages, busy status and turn completion, and shuts down on instance disposal", async () => {
    await using dir = await tmpdir({ git: true, config: { learn: { capture: true, auto_reflect: true } } })
    let activityReady = Promise.withResolvers<void>()
    const idleReady = Promise.withResolvers<void>()
    const originalActivity = Scheduler.prototype.onActivity
    const originalIdle = Scheduler.prototype.onIdle
    const activity = spyOn(Scheduler.prototype, "onActivity").mockImplementation(function (this: Scheduler, sessionID) {
      originalActivity.call(this, sessionID)
      activityReady.resolve()
    })
    const idle = spyOn(Scheduler.prototype, "onIdle").mockImplementation(function (this: Scheduler, sessionID) {
      originalIdle.call(this, sessionID)
      idleReady.resolve()
    })
    const shutdown = spyOn(Scheduler.prototype, "shutdown")
    const reflect = spyOn(Auto, "autoReflectSession").mockImplementation(async () => {
      throw new Error("empty session must not reflect")
    })
    try {
      await Instance.provide({ directory: dir.path, fn: async () => {
        try {
          await start()
          const session = await Session.create({})
          const userID = MessageID.ascending()
          await Session.updateMessage({
            id: userID, sessionID: session.id, role: "user", time: { created: Date.now() },
            agent: "build", model, tools: {},
          })
          await activityReady.promise
          expect(activity.mock.calls).toEqual([[session.id]])

          activityReady = Promise.withResolvers<void>()
          await SessionStatus.set(session.id, { type: "busy" })
          await activityReady.promise
          expect(activity.mock.calls).toEqual([[session.id], [session.id]])

          await Session.updateMessage({
            id: MessageID.ascending(), sessionID: session.id, role: "assistant",
            time: { created: Date.now(), completed: Date.now() }, parentID: userID,
            modelID: model.modelID, providerID: model.providerID, mode: "build", agent: "build",
            path: { cwd: dir.path, root: dir.path }, cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          await SessionStatus.set(session.id, { type: "idle" })
          await idleReady.promise
          await drainScheduledReflections(dir.path, session.id)
          expect(idle.mock.calls).toEqual([[session.id]])
          expect(activity.mock.calls).toEqual([[session.id], [session.id]])
          expect(reflect).not.toHaveBeenCalled()
        } finally {
          await Instance.dispose()
        }
        expect(shutdown).toHaveBeenCalledTimes(1)
        expect(reflect).not.toHaveBeenCalled()
      } })
    } finally {
      activity.mockRestore()
      idle.mockRestore()
      shutdown.mockRestore()
      reflect.mockRestore()
    }
  })

  test("shared-project reflections use the instance that emitted the session event", async () => {
    await using dir = await tmpdir({ git: true, config: { learn: { capture: true, auto_reflect: true, model: "first/model" } } })
    const second = path.join(dir.path, "second")
    await fs.mkdir(second)
    await fs.writeFile(path.join(second, "opencode.json"), JSON.stringify({ learn: { model: "second/model", max_stored: 7 } }))
    const reflected = Promise.withResolvers<Parameters<typeof Auto.autoReflectSession>[1]>()
    const reflect = spyOn(Auto, "autoReflectSession").mockImplementation(async (_sessionID, options) => {
      reflected.resolve(options)
      return undefined
    })
    try {
      await Instance.provide({ directory: dir.path, fn: start })
      await Instance.provide({ directory: second, fn: async () => {
        await start()
        const session = await Session.create({})
        for (let index = 1; index <= 3; index++) await appendSignal(dir.path, {
          kind: "user_correction", sessionID: session.id, messageID: `message_${index}`,
          text: `Keep explicit columns ${index}.`, reason: "correction",
        })
        await SessionStatus.set(session.id, { type: "idle" })
        const options = await reflected.promise
        expect(options?.context?.directory).toBe(second)
        expect(Config.peek(options!.context!)?.learn).toMatchObject({ model: "second/model", max_stored: 7 })
        expect(reflect).toHaveBeenCalledTimes(1)
      } })
    } finally {
      await Instance.disposeAll()
      reflect.mockRestore()
    }
  })

  test.each(["open", "deferred", "reopened", "reopened-during-lookup"])("startup recovery uses only the session's directory (%s)", async (mode) => {
    const open = mode === "open"
    await using dir = await tmpdir({ git: true, config: { learn: { capture: true, auto_reflect: true, recovery_max_reflections: 1 } } })
    const second = path.join(dir.path, "second")
    await fs.mkdir(second)
    let previousID = ""
    await Instance.provide({ directory: second, fn: async () => {
      const session = await Session.create({})
      previousID = session.id
      await appendSignal(dir.path, {
        kind: "user_correction", sessionID: session.id, messageID: "old_message",
        text: "Keep explicit columns.", reason: "correction",
      })
      await Instance.dispose()
    } })
    const idleReady = Promise.withResolvers<Scheduler>()
    const originalIdle = Scheduler.prototype.onIdle
    const idle = spyOn(Scheduler.prototype, "onIdle").mockImplementation(function (this: Scheduler, sessionID) {
      originalIdle.call(this, sessionID)
      idleReady.resolve(this)
    })
    let latest: Scheduler | undefined
    const originalRetry = Scheduler.prototype.retryDeferredRecovery
    const retry = spyOn(Scheduler.prototype, "retryDeferredRecovery").mockImplementation(function (this: Scheduler) {
      originalRetry.call(this)
      latest = this
    })
    const lookupEntered = Promise.withResolvers<void>()
    const releaseLookup = Promise.withResolvers<void>()
    const originalGet = Session.get
    const get = spyOn(Session, "get").mockImplementation(Object.assign(async (id: Parameters<typeof originalGet>[0]) => {
      if (mode === "reopened-during-lookup" && id === previousID) {
        lookupEntered.resolve()
        await releaseLookup.promise
      }
      return originalGet(id)
    }, originalGet))
    const reflect = spyOn(Auto, "autoReflectSession").mockResolvedValue(undefined)
    try {
      await Instance.provide({ directory: dir.path, fn: start })
      if (open) await Instance.provide({ directory: second, fn: start })
      await Instance.provide({ directory: dir.path, fn: async () => {
        const current = await Session.create({})
        await SessionStatus.set(current.id, { type: "idle" })
        if (mode === "reopened-during-lookup") await lookupEntered.promise
        else await (await idleReady.promise).settle()
        expect(reflect).toHaveBeenCalledTimes(open ? 1 : 0)
        if (open) expect(reflect.mock.calls[0][1]?.context?.directory).toBe(second)
      } })
      if (!open) {
        if (mode !== "reopened-during-lookup") {
          const third = path.join(dir.path, "third")
          await fs.mkdir(third)
          await Instance.provide({ directory: third, fn: start })
          await (await idleReady.promise).settle()
          expect(reflect).not.toHaveBeenCalled()
        }

        if (mode.startsWith("reopened")) await Instance.disposeAll()
        await Instance.provide({ directory: second, fn: start })
        releaseLookup.resolve()
        await (await idleReady.promise).settle()
        await latest!.settle()
        expect(reflect).toHaveBeenCalledTimes(1)
        expect(reflect.mock.calls[0][1]?.context?.directory).toBe(second)
        expect(reflect.mock.calls[0][1]?.signalIDs).toHaveLength(1)
      }
    } finally {
      releaseLookup.resolve()
      await Instance.disposeAll()
      idle.mockRestore()
      retry.mockRestore()
      get.mockRestore()
      reflect.mockRestore()
    }
  })

  test("run drains an idle reflection and receives its result while graceful shutdown never waits on the model", async () => {
    await using dir = await tmpdir({ git: true, config: { learn: { capture: true, auto_reflect: true } } })
    const entered = Promise.withResolvers<Parameters<typeof Auto.autoReflectSession>[1]>()
    const release = Promise.withResolvers<void>()
    const drainEntered = Promise.withResolvers<void>()
    const outcome = { ok: true, signals: 3, summary: "1 candidate lesson", line: "learn: 3 signals -> 1 candidate lesson" }
    const reflect = spyOn(Auto, "autoReflectSession").mockImplementation(async (_sessionID, options) => {
      entered.resolve(options)
      await release.promise
      return outcome
    })
    const originalDrain = Scheduler.prototype.drainSession
    const drain = spyOn(Scheduler.prototype, "drainSession").mockImplementation(function (this: Scheduler, ...args) {
      drainEntered.resolve()
      return originalDrain.apply(this, args)
    })
    let pendingDrain: Promise<Auto.AutoReflectOutcome | undefined> | undefined
    try {
      await Instance.provide({ directory: dir.path, fn: async () => {
        try {
          await start()
          const session = await Session.create({})
          for (let index = 1; index <= 3; index++) await appendSignal(dir.path, {
            kind: "user_correction", sessionID: session.id, messageID: `message_${index}`,
            text: `Keep explicit columns ${index}.`, reason: "correction",
          })
          await SessionStatus.set(session.id, { type: "idle" })
          const options = await entered.promise
          expect(reflect).toHaveBeenCalledTimes(1)
          expect(reflect.mock.calls[0][0]).toBe(session.id)
          expect(options?.shouldContinue?.()).toBe(true)
          let drained = false
          pendingDrain = drainScheduledReflections(dir.path, session.id).then((result) => {
            drained = true
            return result
          })
          await drainEntered.promise
          expect(drained).toBe(false)

          await shutdownScheduledReflections()
          expect(drained).toBe(false)
          expect(options?.shouldContinue?.()).toBe(false)
          expect(reflect).toHaveBeenCalledTimes(1)
          release.resolve()
          expect(await pendingDrain).toEqual(outcome)
          expect(await drainScheduledReflections(dir.path, session.id)).toBeUndefined()
          expect(reflect).toHaveBeenCalledTimes(1)
        } finally {
          release.resolve()
          await pendingDrain
          await Instance.dispose()
        }
      } })
    } finally {
      release.resolve()
      await pendingDrain
      reflect.mockRestore()
      drain.mockRestore()
    }
  })
})
