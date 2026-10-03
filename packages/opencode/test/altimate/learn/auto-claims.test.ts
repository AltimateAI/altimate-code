// altimate_change - new file
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import * as Reflect from "../../../src/altimate/learn/reflect"
import * as Signals from "../../../src/altimate/learn/signals"
import * as Store from "../../../src/altimate/learn/store"
import { DEFAULT_NAME } from "../../../src/altimate/learn/playbook"
import { createClaimManager } from "../../../src/altimate/learn/claims"
import { autoReflectSession } from "../../../src/altimate/learn/auto"
import { readScheduleState } from "../../../src/altimate/learn/schedule-state"

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
        expect(state.lastReflection).toMatchObject({ sessionID: session.id, result: "failure" })
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
