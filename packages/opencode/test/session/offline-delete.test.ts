// altimate_change - new file
import { afterEach, expect, test } from "bun:test"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Database, eq } from "../../src/storage/db"
import { Log } from "../../src/util/log"
import { Server } from "../../src/server/server"
import path from "node:path"
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

test("the HTTP API reports the offline shared-session refusal as a 400 with its message", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "shared" })
      Database.use((db) =>
        db.update(SessionTable).set({ share_url: "https://share.example/s/2" }).where(eq(SessionTable.id, session.id)).run(),
      )
      const previous = process.env.ALTIMATE_OFFLINE
      process.env.ALTIMATE_OFFLINE = "1"
      try {
        const res = await Server.Default().request(`/session/${session.id}`, { method: "DELETE" })
        const body = await res.text()
        expect({ status: res.status, body }).toMatchObject({ status: 400 })
        expect(body).toContain("This session is shared")
        expect((await Session.get(session.id)).id).toBe(session.id)
      } finally {
        if (previous === undefined) delete process.env.ALTIMATE_OFFLINE
        else process.env.ALTIMATE_OFFLINE = previous
      }
      Database.use((db) => db.update(SessionTable).set({ share_url: null }).where(eq(SessionTable.id, session.id)).run())
      await Session.remove(session.id).catch(() => {})
    },
  })
})

test("a server started online refuses a project that requests offline mode, with the message", async () => {
  await using tmp = await tmpdir({ git: true })
  await Bun.write(path.join(tmp.path, "opencode.json"), JSON.stringify({ offline: true }))
  const previous = process.env.ALTIMATE_OFFLINE
  delete process.env.ALTIMATE_OFFLINE
  try {
    const res = await Server.Default().request(`/session?directory=${encodeURIComponent(tmp.path)}`)
    const body = await res.text()
    expect({ status: res.status, body }).toMatchObject({ status: 400 })
    expect(body).toContain("This project requests offline mode")
  } finally {
    if (previous !== undefined) process.env.ALTIMATE_OFFLINE = previous
  }
})
