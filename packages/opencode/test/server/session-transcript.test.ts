import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

async function withoutWatcher<T>(fn: () => Promise<T>) {
  if (process.platform !== "win32") return fn()
  const prev = process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
  process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
    else process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = prev
  }
}

async function addUserMessage(sessionID: SessionID, text: string) {
  const id = MessageID.ascending()
  await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)
  await Session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: id,
    type: "text",
    text,
  })
  return id
}

describe("session transcript endpoint", () => {
  test("returns 200 with text/plain markdown for a session", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "Test Session" })
          await addUserMessage(session.id, "Hello world")
          const app = Server.Default()

          const res = await app.request(`/session/${session.id}/transcript`)
          expect(res.status).toBe(200)
          expect(res.headers.get("content-type")).toContain("text/plain")

          const body = await res.text()
          expect(body).toStartWith("# ")
          expect(body).toContain("Test Session")
          expect(body).toContain("## User")
          expect(body).toContain("Hello world")

          await Session.remove(session.id)
        },
      }),
    )
  })

  test("returns 404 for a missing session", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const app = Server.Default()
          const res = await app.request(`/session/ses_nonexistent/transcript`)
          expect(res.status).toBe(404)
        },
      }),
    )
  })

  test("returns markdown for an empty session (no messages)", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "Empty Session" })
          const app = Server.Default()

          const res = await app.request(`/session/${session.id}/transcript`)
          expect(res.status).toBe(200)
          const body = await res.text()
          expect(body).toStartWith("# Empty Session")
          expect(body).toContain("Session ID:")

          await Session.remove(session.id)
        },
      }),
    )
  })

  test("accepts thinking, toolDetails, and assistantMetadata query params", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "Options Session" })
          await addUserMessage(session.id, "test message")
          const app = Server.Default()

          const res = await app.request(
            `/session/${session.id}/transcript?thinking=true&toolDetails=true&assistantMetadata=true`,
          )
          expect(res.status).toBe(200)
          const body = await res.text()
          expect(body).toStartWith("# ")

          await Session.remove(session.id)
        },
      }),
    )
  })
})
