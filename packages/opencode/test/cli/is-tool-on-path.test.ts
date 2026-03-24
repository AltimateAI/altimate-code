import { afterEach, describe, test, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { isToolOnPath } from "../../src/cli/cmd/skill-helpers"
import { Instance } from "../../src/project/instance"

/** Create a tmpdir with git initialized (signing disabled for CI). */
async function tmpdirGit(init?: (dir: string) => Promise<void>) {
  return tmpdir({
    init: async (dir) => {
      await $`git init`.cwd(dir).quiet()
      await $`git config core.fsmonitor false`.cwd(dir).quiet()
      await $`git config commit.gpgsign false`.cwd(dir).quiet()
      await $`git config user.email "test@opencode.test"`.cwd(dir).quiet()
      await $`git config user.name "Test"`.cwd(dir).quiet()
      await $`git commit --allow-empty -m "root"`.cwd(dir).quiet()
      await init?.(dir)
    },
  })
}

describe("isToolOnPath", () => {
  const savedEnv: Record<string, string | undefined> = {}

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
    Object.keys(savedEnv).forEach((k) => delete savedEnv[k])
  })

  test("returns true when tool exists in .opencode/tools/ under cwd", async () => {
    await using tmp = await tmpdirGit(async (dir) => {
      const toolsDir = path.join(dir, ".opencode", "tools")
      await fs.mkdir(toolsDir, { recursive: true })
      const toolPath = path.join(toolsDir, "my-test-tool")
      await fs.writeFile(toolPath, "#!/bin/sh\necho ok\n")
      await fs.chmod(toolPath, 0o755)
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const found = await isToolOnPath("my-test-tool", tmp.path)
        expect(found).toBe(true)
      },
    })
  })

  test("returns false when tool does not exist anywhere", async () => {
    savedEnv.ALTIMATE_BIN_DIR = process.env.ALTIMATE_BIN_DIR
    delete process.env.ALTIMATE_BIN_DIR

    await using tmp = await tmpdirGit()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const found = await isToolOnPath("altimate-nonexistent-tool-xyz-99999", tmp.path)
        expect(found).toBe(false)
      },
    })
  })

  test("returns true when tool is found via ALTIMATE_BIN_DIR", async () => {
    await using tmp = await tmpdirGit(async (dir) => {
      const binDir = path.join(dir, "custom-bin")
      await fs.mkdir(binDir, { recursive: true })
      const toolPath = path.join(binDir, "my-bin-tool")
      await fs.writeFile(toolPath, "#!/bin/sh\necho ok\n")
      await fs.chmod(toolPath, 0o755)
    })

    savedEnv.ALTIMATE_BIN_DIR = process.env.ALTIMATE_BIN_DIR
    process.env.ALTIMATE_BIN_DIR = path.join(tmp.path, "custom-bin")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const found = await isToolOnPath("my-bin-tool", tmp.path)
        expect(found).toBe(true)
      },
    })
  })

  test("returns true when tool is on PATH via prepended directory", async () => {
    await using tmp = await tmpdirGit(async (dir) => {
      const pathDir = path.join(dir, "path-bin")
      await fs.mkdir(pathDir, { recursive: true })
      const toolPath = path.join(pathDir, "my-path-tool")
      await fs.writeFile(toolPath, "#!/bin/sh\necho ok\n")
      await fs.chmod(toolPath, 0o755)
    })

    savedEnv.ALTIMATE_BIN_DIR = process.env.ALTIMATE_BIN_DIR
    delete process.env.ALTIMATE_BIN_DIR

    savedEnv.PATH = process.env.PATH
    const sep = process.platform === "win32" ? ";" : ":"
    process.env.PATH = path.join(tmp.path, "path-bin") + sep + (process.env.PATH ?? "")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const found = await isToolOnPath("my-path-tool", tmp.path)
        expect(found).toBe(true)
      },
    })
  })
})
