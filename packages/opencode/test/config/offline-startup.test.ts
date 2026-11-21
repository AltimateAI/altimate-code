// altimate_change - new file
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Global } from "../../src/global"
import { Offline } from "../../src/config/offline"

test("a legacy global TOML config that requests offline mode is detected at startup", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "offline-legacy-"))
  const legacy = path.join(Global.Path.config, "config")
  const previous = process.env.ALTIMATE_OFFLINE
  delete process.env.ALTIMATE_OFFLINE
  try {
    await fs.mkdir(Global.Path.config, { recursive: true })
    await fs.writeFile(legacy, 'model = "fixture"\noffline = true\n')
    await expect(Offline.assertStartupPolicy(project)).rejects.toThrow("requests offline mode")
    await fs.writeFile(legacy, "offline = false\n")
    await expect(Offline.assertStartupPolicy(project)).resolves.toBeUndefined()
    await fs.writeFile(legacy, "not = [valid toml")
    await expect(Offline.assertStartupPolicy(project)).resolves.toBeUndefined()
  } finally {
    await fs.rm(legacy, { force: true })
    await fs.rm(project, { recursive: true, force: true })
    if (previous === undefined) delete process.env.ALTIMATE_OFFLINE
    else process.env.ALTIMATE_OFFLINE = previous
  }
})
