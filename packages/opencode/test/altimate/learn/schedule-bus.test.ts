// altimate_change - new file
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
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
    const originalSettle = Scheduler.prototype.settle
    const settle = spyOn(Scheduler.prototype, "settle").mockImplementation(function (this: Scheduler) {
      drainEntered.resolve()
      return originalSettle.call(this)
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
      settle.mockRestore()
    }
  })
})
