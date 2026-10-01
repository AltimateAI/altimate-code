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
