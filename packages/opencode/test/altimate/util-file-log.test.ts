// altimate_change - new file
import { expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { fileLog, resetPermissionCheckForTests } from "../../src/altimate/util/file-log"

test.skipIf(process.platform === "win32")("a log file another writer created world-readable is made owner-only", () => {
  const file = path.join(Global.Path.log, "opencode.log")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, "")
  fs.chmodSync(file, 0o644)
  resetPermissionCheckForTests()
  fileLog("INFO", "test", "permission check")
  expect(fs.statSync(file).mode & 0o077).toBe(0)
})
