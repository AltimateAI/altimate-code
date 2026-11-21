// altimate_change - new file
import { afterEach, expect, test } from "bun:test"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Database, eq } from "../../src/storage/db"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })
afterEach(async () => {
  await Instance.disposeAll()
})

test("offline mode refuses to delete a shared session, or its parent, and keeps both", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await Session.create({ title: "parent" })
      const child = await Session.create({ title: "child", parentID: parent.id })
      Database.use((db) =>
        db.update(SessionTable).set({ share_url: "https://share.example/s/1" }).where(eq(SessionTable.id, child.id)).run(),
      )
      const previous = process.env.ALTIMATE_OFFLINE
      process.env.ALTIMATE_OFFLINE = "1"
      try {
        await expect(Session.remove(child.id)).rejects.toThrow("This session is shared")
        await expect(Session.remove(parent.id)).rejects.toThrow("This session is shared")
        expect((await Session.get(child.id)).share?.url).toBe("https://share.example/s/1")
        expect((await Session.get(parent.id)).id).toBe(parent.id)
      } finally {
        if (previous === undefined) delete process.env.ALTIMATE_OFFLINE
        else process.env.ALTIMATE_OFFLINE = previous
      }
      await Session.remove(parent.id).catch(() => {})
    },
  })
})
