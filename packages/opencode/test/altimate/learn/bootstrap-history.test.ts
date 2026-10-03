// altimate_change - new file
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { eq, inArray } from "drizzle-orm"
import { Database } from "../../../src/storage/db"
import { MessageID, PartID, SessionID } from "../../../src/session/schema"
import { historyMessages, historySession, historySessions } from "../../../src/altimate/learn/bootstrap-history"

let projectID: string
let directory: string
let otherProjectID: string
beforeEach(() => {
  projectID = randomUUID()
  otherProjectID = randomUUID()
  directory = `/tmp/learn-bootstrap-history-${projectID}`
  Database.use((db) => db.insert(ProjectTable).values([projectID, otherProjectID].map((id) => ({
    id: ProjectV2.ID.make(id), worktree: AbsolutePath.make(directory), sandboxes: [],
  }))).run())
})
afterEach(() => {
  Database.use((db) => db.delete(ProjectTable)
    .where(inArray(ProjectTable.id, [projectID, otherProjectID].map((id) => ProjectV2.ID.make(id)))).run())
})

function session(label: string, created: number, extra: Partial<typeof SessionTable.$inferInsert> = {}) {
  const id = SessionID.make(`ses_${projectID}_${label}`)
  Database.use((db) => db.insert(SessionTable).values({
    id, project_id: ProjectV2.ID.make(projectID), directory,
    slug: label, title: label, version: "test", time_created: created, time_updated: created,
    ...extra,
  }).run())
  return id
}

function message(sessionID: SessionID, label: string, created: number) {
  const id = MessageID.make(`msg_${projectID}_${label}`)
  Database.use((db) => db.insert(MessageTable).values({
    id, session_id: sessionID, time_created: created, time_updated: created,
    data: {
      role: "user", time: { created }, agent: "test", model: { providerID: "test", modelID: "test" },
    } as typeof MessageTable.$inferInsert.data,
  }).run())
  Database.use((db) => db.insert(PartTable).values({
    id: PartID.make(`prt_${projectID}_${label}`), message_id: id, session_id: sessionID,
    data: { type: "text", text: label } as typeof PartTable.$inferInsert.data,
  }).run())
  return id
}

describe("bootstrap history traversal", () => {
  test("applies creation boundary, current project AND directory, root-only and limit", () => {
    const oldest = session("oldest", 100, { time_updated: 9999 })
    const boundary = session("boundary", 200)
    const recent = session("recent", 300)
    const newest = session("newest", 400)
    session("child", 500, { parent_id: newest })
    session("other-directory", 600, { directory: `${directory}/elsewhere` })
    session("other-project", 700, { project_id: ProjectV2.ID.make(otherProjectID) })
    const input = { projectID, directory, since: 200, limit: 200, pageSize: 1 }
    expect([...historySessions(input)].map((item) => item.id)).toEqual([newest, recent, boundary])
    expect([...historySessions({ ...input, limit: 2 })].map((item) => item.id)).toEqual([newest, recent])
    expect([...historySessions({ ...input, limit: 0 })]).toEqual([])
    expect(historySession({ projectID, directory, sessionID: oldest })?.time.updated).toBe(9999)
  })

  test("cursor ties never lose sessions and resume precisely after the previous batch", () => {
    const ids = ["a", "b", "c", "d", "e"].map((label) => session(label, 100))
    const input = { projectID, directory, since: 0, limit: 3, pageSize: 2 }
    const first = [...historySessions(input)]
    expect(first.map((item) => item.id)).toEqual(ids.slice(2).reverse())
    const last = first.at(-1)!
    const rest = [...historySessions({ ...input, before: { created: last.time.created, id: last.id } })]
    expect(rest.map((item) => item.id)).toEqual(ids.slice(0, 2).reverse())
  })

  test("fetches new pages lazily instead of materializing the complete session history", () => {
    const newest = session("newest", 300)
    const oldest = session("oldest", 100)
    const stream = historySessions({ projectID, directory, since: 0, limit: 3, pageSize: 1 })
    expect(stream.next().value?.id).toBe(newest)
    const middle = session("middle", 200)
    expect([...stream].map((item) => item.id)).toEqual([middle, oldest])
  })

  test("honors explicit metadata privacy/import markers and permits outgoing shares", () => {
    const shared = session("shared", 100, { share_url: "https://altimate.ai/share/local" })
    const privateID = session("private", 200, { metadata: { private: true } })
    const visibilityID = session("visibility", 300, { metadata: { visibility: "private" } })
    const imported = session("imported", 400, { metadata: { sharedFrom: "https://example.test/share/elsewhere" } })
    const input = { projectID, directory, since: 0, limit: 1, pageSize: 1 }
    expect([...historySessions(input)].map((item) => item.id)).toEqual([shared])
    for (const sessionID of [privateID, visibilityID, imported]) {
      expect(historySession({ projectID, directory, sessionID })).toBeUndefined()
    }
    expect(historySession({ projectID, directory, sessionID: shared })?.id).toBe(shared)
  })

  test("lookup excludes children, another project and another directory on pending resumption", () => {
    const root = session("root", 100)
    const child = session("child", 200, { parent_id: root })
    const otherDirectory = session("other-directory", 300, { directory: `${directory}/other` })
    const otherProject = session("other-project", 400, { project_id: ProjectV2.ID.make(otherProjectID) })
    for (const sessionID of [child, otherDirectory, otherProject]) {
      expect(historySession({ projectID, directory, sessionID })).toBeUndefined()
    }
    expect(historySession({ projectID, directory, sessionID: SessionID.make("ses_absent") })).toBeUndefined()
  })

  test("messages stream chronologically across timestamp ties and hydrate their own parts", () => {
    const sid = session("messages", 100)
    const other = session("other", 100)
    const latest = message(sid, "latest", 300)
    const b = message(sid, "b", 100)
    const a = message(sid, "a", 100)
    message(other, "elsewhere", 50)
    const messages = [...historyMessages(sid, 1)]
    expect(messages.map((item) => item.info.id)).toEqual([a, b, latest])
    expect(messages.map((item) => item.parts[0])).toMatchObject([
      { type: "text", text: "a", messageID: a, sessionID: sid },
      { type: "text", text: "b", messageID: b, sessionID: sid },
      { type: "text", text: "latest", messageID: latest, sessionID: sid },
    ])
  })

  test("message traversal does not preload all messages or cross session boundaries", () => {
    const sid = session("messages", 100)
    const first = message(sid, "first", 100)
    const latest = message(sid, "latest", 300)
    const stream = historyMessages(sid, 1)
    expect(stream.next().value?.info.id).toBe(first)
    const middle = message(sid, "middle", 200)
    expect([...stream].map((item) => item.info.id)).toEqual([middle, latest])
    Database.use((db) => db.delete(MessageTable).where(eq(MessageTable.session_id, sid)).run())
    expect([...historyMessages(sid)]).toEqual([])
  })
})
