// altimate_change - new file
import { expect, spyOn, test } from "bun:test"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import * as Playbook from "../../../src/altimate/learn/playbook"
import * as Signals from "../../../src/altimate/learn/signals"
import * as Store from "../../../src/altimate/learn/store"

const NAME = "team-playbook"
const signal = { kind: "review", sessionID: "ses_1", text: "Check model ownership.", reason: "review" } as const
const ignoreFile = (root: string) => path.join(root, ".altimate-code", "learn", ".gitignore")

test.each(["existing", "swapped", "append-swapped"])("learn rejects a %s symlink at the managed ignore path", async (kind) => {
  await using tmp = await tmpdir()
  const file = ignoreFile(tmp.path)
  const target = path.join(tmp.path, "settings.json")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(target, "preserve settings\n")
  if (kind === "existing") await fs.symlink(target, file)
  else await fs.writeFile(file, "# custom rules\n")
  const original = fs.open.bind(fs)
  let opens = 0
  const open = kind !== "existing" ? spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === file && ++opens === (kind === "append-swapped" ? 2 : 1)) {
      await fs.rm(file)
      await fs.symlink(target, file)
    }
    return original(...args)
  }) : undefined
  try {
    await expect(Store.transaction(tmp.path, async () => {})).rejects.toThrow()
    expect(await fs.readFile(target, "utf8")).toBe("preserve settings\n")
  } finally { open?.mockRestore() }
})

test.each([
  ["candidate", (root: string) => Store.saveCandidate(root, NAME, Playbook.create({ name: NAME }))],
  ["signal", (root: string) => Signals.appendSignal(root, signal)],
  ["lock", (root: string) => Store.transaction(root, async () => {})],
] as const)("creating learn state through %s installs the shared-lesson ignore rules", async (_, create) => {
  await using tmp = await tmpdir()
  await create(tmp.path)
  const text = await fs.readFile(ignoreFile(tmp.path), "utf8")
  expect(text).toContain("# Share approved lessons")
  expect(text.split("\n").filter((line) => line && !line.startsWith("#"))).toEqual([
    "*", "!/*/", "!/*/approved.json", "!/.gitignore",
  ])
})

test("later learn writes leave the original .gitignore untouched", async () => {
  await using tmp = await tmpdir()
  await Store.saveCandidate(tmp.path, NAME, Playbook.create({ name: NAME }))
  const file = ignoreFile(tmp.path)
  const original = await fs.readFile(file, "utf8")
  const old = new Date("2000-01-01T00:00:00.000Z")
  await fs.utimes(file, old, old)
  await Signals.appendSignal(tmp.path, signal)
  await Store.saveCandidate(tmp.path, "other-playbook", Playbook.create({ name: "other-playbook" }))
  expect(await fs.readFile(file, "utf8")).toBe(original)
  expect((await fs.stat(file)).mtimeMs).toBe(old.getTime())
})

test("learn transactions accept a read-only .gitignore that already has managed rules", async () => {
  await using tmp = await tmpdir()
  await Store.saveCandidate(tmp.path, NAME, Playbook.create({ name: NAME }))
  const file = ignoreFile(tmp.path)
  const before = await fs.readFile(file, "utf8")
  await fs.chmod(file, 0o444)
  const original = fs.open.bind(fs)
  // Enforce the same permission check even when tests run as root.
  const open = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === file && typeof args[1] === "number" && (args[1] & (constants.O_RDWR | constants.O_WRONLY))) {
      throw Object.assign(new Error("Read-only managed ignore file"), { code: "EACCES" })
    }
    return original(...args)
  })
  try {
    expect(await Store.transaction(tmp.path, async () => "delivered")).toBe("delivered")
    expect(await fs.readFile(file, "utf8")).toBe(before)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o444)
  } finally {
    open.mockRestore()
    await fs.chmod(file, 0o644)
  }
})

test.each(["\n", ""])("learn appends missing managed rules while preserving a user-authored .gitignore ending in %j", async (ending) => {
  await using tmp = await tmpdir({ git: true })
  const file = ignoreFile(tmp.path)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const custom = "# My team rules\nsignals.jsonl" + ending
  await fs.writeFile(file, custom)
  await Signals.appendSignal(tmp.path, signal)
  await Store.saveCandidate(tmp.path, NAME, Playbook.create({ name: NAME }))
  const updated = await fs.readFile(file, "utf8")
  expect(updated.startsWith(custom)).toBe(true)
  expect(updated.match(/# Share approved lessons/g)).toHaveLength(1)
  for (const [relative, ignored] of [[`${NAME}/candidate.json`, 0], [`${NAME}/approved.json`, 1]] as const) {
    const result = Bun.spawnSync(["git", "-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "--quiet", `.altimate-code/learn/${relative}`], {
      cwd: tmp.path,
    })
    expect(result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(ignored)
  }
})

test("Git permits approved snapshots and ignores every operational learning file", async () => {
  await using tmp = await tmpdir({ git: true })
  await Store.saveCandidate(tmp.path, NAME, Playbook.create({ name: NAME }))
  await Store.promote(tmp.path, NAME)
  await Signals.appendSignal(tmp.path, signal)
  const allowed = [".gitignore", `${NAME}/approved.json`, "other-playbook/approved.json"]
  const ignored = [
    "approved.json", "signals.jsonl", `${NAME}/signals.jsonl`, `${NAME}/history.jsonl`,
    `${NAME}/candidate.json`, `${NAME}/retired.json`, `${NAME}/shown.jsonl`,
    `${NAME}/approved.json.malformed-123`, `${NAME}/signals.jsonl.malformed-123`,
    `${NAME}/.approved.json.tmp-123`, `${NAME}/versions/v1.json`, `${NAME}/versions/approved.json`,
    "claims/batch.json", ".sessions/session.json", "learn-state.lock/meta.json",
  ]
  for (const file of [...allowed, ...ignored]) {
    const relative = `.altimate-code/learn/${file}`
    const absolute = path.join(tmp.path, relative)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    if (file !== ".gitignore") await fs.writeFile(absolute, "[]\n")
    const result = Bun.spawnSync(["git", "-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "--quiet", relative], {
      cwd: tmp.path,
    })
    expect(result.stderr.toString()).toBe("")
    expect({ file, ignored: result.exitCode }).toEqual({ file, ignored: allowed.includes(file) ? 1 : 0 })
  }
})
