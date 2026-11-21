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

test.skipIf(process.platform === "win32")("offline language servers get the user's proxy exclusions back", async () => {
  const { spawn } = await import("../../src/lsp/launch")
  const keys = ["ALTIMATE_OFFLINE", "NO_PROXY", "no_proxy", "ALTIMATE_OFFLINE_USER_PROXY"]
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  try {
    // The state Offline.start leaves: the bypass, plus the user's original values.
    process.env.ALTIMATE_OFFLINE = "1"
    process.env.ALTIMATE_OFFLINE_USER_PROXY = JSON.stringify({ NO_PROXY: "corp.example" })
    process.env.NO_PROXY = process.env.no_proxy = "*"
    for (const opts of [{}, { env: { ...process.env } }]) {
      const proc = spawn("sh", ["-c", 'printf "%s|%s|%s" "$NO_PROXY" "$no_proxy" "$ALTIMATE_OFFLINE_USER_PROXY"'], opts)
      const out = await new Response(proc.stdout as any).text()
      await new Promise((resolve) => proc.once("exit", resolve))
      expect(out).toBe("corp.example||")
    }
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})
