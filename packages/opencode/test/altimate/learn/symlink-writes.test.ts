// altimate_change - new file
import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { Delivery } from "../../../src/altimate/learn/delivery"
import { canonical, type Lesson } from "../../../src/altimate/learn/lesson"
import * as Store from "../../../src/altimate/learn/store"
import { appendSignal } from "../../../src/altimate/learn/signals"

const name = "team-playbook"
const lesson: Lesson = {
  id: "L-0001", text: "Keep project rules explicit.", tags: [], scope: "project", pinned: true,
  helpful: 0, harmful: 0, applied: 0, created: "2026-09-30T00:00:00.000Z", updated: "2026-09-30T00:00:00.000Z",
}

test.each(["shown.jsonl", "usage.json", ".sessions", "session-file", "store", "learn", ".altimate-code"])(
  "prompt delivery skips unsafe %s symlinks without changing the destination", async (kind) => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    const p = Store.paths(tmp.path, name)
    await fs.mkdir(p.learnDir, { recursive: true })
    await fs.writeFile(p.approved, canonical([lesson]))
    let link = path.join(p.learnDir, kind)
    let target = path.join(outside.path, "target")
    let contents = "sentinel\n"
    if (["store", "learn", ".altimate-code"].includes(kind)) {
      link = kind === "store" ? p.learnDir : path.join(tmp.path, ".altimate-code", ...(kind === "learn" ? ["learn"] : []))
      await fs.rename(link, target)
    } else if (kind === ".sessions") {
      link = path.join(tmp.path, ".altimate-code/learn/.sessions")
      await fs.mkdir(target)
    } else {
      if (kind === "usage.json") contents = "{}"
      if (kind === "session-file") {
        link = path.join(tmp.path, ".altimate-code/learn/.sessions", Store.sha256("session") + ".json")
        await fs.mkdir(path.dirname(link), { recursive: true })
        // A missing target must still be rejected, rather than replaced by an atomic write.
      } else await fs.writeFile(target, contents)
    }
    await fs.symlink(target, link)
    const delivery = new Delivery(tmp.path)
    expect(await delivery.prepare("session", "first", "Start work")).toEqual({ section: "", requestNote: "" })
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
    if (["shown.jsonl", "usage.json"].includes(kind)) expect(await fs.readFile(target, "utf8")).toBe(contents)
    if (kind === ".sessions") expect(await fs.readdir(target)).toEqual([])
    if (kind === "session-file") await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" })
  },
)

test.each(["candidate.json", "approved.json", "usage.json", "history.jsonl", "signals.jsonl", "versions/v1.json"])(
  "atomic learn writes refuse a symlink at %s", async (relative) => {
    await using tmp = await tmpdir()
    const file = path.join(Store.paths(tmp.path, name).learnDir, relative)
    const target = path.join(tmp.path, "victim")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(target, "unchanged")
    await fs.symlink(target, file)
    await expect(Store.transaction(tmp.path, () => Store.writeAtomic(tmp.path, file, "changed"))).rejects.toThrow(/symlink/i)
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(target, "utf8")).toBe("unchanged")
  },
)

test.each([".altimate-code", ".altimate-code/learn", ".altimate-code/learn/team-playbook"])(
  "signal capture refuses symlinked ancestor %s before making directories", async (relative) => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    const link = path.join(tmp.path, relative)
    await fs.mkdir(path.dirname(link), { recursive: true })
    await fs.symlink(outside.path, link)
    await expect(appendSignal(tmp.path, { kind: "user_correction", sessionID: "s", text: "No, use refs.", reason: "correction" })).rejects.toThrow(/symlink/i)
    expect(await fs.readdir(outside.path)).toEqual([])
  },
)

test.each(["signals.jsonl", "team-playbook/signals.jsonl"])("signal writes reject linked %s without importing it", async (relative) => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, ".altimate-code/learn", relative)
  const target = path.join(tmp.path, "victim")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(target, "")
  await fs.symlink(target, file)
  await expect(appendSignal(tmp.path, { kind: "user_correction", sessionID: "s", text: "No, use refs.", reason: "correction" })).rejects.toThrow(/symlink/i)
  expect((await fs.lstat(file)).isSymbolicLink()).toBe(true)
  expect(await fs.readFile(target, "utf8")).toBe("")
})

test("delivery refuses a shown symlink swapped immediately before the append open", async () => {
  await using tmp = await tmpdir()
  const p = Store.paths(tmp.path, name)
  const shown = path.join(p.learnDir, "shown.jsonl")
  const target = path.join(tmp.path, "victim")
  await fs.mkdir(p.learnDir, { recursive: true })
  await fs.writeFile(p.approved, canonical([lesson]))
  await fs.writeFile(target, "unchanged")
  const original = fs.open.bind(fs)
  const open = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === shown) await fs.symlink(target, shown)
    return original(...args)
  })
  try {
    expect(await new Delivery(tmp.path).prepare("session", "first", "Start work")).toEqual({ section: "", requestNote: "" })
    expect(await fs.readFile(target, "utf8")).toBe("unchanged")
  } finally { open.mockRestore() }
})

test("flush refuses a newly symlinked usage file without replacing it", async () => {
  await using tmp = await tmpdir()
  const p = Store.paths(tmp.path, name)
  const target = path.join(tmp.path, "victim")
  await fs.mkdir(p.learnDir, { recursive: true })
  await fs.writeFile(p.approved, canonical([lesson]))
  const delivery = new Delivery(tmp.path)
  expect((await delivery.prepare("session", "first", "Start work")).section).toContain(lesson.text)
  await fs.writeFile(target, "{}")
  await fs.symlink(target, p.usage)
  await delivery.flush("session")
  expect((await fs.lstat(p.usage)).isSymbolicLink()).toBe(true)
  expect(await fs.readFile(target, "utf8")).toBe("{}")
})
