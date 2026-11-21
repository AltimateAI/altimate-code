import { expect, spyOn, test } from "bun:test"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { SessionID } from "../../src/session/schema"
import { ValidatorEnforcement } from "../../src/session/validators/enforcement"
import { Filesystem } from "../../src/util/filesystem"
import { withTestStateHome } from "../fixture/fixture"

test("a failed advisory write keeps delivered state until recovery or session deletion", async () => {
  await withTestStateHome(async () => {
    const sessionID = SessionID.make("ses_validator-advisories")
    const note = "Schema verification was unavailable."
    const pending = { pending: [note], shown: [] }
    const delivered = { pending: [], shown: [ValidatorEnforcement.advisoryFingerprint(note)] }
    ValidatorEnforcement.saveAdvisories(sessionID, pending)

    const write = spyOn(Filesystem, "writeJsonAtomic").mockImplementation(() => {
      throw new Error("state directory is temporarily unwritable")
    })
    try {
      ValidatorEnforcement.saveAdvisories(sessionID, delivered)
      expect(await ValidatorEnforcement.loadAdvisories(sessionID)).toEqual(delivered)
    } finally {
      write.mockRestore()
    }
    expect(await ValidatorEnforcement.loadAdvisories(sessionID)).toEqual(delivered)
    const folder = path.join(Global.Path.state, "validator-advisories")
    const [file] = await readdir(folder)
    expect(await Filesystem.readJson(path.join(folder, file!))).toEqual(delivered)

    const failedWrite = spyOn(Filesystem, "writeJsonAtomic").mockImplementation(() => {
      throw new Error("state directory is temporarily unwritable")
    })
    try {
      ValidatorEnforcement.saveAdvisories(sessionID, pending)
      await ValidatorEnforcement.removeAdvisories(sessionID)
      expect(await ValidatorEnforcement.loadAdvisories(sessionID)).toEqual({ pending: [], shown: [] })
    } finally {
      failedWrite.mockRestore()
    }
  })
})
