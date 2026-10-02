// altimate_change - new file
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as Playbook from "../../../src/altimate/learn/playbook"
import * as Store from "../../../src/altimate/learn/store"

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
  test("new playbook uses alwaysApply without dbt_project.yml", async () => {
    const pb = await Store.loadCandidate(root, NAME)
    expect(Playbook.serialize(pb)).toContain("alwaysApply: true")
  })

  test("new playbook uses applyPaths dbt_project.yml when it exists", async () => {
    await fs.writeFile(path.join(root, "dbt_project.yml"), "name: x\n")
    expect(Playbook.serialize(await Store.loadCandidate(root, NAME))).toContain('applyPaths: ["dbt_project.yml"]')
  })

  test("--apply-paths wins", async () => {
    const pb = await Store.loadCandidate(root, NAME, { applyPaths: ["pyproject.toml"] })
    expect(Playbook.serialize(pb)).toContain('applyPaths: ["pyproject.toml"]')
  })

  test("seeds from the promoted skill when no candidate exists", async () => {
    await stage(["First rule about naming."])
    await Store.promote(root, NAME)
    await Store.reject(root, NAME)
    const pb = await Store.loadCandidate(root, NAME)
    expect(Playbook.bullets(pb).map((b) => b.text)).toEqual(["First rule about naming."])
  })
})

describe("promote / rollback / reject flow", () => {
  test("promote copies the candidate to the project skill path and logs history", async () => {
    const cand = await stage(["Rule one about naming."])
    const r = await Store.promote(root, NAME)
    expect(r.archived).toBeUndefined()
    const skill = path.join(root, ".altimate-code/skills", NAME, "SKILL.md")
    expect(await fs.readFile(skill, "utf8")).toBe(Playbook.serialize(cand))
    const history = (await fs.readFile(path.join(root, ".altimate-code/learn", NAME, "history.jsonl"), "utf8")).trim().split("\n")
    expect(JSON.parse(history.at(-1)!)).toMatchObject({ action: "promote" })
  })

  test("second promote archives the previous version; rollback restores and consumes it", async () => {
    await stage(["Rule one about naming."])
    await Store.promote(root, NAME)
    const v1 = (await Store.readPromoted(root, NAME))!
    await stage(["Rule one about naming.", "Rule two about tests."])
    expect((await Store.promote(root, NAME)).archived).toBe(1)
    expect(await fs.readFile(path.join(root, ".altimate-code/learn", NAME, "versions/v1.md"), "utf8")).toBe(v1)

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
    expect(versions.sort()).toEqual(["v1.md", "v2.md"])
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
    const candidate = Playbook.serialize(await stage([text]))
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
    const candidate = Playbook.serialize(await stage([...texts, "Document the model grain."]))
    const review = await Store.reviewCandidate(root, NAME)
    expect(review.candidateHash).toBe(Store.sha256(candidate))
    expect(review.diff).toContain("WARNING [L-0001]: mentions skipping or disabling verification\n  Never skip tests.")
    expect(review.diff).toContain("+- [L-0007] Document the model grain.")
    expect(review.diff).not.toContain(" - [L-0001]")
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
    expect(await Store.readPromoted(root, NAME)).toContain("c:L-0001")
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
    expect(await Store.diff(root, NAME)).toContain("+- [L-0001] Rule one about naming.")
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
    expect(await Store.readPromoted(root, NAME)).not.toMatch(/ses_|task|src:/)
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
