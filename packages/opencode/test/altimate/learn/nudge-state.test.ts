// altimate_change - new file
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { claimNudge, dismissNudge, readNudgeState } from "../../../src/altimate/learn/nudge-state"

let root: string
let stateDir: string
let file: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-nudge-state-"))
  stateDir = path.join(root, "state")
  file = path.join(stateDir, "learn-nudge.json")
})
afterEach(() => fs.rm(root, { recursive: true, force: true }))

describe("global learning nudge state", () => {
  test("stable project identities share the same budget across TUI worktrees", async () => {
    expect(await claimNudge("project:shared-repository", stateDir)).toBe(true)
    expect(await claimNudge("project:shared-repository", stateDir)).toBe(false)
    expect(await claimNudge("project:another-repository", stateDir)).toBe(true)
    expect((await readNudgeState(stateDir)).totalCount).toBe(2)
    expect(await fs.readFile(file, "utf8")).not.toContain("shared-repository")
  })
  test("reading missing state creates no files or directories", async () => {
    expect(await readNudgeState(stateDir)).toEqual({ shownProjectHashes: [], totalCount: 0, dismissed: false })
    expect(await fs.readdir(root)).toEqual([])
  })

  test("importing the nudge state module does not initialize global storage", async () => {
    const module = path.resolve(import.meta.dir, "../../../src/altimate/learn/nudge-state.ts")
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      import fs from "node:fs/promises";
      fs.mkdir = async () => { throw new Error("Unexpected directory initialization"); };
      await import(${JSON.stringify(module)});
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(await fs.readdir(root)).toEqual([])
  })

  test("persists only project hashes, total count, and dismissal", async () => {
    const project = path.join(root, "private-project-name")
    await fs.mkdir(project)
    expect(await claimNudge(project, stateDir)).toBe(true)
    const text = await fs.readFile(file, "utf8")
    const state = await readNudgeState(stateDir)
    expect(Object.keys(state).sort()).toEqual(["dismissed", "shownProjectHashes", "totalCount"])
    expect(state.shownProjectHashes).toHaveLength(1)
    expect(state.shownProjectHashes[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(state.totalCount).toBe(1)
    expect(state.dismissed).toBe(false)
    expect(text).not.toContain(root)
    expect(text).not.toContain("private-project-name")
    expect(await fs.readdir(project)).toEqual([])
    expect(await fs.readdir(stateDir)).toEqual(["learn-nudge.json"])
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  test("a project is shown once, including canonical and symlink aliases", async () => {
    const project = path.join(root, "project")
    const alias = path.join(root, "alias")
    await fs.mkdir(project)
    await fs.symlink(project, alias, "dir")
    expect(await claimNudge(project, stateDir)).toBe(true)
    expect(await claimNudge(path.join(project, "."), stateDir)).toBe(false)
    expect(await claimNudge(alias, stateDir)).toBe(false)
    expect((await readNudgeState(stateDir)).totalCount).toBe(1)
  })

  test("never exceeds three projects, even across concurrent callers", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimNudge(path.join(root, `project-${i}`), stateDir)),
    )
    expect(results.filter(Boolean)).toHaveLength(3)
    const state = await readNudgeState(stateDir)
    expect(state.totalCount).toBe(3)
    expect(state.shownProjectHashes).toHaveLength(3)
    expect(await claimNudge(path.join(root, "another-project"), stateDir)).toBe(false)
    expect(await fs.readdir(stateDir)).toEqual(["learn-nudge.json"])
  })

  test("concurrent claims of the same project reserve exactly one notice", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => claimNudge(root, stateDir)))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect((await readNudgeState(stateDir)).totalCount).toBe(1)
  })

  test("dismissal persists globally and preserves previous counts", async () => {
    expect(await claimNudge(root, stateDir)).toBe(true)
    await dismissNudge(stateDir)
    await dismissNudge(stateDir)
    expect(await claimNudge(path.join(root, "other"), stateDir)).toBe(false)
    expect(await readNudgeState(stateDir)).toMatchObject({ totalCount: 1, dismissed: true })
    expect((await readNudgeState(stateDir)).shownProjectHashes).toHaveLength(1)
  })

  test("dismissal before any notice persists without project data", async () => {
    await dismissNudge(stateDir)
    expect(await claimNudge(root, stateDir)).toBe(false)
    expect(await readNudgeState(stateDir)).toEqual({ shownProjectHashes: [], totalCount: 0, dismissed: true })
  })

  test("a racing claim cannot undo permanent dismissal", async () => {
    await Promise.all([
      claimNudge(root, stateDir),
      dismissNudge(stateDir),
      claimNudge(path.join(root, "other"), stateDir),
    ])
    expect((await readNudgeState(stateDir)).dismissed).toBe(true)
    expect(await claimNudge(path.join(root, "later"), stateDir)).toBe(false)
  })

  test("replaces the state atomically instead of truncating an open reader", async () => {
    expect(await claimNudge(root, stateDir)).toBe(true)
    const original = await fs.readFile(file, "utf8")
    const reader = await fs.open(file, "r")
    try {
      await dismissNudge(stateDir)
      expect(await reader.readFile("utf8")).toBe(original)
      expect(JSON.parse(await fs.readFile(file, "utf8")).dismissed).toBe(true)
      expect((await reader.stat()).ino).not.toBe((await fs.stat(file)).ino)
      expect(await fs.readdir(stateDir)).toEqual(["learn-nudge.json"])
    } finally {
      await reader.close()
    }
  })

  test("unknown fields are excluded from reads and subsequent writes", async () => {
    await fs.mkdir(stateDir)
    await fs.writeFile(
      file,
      JSON.stringify({
        shownProjectHashes: [],
        totalCount: 0,
        dismissed: false,
        project: root,
        corrections: ["private user text"],
      }),
    )
    expect(await readNudgeState(stateDir)).toEqual({ shownProjectHashes: [], totalCount: 0, dismissed: false })
    expect(await claimNudge(root, stateDir)).toBe(true)
    const text = await fs.readFile(file, "utf8")
    expect(text).not.toContain(root)
    expect(text).not.toContain("private user text")
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["dismissed", "shownProjectHashes", "totalCount"])
  })

  test("failed atomic replacement preserves previous state and cleans its staging file", async () => {
    expect(await claimNudge(root, stateDir)).toBe(true)
    const original = await fs.readFile(file, "utf8")
    const module = path.resolve(import.meta.dir, "../../../src/altimate/learn/nudge-state.ts")
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      import fs from "node:fs/promises";
      import { claimNudge } from ${JSON.stringify(module)};
      fs.rename = async () => { throw new Error("Simulated rename failure"); };
      console.log(await claimNudge(${JSON.stringify(path.join(root, "other"))}, ${JSON.stringify(stateDir)}));
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(stdout.trim()).toBe("false")
    expect(await fs.readFile(file, "utf8")).toBe(original)
    expect(await fs.readdir(stateDir)).toEqual(["learn-nudge.json"])
  })

  test("corrupt state suppresses claims without resetting history; explicit dismissal can repair it", async () => {
    await fs.mkdir(stateDir)
    for (const raw of [
      "{broken",
      "null",
      JSON.stringify({ shownProjectHashes: [], totalCount: -1, dismissed: false }),
      JSON.stringify({ shownProjectHashes: ["raw-path"], totalCount: 1, dismissed: false }),
      JSON.stringify({ shownProjectHashes: ["a".repeat(64)], totalCount: 0, dismissed: false }),
    ]) {
      await fs.writeFile(file, raw)
      await expect(readNudgeState(stateDir)).rejects.toThrow("Invalid learning nudge state")
      expect(await claimNudge(root, stateDir)).toBe(false)
      expect(await fs.readFile(file, "utf8")).toBe(raw)
      expect(await fs.readdir(stateDir)).toEqual(["learn-nudge.json"])
    }
    await dismissNudge(stateDir)
    expect(await readNudgeState(stateDir)).toEqual({ shownProjectHashes: [], totalCount: 0, dismissed: true })
    expect(await claimNudge(root, stateDir)).toBe(false)
  })

  test("unreadable state fails closed and removes only its own staging file", async () => {
    await fs.mkdir(file, { recursive: true })
    expect(await claimNudge(root, stateDir)).toBe(false)
    await expect(dismissNudge(stateDir)).rejects.toThrow()
    expect(await fs.readdir(stateDir)).toEqual(["learn-nudge.json"])
    expect((await fs.stat(file)).isDirectory()).toBe(true)
  })

  test("never steals an existing staging file, including an interrupted writer", async () => {
    await fs.mkdir(stateDir)
    await fs.writeFile(file + ".tmp", "another writer")
    expect(await claimNudge(root, stateDir)).toBe(false)
    await expect(dismissNudge(stateDir)).rejects.toThrow("busy")
    expect(await fs.readFile(file + ".tmp", "utf8")).toBe("another writer")
    expect(await fs.readdir(stateDir)).toEqual(["learn-nudge.json.tmp"])
  })

  test("independent processes share the global cap without lost writes", async () => {
    const module = path.resolve(import.meta.dir, "../../../src/altimate/learn/nudge-state.ts")
    const children = Array.from({ length: 7 }, (_, i) =>
      Bun.spawn(
        [
          process.execPath,
          "--eval",
          `import { claimNudge } from ${JSON.stringify(module)};
       console.log(await claimNudge(${JSON.stringify(path.join(root, `process-${i}`))}, ${JSON.stringify(stateDir)}));`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    )
    try {
      const results = await Promise.all(
        children.map(async (child) => {
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
          expect(stderr).toBe("")
          expect(code).toBe(0)
          return stdout.trim() === "true"
        }),
      )
      expect(results.filter(Boolean)).toHaveLength(3)
      expect(await readNudgeState(stateDir)).toMatchObject({ totalCount: 3, dismissed: false })
      expect((await readNudgeState(stateDir)).shownProjectHashes).toHaveLength(3)
      expect(await fs.readdir(stateDir)).toEqual(["learn-nudge.json"])
    } finally {
      children.forEach((child) => child.kill())
    }
  }, 15_000)
})
