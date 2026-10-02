// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import * as Store from "../../../src/altimate/learn/store"
import * as Signals from "../../../src/altimate/learn/signals"
import * as Playbook from "../../../src/altimate/learn/playbook"
import { reflectSessionSignals } from "../../../src/altimate/learn/session-reflect"
import type { Delta } from "../../../src/altimate/learn/curator"

const name = "team-playbook"
const sessionID = "ses_concurrent"
const original = { id: "L-aaaa", text: "Keep `amount_cents` unchanged in staging.", helpful: 0, harmful: 0 }
const current = { ...original, text: "Convert `amount_cents` to dollars in staging." }
const correction = "Round `amount_cents` before converting to dollars."
const independent = "Keep timestamps in UTC."
const reason = "changed concurrently; will be reconsidered"
const source = async () => ({ prompts: [], calls: [] })

async function stage(root: string, bullet = original) {
  await Store.saveCandidate(root, name, Playbook.withBullets(Playbook.create({ name }), [bullet]))
}

async function signal(root: string) {
  return (await Signals.appendSignal(root, {
    kind: "review", sessionID, text: "Review currency conversion.", reason: "review",
  }))!
}

describe("reflection rebasing rejects stale destructive deltas", () => {
  const cases: Array<[string, Delta]> = [
    ["EDIT", { op: "EDIT", id: original.id, text: correction, reason: "review" }],
    ["REMOVE", { op: "REMOVE", id: original.id, reason: "review" }],
    ["HARMFUL", { op: "HARMFUL", id: original.id, reason: "review" }],
    ["supersede", { op: "ADD", supersedes: original.id, text: correction, reason: "review" }],
  ]
  for (const [op, delta] of cases) {
    test(`${op} cannot change newer text and its signals are retried`, async () => {
      await using dir = await tmpdir()
      await stage(dir.path)
      const pending = await signal(dir.path)
      const input = { root: dir.path, name, sessionID, loadSource: source }
      const result = await reflectSessionSignals({
        ...input,
        getGenerate: async () => async ({ schema, prompt }) => {
          if (schema) return { text: null }
          expect(prompt).toContain(original.text)
          await stage(dir.path, current)
          return { deltas: [delta] }
        },
      })
      if (result.status !== "done") throw new Error("expected reflection")
      expect(result.result.curated.rejected).toEqual([{ delta: expect.objectContaining(delta), reason }])
      expect(result.result.curated.applied).toEqual([])
      expect(Playbook.bullets(await Store.loadCandidate(dir.path, name))).toEqual([current])
      expect((await Signals.listSignals(dir.path)).map((s) => s.id)).toEqual([pending.id])
      const retried = await reflectSessionSignals({
        ...input,
        getGenerate: async () => async ({ prompt }) => {
          expect(prompt).toContain(current.text)
          return { deltas: [{ op: "HELPFUL", id: current.id, reason: "new rule is correct" }] }
        },
      })
      expect(retried.status).toBe("done")
      expect(await Signals.listSignals(dir.path)).toEqual([])
      expect(Playbook.bullets(await Store.loadCandidate(dir.path, name))).toEqual([{ ...current, helpful: 1 }])
    })
  }

  test("implicit supersession cannot replace concurrently changed text", async () => {
    await using dir = await tmpdir()
    await stage(dir.path, { ...original, harmful: 1 })
    await signal(dir.path)
    const delta: Delta = { op: "ADD", text: correction, reason: "review" }
    const newer = { ...current, harmful: 1 }
    const result = await reflectSessionSignals({
      root: dir.path, name, sessionID, loadSource: source,
      getGenerate: async () => async () => {
        await stage(dir.path, newer)
        return { deltas: [delta] }
      },
    })
    if (result.status !== "done") throw new Error("expected reflection")
    expect(result.result.curated.rejected).toEqual([{ delta: expect.objectContaining(delta), reason }])
    expect(result.result.curated.applied).toEqual([])
    expect(Playbook.bullets(await Store.loadCandidate(dir.path, name))).toEqual([newer])
    expect(await Signals.listSignals(dir.path)).toHaveLength(1)
  })

  test("rejected stale evidence cannot turn an ADD into implicit supersession", async () => {
    await using dir = await tmpdir()
    await stage(dir.path)
    await signal(dir.path)
    const result = await reflectSessionSignals({
      root: dir.path, name, sessionID, loadSource: source,
      getGenerate: async () => async () => {
        await stage(dir.path, current)
        return { deltas: [
          { op: "HARMFUL", id: original.id, reason: "review" },
          { op: "ADD", text: correction, reason: "review" },
        ] }
      },
    })
    if (result.status !== "done") throw new Error("expected reflection")
    expect(result.result.curated.rejected).toContainEqual({ delta: expect.objectContaining({ op: "HARMFUL" }), reason })
    expect(result.result.curated.applied).toEqual([])
    expect(Playbook.bullets(await Store.loadCandidate(dir.path, name))).toEqual([current])
    expect(await Signals.listSignals(dir.path)).toHaveLength(1)
  })

  test("independent ADDs still rebase when a stale EDIT is rejected", async () => {
    await using dir = await tmpdir()
    await stage(dir.path)
    await signal(dir.path)
    const result = await reflectSessionSignals({
      root: dir.path, name, sessionID, loadSource: source,
      getGenerate: async () => async () => {
        await stage(dir.path, current)
        return { deltas: [
          { op: "EDIT", id: original.id, text: correction, reason: "review" },
          { op: "ADD", text: independent, reason: "review" },
        ] }
      },
    })
    if (result.status !== "done") throw new Error("expected reflection")
    expect(result.result.curated.rejected).toContainEqual({ delta: expect.objectContaining({ op: "EDIT" }), reason })
    expect(Playbook.bullets(await Store.loadCandidate(dir.path, name)).map((b) => b.text)).toEqual([current.text, independent])
    expect(await Signals.listSignals(dir.path)).toEqual([])
  })

  test("counter changes alone do not reject an EDIT", async () => {
    await using dir = await tmpdir()
    await stage(dir.path)
    await signal(dir.path)
    const result = await reflectSessionSignals({
      root: dir.path, name, sessionID, loadSource: source,
      getGenerate: async () => async () => {
        await stage(dir.path, { ...original, helpful: 2 })
        return { deltas: [{ op: "EDIT", id: original.id, text: correction, reason: "review" }] }
      },
    })
    if (result.status !== "done") throw new Error("expected reflection")
    expect(result.result.curated.rejected).toEqual([])
    expect(Playbook.bullets(await Store.loadCandidate(dir.path, name))).toEqual([{ ...original, text: correction, helpful: 2 }])
    expect(await Signals.listSignals(dir.path)).toEqual([])
  })

  test("an unrelated pending replacement does not consume rejected-only feedback", async () => {
    await using dir = await tmpdir()
    await stage(dir.path)
    await signal(dir.path)
    await Store.writePendingReplacements(dir.path, name, [{
      id: "L-bbbb", text: "Document model ownership.", reasons: ["old review"],
      feedback: "Record model owners.", kind: "review", attempts: 0,
    }])
    const result = await reflectSessionSignals({
      root: dir.path, name, sessionID, loadSource: source,
      getGenerate: async () => async ({ schema }) => {
        if (schema) return { text: independent }
        await stage(dir.path, current)
        return { deltas: [{ op: "EDIT", id: original.id, text: correction, reason: "review" }] }
      },
    })
    if (result.status !== "done") throw new Error("expected reflection")
    expect(result.result.curated.rejected).toContainEqual({ delta: expect.objectContaining({ op: "EDIT" }), reason })
    expect(result.result.curated.applied).toContainEqual(expect.objectContaining({ op: "ADD", text: independent, note: "replacement" }))
    expect(Playbook.bullets(await Store.loadCandidate(dir.path, name)).map((b) => b.text)).toEqual([current.text, independent])
    expect(await Signals.listSignals(dir.path)).toHaveLength(1)
  })
})
