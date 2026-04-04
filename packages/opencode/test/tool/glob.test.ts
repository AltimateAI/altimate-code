import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { GlobTool } from "../../src/tool/glob"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("tool.glob", () => {
  test("finds files matching pattern", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.txt"), "hello")
        await Bun.write(path.join(dir, "b.txt"), "world")
        await Bun.write(path.join(dir, "c.md"), "readme")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "*.txt" }, ctx)
        expect(result.metadata.count).toBe(2)
        expect(result.output).toContain("a.txt")
        expect(result.output).toContain("b.txt")
        expect(result.output).not.toContain("c.md")
      },
    })
  })

  test("returns 'No files found' when no matches", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "*.nonexistent" }, ctx)
        expect(result.metadata.count).toBe(0)
        expect(result.output).toBe("No files found")
      },
    })
  })

  test("truncates results at 100 files", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        for (let i = 0; i < 110; i++) {
          await Bun.write(path.join(dir, `file${String(i).padStart(3, "0")}.txt`), "")
        }
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "*.txt" }, ctx)
        expect(result.metadata.count).toBe(100)
        expect(result.metadata.truncated).toBe(true)
        expect(result.output).toContain("Results are truncated")
      },
    })
  })

  test("respects user abort signal", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.txt"), "hello")
      },
    })
    const controller = new AbortController()
    controller.abort()
    const abortCtx = { ...ctx, abort: controller.signal }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        await expect(glob.execute({ pattern: "*.txt" }, abortCtx)).rejects.toThrow()
      },
    })
  })

  test("finds nested files with ** pattern", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "sub", "deep"), { recursive: true })
        await Bun.write(path.join(dir, "sub", "deep", "target.yml"), "")
        await Bun.write(path.join(dir, "other.txt"), "")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "**/target.yml" }, ctx)
        expect(result.metadata.count).toBe(1)
        expect(result.output).toContain("target.yml")
      },
    })
  })

  test("uses custom path parameter", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "subdir"))
        await Bun.write(path.join(dir, "subdir", "inner.txt"), "")
        await Bun.write(path.join(dir, "outer.txt"), "")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute(
          { pattern: "*.txt", path: path.join(tmp.path, "subdir") },
          ctx,
        )
        expect(result.metadata.count).toBe(1)
        expect(result.output).toContain("inner.txt")
        expect(result.output).not.toContain("outer.txt")
      },
    })
  })

  test("blocks home directory with helpful message", async () => {
    const homeDir = os.homedir()
    await Instance.provide({
      directory: homeDir,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "**/*.yml", path: homeDir }, ctx)
        expect(result.metadata.count).toBe(0)
        expect(result.output).toContain("too broad to search")
      },
    })
  })

  test("blocks root directory with helpful message", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "**/*.yml", path: "/" }, ctx)
        expect(result.metadata.count).toBe(0)
        expect(result.output).toContain("too broad to search")
      },
    })
  })

  test("allows subdirectory of home", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "project.yml"), "")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "*.yml" }, ctx)
        expect(result.metadata.count).toBe(1)
        expect(result.output).toContain("project.yml")
      },
    })
  })

  test("excludes node_modules by default", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true })
        await Bun.write(path.join(dir, "node_modules", "pkg", "index.ts"), "")
        await Bun.write(path.join(dir, "src.ts"), "")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "**/*.ts" }, ctx)
        expect(result.metadata.count).toBe(1)
        expect(result.output).toContain("src.ts")
        expect(result.output).not.toContain("node_modules")
      },
    })
  })

  test("propagates non-abort errors instead of treating as timeout", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        // Searching a non-existent path should throw ENOENT, not return "timed out"
        const badPath = path.join(tmp.path, "nonexistent-dir-12345")
        await expect(
          glob.execute({ pattern: "*.txt", path: badPath }, ctx),
        ).rejects.toThrow()
      },
    })
  })

  test("completes without timeout on small directories", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.txt"), "hello")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "*.txt" }, ctx)
        expect(result.metadata.count).toBe(1)
        expect(result.metadata.truncated).toBe(false)
        expect(result.output).not.toContain("timed out")
      },
    })
  })

  test("excludes dist and build by default", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "dist"), { recursive: true })
        await fs.mkdir(path.join(dir, "build"), { recursive: true })
        await Bun.write(path.join(dir, "dist", "bundle.js"), "")
        await Bun.write(path.join(dir, "build", "output.js"), "")
        await Bun.write(path.join(dir, "app.js"), "")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await GlobTool.init()
        const result = await glob.execute({ pattern: "**/*.js" }, ctx)
        expect(result.metadata.count).toBe(1)
        expect(result.output).toContain("app.js")
        expect(result.output).not.toContain("dist")
        expect(result.output).not.toContain("build")
      },
    })
  })
})
