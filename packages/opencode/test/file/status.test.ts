import { describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { $ } from "bun"
import { File } from "../../src/file"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("File.status()", () => {
  test("detects modified files with line counts", async () => {
    await using tmp = await tmpdir({ git: true })
    const filepath = path.join(tmp.path, "test.txt")
    await fs.writeFile(filepath, "line1\nline2\n")
    await $`git add test.txt && git commit -m "initial"`.cwd(tmp.path).quiet()

    // Modify the file — append two lines
    await fs.writeFile(filepath, "line1\nline2\nline3\nline4\n")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const changed = await File.status()
        expect(changed.length).toBe(1)
        expect(changed[0].path).toBe("test.txt")
        expect(changed[0].status).toBe("modified")
        expect(changed[0].added).toBe(2)
        expect(changed[0].removed).toBe(0)
      },
    })
  })

  test("detects untracked (new) files", async () => {
    await using tmp = await tmpdir({ git: true })
    // No trailing newline so split("\n") gives exactly 2 elements
    await fs.writeFile(path.join(tmp.path, "newfile.ts"), "const x = 1\nconst y = 2")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const changed = await File.status()
        const added = changed.find((f) => f.path === "newfile.ts")
        expect(added).toBeDefined()
        expect(added!.status).toBe("added")
        expect(added!.added).toBe(2) // "const x = 1\nconst y = 2".split("\n").length === 2
      },
    })
  })

  test("detects deleted files", async () => {
    await using tmp = await tmpdir({ git: true })
    const filepath = path.join(tmp.path, "to-delete.txt")
    await fs.writeFile(filepath, "content\n")
    await $`git add to-delete.txt && git commit -m "add file"`.cwd(tmp.path).quiet()

    // Delete the file
    await fs.rm(filepath)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const changed = await File.status()
        // Deleted files appear in diff --numstat (as "modified") AND diff --diff-filter=D (as "deleted")
        const deleted = changed.find((f) => f.path === "to-delete.txt" && f.status === "deleted")
        expect(deleted).toBeDefined()
        expect(deleted!.status).toBe("deleted")
      },
    })
  })

  test("returns empty array for clean working tree", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const changed = await File.status()
        expect(changed).toEqual([])
      },
    })
  })

  test("handles binary files with dash line counts", async () => {
    await using tmp = await tmpdir({ git: true })
    const filepath = path.join(tmp.path, "image.png")
    // Write binary content with null bytes so git classifies it as binary
    await fs.writeFile(filepath, Buffer.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0x00]))
    await $`git add image.png && git commit -m "add image"`.cwd(tmp.path).quiet()

    // Modify the binary
    await fs.writeFile(filepath, Buffer.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x00]))

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const changed = await File.status()
        const binary = changed.find((f) => f.path === "image.png")
        expect(binary).toBeDefined()
        expect(binary!.status).toBe("modified")
        // Binary files report "-" in diff --numstat, which gets parsed as 0
        expect(binary!.added).toBe(0)
        expect(binary!.removed).toBe(0)
      },
    })
  })

  test("normalizes paths to be relative", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.mkdir(path.join(tmp.path, "src"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "src", "app.ts"), "const x = 1\n")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const changed = await File.status()
        expect(changed.length).toBeGreaterThan(0)
        for (const file of changed) {
          // All paths should be relative, not absolute
          expect(path.isAbsolute(file.path)).toBe(false)
        }
      },
    })
  })
})
