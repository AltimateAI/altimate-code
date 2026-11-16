// altimate_change - new file
//
// "What changed" for everyone on a workspace (`workspace-activity.ts`): the line a client shows when a session starts,
// and each client's own last look. Network is stubbed at `globalThis.fetch`; files are real, in a sandbox state
// directory.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), "altimate-activity-"))
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")

const { AltimateApi } = await import("../../../src/altimate/api/client")
const { WorkspaceActivity } = await import("../../../src/altimate/workspace/workspace-activity")
const { recordApprovedBinding } = await import("../../../src/altimate/workspace/state")

type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>
const originalIsConfigured = AltimateApi.isConfigured
const originalGetCreds = AltimateApi.getCredentials
const originalFetch = globalThis.fetch
const API = "https://api.example.com"
let configured = true
;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () => configured
;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
  ({ altimateInstanceName: "acme", altimateUrl: API, altimateApiKey: "k" }) as Creds

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const change = (name: string, action: string, at: string, kind = "skill") => ({
  kind,
  name,
  action,
  actor_name: "Ada",
  at,
})

/** The `since` each activity request sent (undefined: none), and the answer it gets. */
let asked: (string | undefined)[] = []
let activity: (since: string | undefined) => Response = () => reply({ items: [], has_more: false })
let project = ""

beforeEach(async () => {
  configured = true
  asked = []
  activity = () => reply({ items: [], has_more: false })
  rmSync(WorkspaceActivity.dir(), { recursive: true, force: true })
  project = mkdtempSync(path.join(SANDBOX, "proj-"))
  globalThis.fetch = (async (input: any) => {
    const url = new URL(typeof input === "string" ? input : input.url)
    if (url.pathname.endsWith("/users/me")) return reply({ id: 7 })
    if (url.pathname.endsWith("/datamates/42/activity")) {
      const since = url.searchParams.get("since") ?? undefined
      asked.push(since)
      return activity(since)
    }
    return reply({ items: [], total: 0, page: 1, size: 50, pages: 1 })
  }) as typeof fetch
  await recordApprovedBinding(
    project,
    { datamateId: 42, datamateName: "Growth", repoRemote: null, projectPath: project, linkedAt: Date.now() } as never,
    { awaitBackfill: true },
  )
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

afterAll(() => {
  ;(AltimateApi as unknown as { isConfigured: typeof originalIsConfigured }).isConfigured = originalIsConfigured
  ;(AltimateApi as unknown as { getCredentials: typeof originalGetCreds }).getCredentials = originalGetCreds
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe("what changed since this client last looked", () => {
  test("the first look says nothing; the next one says what changed after the newest change it saw", async () => {
    activity = () => reply({ items: [change("old", "added", "2026-11-10T00:00:00Z")], has_more: true })
    expect(await WorkspaceActivity.changesSince(project, "tui")).toEqual({
      status: "first",
      workspace: { id: 42, name: "Growth" },
    })
    activity = (since) =>
      reply({
        items: since
          ? [
              change("cost-guard", "removed", "2026-11-12T00:00:00Z"),
              change("naming", "added", "2026-11-11T00:00:00Z"),
              change("glossary", "added", "2026-11-11T00:00:00Z", "knowledge"),
            ]
          : [],
        has_more: false,
      })
    const next = await WorkspaceActivity.changesSince(project, "tui")
    expect(asked).toEqual([undefined, "2026-11-10T00:00:00Z"])
    expect(next.status === "ok" && next.line).toBe(
      "Since your last session in Growth: 1 skill removed (cost-guard), 1 skill added (naming), 1 knowledge base added (glossary).",
    )
    // Nothing newer: nothing to say, and the mark stays on the newest change seen.
    activity = () => reply({ items: [], has_more: false })
    const quiet = await WorkspaceActivity.changesSince(project, "tui")
    expect(quiet).toEqual({ status: "ok", workspace: { id: 42, name: "Growth" }, items: [] })
    expect(asked[2]).toBe("2026-11-12T00:00:00Z")
  })

  test("a first look at an empty window records no clock time: what comes later is all new", async () => {
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("first")
    activity = () => reply({ items: [change("naming", "added", "2026-11-11T00:00:00Z")], has_more: false })
    const next = await WorkspaceActivity.changesSince(project, "tui")
    // No `since`: the whole window is after the empty first look.
    expect(asked).toEqual([undefined, undefined])
    expect(next.status === "ok" && next.line).toBe("Since your last session in Growth: 1 skill added (naming).")
  })

  test("each client keeps its own last look", async () => {
    activity = () => reply({ items: [change("a", "added", "2026-11-10T00:00:00Z")], has_more: false })
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("first")
    expect((await WorkspaceActivity.changesSince(project, "vscode")).status).toBe("first")
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("ok")
  })

  test("a server without the route, and a signed-out person, say why", async () => {
    activity = () => reply({ detail: "Not Found" }, 404)
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("unsupported")
    configured = false
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("signed_out")
  })
})

describe("the line", () => {
  test("groups by kind of change, names a few, and counts an item changed twice once", () => {
    const items = [
      change("a", "added", "6"),
      change("b", "added", "5"),
      change("c", "added", "4"),
      change("d", "added", "3"),
      change("a", "added", "2"),
      change("x", "updated", "1"),
    ] as never
    expect(WorkspaceActivity.summaryLine("Growth", items)).toBe(
      "Since your last session in Growth: 4 skills added (a, b, c, and 1 more), 1 skill updated (x).",
    )
    expect(WorkspaceActivity.summaryLine("Growth", [], true)).toBeUndefined()
    expect(WorkspaceActivity.summaryLine("Gro\u001b[1mwth", [change("e", "removed", "1")] as never, true)).toBe(
      "Since your last session in Gro [1mwth: 1 skill removed (e), and more.",
    )
  })
})
