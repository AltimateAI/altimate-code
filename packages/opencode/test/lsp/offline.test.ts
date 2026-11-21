// altimate_change - new file
import { expect, test, spyOn } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { Vue } from "../../src/lsp/server"
import type { RuntimeFlags } from "../../src/effect/runtime-flags"
import type { InstanceContext } from "../../src/project/instance-context"

test.skipIf(process.platform === "win32")("offline LSP spawns an npm-cached server; standalone disableLspDownload returns early", async () => {
  const prior = process.env.ALTIMATE_OFFLINE
  const priorPath = process.env.PATH
  const dir = path.join(Global.Path.cache, "packages", Npm.sanitize("@vue/language-server"))
  const bin = path.join(dir, "node_modules", ".bin", "vue-language-server")
  await fs.mkdir(path.dirname(bin), { recursive: true })
  await fs.writeFile(bin, `#!${process.execPath}\nprocess.exit(0)\n`, { mode: 0o755 })
  const flags = { disableLspDownload: true } as RuntimeFlags.Info
  const ctx = { directory: dir, worktree: dir, project: {} } as InstanceContext
  const which = spyOn(Npm, "which")
  try {
    process.env.PATH = ""
    process.env.ALTIMATE_OFFLINE = "1"
    const handle = await Vue.spawn(dir, ctx, flags)
    expect(handle).toBeDefined()
    expect(which).toHaveBeenCalledWith("@vue/language-server")
    expect(await new Promise<number | null>((resolve, reject) => {
      handle!.process.once("error", reject)
      handle!.process.once("exit", (code) => resolve(code))
    })).toBe(0)
    which.mockClear()
    process.env.ALTIMATE_OFFLINE = "0"
    expect(await Vue.spawn(dir, ctx, flags)).toBeUndefined()
    expect(which).not.toHaveBeenCalled()
  } finally {
    which.mockRestore()
    if (prior === undefined) delete process.env.ALTIMATE_OFFLINE
    else process.env.ALTIMATE_OFFLINE = prior
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    await fs.rm(dir, { recursive: true, force: true })
  }
})
