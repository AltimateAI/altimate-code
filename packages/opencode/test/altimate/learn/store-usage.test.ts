import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import * as Store from "../../../src/altimate/learn/store"
import * as Lessons from "../../../src/altimate/learn/lesson"
import { tmpdir } from "../../fixture/fixture"

const NAME = "team-playbook"

function lesson(id: string, applied: number): Lessons.Lesson {
  return Lessons.fromBullet({ id, text: "Preserve explicit exports.", helpful: 0, harmful: 0 }, {
    id, text: "Preserve explicit exports.", tags: [], scope: "project", helpful: 0, harmful: 0, applied,
    created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z",
  })
}

test("promote preserves legacy applied counts locally when a staged candidate resets them", async () => {
  await using tmp = await tmpdir()
  const p = Store.paths(tmp.path, NAME)
  await fs.mkdir(p.learnDir, { recursive: true })
  await fs.writeFile(p.approved, Lessons.canonical([lesson("L-0001", 7)]))
  const candidate = Lessons.canonical([lesson("L-0001", 0)])
  await fs.writeFile(p.candidate, candidate)

  await Store.promote(tmp.path, NAME)

  expect(JSON.parse(await fs.readFile(path.join(p.learnDir, "usage.json"), "utf8"))).toEqual({ "L-0001": 7 })
  expect(await fs.readFile(p.approved, "utf8")).toBe(candidate)
  expect((await Store.loadApproved(tmp.path, NAME))[0].applied).toBe(0)
  expect((await Store.mergeUsage(tmp.path, NAME, await Store.loadApproved(tmp.path, NAME)))[0].applied).toBe(7)
})

test("promote keeps all existing usage and the legacy baseline of removed lessons", async () => {
  await using tmp = await tmpdir()
  const p = Store.paths(tmp.path, NAME)
  await fs.mkdir(p.learnDir, { recursive: true })
  await fs.writeFile(p.approved, Lessons.canonical([lesson("L-0001", 7), lesson("L-0002", 6)]))
  await fs.writeFile(p.candidate, Lessons.canonical([lesson("L-0001", 0)]))
  const usage = path.join(p.learnDir, "usage.json")
  await fs.writeFile(usage, JSON.stringify({ "L-0001": 10, "L-ffff": 4 }))

  await Store.promote(tmp.path, NAME)

  expect(JSON.parse(await fs.readFile(usage, "utf8"))).toEqual({ "L-0001": 10, "L-0002": 6, "L-ffff": 4 })
})

test("usage merges the greater local or legacy count without changing lesson snapshots", async () => {
  await using tmp = await tmpdir()
  const p = Store.paths(tmp.path, NAME)
  await fs.mkdir(p.learnDir, { recursive: true })
  const lessons = [lesson("L-0001", 3), lesson("L-0002", 8)]
  const before = Lessons.canonical(lessons)
  await fs.writeFile(p.approved, before)
  await fs.writeFile(p.usage, JSON.stringify({ "L-0001": 9, "L-0002": 2 }))

  expect((await Store.mergeUsage(tmp.path, NAME, lessons)).map((entry) => entry.applied)).toEqual([9, 8])
  expect(Lessons.canonical(lessons)).toBe(before)
  expect(await fs.readFile(p.approved, "utf8")).toBe(before)
})

test("usage reads ignore malformed counters and tolerate malformed or missing JSON", async () => {
  await using tmp = await tmpdir()
  const p = Store.paths(tmp.path, NAME)
  expect(await Store.readUsage(tmp.path, NAME)).toEqual({})
  await fs.mkdir(p.learnDir, { recursive: true })
  await fs.writeFile(p.usage, JSON.stringify({
    "L-0001": 4, "L-0002": -1, "L-0003": 1.5, "L-0004": "5", "L-0005": Number.MAX_SAFE_INTEGER + 1,
    "L-0006": 0, unexpected: 2,
  }))
  expect(await Store.readUsage(tmp.path, NAME)).toEqual({ "L-0001": 4, "L-0006": 0 })
  for (const raw of ["{", "[]", "null"]) {
    await fs.writeFile(p.usage, raw)
    expect(await Store.readUsage(tmp.path, NAME)).toEqual({})
  }
})
