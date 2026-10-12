// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import * as Store from "../../../src/altimate/learn/store"
import * as Signals from "../../../src/altimate/learn/signals"
import * as Playbook from "../../../src/altimate/learn/playbook"
import { reflectCore, reflectSessionSignals } from "../../../src/altimate/learn/session-reflect"
import { FEEDBACK_CAP } from "../../../src/altimate/learn/reflect"

const name = "team-playbook"
const source = { prompts: [], calls: [] }

describe("review reflection regressions", () => {
  test("concurrent reflections rebase model deltas onto the current candidate", async () => {
    await using dir = await tmpdir()
    const started = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const base = { root: dir.path, name, source, feedback: "review", kind: "review" as const, origin: "first" }
    const first = reflectCore({
      ...base,
      generate: async () => {
        started.resolve()
        await resume.promise
        return { deltas: [{ op: "ADD", text: "Keep timestamps in UTC.", reason: "review" }] }
      },
    })
    await started.promise
    try {
      await reflectCore({
        ...base, origin: "second",
        generate: async () => ({ deltas: [{ op: "ADD", text: "List result columns explicitly.", reason: "review" }] }),
      })
    } finally {
      resume.resolve()
    }
    await first
    expect(Playbook.bullets(await Store.loadCandidate(dir.path, name)).map((b) => b.text).sort()).toEqual([
      "Keep timestamps in UTC.", "List result columns explicitly.",
    ])
  })

  test("oversized signal batches consume only complete feedback included in the model request", async () => {
    await using dir = await tmpdir()
    for (let i = 0; i < 7; i++) {
      await Signals.appendSignal(dir.path, {
        kind: "review", sessionID: Signals.EXTERNAL_SESSION, text: `review-${i}: ` + "x".repeat(1990), reason: "review",
      })
    }
    const prompts: string[] = []
    const input = {
      root: dir.path, name, sessionID: Signals.EXTERNAL_SESSION,
      loadSource: async () => source,
      getGenerate: async () => async ({ prompt }: { prompt: string }) => {
        prompts.push(prompt)
        return { deltas: [] }
      },
    }
    const result = await reflectSessionSignals(input)
    expect(result.status).toBe("done")
    if (result.status !== "done") throw new Error("expected done")
    expect(result.signals.length).toBeLessThan(7)
    const feedback = Signals.feedbackFromSignals(result.signals).text
    expect(feedback.length).toBeLessThanOrEqual(FEEDBACK_CAP)
    expect(prompts[0]).toContain(feedback)
    expect(prompts[0]).not.toContain("[truncated]")
    expect(await Signals.listSignals(dir.path)).toHaveLength(7 - result.signals.length)
    await reflectSessionSignals(input)
    expect(await Signals.listSignals(dir.path)).toHaveLength(0)
    expect(prompts[1]).toContain("review-6:")
  })

  test("overlapping reflections cannot apply the same signals twice", async () => {
    await using dir = await tmpdir()
    await Store.saveCandidate(dir.path, name, Playbook.withBullets(Playbook.create({ name }), [
      { id: "L-0001", text: "Keep timestamps in UTC.", helpful: 0, harmful: 0 },
    ]))
    await Signals.appendSignal(dir.path, {
      kind: "review", sessionID: "ses_shared", text: "The timestamp handling is correct.", reason: "review",
    })
    const started = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const deltas = [{ op: "HELPFUL", id: "L-0001", reason: "review confirmed" }]
    const base = { root: dir.path, name, sessionID: "ses_shared", loadSource: async () => source }
    const first = reflectSessionSignals({
      ...base,
      getGenerate: async () => async () => {
        started.resolve()
        await resume.promise
        return { deltas }
      },
    })
    await started.promise
    try {
      expect(await reflectSessionSignals({
        ...base,
        getGenerate: async () => { throw new Error("An overlapping batch must not resolve a model") },
      })).toEqual({ status: "none" })
    } finally {
      resume.resolve()
    }
    expect((await first).status).toBe("done")
    expect(Playbook.bullets(await Store.loadCandidate(dir.path, name))[0].helpful).toBe(1)
  })

  test("external user corrections and mixed review signals reflect without a session", async () => {
    await using dir = await tmpdir()
    for (const kind of ["user_correction", "review", "ci"] as const) {
      await Signals.appendSignal(dir.path, {
        kind, sessionID: Signals.EXTERNAL_SESSION, text: "No, use snake case.", reason: "external",
      })
    }
    let prompt = ""
    const result = await reflectSessionSignals({
      root: dir.path, name, sessionID: Signals.EXTERNAL_SESSION,
      loadSource: async () => { throw new Error("Session not found") },
      getGenerate: async () => async (input) => {
        prompt = input.prompt
        return { deltas: [{ op: "ADD", text: "Use snake case for model names.", reason: "user correction" }] }
      },
    })
    expect(result.status).toBe("done")
    expect(prompt).toContain("[user_correction] No, use snake case.")
    expect(prompt).toContain("[review] No, use snake case.")
    expect(prompt).toContain("[ci] No, use snake case.")
    expect(await Signals.listSignals(dir.path)).toHaveLength(0)
  })
})
