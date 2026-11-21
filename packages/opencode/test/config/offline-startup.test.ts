// altimate_change - new file
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"
import path from "node:path"
import { Global } from "../../src/global"
import { Offline } from "../../src/config/offline"

test("a legacy global TOML config that requests offline mode is detected at startup", async () => {
  await using tmp = await tmpdir()
  const project = tmp.path
  const legacy = path.join(Global.Path.config, "config")
  const keys = ["ALTIMATE_OFFLINE", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT"]
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  try {
    await fs.mkdir(Global.Path.config, { recursive: true })
    await fs.writeFile(legacy, 'model = "fixture"\noffline = true\n')
    await expect(Offline.assertStartupPolicy(project)).rejects.toThrow("requests offline mode")
    await fs.writeFile(legacy, "offline = false\n")
    await expect(Offline.assertStartupPolicy(project)).resolves.toBeUndefined()
    await fs.writeFile(legacy, "not = [valid toml")
    await expect(Offline.assertStartupPolicy(project)).resolves.toBeUndefined()
    // An unparseable file that plainly requests offline mode still counts.
    await fs.writeFile(legacy, "offline = true\nbroken = [\n")
    await expect(Offline.assertStartupPolicy(project)).rejects.toThrow("requests offline mode")
  } finally {
    await fs.rm(legacy, { force: true })
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})
