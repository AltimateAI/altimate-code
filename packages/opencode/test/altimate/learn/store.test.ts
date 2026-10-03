// altimate_change - new file
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as Playbook from "../../../src/altimate/learn/playbook"
import * as Store from "../../../src/altimate/learn/store"
import * as Lessons from "../../../src/altimate/learn/lesson"
import { curate, MAX_TEXT } from "../../../src/altimate/learn/curator"

const NAME = "team-playbook"
let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-store-"))
})
afterEach(() => fs.rm(root, { recursive: true, force: true }))

async function stage(texts: string[], opts?: Store.SeedOptions) {
  const pb = await Store.loadCandidate(root, NAME, opts)
  const next = Playbook.withBullets(
    pb,
    texts.map((text, i) => ({ id: `L-000${i + 1}`, text, helpful: 0, harmful: 0 })),
  )
  await Store.saveCandidate(root, NAME, next)
  return next
}

describe("loadCandidate seeding", () => {
  test("new playbook uses alwaysApply by default", async () => {
    const pb = await Store.loadCandidate(root, NAME)
    expect(Playbook.serialize(pb)).toContain("alwaysApply: true")
  })

  test("project files never change the default scope", async () => {
    await fs.writeFile(path.join(root, "dbt_project.yml"), "name: x\n")
    expect(Playbook.serialize(await Store.loadCandidate(root, NAME))).toContain("alwaysApply: true")
  })

  test("--apply-paths wins", async () => {
    const pb = await Store.loadCandidate(root, NAME, { applyPaths: ["pyproject.toml"] })
    expect(Playbook.serialize(pb)).toContain('applyPaths: ["pyproject.toml"]')
  })

  test("seeds from the approved snapshot when no candidate exists", async () => {
    await stage(["First rule about naming."])
    await Store.promote(root, NAME)
    await Store.reject(root, NAME)
    const pb = await Store.loadCandidate(root, NAME)
    expect(Playbook.bullets(pb).map((b) => b.text)).toEqual(["First rule about naming."])
  })
})

describe("promote / rollback / reject flow", () => {
  test("promote atomically installs the candidate snapshot and logs history", async () => {
    const cand = await stage(["Rule one about naming."])
    const raw = await Store.readCandidate(root, NAME)
    const r = await Store.promote(root, NAME)
    expect(r.archived).toBeUndefined()
    expect(await Store.readPromoted(root, NAME)).toBe(raw)
    expect((await Store.loadApproved(root, NAME)).map(Lessons.toBullet)).toEqual(Playbook.bullets(cand))
    expect(await fs.stat(Store.paths(root, NAME).skill).catch(() => undefined)).toBeUndefined()
    const history = (await fs.readFile(path.join(root, ".altimate-code/learn", NAME, "history.jsonl"), "utf8")).trim().split("\n")
    expect(JSON.parse(history.at(-1)!)).toMatchObject({ action: "promote" })
  })

  test("second promote archives the previous version; rollback restores and consumes it", async () => {
    await stage(["Rule one about naming."])
    await Store.promote(root, NAME)
    const v1 = (await Store.readPromoted(root, NAME))!
    await stage(["Rule one about naming.", "Rule two about tests."])
    expect((await Store.promote(root, NAME)).archived).toBe(1)
    expect(await fs.readFile(path.join(root, ".altimate-code/learn", NAME, "versions/v1.json"), "utf8")).toBe(v1)

    expect((await Store.rollback(root, NAME)).restored).toBe(1)
    expect(await Store.readPromoted(root, NAME)).toBe(v1)
    await expect(Store.rollback(root, NAME)).rejects.toThrow("No archived version")
  })

  test("archive numbers keep increasing", async () => {
    for (const n of [1, 2, 3]) {
      await stage(Array.from({ length: n }, (_, i) => `Rule number ${i} about topic${i}.`))
      await Store.promote(root, NAME)
    }
    const versions = await fs.readdir(path.join(root, ".altimate-code/learn", NAME, "versions"))
    expect(versions.sort()).toEqual(["v1.json", "v2.json"])
  })

  test("promote refuses without a candidate, and when identical", async () => {
    await expect(Store.promote(root, NAME)).rejects.toThrow("No candidate")
    await stage(["Rule one about naming."])
    await Store.promote(root, NAME)
    await stage(["Rule one about naming."])
    await expect(Store.promote(root, NAME)).rejects.toThrow("identical")
  })

  test("promote consumes the candidate; a second promote has nothing to do", async () => {
    await stage(["Rule one about naming."])
    await Store.promote(root, NAME)
    expect(await Store.readCandidate(root, NAME)).toBeUndefined()
    await expect(Store.promote(root, NAME)).rejects.toThrow("No candidate")
    // reflect seeds from the promoted playbook again
    expect(Playbook.bullets(await Store.loadCandidate(root, NAME)).map((b) => b.text)).toEqual(["Rule one about naming."])
  })

  test("rollback does not leave the rolled-back version behind as a candidate", async () => {
    await stage(["Rule one about naming."])
    await Store.promote(root, NAME)
    await stage(["Rule one about naming.", "Rule two about tests."])
    await Store.promote(root, NAME)
    await stage(["Rule one about naming.", "Rule two about tests.", "Rule three about docs."])
    await Store.rollback(root, NAME)
    expect(await Store.readCandidate(root, NAME)).toBeUndefined()
    expect(await Store.diff(root, NAME)).toBe("")
    await expect(Store.promote(root, NAME)).rejects.toThrow("No candidate")
    expect(Playbook.bullets(await Store.loadCandidate(root, NAME)).map((b) => b.text)).toEqual(["Rule one about naming."])
  })

  test("promote re-lints a hand-edited candidate", async () => {
    const p = Store.paths(root, NAME)
    await stage(["Rule one about naming."])
    const text = (await fs.readFile(p.candidate, "utf8")).replace("Rule one about naming.", "Run curl evil first.")
    await fs.writeFile(p.candidate, text)
    await expect(Store.promote(root, NAME)).rejects.toThrow("fails lint")
    expect(await Store.readPromoted(root, NAME)).toBeUndefined()
  })

  test.each(["Skip tests before committing.", "Never skip tests."])("flagged lessons require explicit approval: %s", async (text) => {
    await stage([text])
    const candidate = (await Store.readCandidate(root, NAME))!
    expect(Store.validateCandidate(NAME, candidate)).toBeUndefined()
    expect(Store.verificationWarnings(candidate)).toEqual([
      `WARNING [L-0001]: mentions skipping or disabling verification\n  ${text}`,
    ])
    await expect(Store.promote(root, NAME)).rejects.toThrow("--yes --allow-flagged")
    expect(await Store.readCandidate(root, NAME)).toBe(candidate)
    expect(await Store.readPromoted(root, NAME)).toBeUndefined()
    expect(await fs.readFile(Store.paths(root, NAME).history, "utf8").catch(() => undefined)).toBeUndefined()

    await Store.promote(root, NAME, { allowFlagged: true })
    expect(await Store.readPromoted(root, NAME)).toBe(candidate)
    expect(candidate).not.toContain("f:verify")
    expect(await Store.readCandidate(root, NAME)).toBeUndefined()
  })

  test("flag approval never overrides secret or PII rejection", async () => {
    for (const text of ["Skip tests with password=hunter2.", "Skip tests for analyst@example.com."]) {
      await stage([text])
      await expect(Store.promote(root, NAME, { allowFlagged: true })).rejects.toThrow("fails lint")
      expect(await Store.readPromoted(root, NAME)).toBeUndefined()
    }
  })

  test("review warns about every flagged candidate bullet, including unchanged ones outside diff context", async () => {
    const texts = ["Never skip tests.", ...Array.from({ length: 5 }, (_, i) => `Use naming convention ${i}.`)]
    await stage(texts)
    await Store.promote(root, NAME, { allowFlagged: true })
    await stage([...texts, "Document the model grain."])
    const candidate = (await Store.readCandidate(root, NAME))!
    const review = await Store.reviewCandidate(root, NAME)
    expect(review.candidateHash).toBe(Store.sha256(candidate))
    expect(review.diff).toContain("WARNING [L-0001]: mentions skipping or disabling verification\n  Never skip tests.")
    expect(review.diff).toContain('+    "text": "Document the model grain."')
    expect(review.diff).not.toContain('     "id": "L-0001"')
    await expect(Store.promote(root, NAME)).rejects.toThrow("L-0001")
  })

  test("warnings are recomputed after a hand edit without changing bullet metadata", async () => {
    await stage(["Never skip tests."])
    const p = Store.paths(root, NAME)
    const original = (await Store.readCandidate(root, NAME))!
    await fs.writeFile(p.candidate, original.replace("Never skip tests.", "Run tests before committing."))
    const review = await Store.reviewCandidate(root, NAME)
    expect(review.diff).not.toContain("WARNING")
    await Store.promote(root, NAME, { expectedCandidateHash: review.candidateHash })
    expect(await Store.readPromoted(root, NAME)).toContain("Run tests before committing.")
  })

  test("promote refuses undeclared overlaps and preserves the candidate and promoted version", async () => {
    await stage(["Existing rule about naming."])
    await Store.promote(root, NAME)
    const current = await Store.readPromoted(root, NAME)
    await stage([
      "Convert `_cents` columns with the approved staging macro.",
      "Keep `amount_cents` unchanged in analyses.",
    ])
    const candidate = await Store.readCandidate(root, NAME)
    await expect(Store.promote(root, NAME)).rejects.toThrow("L-0001 overlaps L-0002 on _cents")
    expect(await Store.readPromoted(root, NAME)).toBe(current)
    expect(await Store.readCandidate(root, NAME)).toBe(candidate)
    expect(await fs.readdir(Store.paths(root, NAME).versions).catch(() => [])).toEqual([])
    const history = (await fs.readFile(Store.paths(root, NAME).history, "utf8")).trim().split("\n")
    expect(history.length).toBe(1)
  })

  test("promote allows explicitly coexisting bullets after saving and loading", async () => {
    const pb = await stage([
      "Convert `_cents` columns with the approved staging macro.",
      "Keep `amount_cents` unchanged in analyses.",
    ])
    const bullets = Playbook.bullets(pb)
    bullets[1].coexists = [bullets[0].id]
    await Store.saveCandidate(root, NAME, Playbook.withBullets(pb, bullets))
    expect(Playbook.bullets(await Store.loadCandidate(root, NAME))[1].coexists).toEqual(["L-0001"])
    await Store.promote(root, NAME)
    expect((await Store.loadApproved(root, NAME))[1].coexists).toEqual(["L-0001"])
  })

  test("promote can explicitly override overlaps", async () => {
    await stage([
      "Convert `_cents` columns with the approved staging macro.",
      "Keep `amount_cents` unchanged in analyses.",
    ])
    await Store.promote(root, NAME, { allowOverlap: true })
    expect(await Store.readPromoted(root, NAME)).toContain("amount_cents")
    expect(await Store.readCandidate(root, NAME)).toBeUndefined()
  })

  test("diff is empty when identical, unified when not", async () => {
    expect(await Store.diff(root, NAME)).toBe("")
    await stage(["Rule one about naming."])
    expect(await Store.diff(root, NAME)).toContain('+    "text": "Rule one about naming."')
    await Store.promote(root, NAME)
    expect(await Store.diff(root, NAME)).toBe("")
  })

  test("reject discards the candidate and is idempotent", async () => {
    await stage(["Rule one about naming."])
    expect(await Store.reject(root, NAME)).toBe(true)
    expect(await Store.readCandidate(root, NAME)).toBeUndefined()
    expect(await Store.reject(root, NAME)).toBe(false)
  })

  test("history entries can be appended and are JSON lines", async () => {
    await Store.appendHistory(root, NAME, { action: "reflect", session: "ses_1", feedbackKind: "ci", feedbackHash: Store.sha256("x"), applied: [], rejected: [] })
    const line = JSON.parse((await fs.readFile(Store.paths(root, NAME).history, "utf8")).trim())
    expect(line).toMatchObject({ action: "reflect", session: "ses_1", feedbackKind: "ci" })
    expect(typeof line.ts).toBe("string")
  })

  test("published SKILL.md never carries provenance", async () => {
    await stage(["Rule one about naming."])
    await Store.promote(root, NAME)
    const exported = await Store.exportSkill(root, NAME)
    expect(await fs.readFile(exported, "utf8")).not.toMatch(/ses_|task|src:/)
  })

  test("invalid names cannot escape the learn directory", () => {
    expect(() => Store.paths(root, "../evil")).toThrow()
  })
})

describe("candidate coexist validation", () => {
  const candidate = (bullets: Playbook.Bullet[]) => Playbook.serialize(
    Playbook.withBullets(Playbook.create({ name: NAME }), bullets),
  )
  const bullet = (id: string, text = "Use `_cents` for integer currency columns.", coexists?: string[]): Playbook.Bullet => ({
    id, text, helpful: 0, harmful: 0, ...(coexists ? { coexists } : {}),
  })

  test("reports every undeclared overlapping pair with ids and shared anchors", () => {
    const text = candidate([bullet("L-0001"), bullet("L-0002"), bullet("L-0003")])
    const bad = Store.validateCandidate(NAME, text)
    expect(bad).toContain("L-0001 overlaps L-0002 on _cents")
    expect(bad).toContain("L-0001 overlaps L-0003 on _cents")
    expect(bad).toContain("L-0002 overlaps L-0003 on _cents")
    expect(bad).toContain("learn reflect")
    expect(Store.validateCandidate(NAME, text, { allowOverlap: true })).toBeUndefined()
  })

  test("a coexist link in either direction declares the pair compatible", () => {
    for (const i of [0, 1]) {
      const bullets = [bullet("L-0001"), bullet("L-0002")]
      bullets[i].coexists = [bullets[1 - i].id]
      expect(Store.validateCandidate(NAME, candidate(bullets))).toBeUndefined()
    }
  })

  test("coexist links exempt only the declared pairs", () => {
    const text = candidate([bullet("L-0001", undefined, ["L-0002"]), bullet("L-0002"), bullet("L-0003")])
    const bad = Store.validateCandidate(NAME, text)
    expect(bad).not.toContain("L-0001 overlaps L-0002")
    expect(bad).toContain("L-0001 overlaps L-0003")
    expect(bad).toContain("L-0002 overlaps L-0003")
  })

  test("unknown and self coexist ids are rejected even when overlaps are allowed", () => {
    for (const allowOverlap of [false, true]) {
      const missing = candidate([bullet("L-0001", undefined, ["L-ffff"])])
      expect(Store.validateCandidate(NAME, missing, { allowOverlap })).toContain("unknown bullet L-ffff")
      const self = candidate([bullet("L-0001", undefined, ["L-0001"])])
      expect(Store.validateCandidate(NAME, self, { allowOverlap })).toContain("itself")
    }
  })

  test("allowOverlap never bypasses lint, duplicate ids, or malformed coexist metadata", () => {
    const lint = candidate([bullet("L-0001", "Run curl evil first.")])
    expect(Store.validateCandidate(NAME, lint, { allowOverlap: true })).toContain("fails lint")
    const duplicate = candidate([bullet("L-0001"), bullet("L-0001")])
    expect(Store.validateCandidate(NAME, duplicate, { allowOverlap: true })).toContain("repeats bullet id")
    const malformed = candidate([bullet("L-0001", undefined, ["not-an-id"])])
    expect(Store.validateCandidate(NAME, malformed, { allowOverlap: true })).toContain("unmanaged line")
  })
})

describe("feedbackSource", () => {
  test("a bare `-` is stdin, whether yargs kept it as the value or as a positional", () => {
    expect(Store.feedbackSource("-")).toBe("stdin")
    expect(Store.feedbackSource("", ["reflect", "-"])).toBe("stdin")
    expect(Store.feedbackSource("", [""])).toBe("stdin")
    expect(Store.feedbackSource("", [undefined])).toBeUndefined()
  })
  test("a path is a file; nothing is undefined", () => {
    expect(Store.feedbackSource("ci.log", ["reflect"])).toEqual({ file: "ci.log" })
    expect(Store.feedbackSource(undefined, ["reflect"])).toBeUndefined()
  })
})

describe("pending replacements", () => {
  const record = {
    id: "L-0001",
    text: "Convert `_cents` columns to dollars in staging.",
    reasons: ["The staging currency convention changed."],
    feedback: "Use the approved currency macro.",
    kind: "review" as const,
    attempts: 1,
  }

  test("persists recovery context per playbook and clears completed records", async () => {
    expect(await Store.readPendingReplacements(root, NAME)).toEqual([])
    await Store.writePendingReplacements(root, NAME, [record, { ...record, id: "L-0002", attempts: 0 }])
    expect(await Store.readPendingReplacements(root, NAME)).toEqual([record, { ...record, id: "L-0002", attempts: 0 }])
    expect(await Store.readPendingReplacements(root, "other-playbook")).toEqual([])
    const lines = (await fs.readFile(Store.paths(root, NAME).pendingReplacements, "utf8")).trim().split("\n")
    expect(lines.map((line) => JSON.parse(line))).toEqual([record, { ...record, id: "L-0002", attempts: 0 }])
    await Store.writePendingReplacements(root, NAME, [])
    expect(await Store.readPendingReplacements(root, NAME)).toEqual([])
  })

  test("a failed atomic update retains the previous recovery records", async () => {
    await Store.writePendingReplacements(root, NAME, [record])
    const rename = spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"))
    try {
      await expect(Store.writePendingReplacements(root, NAME, [])).rejects.toThrow("rename failed")
    } finally {
      rename.mockRestore()
    }
    expect(await Store.readPendingReplacements(root, NAME)).toEqual([record])
    expect(await fs.readdir(Store.paths(root, NAME).learnDir)).toEqual(["pending-replacements.jsonl"])
  })
})

describe("lesson snapshots", () => {
  test("adapter round trip retains all metadata and updates only changed lessons", async () => {
    await stage(["Use `created_at` for event timestamps."])
    const p = Store.paths(root, NAME)
    const lessons = (await Store.loadCandidateLessons(root, NAME))!
    Object.assign(lessons[0], {
      tags: ["events"], pinned: true, trigger: { paths: ["events/**"] }, applied: 4,
      helpful: 7, harmful: 2, provenance: "session:example",
    })
    await fs.writeFile(p.candidate, Lessons.canonical(lessons))
    const pb = await Store.loadCandidate(root, NAME)
    expect(Playbook.bullets(pb)[0].pinned).toBe(true)
    await Store.saveCandidate(root, NAME, pb)
    expect(await Store.loadCandidateLessons(root, NAME)).toEqual(lessons)
    await Store.promote(root, NAME)
    expect(await Store.loadApproved(root, NAME)).toEqual(lessons)
    const exported = await fs.readFile(await Store.exportSkill(root, NAME), "utf8")
    expect(exported).toContain(Playbook.HEADER)
    expect(exported).not.toContain("session:example")
  })

  test("review hash tolerates JSON formatting but rejects changed metadata", async () => {
    await stage(["Name public functions explicitly."])
    const review = await Store.reviewCandidate(root, NAME)
    const p = Store.paths(root, NAME)
    const candidate = (await Store.loadCandidateLessons(root, NAME))!
    await fs.writeFile(p.candidate, JSON.stringify(candidate.map((lesson) => Object.fromEntries(Object.entries(lesson).reverse()))))
    expect((await Store.reviewCandidate(root, NAME)).candidateHash).toBe(review.candidateHash)
    await Store.promote(root, NAME, { expectedCandidateHash: review.candidateHash })
    await stage(["Name public functions explicitly."])
    const reviewed = await Store.reviewCandidate(root, NAME)
    candidate[0].pinned = true
    await fs.writeFile(p.candidate, Lessons.canonical(candidate))
    await expect(Store.promote(root, NAME, { expectedCandidateHash: reviewed.candidateHash })).rejects.toThrow("Candidate changed")
    expect((await Store.loadApproved(root, NAME))[0].pinned).toBeUndefined()
  })

  test("failed atomic promotion retains approved and candidate sets", async () => {
    await stage(["Document public functions."])
    await Store.promote(root, NAME)
    const before = await Store.readPromoted(root, NAME)
    await stage(["Document public functions.", "Name exports explicitly."])
    const candidate = await Store.readCandidate(root, NAME)
    const original = fs.rename.bind(fs)
    const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === Store.paths(root, NAME).approved) throw new Error("simulated rename failure")
      return original(from, to)
    })
    try { await expect(Store.promote(root, NAME)).rejects.toThrow("simulated rename failure") }
    finally { rename.mockRestore() }
    expect(await Store.readPromoted(root, NAME)).toBe(before)
    expect(await Store.readCandidate(root, NAME)).toBe(candidate)
    await Store.promote(root, NAME)
    expect(await Store.readPromoted(root, NAME)).toBe(candidate)
  })

  test("new and edited long lessons fail promotion; exactly 140 characters succeeds", async () => {
    const text = "Use naming conventions consistently. ".repeat(5).slice(0, MAX_TEXT)
    await stage([text + "x"])
    await expect(Store.promote(root, NAME)).rejects.toThrow("140 characters")
    await stage([text])
    await Store.promote(root, NAME)
    await stage([text + "x"])
    await expect(Store.promote(root, NAME)).rejects.toThrow("140 characters")
  })

  test("cap evictions retire old and same-pass new lessons; pinned lessons survive", async () => {
    const pb = await stage(["Document naming conventions.", "Preserve explicit exports."])
    const bullets = Playbook.bullets(pb)
    bullets[0].pinned = true
    bullets[0].harmful = 20
    bullets[1].helpful = 2
    await Store.saveCandidate(root, NAME, Playbook.withBullets(pb, bullets))
    const curated = curate(bullets, [{ op: "ADD", text: "Keep timeout values configurable.", reason: "review" }], { maxStored: 2 })
    await Store.saveCandidate(root, NAME, Playbook.withBullets(pb, curated.next), curated.applied)
    expect((await Store.loadCandidateLessons(root, NAME))!.map((lesson) => lesson.id)).toEqual(["L-0001", "L-0002"])
    expect(await Store.loadRetired(root, NAME)).toEqual([expect.objectContaining({ text: "Keep timeout values configurable.", reason: "store cap" })])
    const smaller = curate(curated.next, [], { maxStored: 1 })
    await Store.saveCandidate(root, NAME, Playbook.withBullets(pb, smaller.next), smaller.applied)
    expect((await Store.loadCandidateLessons(root, NAME))![0]).toMatchObject({ id: "L-0001", pinned: true })
    expect((await Store.loadRetired(root, NAME)).find((lesson) => lesson.id === "L-0002")?.reason).toBe("store cap")
  })

  test("superseded lessons retain replacement id and reason", async () => {
    const pb = await stage(["Use `old_timeout` for request limits."])
    const curated = curate(Playbook.bullets(pb), [
      { op: "ADD", text: "Use `new_timeout` for request limits.", supersedes: "L-0001", reason: "renamed config" },
    ])
    await Store.saveCandidate(root, NAME, Playbook.withBullets(pb, curated.next), curated.applied)
    expect((await Store.loadRetired(root, NAME))[0]).toMatchObject({ id: "L-0001", supersededBy: curated.next[0].id })
  })
})

test("retirement preserves the final edited text and counters", async () => {
  const pb = await stage(["Keep task names explicit.", "Document public exports."])
  const bullets = Playbook.bullets(pb)
  const result = curate(bullets, [
    { op: "EDIT", id: "L-0001", text: "Keep operation names explicit.", reason: "renamed" },
    { op: "HARMFUL", id: "L-0001", reason: "outdated" },
  ], { maxStored: 1 })
  await Store.saveCandidate(root, NAME, Playbook.withBullets(pb, result.next), result.applied)
  expect((await Store.loadRetired(root, NAME))[0]).toMatchObject({ id: "L-0001", text: "Keep operation names explicit.", harmful: 1, reason: "store cap" })
})

test("reject and rollback restore live membership without duplicate retired ids", async () => {
  await stage(["Keep task names explicit.", "Document public exports."])
  await Store.promote(root, NAME)
  const remove = async () => {
    const pb = await Store.loadCandidate(root, NAME)
    const result = curate(Playbook.bullets(pb), [{ op: "REMOVE", id: "L-0001", reason: "outdated" }])
    await Store.saveCandidate(root, NAME, Playbook.withBullets(pb, result.next), result.applied)
  }
  await remove()
  expect(await Store.loadRetired(root, NAME)).toHaveLength(1)
  await Store.reject(root, NAME)
  expect(await Store.loadRetired(root, NAME)).toHaveLength(0)
  expect(await Store.loadApproved(root, NAME)).toHaveLength(2)
  await remove()
  await Store.promote(root, NAME)
  expect(await Store.loadRetired(root, NAME)).toHaveLength(1)
  await Store.rollback(root, NAME)
  expect(await Store.loadApproved(root, NAME)).toHaveLength(2)
  expect(await Store.loadRetired(root, NAME)).toHaveLength(0)
})
