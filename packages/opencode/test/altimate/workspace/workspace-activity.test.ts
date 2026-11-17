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
/** A change as a server with ids sends it. */
const tracked = (id: string, name: string, action: string, at: string, kind = "skill", subject = `${kind}:${name}`) => ({
  ...change(name, action, at, kind),
  id,
  subject,
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

describe("changes that commit late, and what was already reported", () => {
  test("each look asks again from a few minutes before the mark, and reports only what it had not", async () => {
    activity = () => reply({ items: [tracked("e1", "naming", "added", "2026-11-12T10:00:00Z")], has_more: false })
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("first")
    // A change stamped before the mark (its transaction started earlier, it committed later), and the one already seen.
    activity = () =>
      reply({
        items: [
          tracked("e1", "naming", "added", "2026-11-12T10:00:00Z"),
          tracked("e0", "late", "added", "2026-11-12T09:59:00Z"),
        ],
        has_more: false,
      })
    const next = await WorkspaceActivity.changesSince(project, "tui")
    expect(asked[1]).toBe("2026-11-12T09:55:00.000Z")
    expect(next.status === "ok" && next.line).toBe("Since your last session in Growth: 1 skill added (late).")
    // Both are reported now: nothing more to say.
    const quiet = await WorkspaceActivity.changesSince(project, "tui")
    expect(quiet.status === "ok" && quiet.line).toBeUndefined()
  })

  test("an older server without ids is asked from the mark itself, as before", () => {
    expect(WorkspaceActivity.sinceOf({ at: "2026-11-12T10:00:00Z", ids: [], overlap: false })).toBe("2026-11-12T10:00:00Z")
    // A mark written before ids, read back.
    expect(WorkspaceActivity.markOf("2026-11-12T10:00:00Z")).toEqual({ at: "2026-11-12T10:00:00Z", ids: [], overlap: false })
    // A server time without a zone is UTC.
    expect(WorkspaceActivity.sinceOf({ at: "2026-11-12T10:00:00", ids: [], overlap: true })).toBe("2026-11-12T09:55:00.000Z")
  })
})

describe("a deferred look", () => {
  test("keeps the mark until the line was shown, so a client that goes away first shows it next time", async () => {
    activity = () => reply({ items: [], has_more: false })
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("first")
    activity = () => reply({ items: [tracked("e1", "naming", "added", "2026-11-12T10:00:00Z")], has_more: false })
    const unshown = await WorkspaceActivity.changesSince(project, "tui", { defer: true })
    expect(unshown.status === "ok" && unshown.line).toBe("Since your last session in Growth: 1 skill added (naming).")
    // Not acknowledged: the next start says it again.
    const again = await WorkspaceActivity.changesSince(project, "tui", { defer: true })
    expect(again.status === "ok" && again.line).toBe("Since your last session in Growth: 1 skill added (naming).")
    if (again.status !== "ok" || !again.seen) throw new Error("expected a mark to acknowledge")
    expect(await WorkspaceActivity.acknowledge(project, "tui", again.seen)).toEqual({ status: "ok" })
    const after = await WorkspaceActivity.changesSince(project, "tui", { defer: true })
    expect(after.status === "ok" && after.line).toBeUndefined()
  })
})

describe("the line", () => {
  test("with more changes than one look reads, says so instead of giving partial counts", () => {
    const items = [
      tracked("e3", "a", "removed", "3"),
      tracked("e2", "b", "added", "2"),
      tracked("e1", "c", "added", "1"),
      tracked("e0", "d", "updated", "0"),
    ] as never
    expect(WorkspaceActivity.summaryLine("Growth", items, true)).toBe(
      "Since your last session in Growth: more than 4 changes to its skills and knowledge; the newest: a removed, b added, c added.",
    )
  })

  test("counts items, not names: two knowledge bases with one name are two, one item changed twice is one", () => {
    const items = [
      tracked("e1", "Glossary", "added", "2", "knowledge", "kb-1"),
      tracked("e2", "Glossary", "added", "1", "knowledge", "kb-2"),
      tracked("e3", "naming", "added", "1", "skill", "s-1"),
      tracked("e4", "naming", "added", "0", "skill", "s-1"),
    ] as never
    expect(WorkspaceActivity.summaryLine("Growth", items)).toBe(
      "Since your last session in Growth: 2 knowledge bases added (Glossary), 1 skill added (naming).",
    )
  })

  test("caps long names and the whole line, and leaves out an empty name", () => {
    const long = "x".repeat(300)
    const line = WorkspaceActivity.summaryLine(
      "Growth",
      [
        tracked("e1", long, "added", "3", "skill", "s-1"),
        tracked("e2", "", "removed", "2", "skill", "s-2"),
      ] as never,
    )!
    expect(line).toBe(`Since your last session in Growth: 1 skill added (${"x".repeat(39)}…), 1 skill removed.`)
    const many = Array.from({ length: 6 }, (_, g) =>
      Array.from({ length: 3 }, (_, i) =>
        tracked(`e${g}-${i}`, `${"n".repeat(38)}${g}${i}`, ["added", "updated", "removed"][g % 3], "1", g < 3 ? "skill" : "knowledge", `s${g}-${i}`),
      ),
    ).flat()
    const capped = WorkspaceActivity.summaryLine("Growth", many as never)!
    expect(capped.length).toBe(300)
    expect(capped.endsWith("…")).toBe(true)
  })

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
      "Since your last session in Gro [1mwth: more than 1 change to its skills and knowledge; the newest: e removed.",
    )
  })
})
