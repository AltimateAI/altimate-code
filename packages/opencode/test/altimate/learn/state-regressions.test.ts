// altimate_change - new file
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as Playbook from "../../../src/altimate/learn/playbook"
import * as Store from "../../../src/altimate/learn/store"

const NAME = "team-playbook"
let root: string
const recovery: Store.PendingReplacement = {
  id: "L-0001", text: "Use snake case for warehouse relations.", reasons: ["Naming changed."],
  feedback: "Use snake case.", kind: "review", attempts: 1,
}

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-state-regression-")) })
afterEach(() => fs.rm(root, { recursive: true, force: true }))

async function stage(text: string) {
  await Store.saveCandidate(root, NAME, Playbook.withBullets(Playbook.create({ name: NAME }), [
    { id: "L-0001", text, helpful: 0, harmful: 0 },
  ]))
}

describe("review finding regressions: learn state", () => {
  test("promotion refuses a candidate changed after the reviewed content hash", async () => {
    await stage("Use snake case for warehouse relations.")
    const reviewed = (await Store.readCandidate(root, NAME))!
    await stage("Use explicit names for data model owners.")
    await expect(Store.promote(root, NAME, { expectedCandidateHash: Store.sha256(reviewed) })).rejects.toThrow("re-run")
    expect(await Store.readPromoted(root, NAME)).toBeUndefined()
    expect(await Store.readCandidate(root, NAME)).toContain("explicit names")
  })

  test("malformed harmful values are quarantined while valid records survive", async () => {
    await stage("Use snake case for warehouse relations.")
    const file = Store.paths(root, NAME).harmful
    const raw = JSON.stringify({ "L-0001": 42, "L-0002": ["abcdef12"], "L-0003": [5] })
    await fs.writeFile(file, raw)
    expect(await Store.readHarmfulFrom(root, NAME)).toEqual({ "L-0002": ["abcdef12"] })
    expect(await Store.readHarmfulFrom(root, NAME)).toEqual({ "L-0002": ["abcdef12"] })
    const quarantined = (await fs.readdir(path.dirname(file))).filter((name) => name.startsWith("harmful.json.malformed-"))
    expect(quarantined).toHaveLength(1)
    expect(await fs.readFile(path.join(path.dirname(file), quarantined[0]), "utf8")).toBe(raw)
    expect((await fs.stat(path.join(path.dirname(file), quarantined[0]))).mode & 0o777).toBe(0o600)
  })

  test("malformed pending records are quarantined without blocking valid recovery", async () => {
    await stage("Use snake case for warehouse relations.")
    const file = Store.paths(root, NAME).pendingReplacements
    const raw = [JSON.stringify(recovery), "{broken", JSON.stringify({ ...recovery, reasons: 42 }), JSON.stringify({ ...recovery, attempts: -1 }), JSON.stringify({ ...recovery, kind: "unknown" })].join("\n")
    await fs.writeFile(file, raw)
    expect(await Store.readPendingReplacements(root, NAME)).toEqual([recovery])
    expect(await Store.readPendingReplacements(root, NAME)).toEqual([recovery])
    const quarantined = (await fs.readdir(path.dirname(file))).filter((name) => name.startsWith("pending-replacements.jsonl.malformed-"))
    expect(quarantined).toHaveLength(1)
    expect(await fs.readFile(path.join(path.dirname(file), quarantined[0]), "utf8")).toBe(raw)
  })

  for (const state of ["harmful", "pending"] as const) {
    test(`interrupted ${state} quarantine preserves valid records on rerun`, async () => {
      await stage("Use snake case for warehouse relations.")
      const p = Store.paths(root, NAME)
      const file = state === "harmful" ? p.harmful : p.pendingReplacements
      const raw = state === "harmful"
        ? JSON.stringify({ "L-0001": 42, "L-0002": ["feedback"] })
        : `${JSON.stringify(recovery)}\n{broken\n`
      await fs.writeFile(file, raw)
      const read = () => state === "harmful" ? Store.readHarmfulFrom(root, NAME) : Store.readPendingReplacements(root, NAME)
      const rename = fs.rename.bind(fs)
      const interrupted = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (String(destination) === file) throw new Error("interrupted repaired write")
        await rename(source, destination)
      })
      try {
        await expect(read()).rejects.toThrow("interrupted repaired write")
      } finally {
        interrupted.mockRestore()
      }
      const valid = state === "harmful" ? { "L-0002": ["feedback"] } : [recovery]
      expect(await read()).toEqual(valid)
      expect(await read()).toEqual(valid)
      const quarantined = (await fs.readdir(p.learnDir)).filter((name) => name.startsWith(`${path.basename(file)}.malformed-`))
      expect(quarantined).toHaveLength(1)
      expect(await fs.readFile(path.join(p.learnDir, quarantined[0]), "utf8")).toBe(raw)
    })
  }

  test("interrupted history quarantine preserves valid history and migration remains idempotent", async () => {
    const p = Store.paths(root, NAME)
    await fs.mkdir(p.skillDir, { recursive: true })
    await fs.mkdir(p.learnDir, { recursive: true })
    await fs.writeFile(p.skill, Playbook.serialize(Playbook.create({ name: NAME })))
    const entry = { action: "reflect", ts: "2026-09-30T00:00:00.000Z", session: "original" }
    const raw = `${JSON.stringify(entry)}\n{broken\n`
    await fs.writeFile(p.history, raw)
    const rename = fs.rename.bind(fs)
    const interrupted = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (String(destination) === p.history) throw new Error("interrupted repaired history")
      await rename(source, destination)
    })
    try {
      await expect(Store.migrate(root, NAME)).resolves.toBeUndefined()
      expect(JSON.parse(await fs.readFile(p.migration, "utf8")).complete).toBe(false)
    } finally {
      interrupted.mockRestore()
    }
    await Store.migrate(root, NAME)
    await Store.migrate(root, NAME)
    const history = (await fs.readFile(p.history, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(history.filter((record) => record.action === "reflect")).toEqual([entry])
    expect(history.filter((record) => record.action === "migrated-from")).toHaveLength(1)
    expect(JSON.parse(await fs.readFile(p.migration, "utf8")).complete).toBe(true)
    const quarantined = (await fs.readdir(p.learnDir)).filter((name) => name.startsWith("history.jsonl.malformed-"))
    expect(quarantined).toHaveLength(1)
    expect(await fs.readFile(path.join(p.learnDir, quarantined[0]), "utf8")).toBe(raw)
  })

  test("reject discards pending recovery from the rejected candidate", async () => {
    await stage("Use snake case for warehouse relations.")
    await Store.writePendingReplacements(root, NAME, [recovery])
    await Store.reject(root, NAME)
    expect(await Store.readPendingReplacements(root, NAME)).toEqual([])
  })

  test("rollback discards pending recovery from the rolled-back candidate", async () => {
    await stage("Use snake case for warehouse relations.")
    await Store.promote(root, NAME)
    await stage("Use explicit names for data model owners.")
    await Store.promote(root, NAME)
    await Store.writePendingReplacements(root, NAME, [recovery])
    await Store.rollback(root, NAME)
    expect(await Store.readPendingReplacements(root, NAME)).toEqual([])
  })
})
