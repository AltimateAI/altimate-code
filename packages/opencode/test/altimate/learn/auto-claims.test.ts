// altimate_change - new file
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import * as Reflect from "../../../src/altimate/learn/reflect"
import * as Signals from "../../../src/altimate/learn/signals"
import * as Store from "../../../src/altimate/learn/store"
import * as SessionReflect from "../../../src/altimate/learn/session-reflect"
import { create, DEFAULT_NAME, withBullets } from "../../../src/altimate/learn/playbook"
import { createClaimManager } from "../../../src/altimate/learn/claims"
import { autoReflectSession } from "../../../src/altimate/learn/auto"
import { readScheduleState } from "../../../src/altimate/learn/schedule-state"
import * as ScheduleState from "../../../src/altimate/learn/schedule-state"

const config = { learn: { capture: true, auto_reflect: true, model: "test/model" } }
const keys = ["ALTIMATE_LEARN_CAPTURE", "ALTIMATE_LEARN_AUTO", "ALTIMATE_LEARN_MODEL"]
let original: Record<string, string | undefined>
beforeEach(() => {
  original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
})
afterEach(async () => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
  await Instance.disposeAll()
})

async function signal(root: string, sessionID: string) {
  return (await Signals.appendSignal(root, {
    kind: "user_correction", sessionID, text: "No, list result columns explicitly.", reason: "correction",
  }))!
}

describe("run-end automatic reflection claims", () => {
  test("committed reflection stays successful when the status write fails", async () => {
    await using dir = await tmpdir({ git: true, config })
    const model = spyOn(Reflect, "providerGenerate").mockImplementation(() => Effect.succeed(async () => ({
      deltas: [{ op: "ADD", text: "List result columns explicitly.", reason: "user correction" }],
    })))
    const status = spyOn(ScheduleState, "recordReflection").mockRejectedValue(new Error("status disk unavailable"))
    try {
      await Instance.provide({ directory: dir.path, fn: async () => {
        const session = await Session.create({})
        await signal(dir.path, session.id)
        const result = await autoReflectSession(session.id)
        expect(await Signals.listSignals(dir.path)).toEqual([])
        expect(await Store.loadCandidateLessons(dir.path, DEFAULT_NAME)).toHaveLength(1)
        expect(await Bun.file(Store.paths(dir.path, DEFAULT_NAME).history).exists()).toBe(true)
        expect(result).toMatchObject({ ok: true, signals: 1 })
        expect(result?.line).toContain("staged")
        expect(result?.line).not.toContain("signals stay open")
        expect(status).toHaveBeenCalledTimes(1)
        expect(status.mock.calls[0][2]).toBe("success")
      } })
    } finally {
      status.mockRestore()
      model.mockRestore()
    }
  })

  test("provider errors are redacted in the run-end outcome and persisted status", async () => {
    await using dir = await tmpdir({ git: true, config })
    const secret = "sk-abcdef1234567890XYZ"
    const model = spyOn(Reflect, "providerGenerate").mockImplementation(() => Effect.succeed(async () => {
      throw new Error(`provider rejected ${secret}`)
    }))
    try {
      await Instance.provide({ directory: dir.path, fn: async () => {
        const session = await Session.create({})
        await signal(dir.path, session.id)
        const result = await autoReflectSession(session.id)
        expect(result?.ok).toBe(false)
        expect(result?.line).toContain("provider rejected")
        expect(result?.line).not.toContain(secret)
        expect((await readScheduleState(dir.path)).lastReflection?.summary).not.toContain(secret)
        expect(await Signals.listSignals(dir.path)).toHaveLength(1)
      } })
    } finally {
      model.mockRestore()
    }
  })

  test("run exit aborts at its overall deadline and late model results leave signals open", async () => {
    await using dir = await tmpdir({ git: true, config })
    const release = Promise.withResolvers<void>()
    let abort: AbortSignal | undefined
    let reflection: ReturnType<typeof SessionReflect.reflectSessionSignals> | undefined
    const originalReflect = SessionReflect.reflectSessionSignals
    const reflect = spyOn(SessionReflect, "reflectSessionSignals").mockImplementation((input) => {
      reflection = originalReflect(input)
      return reflection
    })
    const model = spyOn(Reflect, "providerGenerate").mockImplementation((_model, _timeout, abortSignal) => {
      abort = abortSignal
      return Effect.succeed(async () => {
        await release.promise
        return { deltas: [{ op: "ADD", text: "List result columns explicitly.", reason: "correction" }] }
      })
    })
    try {
      await Instance.provide({ directory: dir.path, fn: async () => {
        const session = await Session.create({})
        await signal(dir.path, session.id)
        const pending = autoReflectSession(session.id, { waitForScheduled: true, deadline: Date.now() + 250 })
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const outcome = await Promise.race([
            pending,
            new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 750) }),
          ])
          expect(outcome).toMatchObject({ ok: false })
          expect(outcome?.line).toContain("timed out")
          expect(outcome?.line).toContain("signals stay open for the next run")
          expect(abort?.aborted).toBe(true)
          expect(await Signals.listSignals(dir.path)).toHaveLength(1)
          release.resolve()
          await reflection
          expect(await Signals.listSignals(dir.path)).toHaveLength(1)
          expect(await Store.readCandidate(dir.path, DEFAULT_NAME)).toBeUndefined()
        } finally {
          clearTimeout(timer)
          release.resolve()
          await pending
          await reflection
        }
      } })
    } finally {
      release.resolve()
      reflect.mockRestore()
      model.mockRestore()
    }
  })

  test("scheduler records sum reflection and replacement usage in state and history", async () => {
    await using dir = await tmpdir({ git: true, config })
    await Store.saveCandidate(dir.path, DEFAULT_NAME, withBullets(create({ name: DEFAULT_NAME }), [
      { id: "L-0001", text: "Convert `_cents` columns in staging.", helpful: 0, harmful: 0 },
    ]))
    let calls = 0
    const schema = {}
    const model = spyOn(Reflect, "providerGenerate").mockImplementation((_model, timeout, abortSignal, onUsage) => Effect.succeed(
      Reflect.makeGenerate({} as never, schema, timeout, async (request) => {
        calls++
        return {
          object: request.schema === schema
            ? { deltas: [{ op: "REMOVE", id: "L-0001", reason: "staging convention changed" }] }
            : { text: "Preserve raw integer values for `_cents` columns in staging." },
          usage: { inputTokens: 100 * calls, outputTokens: 25 * calls },
        }
      }, abortSignal, onUsage, { cost: { input: 2, output: 4, cache: { read: 0, write: 0 } } }),
    ))
    try {
      await Instance.provide({ directory: dir.path, fn: async () => {
        const session = await Session.create({})
        await signal(dir.path, session.id)
        const result = await autoReflectSession(session.id)
        expect(result?.ok).toBe(true)
        expect(calls).toBe(2)
        const usage = (await readScheduleState(dir.path)).lastReflection?.usage
        expect(usage).toMatchObject({ inputTokens: 300, outputTokens: 75 })
        expect(usage?.estimatedCost).toBeCloseTo(0.0009, 10)
        expect(result?.usage).toEqual(usage)
        const history = JSON.parse((await Bun.file(Store.paths(dir.path, DEFAULT_NAME).history).text()).trim())
        expect(history.usage).toEqual(usage)
      } })
    } finally {
      model.mockRestore()
    }
  })

  test("a live other-process claim skips model resolution, then release allows candidate-only reflection", async () => {
    await using dir = await tmpdir({ git: true, config })
    let calls = 0
    const model = spyOn(Reflect, "providerGenerate").mockImplementation(() => Effect.succeed(async () => {
      calls++
      return { deltas: [{ op: "ADD", text: "List result columns explicitly.", reason: "user correction" }] }
    }))
    try {
      await Instance.provide({ directory: dir.path, fn: async () => {
        const session = await Session.create({})
        const pending = await signal(dir.path, session.id)
        const other = createClaimManager({ pid: 101, host: "another-process", isAlive: () => true })
        const claim = await other.acquire(dir.path, DEFAULT_NAME, [pending.id])
        expect(claim).toBeDefined()
        try {
          expect(await autoReflectSession(session.id)).toBeUndefined()
          expect(model).not.toHaveBeenCalled()
          expect(calls).toBe(0)
        } finally {
          await claim!.release()
        }
        const result = await autoReflectSession(session.id)
        expect(result).toMatchObject({ ok: true, signals: 1 })
        expect(calls).toBe(1)
        expect(model).toHaveBeenCalledTimes(1)
        expect(await Signals.listSignals(dir.path)).toEqual([])
        expect(await Store.loadCandidateLessons(dir.path, DEFAULT_NAME)).toHaveLength(1)
        expect(await Store.loadApproved(dir.path, DEFAULT_NAME)).toEqual([])
        expect((await readScheduleState(dir.path)).lastReflection).toMatchObject({ sessionID: session.id, result: "success" })
      } })
    } finally {
      model.mockRestore()
    }
  })

  test("model failure persists retry backoff and an immediate run-end retry does not call the provider", async () => {
    await using dir = await tmpdir({ git: true, config })
    const model = spyOn(Reflect, "providerGenerate").mockImplementation(() => Effect.succeed(async () => {
      throw new Error("provider offline")
    }))
    try {
      await Instance.provide({ directory: dir.path, fn: async () => {
        const session = await Session.create({})
        await signal(dir.path, session.id)
        const before = Date.now()
        expect(await autoReflectSession(session.id)).toMatchObject({ ok: false })
        const state = await readScheduleState(dir.path)
        expect(state.lastReflection).toMatchObject({
          sessionID: session.id, result: "failure", usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
        })
        expect(state.lastReflection!.summary).toContain("provider offline")
        expect(state.recoveries[session.id].failures).toBe(1)
        expect(state.recoveries[session.id].retryAt).toBeGreaterThanOrEqual(before + 60_000)
        expect(await autoReflectSession(session.id)).toBeUndefined()
        expect(model).toHaveBeenCalledTimes(1)
        expect(await Signals.listSignals(dir.path)).toHaveLength(1)
        expect(await Store.readCandidate(dir.path, DEFAULT_NAME)).toBeUndefined()
      } })
    } finally {
      model.mockRestore()
    }
  })

  test("recovery deadlines reach the provider and expired deadlines never resolve a model", async () => {
    await using dir = await tmpdir({ git: true, config })
    let deadlineSignal: AbortSignal | undefined
    const model = spyOn(Reflect, "providerGenerate").mockImplementation((_model, _timeout, abortSignal) => {
      deadlineSignal = abortSignal
      return Effect.succeed(async () => ({ deltas: [] }))
    })
    try {
      await Instance.provide({ directory: dir.path, fn: async () => {
        const session = await Session.create({})
        await signal(dir.path, session.id)
        expect(await autoReflectSession(session.id, { deadline: Date.now() - 1 })).toBeUndefined()
        expect(model).not.toHaveBeenCalled()
        const result = await autoReflectSession(session.id, { context: Instance.current, deadline: Date.now() + 60_000 })
        expect(result).toMatchObject({ ok: true })
        expect(deadlineSignal).toBeInstanceOf(AbortSignal)
        expect(deadlineSignal!.aborted).toBe(false)
      } })
    } finally {
      model.mockRestore()
    }
  })
})
