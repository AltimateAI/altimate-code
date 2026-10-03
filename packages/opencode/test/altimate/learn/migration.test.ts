// altimate_change - new file
import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import * as Playbook from "../../../src/altimate/learn/playbook"
import * as Store from "../../../src/altimate/learn/store"
import * as Lessons from "../../../src/altimate/learn/lesson"

const name = "project-conventions"
async function legacy(root: string, text = "Use explicit column lists.") {
  const p = Store.paths(root, name)
  await fs.mkdir(p.skillDir, { recursive: true })
  await fs.mkdir(p.versions, { recursive: true })
  const pb = Playbook.withBullets(Playbook.create({ name, applyPaths: ["src/**"] }), [
    { id: "L-1234", text, helpful: 3, harmful: 1 },
  ])
  await fs.writeFile(p.skill, Playbook.serialize(pb))
  await fs.writeFile(path.join(p.learnDir, "candidate.md"), Playbook.serialize(Playbook.withBullets(pb, [
    { id: "L-1234", text, helpful: 4, harmful: 1 },
  ])))
  await fs.writeFile(path.join(p.versions, "v2.md"), Playbook.serialize(pb))
  return p
}

test("imports custom names, candidate, versions and sidecars once without deleting the managed skill", async () => {
  await using tmp = await tmpdir()
  const p = await legacy(tmp.path)
  await Store.writeHarmfulFrom(tmp.path, name, { "L-1234": ["feedback"] })
  await Store.appendHistory(tmp.path, name, { action: "reflect", feedbackHash: "original" })
  await Store.writePendingReplacements(tmp.path, name, [{ id: "L-abcd", text: "Earlier convention.", reasons: ["changed"], feedback: "review", kind: "review", attempts: 0 }])
  const skill = await fs.readFile(p.skill, "utf8")
  expect((await Store.loadApproved(tmp.path, name))[0]).toMatchObject({ id: "L-1234", helpful: 3, trigger: { paths: ["src/**"] } })
  expect((await Store.loadCandidateLessons(tmp.path, name))![0].helpful).toBe(4)
  expect(Lessons.parse(await fs.readFile(path.join(p.versions, "v2.json"), "utf8"))[0].helpful).toBe(3)
  expect(await Store.readHarmfulFrom(tmp.path, name)).toEqual({ "L-1234": ["feedback"] })
  expect(await Store.readPendingReplacements(tmp.path, name)).toHaveLength(1)
  const first = await fs.readFile(p.history, "utf8")
  await Store.migrate(tmp.path, name)
  expect(await fs.readFile(p.history, "utf8")).toBe(first)
  expect(first.split("\n").filter((line) => line.includes('"action":"migrated-from"'))).toHaveLength(1)
  expect(await fs.readFile(p.skill, "utf8")).toBe(skill)
  await Store.reject(tmp.path, name)
  expect(await Store.readCandidate(tmp.path, name)).toBeUndefined()
  await Store.rollback(tmp.path, name)
  expect(await fs.stat(path.join(p.versions, "v2.json")).catch(() => undefined)).toBeUndefined()
  await Store.migrate(tmp.path, name)
  expect(await fs.stat(path.join(p.versions, "v2.json")).catch(() => undefined)).toBeUndefined()
})

test("ordinary skills and existing new stores are never imported", async () => {
  await using tmp = await tmpdir()
  const p = await legacy(tmp.path)
  await fs.writeFile(p.skill, (await fs.readFile(p.skill, "utf8")).replace(Playbook.HEADER, "User-owned skill."))
  expect(await Store.loadApproved(tmp.path, name)).toEqual([])
  expect(await fs.stat(p.migration).catch(() => undefined)).toBeUndefined()
  await legacy(tmp.path)
  await fs.writeFile(p.approved, "[]\n")
  expect(await Store.loadApproved(tmp.path, name)).toEqual([])
  expect(await Store.loadCandidateLessons(tmp.path, name)).toBeUndefined()
})

test("malformed candidate, versions and sidecars are quarantined without losing valid records", async () => {
  await using tmp = await tmpdir()
  const p = await legacy(tmp.path)
  await fs.writeFile(path.join(p.learnDir, "candidate.md"), "not a playbook")
  await fs.writeFile(path.join(p.versions, "v3.md"), "broken")
  await fs.writeFile(p.harmful, '{"L-1234":["feedback"],"bad":1}')
  await fs.writeFile(p.history, '{"action":"reflect"}\ninvalid\n')
  await Store.migrate(tmp.path, name)
  expect(await Store.loadApproved(tmp.path, name)).toHaveLength(1)
  expect(await Store.loadCandidateLessons(tmp.path, name)).toBeUndefined()
  const files = await fs.readdir(p.learnDir)
  expect(files.filter((name) => name.startsWith("candidate.md.malformed-"))).toHaveLength(1)
  expect(files.filter((name) => name.startsWith("harmful.json.malformed-"))).toHaveLength(1)
  expect(files.filter((name) => name.startsWith("history.jsonl.malformed-"))).toHaveLength(1)
  expect((await fs.readdir(p.versions)).filter((name) => name.startsWith("v3.md.malformed-"))).toHaveLength(1)
  await Store.migrate(tmp.path, name)
  expect(await fs.readdir(p.learnDir)).toEqual(files)
})

test("interrupted migration resumes after approved is written without overwriting it or duplicating history", async () => {
  await using tmp = await tmpdir()
  const p = await legacy(tmp.path)
  const original = fs.rename.bind(fs)
  const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === p.candidate) throw new Error("crash after approved")
    return original(from, to)
  })
  try { await expect(Store.migrate(tmp.path, name)).resolves.toBeUndefined() }
  finally { rename.mockRestore() }
  const approved = await fs.readFile(p.approved, "utf8")
  expect(await fs.stat(p.candidate).catch(() => undefined)).toBeUndefined()
  await Store.migrate(tmp.path, name)
  expect(await fs.readFile(p.approved, "utf8")).toBe(approved)
  expect(await Store.loadCandidateLessons(tmp.path, name)).toHaveLength(1)
  expect(await fs.stat(path.join(p.versions, "v2.json"))).toBeDefined()
  await Store.migrate(tmp.path, name)
  const history = (await fs.readFile(p.history, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  expect(history.filter((entry) => entry.action === "migrated-from")).toHaveLength(1)
})

for (const invalid of ["json", "shape", "lessons", "source", "target", "quarantine"] as const) {
  test(`malformed ${invalid} migration journal is quarantined once and rebuilt safely`, async () => {
    await using tmp = await tmpdir()
    const p = await legacy(tmp.path)
    const untouched = path.join(tmp.path, "untouched.txt")
    await fs.writeFile(untouched, "User-owned file.")
    const journal = { source: p.skill, complete: false, imports: [], malformed: [] }
    const raw = invalid === "json" ? "{broken" : JSON.stringify({
      ...journal,
      ...(invalid === "shape" ? { complete: "false" } : {}),
      ...(invalid === "lessons" ? { imports: [{ file: p.approved, lessons: [{ id: "L-1234", text: "Incomplete record." }] }] } : {}),
      ...(invalid === "source" ? { source: untouched } : {}),
      ...(invalid === "target" ? { imports: [{ file: untouched, lessons: [] }] } : {}),
      ...(invalid === "quarantine" ? { malformed: [{ file: untouched, reason: "invalid" }] } : {}),
    })
    await fs.writeFile(p.migration, raw)
    await Store.migrate(tmp.path, name)
    expect((await Store.loadApproved(tmp.path, name))[0].helpful).toBe(3)
    expect((await Store.loadCandidateLessons(tmp.path, name))![0].helpful).toBe(4)
    expect(Lessons.parse(await fs.readFile(path.join(p.versions, "v2.json"), "utf8"))).toHaveLength(1)
    expect(await fs.readFile(untouched, "utf8")).toBe("User-owned file.")
    const quarantined = (await fs.readdir(p.learnDir)).filter((file) => file.startsWith("migration.json.malformed-"))
    expect(quarantined).toHaveLength(1)
    expect(await fs.readFile(path.join(p.learnDir, quarantined[0]), "utf8")).toBe(raw)
    expect(JSON.parse(await fs.readFile(p.migration, "utf8")).complete).toBe(true)
    const history = await fs.readFile(p.history, "utf8")
    await Store.migrate(tmp.path, name)
    expect(await fs.readFile(p.history, "utf8")).toBe(history)
    expect((await fs.readdir(p.learnDir)).filter((file) => file.startsWith("migration.json.malformed-"))).toEqual(quarantined)
  })
}

test("rebuilding an interrupted malformed journal preserves existing JSON targets", async () => {
  await using tmp = await tmpdir()
  const p = await legacy(tmp.path)
  const approved = Lessons.canonical([{
    ...Lessons.fromBullet({ id: "L-1234", text: "Newer approved guidance.", helpful: 9, harmful: 0 }),
    tags: ["keep"], pinned: true,
  }])
  await fs.writeFile(p.approved, approved)
  await fs.writeFile(p.migration, "{truncated")
  await Store.migrate(tmp.path, name)
  expect(await fs.readFile(p.approved, "utf8")).toBe(approved)
  expect(await Store.loadCandidateLessons(tmp.path, name)).toHaveLength(1)
  expect(await fs.stat(path.join(p.versions, "v2.json"))).toBeDefined()
})

test("a malformed completed journal cannot resurrect rejected candidates or consumed versions", async () => {
  await using tmp = await tmpdir()
  const p = await legacy(tmp.path)
  await Store.migrate(tmp.path, name)
  await Store.reject(tmp.path, name)
  await Store.rollback(tmp.path, name)
  const approved = await fs.readFile(p.approved, "utf8")
  const history = await fs.readFile(p.history, "utf8")
  await fs.writeFile(p.migration, '{"complete":true}')
  await Store.migrate(tmp.path, name)
  expect(await Store.readCandidate(tmp.path, name)).toBeUndefined()
  expect(await fs.stat(path.join(p.versions, "v2.json")).catch(() => undefined)).toBeUndefined()
  expect(await fs.readFile(p.approved, "utf8")).toBe(approved)
  expect(await fs.readFile(p.history, "utf8")).toBe(history)
  expect(JSON.parse(await fs.readFile(p.migration, "utf8"))).toEqual({ source: p.skill, complete: true, imports: [], malformed: [] })
  await Store.migrate(tmp.path, name)
  expect((await fs.readdir(p.learnDir)).filter((file) => file.startsWith("migration.json.malformed-"))).toHaveLength(1)
})

test("a rebuilt journal is durable before legacy quarantine begins", async () => {
  await using tmp = await tmpdir()
  const p = await legacy(tmp.path)
  const candidate = path.join(p.learnDir, "candidate.md")
  await fs.writeFile(candidate, "invalid playbook")
  await fs.writeFile(p.migration, "{truncated")
  const original = fs.rename.bind(fs)
  const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === p.migration) throw new Error("crash before rebuilt journal")
    return original(from, to)
  })
  try { await Store.migrate(tmp.path, name) } finally { rename.mockRestore() }
  expect(await fs.readFile(candidate, "utf8")).toBe("invalid playbook")
  expect(await fs.readFile(p.migration, "utf8")).toBe("{truncated")
  await Store.migrate(tmp.path, name)
  expect(await Store.loadApproved(tmp.path, name)).toHaveLength(1)
  expect(await Store.readCandidate(tmp.path, name)).toBeUndefined()
  const files = await fs.readdir(p.learnDir)
  expect(files.filter((file) => file.startsWith("migration.json.malformed-"))).toHaveLength(1)
  expect(files.filter((file) => file.startsWith("candidate.md.malformed-"))).toHaveLength(1)
})

test("long imported approved and candidate lessons are grandfathered, edits must shorten them", async () => {
  await using tmp = await tmpdir()
  const long = "Use the exact identifier `created_at` for event timestamps and preserve its source timezone when transforming records for reporting purposes. Always document units."
  expect(long.length).toBeGreaterThan(140)
  const p = await legacy(tmp.path, long)
  const candidate = (await Store.loadCandidateLessons(tmp.path, name))!
  expect(candidate[0].text).toBe(long)
  await Store.promote(tmp.path, name)
  const pb = await Store.loadCandidate(tmp.path, name)
  const bullets = Playbook.bullets(pb)
  bullets[0].text = long + "x"
  await Store.saveCandidate(tmp.path, name, Playbook.withBullets(pb, bullets))
  await expect(Store.promote(tmp.path, name)).rejects.toThrow("140 characters")
  bullets[0].text = "Use `created_at` for event timestamps."
  await Store.saveCandidate(tmp.path, name, Playbook.withBullets(pb, bullets))
  await Store.promote(tmp.path, name)
  expect((await Store.loadApproved(tmp.path, name))[0].text).toBe(bullets[0].text)
  expect(await fs.readFile(p.skill, "utf8")).toContain(long)
})

test("malformed live skill can resume after its quarantine rename", async () => {
  await using tmp = await tmpdir()
  const p = await legacy(tmp.path)
  await fs.appendFile(p.skill, "unmanaged line\n")
  const original = fs.rename.bind(fs)
  const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === p.approved) throw new Error("crash after quarantine")
    return original(from, to)
  })
  try { await Store.migrate(tmp.path, name) } finally { rename.mockRestore() }
  expect(await fs.stat(p.skill).catch(() => undefined)).toBeUndefined()
  await Store.migrate(tmp.path, name)
  expect(await Store.loadApproved(tmp.path, name)).toEqual([])
  expect(await Store.loadCandidateLessons(tmp.path, name)).toHaveLength(1)
})

test("learn source has no framework-specific defaults or references", async () => {
  const dir = path.resolve(import.meta.dir, "../../../src/altimate/learn")
  const source = await Promise.all((await fs.readdir(dir)).map((name) => fs.readFile(path.join(dir, name), "utf8")))
  expect(source.join("\n")).not.toMatch(/dbt/i)
})

test("unsafe numeric counters are quarantined instead of importing an unreadable snapshot", async () => {
  await using tmp = await tmpdir()
  const p = await legacy(tmp.path)
  const raw = await fs.readFile(p.skill, "utf8")
  await fs.writeFile(p.skill, raw.replace("h:3", `h:${"9".repeat(400)}`))
  await Store.migrate(tmp.path, name)
  expect(await Store.loadApproved(tmp.path, name)).toEqual([])
  expect((await fs.readdir(p.skillDir)).filter((file) => file.startsWith("SKILL.md.malformed-"))).toHaveLength(1)
})
