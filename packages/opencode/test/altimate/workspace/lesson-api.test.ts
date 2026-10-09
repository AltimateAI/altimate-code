// altimate_change - new file
//
// The learned-lesson wire client: requests act as the captured credential, responses are parsed against
// the contract, and failures are classified the way sync acts on them.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { LessonApi, LessonApiError } from "../../../src/altimate/workspace/lesson-api"
import { sandboxHome, startServer, type Server } from "../learn/sync-fixture"

const REMOTE = "git@github.com:acme/analytics.git"
let server: Server
let home: Awaited<ReturnType<typeof sandboxHome>>
beforeAll(async () => { home = await sandboxHome() })
afterAll(async () => { await home.restore() })
beforeEach(() => {
  server = startServer()
  server.bindings.set(REMOTE, server.datamateId)
})
afterEach(() => server.stop())

const actAs = () => ({ url: server.url, instance: "acme", apiKey: "key-a" })
const sync = (datamate = server.datamateId, remote = REMOTE) =>
  LessonApi.sync(actAs(), datamate, { repo_remote: remote, store: "team-playbook", local_keys: [] })
async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as LessonApiError
  }
  throw new Error("expected a failure")
}

test("acts as the captured credential, not the ambient one", async () => {
  await home.signIn(server.url, "key-b")
  const response = await sync()
  expect(response).toMatchObject({ unchanged: false, repo_identity: "https://github.com/acme/analytics", lessons: [] })
  expect(server.requests.at(-1)).toMatchObject({ user: 2, path: `/datamates/${server.datamateId}/lessons/sync` })
})

test("failures are classified by what sync does about them", async () => {
  server.routesMissing = true
  expect((await failure(sync())).kind).toBe("unsupported")
  server.routesMissing = false
  expect((await failure(sync(99))).kind).toBe("workspace_not_found")
  expect((await failure(sync(server.datamateId, "git@github.com:acme/unbound.git"))).kind).toBe("repo_not_bound")
  server.failNext = 1
  expect((await failure(sync())).kind).toBe("transient")
  const usage = { batch_id: "6a1e0d8c-1c0e-4c39-9c84-3f5b9d6f6a10", items: [{ public_id: "x", applied: 1, helpful: 0, harmful: 0 }] }
  await LessonApi.usage(actAs(), server.datamateId, usage)
  expect(await LessonApi.usage(actAs(), server.datamateId, usage)).toEqual({ duplicate: true, applied_items: 1 })
  expect((await failure(LessonApi.usage(actAs(), server.datamateId, { ...usage, items: [{ ...usage.items[0], applied: 2 }] }))).kind).toBe("batch_conflict")
})

test("a response that breaks the contract is rejected, not trusted", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ revision: "seven" })) as unknown as typeof fetch
  try {
    expect((await failure(sync())).kind).toBe("rejected")
  } finally { globalThis.fetch = original }
})
