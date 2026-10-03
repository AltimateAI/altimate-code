// altimate_change - new file
//
// `reflect --session` from captured signals, with the model call and the session source stubbed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as Signals from "../../../src/altimate/learn/signals"
import * as Store from "../../../src/altimate/learn/store"
import * as Playbook from "../../../src/altimate/learn/playbook"
import { reflectCore, reflectSessionSignals } from "../../../src/altimate/learn/session-reflect"
import { makeGenerate, type Generate } from "../../../src/altimate/learn/reflect"
import { type Delta } from "../../../src/altimate/learn/curator"
import { autoReflectEnabled, captureEnabled } from "../../../src/altimate/learn/capture"
import { learnMaxStored, learnModel } from "../../../src/altimate/learn/auto"

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
  test("scope-limited reflection preserves unrelated replacement feedback without sending it", async () => {
    const pending = [{ id: "L-aaaa", text: "Keep historical rows.", reasons: ["old session review"],
      feedback: "UNSELECTED SESSION EXCERPT", kind: "review" as const, attempts: 5 }]
    await Store.writePendingReplacements(root, NAME, pending)
    await seed("user_correction", "No, use explicit columns.")
    const requests: string[] = []
    const result = await reflectSessionSignals({
      root, name: NAME, sessionID: "ses_1", loadSource: source, recoverPending: false,
      getGenerate: async () => async ({ prompt }) => {
        requests.push(prompt)
        return { deltas: [] }
      },
    })
    expect(result.status).toBe("done")
    expect(requests).toHaveLength(1)
    expect(requests[0]).not.toContain("UNSELECTED SESSION EXCERPT")
    expect(await Store.readPendingReplacements(root, NAME)).toEqual(pending)
  })

  test("custom-name reflection reads and consumes only that store's signals", async () => {
    const name = "backend-rules"
    const defaults = await seed("review", "Default-only feedback.")
    const named = (await Signals.appendSignal(root, {
      kind: "review", sessionID: "ses_1", text: "Use explicit columns for backend queries.", reason: "review",
    }, name))!
    const result = await reflectSessionSignals({
      root, name, sessionID: "ses_1", loadSource: source,
      getGenerate: async () => async (input) => {
        expect(input.prompt).toContain(named.text)
        expect(input.prompt).not.toContain(defaults.text)
        return addRule(input)
      },
    })
    expect(result.status).toBe("done")
    expect(await Signals.listSignals(root, {}, name)).toEqual([])
    expect(await Signals.listSignals(root)).toEqual([defaults])
    expect(await Store.loadCandidateLessons(root, name)).toHaveLength(1)
    expect(await Store.readCandidate(root, NAME)).toBeUndefined()
  })

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

describe("reflection convention relationships", () => {
  const cents = "Convert `_cents` in staging with `cents_to_dollars(...)`."
  const replacement = "Divide `amount_cents` inline to produce dollars."
  const input = () => ({
    root, name: NAME, source: { prompts: [], calls: [] }, feedback: "The convention changed.",
    kind: "review" as const, origin: "ses_1",
  })

  async function stage() {
    const pb = Playbook.withBullets(Playbook.create({ name: NAME }), [
      { id: "L-aaaa", text: cents, helpful: 3, harmful: 1 },
      { id: "L-bbbb", text: "Wrap timestamps with `to_utc(...)`.", helpful: 0, harmful: 0 },
    ])
    await Store.saveCandidate(root, NAME, pb)
  }

  test("supersession survives the full pipeline in place and retains old text in history", async () => {
    await stage()
    const result = await reflectCore({
      ...input(),
      generate: async () => ({ deltas: [{ op: "ADD", text: replacement, supersedes: "L-aaaa", reason: "outdated" }] }),
    })
    const saved = Playbook.bullets(await Store.loadCandidate(root, NAME))
    expect(saved.map((b) => b.text)).toEqual([replacement, "Wrap timestamps with `to_utc(...)`."])
    expect(saved[0].id).not.toBe("L-aaaa")
    expect(saved[0]).toMatchObject({ helpful: 0, harmful: 0 })
    expect(result.curated.rejected).toEqual([])
    const history = JSON.parse((await fs.readFile(Store.paths(root, NAME).history, "utf8")).trim())
    expect(history.applied[0]).toMatchObject({ op: "REMOVE", id: "L-aaaa", text: cents, reason: `superseded by ${saved[0].id}` })
    await Store.promote(root, NAME)
    expect(await Store.loadApproved(root, NAME)).toMatchObject(saved)
  })

  test("declared coexistence survives subsequent reflection and promotion", async () => {
    await stage()
    await reflectCore({
      ...input(),
      generate: async () => ({ deltas: [{ op: "ADD", text: "Analyses keep `amount_cents` as integers.", coexists: ["L-aaaa"], reason: "different scope" }] }),
    })
    let prompt = ""
    await reflectCore({
      ...input(),
      generate: async (input) => {
        prompt = input.prompt
        return { deltas: [{ op: "HELPFUL", id: "L-bbbb", reason: "verified" }] }
      },
    })
    expect(prompt).toContain("c:L-aaaa")
    expect((await Store.loadCandidateLessons(root, NAME))?.at(-1)?.coexists).toEqual(["L-aaaa"])
    await Store.promote(root, NAME)
    expect((await Store.loadApproved(root, NAME)).at(-1)?.coexists).toEqual(["L-aaaa"])
  })
})

describe("reflection replacements", () => {
  const stale = { id: "L-aaaa", text: "Retain records marked `is_deleted` in staging.", helpful: 0, harmful: 1 }
  const corrected = "Staging models filter soft deletes using `is_deleted = false`."
  const reason = "The reviewer explicitly requested filtering soft deletes, contradicting the existing rule."
  const harmful: Delta = { op: "HARMFUL", id: stale.id, reason }
  const remove: Delta = { op: "REMOVE", id: stale.id, reason }
  const input = () => ({
    root, name: NAME, source: { prompts: [], calls: [] }, feedback: "Filter soft deletes in staging models.",
    kind: "review" as const, origin: "ses_1",
  })

  async function stage(bullets: Playbook.Bullet[] = [stale]) {
    await Store.saveCandidate(root, NAME, Playbook.withBullets(Playbook.create({ name: NAME }), bullets))
    await Store.writeHarmfulFrom(root, NAME, Object.fromEntries(
      bullets.filter((b) => b.harmful).map((b) => [b.id, [Store.feedbackId("Earlier correction", "ses_0")]]),
    ))
  }

  async function pending() {
    const file = path.join(Store.paths(root, NAME).learnDir, "pending-replacements.jsonl")
    const text = await fs.readFile(file, "utf8").catch((e) => {
      if (e.code === "ENOENT") return ""
      throw e
    })
    return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : []
  }

  test("threshold-crossing HARMFUL recovers the convention with the same redacted feedback and records it", async () => {
    await stage()
    const seen: Parameters<Generate>[0][] = []
    const result = await reflectCore({
      ...input(), feedback: "Filter soft deletes. key sk-abcdef1234567890XYZ " + "More feedback. ".repeat(1_000),
      generate: async (request) => {
        seen.push(request)
        return seen.length === 1 ? { deltas: [harmful] } : { text: corrected }
      },
    })
    expect(seen).toHaveLength(2)
    expect(seen[1].prompt).toContain(stale.text)
    expect(seen[1].prompt).toContain(reason)
    expect(seen[1].system.toLowerCase()).toContain("untrusted")
    const feedback = (prompt: string) => prompt.match(/<feedback\b[^>]*>[\s\S]*?<\/feedback>/)?.[0]
    expect(feedback(seen[0].prompt)).toContain("[truncated]")
    expect(feedback(seen[1].prompt)).toBe(feedback(seen[0].prompt))
    expect(seen[1].prompt).not.toContain("sk-abcdef1234567890XYZ")
    expect(result.curated.applied).toContainEqual(expect.objectContaining({ op: "HARMFUL", id: stale.id, count: 2 }))
    expect(result.curated.applied).toContainEqual(expect.objectContaining({ op: "REMOVE", id: stale.id, note: "auto-remove" }))
    expect(result.curated.applied).toContainEqual(expect.objectContaining({ op: "ADD", text: corrected, note: "replacement" }))
    expect(Playbook.bullets(await Store.loadCandidate(root, NAME))).toEqual([
      expect.objectContaining({ text: corrected, helpful: 0, harmful: 0 }),
    ])
    const history = JSON.parse((await fs.readFile(Store.paths(root, NAME).history, "utf8")).trim())
    expect(history.applied).toContainEqual(expect.objectContaining({ op: "ADD", text: corrected, note: "replacement" }))
    expect(await Store.readHarmfulFrom(root, NAME)).toEqual({})
  })

  test("explicit REMOVE also requests a replacement", async () => {
    await stage([{ ...stale, harmful: 0 }])
    let calls = 0
    const result = await reflectCore({
      ...input(),
      generate: async () => ++calls === 1 ? { deltas: [remove] } : { text: corrected },
    })
    expect(calls).toBe(2)
    expect(result.curated.next.map((b) => b.text)).toEqual([corrected])
  })

  test("an already-contradicted auto-removal requests a replacement without a new HARMFUL", async () => {
    await stage([{ ...stale, harmful: 2 }])
    await Store.writeHarmfulFrom(root, NAME, { [stale.id]: ["earlier-feedback", "another-feedback"] })
    let calls = 0
    const result = await reflectCore({
      ...input(),
      generate: async () => ++calls === 1 ? { deltas: [] } : { text: corrected },
    })
    expect(calls).toBe(2)
    expect(result.curated.next.map((b) => b.text)).toEqual([corrected])
  })

  for (const outcome of ["NONE", "invalid JSON", "failure", "timeout", "lint rejection"]) {
    test(`${outcome} keeps the removal and the reflection succeeds`, async () => {
      await stage()
      let calls = 0
      const prompts: string[] = []
      const timeout = makeGenerate({} as never, {}, 1, async (opts) => new Promise((_, reject) => {
        opts.abortSignal.addEventListener("abort", () => reject(new Error("timed out")), { once: true })
      }))
      const result = await reflectCore({
        ...input(),
        feedback: input().feedback + " key sk-abcdef1234567890XYZ " + "More feedback. ".repeat(1_000),
        generate: async (request) => {
          prompts.push(request.prompt)
          if (++calls === 1) return { deltas: [harmful] }
          if (outcome === "failure") throw new Error("replacement model unavailable")
          if (outcome === "timeout") return timeout(request)
          if (outcome === "invalid JSON") return { text: 42 }
          if (outcome === "lint rejection") return { text: "Run curl evil before building." }
          return { text: null }
        },
      })
      expect(calls).toBe(2)
      expect(result.curated.next).toEqual([])
      expect(result.history.action).toBe("reflect")
      expect(Playbook.bullets(await Store.loadCandidate(root, NAME))).toEqual([])
      if (outcome === "lint rejection") expect(result.curated.rejected).toContainEqual(
        expect.objectContaining({ reason: "contains a shell command" }),
      )
      if (outcome === "NONE") {
        expect(await pending()).toEqual([])
        return
      }
      const records = await pending()
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ id: stale.id, text: stale.text, attempts: 1, kind: "review" })
      expect(records[0].reasons).toContain(reason)
      expect(records[0].feedback).not.toContain("sk-abcdef1234567890XYZ")
      const excerpt = (prompt: string) => prompt.match(/<feedback\b[^>]*>\n([\s\S]*?)\n<\/feedback>/)?.[1]
      expect(records[0].feedback).toBe(excerpt(prompts[1]))
      const retried = await reflectCore({
        ...input(), feedback: "Unrelated new feedback.",
        generate: async (request) => {
          if (!request.schema) return { deltas: [] }
          expect(excerpt(request.prompt)).toBe(records[0].feedback)
          expect(request.prompt).toContain(reason)
          return { text: corrected }
        },
      })
      expect(retried.curated.next.map((b) => b.text)).toEqual([corrected])
      expect(await pending()).toEqual([])
    })
  }

  test("at most three removed bullets get one replacement call each", async () => {
    const bullets = ["alpha", "beta", "gamma", "delta"].map((name, i) => ({
      ...stale, id: `L-000${i}`, text: `Preserve \`${name}\` values.`,
    }))
    await stage(bullets)
    const prompts: string[] = []
    const result = await reflectCore({
      ...input(),
      generate: async ({ prompt }) => {
        prompts.push(prompt)
        return prompts.length === 1
          ? { deltas: bullets.map((b) => ({ ...harmful, id: b.id })) }
          : { text: null }
      },
    })
    expect(prompts).toHaveLength(4)
    expect(result.curated.next).toEqual([])
    for (const [i, b] of bullets.slice(0, 3).entries()) expect(prompts[i + 1]).toContain(b.text)
    expect(await pending()).toEqual([expect.objectContaining({ id: bullets[3].id, attempts: 0 })])
    const later = ["epsilon", "zeta", "eta"].map((name, i) => ({ ...stale, id: `L-100${i}`, text: `Preserve \`${name}\` values.` }))
    await stage(later)
    const retried: string[] = []
    await reflectCore({
      ...input(),
      generate: async ({ prompt }) => {
        retried.push(prompt)
        return retried.length === 1
          ? { deltas: later.map((b) => ({ ...harmful, id: b.id })) }
          : { text: null }
      },
    })
    expect(retried).toHaveLength(4)
    expect(retried[1]).toContain(bullets[3].text)
    expect(retried[2]).toContain(later[0].text)
    expect(retried[3]).toContain(later[1].text)
    expect(await pending()).toEqual([expect.objectContaining({ id: later[2].id, attempts: 0 })])
  })

  test("replacement ADDs share the main reflection's ADD budget", async () => {
    await stage()
    const added = ["List result columns explicitly.", "Use UTC for event timestamps.", "Document primary keys in model descriptions."]
    let calls = 0
    const result = await reflectCore({
      ...input(),
      generate: async () => ++calls === 1
        ? { deltas: [harmful, ...added.map((text) => ({ op: "ADD", text, reason: "review" }))] }
        : { text: corrected },
    })
    expect(calls).toBe(2)
    expect(result.curated.next.map((b) => b.text)).toEqual(added)
    expect(result.curated.rejected).toContainEqual(expect.objectContaining({ reason: "edit budget exceeded (max 3 ADDs per reflection)" }))
    expect(await pending()).toEqual([expect.objectContaining({ id: stale.id, attempts: 1 })])
    await reflectCore({ ...input(), generate: async ({ schema }) => schema ? { text: corrected } : { deltas: [] } })
    expect(Playbook.bullets(await Store.loadCandidate(root, NAME)).map((b) => b.text)).toEqual([...added, corrected])
    expect(await pending()).toEqual([])
  })

  test("a pending recovery clears on NONE and expires after five failed attempts", async () => {
    for (const none of [true, false]) {
      await stage()
      for (let attempt = 1; attempt <= (none ? 2 : 5); attempt++) {
        await reflectCore({
          ...input(),
          generate: async ({ schema }) => {
            if (!schema) return { deltas: attempt === 1 ? [harmful] : [] }
            if (none && attempt === 2) return { text: null }
            throw new Error("model unavailable")
          },
        })
        expect(await pending()).toEqual(attempt === (none ? 2 : 5)
          ? [] : [expect.objectContaining({ id: stale.id, attempts: attempt })])
      }
      let calls = 0
      await reflectCore({ ...input(), generate: async () => { calls++; return { deltas: [] } } })
      expect(calls).toBe(1)
    }
  })

  test("generic coalesce does not hide the timestamp rule's replacement after a currency correction", async () => {
    const currency = { ...stale, text: "Fill `_cents` gaps with `coalesce(amount_cents, 0)`." }
    const timestamp = { ...stale, id: "L-bbbb", text: "Normalize `event_time` using `coalesce(event_time, created_at)`." }
    const correction = "Preserve `_cents` nulls instead of using `coalesce(amount_cents, 0)`."
    await stage([currency, timestamp])
    const prompts: string[] = []
    const result = await reflectCore({
      ...input(),
      generate: async ({ prompt }) => {
        prompts.push(prompt)
        return prompts.length === 1 ? { deltas: [
          harmful, { ...harmful, id: timestamp.id }, { op: "ADD", text: correction, reason },
        ] } : { text: "Keep `event_time` in UTC without filling missing values." }
      },
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain(timestamp.text)
    expect(prompts[1]).not.toContain(currency.text)
    expect(result.curated.next.map((b) => b.text)).toEqual([correction, "Keep `event_time` in UTC without filling missing values."])
  })

  test("a staging replacement lands alongside a compatible surviving analysis rule", async () => {
    const cents = { ...stale, text: "Convert `_cents` in staging with `cents_to_dollars(...)`." }
    const analyses = { id: "L-bbbb", text: "Analysis models keep `amount_cents` as integers.", helpful: 0, harmful: 0, coexists: [cents.id] }
    const correction = "Staging models keep `_cents` as integers."
    await stage([cents, analyses])
    const result = await reflectCore({
      ...input(),
      generate: async ({ schema, prompt }) => {
        if (!schema) return { deltas: [remove] }
        expect(prompt).toContain(`[${analyses.id}] ${analyses.text}`)
        return { text: correction, coexists: [analyses.id] }
      },
    })
    expect(result.curated.next.map((b) => b.text)).toEqual([analyses.text, correction])
    expect(result.curated.next[1].coexists).toEqual([analyses.id])
    expect(result.curated.rejected).toEqual([])
    await Store.promote(root, NAME)
  })

  test("replacement detection uses surviving text after a correction is edited away", async () => {
    const other = { id: "L-bbbb", text: "Normalize `event_time` to UTC.", helpful: 0, harmful: 0 }
    const unrelated = "Document primary keys in model descriptions."
    await stage([stale, other])
    let calls = 0
    const result = await reflectCore({
      ...input(),
      generate: async () => ++calls === 1 ? { deltas: [
        remove,
        { op: "EDIT", id: other.id, text: corrected, reason },
        { op: "EDIT", id: other.id, text: unrelated, reason: "separate convention" },
      ] } : { text: corrected },
    })
    expect(calls).toBe(2)
    expect(result.curated.next.map((b) => b.text)).toEqual([unrelated, corrected])
  })

  test("cap eviction alone does not request a replacement", async () => {
    const maxStored = 25
    await stage(Array.from({ length: maxStored }, (_, i) => ({
      id: `L-${i.toString(16).padStart(4, "0")}`, text: `Existing convention ${i}.`, helpful: 0, harmful: 0,
    })))
    let calls = 0
    const result = await reflectCore({
      ...input(), maxStored, generate: async () => {
        calls++
        return { deltas: [{ op: "ADD", text: corrected, reason }] }
      },
    })
    expect(calls).toBe(1)
    expect(result.curated.next).toHaveLength(maxStored)
    expect(result.curated.applied).toContainEqual(expect.objectContaining({ op: "REMOVE", note: "cap eviction" }))
    expect(await Store.loadRetired(root, NAME)).toContainEqual(expect.objectContaining({ reason: "store cap" }))
  })

  test("a duplicate replacement cannot mark a surviving bullet HELPFUL twice", async () => {
    const survivor = { id: "L-bbbb", text: "Normalize `event_time` values to UTC before aggregation.", helpful: 0, harmful: 0 }
    await stage([stale, survivor])
    let calls = 0
    const result = await reflectCore({
      ...input(),
      generate: async () => ++calls === 1
        ? { deltas: [{ op: "HELPFUL", id: survivor.id, reason: "review confirmed timestamp handling" }, remove] }
        : { text: "Normalize `event_time` values to UTC before daily aggregation." },
    })
    expect(calls).toBe(2)
    expect(result.curated.next).toEqual([{ ...survivor, helpful: 1 }])
    expect(result.curated.applied.filter((a) => a.op === "HELPFUL")).toHaveLength(1)
    expect(result.curated.rejected).toContainEqual(expect.objectContaining({ reason: "duplicate HELPFUL for this bullet in one reflection" }))
  })

  test("an explicitly coexisting ADD does not replace an auto-removed convention", async () => {
    const cents = { ...stale, text: "Convert `_cents` in staging with `cents_to_dollars(...)`." }
    const analyses = "Analyses keep `amount_cents` as integers."
    await stage([cents])
    const prompts: string[] = []
    const result = await reflectCore({
      ...input(), feedback: "Staging uses inline currency conversion; analyses still keep integer cents.",
      generate: async ({ prompt }) => {
        prompts.push(prompt)
        return prompts.length === 1
          ? { deltas: [
            { ...harmful, reason: "The reviewer requested inline conversion in staging." },
            { op: "ADD", text: analyses, coexists: [cents.id], reason: "analyses have a separate convention" },
          ] }
          : { text: null }
      },
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain(cents.text)
    expect(result.curated.next.map((b) => b.text)).toEqual([analyses])
    expect(result.curated.applied).toContainEqual(expect.objectContaining({ op: "REMOVE", id: cents.id, note: "auto-remove" }))
    expect(result.curated.rejected).toEqual([])
  })

  const replacements: Array<[string, Delta[]]> = [
    ["ADD", [remove, { op: "ADD", text: corrected, reason }]],
    ["EDIT", [remove, { op: "EDIT", id: "L-bbbb", text: corrected, reason }]],
    ["supersede", [{ op: "ADD", text: corrected, supersedes: stale.id, reason }]],
    ["implicit supersede", [harmful, { op: "ADD", text: corrected, reason }]],
  ]
  for (const [kind, deltas] of replacements) {
    test(`no extra call when a main ${kind} already replaces the removed rule`, async () => {
      await stage([stale, { id: "L-bbbb", text: "Apply warehouse timezone conversion in timestamp models.", helpful: 0, harmful: 0 }])
      let calls = 0
      const result = await reflectCore({
        ...input(), generate: async () => {
          calls++
          return { deltas }
        },
      })
      expect(calls).toBe(1)
      expect(result.curated.next.some((b) => b.id === stale.id)).toBe(false)
      expect(result.curated.next.some((b) => b.text === corrected)).toBe(true)
    })
  }

  test("session signals are consumed even if the replacement call fails", async () => {
    await stage()
    await seed("user_correction", "Filter soft deletes in staging models.", "ses_1", "m1")
    let calls = 0
    const result = await reflectSessionSignals({
      root, name: NAME, sessionID: "ses_1", loadSource: source,
      getGenerate: async () => async () => {
        if (++calls === 1) return { deltas: [harmful] }
        throw new Error("replacement model unavailable")
      },
    })
    expect(calls).toBe(2)
    expect(result.status).toBe("done")
    expect(await Signals.listSignals(root)).toEqual([])
    expect(Playbook.bullets(await Store.loadCandidate(root, NAME))).toEqual([])
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

  test("stored lesson cap: env over config over default, invalid limits are rejected", () => {
    expect(learnMaxStored(undefined, {})).toBe(1000)
    expect(learnMaxStored(75, {})).toBe(75)
    expect(learnMaxStored(75, { ALTIMATE_LEARN_MAX_STORED: "250" })).toBe(250)
    expect(() => learnMaxStored(0, {})).toThrow("positive integer")
    for (const value of ["0", "-1", "1.5", "oops", "Infinity"])
      expect(() => learnMaxStored(75, { ALTIMATE_LEARN_MAX_STORED: value })).toThrow("positive integer")
  })
})
