import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { Glob } from "../../src/util/glob"

// altimate_change start — regression cover for the dropped `ignore` option.
// Without `ignore`, every `**/…` scan walks node_modules/.git/dist in full and
// callers can only discard the matches afterwards — the directories have
// already been read. These tests pin the plumbing and the prune-shaped default
// pattern set that makes the walk cheap.

let root: string

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "glob-ignore-"))
  await mkdir(path.join(root, "src"), { recursive: true })
  await mkdir(path.join(root, "node_modules", "pkg", ".vscode"), { recursive: true })
  await mkdir(path.join(root, ".yarn", "unplugged", "pkg"), { recursive: true })
  await mkdir(path.join(root, "vendor"), { recursive: true })
  await mkdir(path.join(root, "dist"), { recursive: true })
  await mkdir(path.join(root, ".vscode"), { recursive: true })
  await writeFile(path.join(root, ".vscode", "mcp.json"), "{}")
  await writeFile(path.join(root, "src", "mcp.json"), "{}")
  await writeFile(path.join(root, "node_modules", "pkg", ".vscode", "mcp.json"), "{}")
  await writeFile(path.join(root, ".yarn", "unplugged", "pkg", "mcp.json"), "{}")
  await writeFile(path.join(root, "vendor", "mcp.json"), "{}")
  await writeFile(path.join(root, "dist", "mcp.json"), "{}")
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const rel = (abs: string) => path.relative(root, abs).split(path.sep).join("/")

describe("Glob.scan ignore", () => {
  test("without ignore, dependency and build trees are returned", async () => {
    const found = (await Glob.scan("**/mcp.json", { cwd: root, absolute: true, dot: true })).map(rel).sort()
    expect(found).toEqual([
      ".vscode/mcp.json",
      ".yarn/unplugged/pkg/mcp.json",
      "dist/mcp.json",
      "node_modules/pkg/.vscode/mcp.json",
      "src/mcp.json",
      "vendor/mcp.json",
    ])
  })

  test("ignore excludes dependency and build trees but keeps source matches", async () => {
    const found = (
      await Glob.scan("**/mcp.json", {
        cwd: root,
        absolute: true,
        dot: true,
        ignore: [...Glob.DEFAULT_IGNORE],
      })
    )
      .map(rel)
      .sort()
    expect(found).toEqual([".vscode/mcp.json", "src/mcp.json"])
  })

  test("dependency ignore keeps output-named project content but prunes vendored trees", async () => {
    const found = (
      await Glob.scan("**/mcp.json", {
        cwd: root,
        absolute: true,
        dot: true,
        ignore: [...Glob.DEPENDENCY_IGNORE],
      })
    )
      .map(rel)
      .sort()
    expect(found).toEqual([".vscode/mcp.json", "dist/mcp.json", "src/mcp.json"])
  })

  test("scanSync honours ignore too", () => {
    const found = Glob.scanSync("**/mcp.json", {
      cwd: root,
      absolute: true,
      dot: true,
      ignore: [...Glob.DEFAULT_IGNORE],
    })
      .map(rel)
      .sort()
    expect(found).toEqual([".vscode/mcp.json", "src/mcp.json"])
  })

  test("an explicit ignore list is honoured verbatim", async () => {
    const found = (await Glob.scan("**/mcp.json", { cwd: root, absolute: true, dot: true, ignore: ["**/src/**"] })).map(
      rel,
    )
    expect(found).not.toContain("src/mcp.json")
    expect(found).toContain(".vscode/mcp.json")
  })
})

describe("Glob.DEFAULT_IGNORE", () => {
  // The whole point of the fix: `glob` prunes a subtree only when the ignore
  // pattern ends in `/**`. A pattern like "**/node_modules" would filter the
  // results and still walk the tree, which is the slow behaviour we removed.
  test("every pattern ends in /** so the walk is pruned, not post-filtered", () => {
    expect(Glob.DEFAULT_IGNORE.length).toBeGreaterThan(0)
    for (const pattern of Glob.DEFAULT_IGNORE) {
      expect(pattern.endsWith("/**")).toBe(true)
    }
  })

  test("covers the package-manager, VCS and build output directories", () => {
    for (const dir of ["node_modules", ".git", ".yarn/unplugged", "dist", "build", "target", ".venv"]) {
      expect(Glob.DEFAULT_IGNORE).toContain(`**/${dir}/**`)
    }
  })

  test("the content-safe subset does not exclude user output directory names", () => {
    for (const pattern of Glob.DEPENDENCY_IGNORE) {
      expect(pattern.endsWith("/**")).toBe(true)
    }
    expect(Glob.DEPENDENCY_IGNORE).toContain("**/vendor/**")
    for (const dir of ["dist", "build", "out", "target", "coverage"]) {
      expect(Glob.DEPENDENCY_IGNORE).not.toContain(`**/${dir}/**`)
    }
  })
})
// altimate_change end

// altimate_change start — upstream_fix: `exists` must answer without walking the whole tree.
describe("Glob.exists", () => {
  test("agrees with scan() on whether anything matched", async () => {
    for (const pattern of ["**/*.ts", "**/mcp.json", "**/nothing-matches-this.xyz"]) {
      const scanned = await Glob.scan(pattern, { cwd: root, absolute: true })
      const existed = await Glob.exists(pattern, { cwd: root, absolute: true })
      expect(existed, `pattern ${pattern}`).toBe(scanned.length > 0)
    }
  })

  test("honours the same options as scan", async () => {
    // `include: "file"` must not report a directory match, or a skill whose applyPaths names
    // a directory would auto-load on every project that happens to have one.
    const dirOnly = await Glob.exists("src", { cwd: root, include: "file" })
    const withDirs = await Glob.exists("src", { cwd: root, include: "all" })
    expect(dirOnly).toBe(false)
    expect(withDirs).toBe(true)
  })

  test("prunes with ignore, like scan", async () => {
    // Own fixture: the shared `root` has matching files outside the ignored trees too, which
    // would make this pass for the wrong reason.
    const own = await mkdtemp(path.join(tmpdir(), "glob-exists-"))
    try {
      await mkdir(path.join(own, "node_modules", "pkg"), { recursive: true })
      await writeFile(path.join(own, "node_modules", "pkg", "only-here.json"), "{}")

      expect(await Glob.exists("**/only-here.json", { cwd: own })).toBe(true)
      expect(await Glob.exists("**/only-here.json", { cwd: own, ignore: ["**/node_modules/**"] })).toBe(false)
    } finally {
      await rm(own, { recursive: true, force: true })
    }
  })

  test("returns false for a directory that does not exist", async () => {
    expect(await Glob.exists("**/*", { cwd: path.join(root, "no-such-dir") })).toBe(false)
  })
})
// altimate_change end
