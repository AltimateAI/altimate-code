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

describe("pin / unpin", () => {
  test("round trip changes approved metadata and records both actions in history", async () => {
    await stage(["Document naming conventions.", "Preserve explicit exports."])
    await Store.promote(root, NAME)
    const before = await Store.loadApproved(root, NAME)
    const pinned = await Store.setPinned(root, NAME, "L-0001", true)
    expect(pinned).toEqual({ ...before[0], pinned: true, updated: expect.any(String) })
    expect(await Store.loadApproved(root, NAME)).toEqual([pinned, before[1]])
    expect(await Store.readCandidate(root, NAME)).toBeUndefined()

    const unpinned = await Store.setPinned(root, NAME, "L-0001", false)
    expect(unpinned).toEqual({ ...before[0], pinned: false, updated: expect.any(String) })
    expect(await Store.loadApproved(root, NAME)).toEqual([unpinned, before[1]])
    const history = (await fs.readFile(Store.paths(root, NAME).history, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(history.slice(-2)).toEqual([
      { action: "pin", id: "L-0001", ts: expect.any(String) },
      { action: "unpin", id: "L-0001", ts: expect.any(String) },
    ])
    for (const entry of history.slice(-2)) expect(Number.isNaN(Date.parse(entry.ts))).toBe(false)
  })

  test("unknown IDs list search matches and never pin candidate-only or retired lessons", async () => {
    await stage(["Document naming conventions."])
    await Store.promote(root, NAME)
    await stage(["Document naming conventions.", "Preserve explicit exports."])
    const p = Store.paths(root, NAME)
    const approved = await Store.readPromoted(root, NAME)
    const candidate = await Store.readCandidate(root, NAME)
    const history = await fs.readFile(p.history, "utf8")
    const matches = await Store.search(root, NAME, "L-000x")
    expect(matches.map(({ lesson }) => lesson.id)).toEqual(["L-0001"])
    for (const pinned of [true, false]) {
      await expect(Store.setPinned(root, NAME, "L-000x", pinned)).rejects.toThrow('Unknown approved lesson "L-000x"')
      await expect(Store.setPinned(root, NAME, "L-000x", pinned)).rejects.toThrow("[L-0001] approved: Document naming conventions.")
      await expect(Store.setPinned(root, NAME, "L-0002", pinned)).rejects.toThrow("Unknown approved lesson")
    }
    const retired = { ...(await Store.loadApproved(root, NAME))[0], id: "L-abcd", reason: "removed" }
    await fs.writeFile(p.retired, Lessons.canonical([retired]))
    await expect(Store.setPinned(root, NAME, retired.id, true)).rejects.toThrow("[L-abcd] retired:")
    await expect(Store.setPinned(root, NAME, "L-ffffffff", true)).rejects.toThrow("No close matches. Use `learn search <query>`")
    expect(await Store.readPromoted(root, NAME)).toBe(approved)
    expect(await Store.readCandidate(root, NAME)).toBe(candidate)
    expect(await fs.readFile(p.history, "utf8")).toBe(history)
    expect(await Store.loadRetired(root, NAME)).toEqual([retired])
  })

  test("failed atomic pin leaves the approved snapshot and history unchanged", async () => {
    await stage(["Document naming conventions."])
    await Store.promote(root, NAME)
    const p = Store.paths(root, NAME)
    const before = await Store.readPromoted(root, NAME)
    const history = await fs.readFile(p.history, "utf8")
    const original = fs.rename.bind(fs)
    const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === p.approved) throw new Error("simulated rename failure")
      return original(from, to)
    })
    try { await expect(Store.setPinned(root, NAME, "L-0001", true)).rejects.toThrow("simulated rename failure") }
    finally { rename.mockRestore() }
    expect(await Store.readPromoted(root, NAME)).toBe(before)
    expect(await fs.readFile(p.history, "utf8")).toBe(history)
    expect((await fs.readdir(p.learnDir)).some((file) => file.endsWith(".tmp"))).toBe(false)
  })

  test("concurrent pins retain both changes and history records", async () => {
    await stage(["Document naming conventions.", "Preserve explicit exports."])
    await Store.promote(root, NAME)
    await Promise.all(["L-0001", "L-0002"].map((id) => Store.setPinned(root, NAME, id, true)))
    expect((await Store.loadApproved(root, NAME)).map((lesson) => lesson.pinned)).toEqual([true, true])
    const history = (await fs.readFile(Store.paths(root, NAME).history, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(history.filter((entry) => entry.action === "pin").map((entry) => entry.id).sort()).toEqual(["L-0001", "L-0002"])
  })
})

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

test.each([
  ["null", null],
  ["string", "invalid"],
  ["object", { id: "L-0002", text: "Long legacy guidance. ".repeat(10) }],
  ["invalid entries", [null, "invalid", {}, { id: 1, text: "Long legacy guidance. ".repeat(10) }, { id: "L-0002", text: null }]],
] as const)("grandfathered ignores malformed persisted allowances: %s", async (_, malformed) => {
  await stage(["Document naming conventions."])
  const valid = { id: "L-0003", text: "Preserve the imported naming convention. ".repeat(10) }
  expect(valid.text.length).toBeGreaterThan(MAX_TEXT)
  await fs.writeFile(Store.paths(root, NAME).history, [
    { action: "migrated-from", grandfathered: malformed },
    { action: "migrated-from", grandfathered: [valid, { id: "L-0004", text: "Short guidance." }] },
  ].map((entry) => JSON.stringify(entry) + "\n").join(""))
  expect(await Store.grandfathered(root, NAME)).toEqual([valid])
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

  test("promotion and rejection preserve owner-only reflection history permissions", async () => {
    const file = Store.paths(root, NAME).history
    await Store.appendHistory(root, NAME, { action: "reflect", rejected: [] })
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    for (const action of [Store.promote, Store.reject]) {
      await stage(["List result columns explicitly."])
      await fs.chmod(file, 0o644)
      await action(root, NAME)
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    }
    const history = (await fs.readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(history.map((entry) => entry.action)).toEqual(["reflect", "promote", "reject"])
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

describe("single-file skill exports", () => {
  test("updates an existing learn-managed single-file export", async () => {
    await stage(["Document naming conventions."])
    await Store.promote(root, NAME)
    const file = await Store.exportSkill(root, NAME)
    await stage(["Preserve explicit exports."])
    await Store.promote(root, NAME)
    expect(await Store.exportSkill(root, NAME)).toBe(file)
    expect(await fs.readFile(file, "utf8")).toContain("Preserve explicit exports.")
    expect(await fs.readdir(path.dirname(file))).toEqual(["SKILL.md"])
  })

  test.each([false, true])("preserves unverified staging files when the export is edited: %s", async (edited) => {
    await stage(["Document naming conventions."])
    await Store.promote(root, NAME)
    const file = await Store.exportSkill(root, NAME)
    const stale = `${file}.999999.stale123.tmp`
    await fs.writeFile(stale, "Keep this file.")
    const before = await fs.readFile(file, "utf8")
    const existing = edited ? before.replace("Document naming conventions.", "Document error conventions.") : before
    await fs.writeFile(file, existing)
    await stage(["Preserve explicit exports."])
    await Store.promote(root, NAME)
    await expect(Store.exportSkill(root, NAME)).rejects.toThrow("no extra files")
    expect(await fs.readFile(stale, "utf8")).toBe("Keep this file.")
    expect(await fs.readFile(file, "utf8")).toBe(existing)
  })

  test("retries an interrupted first export without treating its empty directory as user-authored", async () => {
    await stage(["Document naming conventions."])
    await Store.promote(root, NAME)
    const p = Store.paths(root, NAME)
    const original = fs.rename.bind(fs)
    const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === p.skill) throw new Error("interrupted first export")
      return original(from, to)
    })
    try { await expect(Store.exportSkill(root, NAME)).rejects.toThrow("interrupted first export") }
    finally { rename.mockRestore() }
    expect(await fs.readdir(p.skillDir)).toEqual([])
    await Store.exportSkill(root, NAME)
    expect(await fs.readFile(p.skill, "utf8")).toContain("Document naming conventions.")
  })

  for (const edit of ["text", "counter"] as const) {
    test(`preserves valid-format hand edits to exported ${edit}`, async () => {
      await stage(["Document naming conventions."])
      await Store.promote(root, NAME)
      const file = await Store.exportSkill(root, NAME)
      const before = await fs.readFile(file, "utf8")
      const edited = edit === "text" ? before.replace("Document naming conventions.", "Document error conventions.") : before.replace("h:0", "h:7")
      expect(Store.validateCandidate(NAME, edited)).toBeUndefined()
      await fs.writeFile(file, edited)
      await stage(["Preserve explicit exports."])
      await Store.promote(root, NAME)
      await expect(Store.exportSkill(root, NAME)).rejects.toThrow("unchanged learn-managed export")
      expect(await fs.readFile(file, "utf8")).toBe(edited)
    })
  }

  test("rollback refreshes an existing export with the restored approved snapshot", async () => {
    await stage(["Document naming conventions."])
    await Store.promote(root, NAME)
    const file = await Store.exportSkill(root, NAME)
    const original = await fs.readFile(file, "utf8")
    await stage(["Preserve explicit exports."])
    await Store.promote(root, NAME)
    await Store.exportSkill(root, NAME)
    expect(await fs.readFile(file, "utf8")).not.toBe(original)
    await Store.rollback(root, NAME)
    expect(await fs.readFile(file, "utf8")).toBe(original)
  })

  test.each(["text", "counter", "unmanaged-line", "removed-header", "unverified-temp"])("rollback restores approved lessons and preserves an edited export: %s", async (edit) => {
    await stage(["Document naming conventions."])
    await Store.promote(root, NAME)
    const p = Store.paths(root, NAME)
    const approved = await fs.readFile(p.approved, "utf8")
    await stage(["Preserve explicit exports."])
    await Store.promote(root, NAME)
    await Store.exportSkill(root, NAME)
    const before = await fs.readFile(p.skill, "utf8")
    const edited = edit === "text" ? before.replace("Preserve explicit exports.", "Document error conventions.") :
      edit === "counter" ? before.replace("h:0", "h:7") :
      edit === "unmanaged-line" ? `${before}\nKeep these local notes.\n` :
      edit === "removed-header" ? before.replace(Playbook.HEADER, "") : before
    await fs.writeFile(p.skill, edited)
    const stale = `${p.skill}.999999.stale123.tmp`
    if (edit === "unverified-temp") await fs.writeFile(stale, "Keep this file.")
    const receipt = await fs.readFile(p.exportState, "utf8")
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect((await Store.rollback(root, NAME)).restored).toBe(1)
      expect(await fs.readFile(p.approved, "utf8")).toBe(approved)
      expect(await fs.readFile(p.skill, "utf8")).toBe(edited)
      expect(await fs.readFile(p.exportState, "utf8")).toBe(receipt)
      if (edit === "unverified-temp") expect(await fs.readFile(stale, "utf8")).toBe("Keep this file.")
      expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toMatch(/left .*SKILL\.md unchanged.*separate reconciliation/)
      expect(await fs.readdir(p.versions)).toEqual([])
    } finally { stderr.mockRestore() }
  })

  test("rollback refreshes an older export without a recorded hash", async () => {
    await stage(["Document naming conventions."])
    await Store.promote(root, NAME)
    const file = await Store.exportSkill(root, NAME)
    const original = await fs.readFile(file, "utf8")
    await stage(["Preserve explicit exports."])
    await Store.promote(root, NAME)
    await Store.exportSkill(root, NAME)
    await fs.rm(Store.paths(root, NAME).exportState)
    await Store.rollback(root, NAME)
    expect(await fs.readFile(file, "utf8")).toBe(original)
  })

  test("retries rollback when an older export is interrupted after restoring approved lessons", async () => {
    await stage(["Document naming conventions."])
    await Store.promote(root, NAME)
    const p = Store.paths(root, NAME)
    const approved = await Store.readPromoted(root, NAME)
    const original = await fs.readFile(await Store.exportSkill(root, NAME), "utf8")
    await stage(["Preserve explicit exports."])
    await Store.promote(root, NAME)
    await Store.exportSkill(root, NAME)
    await fs.rm(p.exportState)
    const renameFile = fs.rename.bind(fs)
    const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === p.exportState && await fs.readFile(p.approved, "utf8") === approved)
        throw new Error("interrupted export receipt")
      return renameFile(from, to)
    })
    try { await expect(Store.rollback(root, NAME)).rejects.toThrow("interrupted export receipt") }
    finally { rename.mockRestore() }
    await Store.rollback(root, NAME)
    expect(await fs.readFile(p.skill, "utf8")).toBe(original)
    expect(await Store.readPromoted(root, NAME)).toBe(approved)
  })

  test("rollback preserves an unrelated hand-written skill", async () => {
    await stage(["Document naming conventions."])
    await Store.promote(root, NAME)
    const original = await Store.readPromoted(root, NAME)
    await stage(["Preserve explicit exports."])
    await Store.promote(root, NAME)
    const p = Store.paths(root, NAME)
    await fs.mkdir(p.skillDir, { recursive: true })
    await fs.writeFile(p.skill, "Hand-written guidance must survive.")
    await Store.rollback(root, NAME)
    expect(await fs.readFile(p.skill, "utf8")).toBe("Hand-written guidance must survive.")
    expect(await Store.readPromoted(root, NAME)).toBe(original)
  })

  for (const ancestor of [".altimate-code", ".altimate-code/skills"] as const) {
    test(`refuses export through a symlinked ${ancestor} ancestor inside the project`, async () => {
      await stage(["Document naming conventions."])
      await Store.promote(root, NAME)
      const file = await Store.exportSkill(root, NAME)
      const original = await fs.readFile(file, "utf8")
      await stage(["Preserve explicit exports."])
      await Store.promote(root, NAME)
      const directory = path.join(root, ancestor)
      const destination = path.join(root, "redirected")
      await fs.rename(directory, destination)
      await fs.symlink(destination, directory)
      await expect(Store.exportSkill(root, NAME)).rejects.toThrow(/symlink/)
      expect(await fs.readFile(file, "utf8")).toBe(original)
    })
  }

  test("refuses a stale export temp symlink without touching its target", async () => {
    await stage(["Document naming conventions."])
    await Store.promote(root, NAME)
    const file = await Store.exportSkill(root, NAME)
    const victim = path.join(root, "victim.txt")
    await fs.writeFile(victim, "Keep this content.")
    const stale = `${file}.999999.stale123.tmp`
    await fs.symlink(victim, stale)
    await expect(Store.exportSkill(root, NAME)).rejects.toThrow(/symlink/)
    expect(await fs.readFile(victim, "utf8")).toBe("Keep this content.")
    expect((await fs.lstat(stale)).isSymbolicLink()).toBe(true)
  })

  for (const kind of ["hand-written", "edited-managed", "empty", "unexpected-file", "nested-symlink", "skill-symlink", "root-symlink", "dangling-symlink"] as const) {
    test(`refuses a ${kind} export target without changing its contents`, async () => {
      await stage(["Document naming conventions."])
      await Store.promote(root, NAME)
      const p = Store.paths(root, NAME)
      const managed = Playbook.serialize(Playbook.create({ name: NAME }))
      const external = path.join(root, "external")
      await fs.mkdir(external)
      const externalSkill = path.join(external, "SKILL.md")
      await fs.writeFile(externalSkill, "External guidance must survive.\n")
      await fs.mkdir(path.dirname(p.skillDir), { recursive: true })
      if (kind === "root-symlink" || kind === "dangling-symlink") {
        await fs.symlink(kind === "root-symlink" ? external : path.join(root, "missing"), p.skillDir)
      } else {
        await fs.mkdir(p.skillDir)
        if (kind === "skill-symlink") await fs.symlink(externalSkill, p.skill)
        else if (kind !== "empty") await fs.writeFile(p.skill,
          kind === "hand-written" ? "Hand-written guidance must survive.\n" :
          kind === "edited-managed" ? `${managed}\nHand-written additions must survive.\n` : managed,
        )
        if (kind === "unexpected-file") await fs.writeFile(path.join(p.skillDir, "private.txt"), "Local notes.\n")
        if (kind === "nested-symlink") {
          await fs.mkdir(path.join(p.skillDir, "references"))
          await fs.symlink(externalSkill, path.join(p.skillDir, "references", "external.md"))
        }
      }
      const before = await fs.readFile(p.skill, "utf8").catch(() => undefined)
      await expect(Store.exportSkill(root, NAME)).rejects.toThrow(/Refusing to export.*learn-managed single-file/)
      expect(await fs.readFile(p.skill, "utf8").catch(() => undefined)).toBe(before)
      expect(await fs.readFile(externalSkill, "utf8")).toBe("External guidance must survive.\n")
      if (kind === "root-symlink" || kind === "dangling-symlink")
        expect((await fs.lstat(p.skillDir)).isSymbolicLink()).toBe(true)
      if (kind === "skill-symlink") expect((await fs.lstat(p.skill)).isSymbolicLink()).toBe(true)
      if (kind === "unexpected-file") expect(await fs.readFile(path.join(p.skillDir, "private.txt"), "utf8")).toBe("Local notes.\n")
      if (kind === "nested-symlink") expect((await fs.lstat(path.join(p.skillDir, "references", "external.md"))).isSymbolicLink()).toBe(true)
      if (kind === "empty") expect(await fs.readdir(p.skillDir)).toEqual([])
    })
  }
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

for (const kind of ["symlink", "regular file"] as const) {
  test(`atomic writes preserve a pre-existing staging ${kind}`, async () => {
    const p = Store.paths(root, NAME)
    await fs.mkdir(p.learnDir, { recursive: true })
    const victim = path.join(root, "victim.txt")
    await fs.writeFile(victim, "Keep this content.")
    const random = 0.125
    const staging = `${p.candidate}.${process.pid}.${random.toString(36).slice(2)}.tmp`
    if (kind === "symlink") await fs.symlink(victim, staging)
    else await fs.writeFile(staging, "Unrelated staging file.")
    const mock = spyOn(Math, "random").mockReturnValue(random)
    try {
      await expect(Store.transaction(root, () => Store.writeAtomic(root, p.candidate, "replacement"))).rejects.toThrow()
    } finally { mock.mockRestore() }
    expect(await fs.readFile(victim, "utf8")).toBe("Keep this content.")
    if (kind === "symlink") expect((await fs.lstat(staging)).isSymbolicLink()).toBe(true)
    else expect(await fs.readFile(staging, "utf8")).toBe("Unrelated staging file.")
    expect(await fs.stat(p.candidate).catch(() => undefined)).toBeUndefined()
  })
}
