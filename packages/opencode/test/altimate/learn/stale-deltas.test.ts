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

  test("mixed stale EDIT and applied ADD keep every signal for retry and dedupe the ADD", async () => {
    await using dir = await tmpdir()
    await stage(dir.path)
    const pending = [await signal(dir.path), (await Signals.appendSignal(dir.path, {
      kind: "review", sessionID, text: "Keep timestamps in UTC.", reason: "review",
    }))!]
    const input = { root: dir.path, name, sessionID, loadSource: source }
    const result = await reflectSessionSignals({
      ...input,
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
    const bullets = Playbook.bullets(await Store.loadCandidate(dir.path, name))
    expect(bullets.map((b) => b.text)).toEqual([current.text, independent])
    expect(result.result.curated.applied).toContainEqual(expect.objectContaining({ op: "ADD", text: independent }))
    expect((await Signals.listSignals(dir.path)).map((s) => s.id)).toEqual(pending.map((s) => s.id))
    const retried = await reflectSessionSignals({
      ...input,
      getGenerate: async () => async ({ prompt }) => {
        expect(prompt).toContain(current.text)
        expect(prompt).toContain(independent)
        return { deltas: [
          { op: "EDIT", id: original.id, text: correction, reason: "review" },
          { op: "ADD", text: independent, reason: "review" },
        ] }
      },
    })
    if (retried.status !== "done") throw new Error("expected retry")
    expect(retried.signals.map((s) => s.id)).toEqual(pending.map((s) => s.id))
    expect(retried.result.curated.rejected).toEqual([])
    expect(retried.result.curated.applied).toContainEqual(expect.objectContaining({
      op: "HELPFUL", id: bullets[1].id, note: "duplicate ADD (similarity 1.00)",
    }))
    expect(Playbook.bullets(await Store.loadCandidate(dir.path, name))).toEqual([
      { ...current, text: correction },
      { ...bullets[1], helpful: 1 },
    ])
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

  for (const queued of [false, true]) {
    test(`replacement generation releases the lock and preserves a changed ${queued ? "surviving overlap" : "removal target"}`, async () => {
      await using dir = await tmpdir()
      const survivor = { ...original, id: "L-bbbb" }
      const before = queued ? survivor : original
      const after = { ...before, text: current.text }
      await stage(dir.path, before)
      const pending = await signal(dir.path)
      const record = {
        id: original.id, text: original.text, reasons: ["review"],
        feedback: "Review currency conversion.", kind: "review" as const, attempts: 0,
      }
      if (queued) await Store.writePendingReplacements(dir.path, name, [record])
      const started = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      const reflection = reflectSessionSignals({
        root: dir.path, name, sessionID, loadSource: source,
        getGenerate: async () => async ({ schema }) => {
          if (!schema) return { deltas: queued ? [] : [{ op: "REMOVE", id: original.id, reason: "review" }] }
          started.resolve()
          await resume.promise
          return { text: correction, ...(queued ? { coexists: [survivor.id] } : {}) }
        },
      })
      await started.promise
      const writer = Store.transaction(dir.path, () => stage(dir.path, after))
      let timer: ReturnType<typeof setTimeout> | undefined
      let unlocked = false
      try {
        unlocked = await Promise.race([
          writer.then(() => true),
          new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 1_000) }),
        ])
      } finally {
        clearTimeout(timer)
        resume.resolve()
      }
      const result = await reflection
      await writer
      expect(unlocked).toBe(true)
      if (result.status !== "done") throw new Error("expected reflection")
      expect(result.result.curated.applied).toEqual([])
      expect(result.result.curated.rejected).toContainEqual(expect.objectContaining({ reason }))
      expect(Playbook.bullets(await Store.loadCandidate(dir.path, name))).toEqual([after])
      expect((await Signals.listSignals(dir.path)).map((s) => s.id)).toEqual([pending.id])
      expect(await Store.readPendingReplacements(dir.path, name)).toEqual(queued ? [record] : [])
    })
  }

  for (const revise of [false, true]) {
    test(`a replacement cannot overwrite a concurrently ${revise ? "revised" : "resolved"} recovery queue`, async () => {
      await using dir = await tmpdir()
      const record = {
        id: original.id, text: original.text, reasons: ["review"],
        feedback: "Review currency conversion.", kind: "review" as const, attempts: 0,
      }
      const newer = revise ? [{ ...record, feedback: "Keep the new currency convention.", attempts: 1 }] : []
      await Store.writePendingReplacements(dir.path, name, [record])
      await signal(dir.path)
      const result = await reflectSessionSignals({
        root: dir.path, name, sessionID, loadSource: source,
        getGenerate: async () => async ({ schema }) => {
          if (!schema) return { deltas: [] }
          await Store.writePendingReplacements(dir.path, name, newer)
          return { text: correction }
        },
      })
      if (result.status !== "done") throw new Error("expected reflection")
      expect(result.result.curated.applied).toEqual([])
      expect(Playbook.bullets(await Store.loadCandidate(dir.path, name))).toEqual([])
      expect(await Store.readPendingReplacements(dir.path, name)).toEqual(newer)
    })
  }

  test("replacement coexistence retains the provisional id of an ADD when the plan is published", async () => {
    await using dir = await tmpdir()
    await stage(dir.path)
    await signal(dir.path)
    const analysis = "Analysis models retain `amount_cents` as integers."
    const replacement = "Staging models convert `amount_cents` to dollars."
    let coexist: string | undefined
    const result = await reflectSessionSignals({
      root: dir.path, name, sessionID, loadSource: source,
      getGenerate: async () => async ({ schema, prompt }) => {
        if (!schema) return { deltas: [
          { op: "ADD", text: analysis, coexists: [original.id], reason: "separate convention" },
          { op: "REMOVE", id: original.id, reason: "review" },
        ] }
        coexist = prompt.match(/\[(L-[a-f0-9]+)\]/)?.[1]
        expect(coexist).toBeDefined()
        return { text: replacement, coexists: [coexist] }
      },
    })
    if (result.status !== "done") throw new Error("expected reflection")
    expect(result.result.curated.rejected).toEqual([])
    const bullets = Playbook.bullets(await Store.loadCandidate(dir.path, name))
    expect(bullets.map((b) => b.text)).toEqual([analysis, replacement])
    if (!coexist) throw new Error("expected provisional ADD id")
    expect(bullets[0].id).toBe(coexist)
    expect(bullets[1].coexists).toEqual([coexist])
    expect(await Store.readPendingReplacements(dir.path, name)).toEqual([])
  })

  for (const changedDuring of ["primary model", "replacement model", "own EDIT"] as const) {
    test(`replacement cap eviction respects text changed by ${changedDuring}`, async () => {
      await using dir = await tmpdir()
      const maxStored = 8
      const bullets = Array.from({ length: maxStored }, (_, i) => ({
        id: `L-${i.toString(16).padStart(4, "0")}`,
        text: `Existing convention ${i}.`, helpful: Math.min(Math.max(i - 1, 0), 2), harmful: 0,
      }))
      const newer = { ...bullets[0], text: "Retain numeric identifiers unchanged in exports." }
      const added = "List result columns explicitly."
      const replacement = "Keep financial calendar dates unambiguous."
      const save = (next: Playbook.Bullet[]) => Store.saveCandidate(
        dir.path, name, Playbook.withBullets(Playbook.create({ name }), next),
      )
      await save(bullets)
      await signal(dir.path)
      const result = await reflectSessionSignals({
        root: dir.path, name, sessionID, loadSource: source, maxStored,
        getGenerate: async () => async ({ schema }) => {
          if (schema) {
            if (changedDuring === "replacement model") await save([newer, ...bullets.slice(1)])
            return { text: replacement }
          }
          if (changedDuring === "primary model") await save([newer, ...bullets.slice(1)])
          return { deltas: [
            ...(changedDuring === "own EDIT" ? [{ op: "EDIT", id: newer.id, text: newer.text, reason: "review" }] : []),
            { op: "REMOVE", id: bullets[maxStored - 1].id, reason: "review" },
            { op: "ADD", text: added, reason: "review" },
          ] }
        },
      })
      if (result.status !== "done") throw new Error("expected reflection")
      const next = Playbook.bullets(await Store.loadCandidate(dir.path, name))
      expect(next).toHaveLength(maxStored)
      expect(next.map((b) => b.text)).toContain(added)
      expect(next.map((b) => b.text)).toContain(replacement)
      const victim = changedDuring === "own EDIT" ? bullets[0] : bullets[1]
      expect(next.some((b) => b.id === victim.id)).toBe(false)
      if (changedDuring !== "own EDIT") expect(next).toContainEqual(newer)
      expect(result.result.curated.applied).toContainEqual(expect.objectContaining({
        op: "REMOVE", id: victim.id, note: "cap eviction",
      }))
    })
  }
})
