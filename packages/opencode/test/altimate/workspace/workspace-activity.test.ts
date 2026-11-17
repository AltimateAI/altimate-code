// altimate_change - new file
//
// "What changed" for everyone on a workspace (`workspace-activity.ts`): the line a client shows when a session starts,
// and each client's own last look. Network is stubbed at `globalThis.fetch`; files are real, in a sandbox state
// directory.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
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

/** The `since` (undefined: none) and `limit` each activity request sent, and the answer it gets. */
let asked: (string | undefined)[] = []
let limits: number[] = []
let activity: (since: string | undefined, limit: number) => Response = () => reply({ items: [], has_more: false })
/** A server holding `changes`: newest first (ties by id, newest first), after `since` to the microsecond as the
 * service compares, at most `limit`. Changes without ids sort by time only. */
const server = (changes: { at: string; id?: string }[]) => (since: string | undefined, limit: number) => {
  const at = (value: string) => WorkspaceActivity.precise(value) ?? ""
  const after = changes
    .filter((c) => since === undefined || at(c.at) > at(since))
    .sort((a, b) => at(b.at).localeCompare(at(a.at)) || (b.id ?? "").localeCompare(a.id ?? "", undefined, { numeric: true }))
  return reply({ items: after.slice(0, limit), has_more: after.length > limit })
}
let project = ""

beforeEach(async () => {
  configured = true
  asked = []
  limits = []
  activity = () => reply({ items: [], has_more: false })
  rmSync(WorkspaceActivity.dir(), { recursive: true, force: true })
  project = mkdtempSync(path.join(SANDBOX, "proj-"))
  globalThis.fetch = (async (input: any) => {
    const url = new URL(typeof input === "string" ? input : input.url)
    if (url.pathname.endsWith("/users/me")) return reply({ id: 7 })
    if (url.pathname.endsWith("/datamates/42/activity")) {
      const since = url.searchParams.get("since") ?? undefined
      const limit = Number(url.searchParams.get("limit"))
      asked.push(since)
      limits.push(limit)
      return activity(since, limit)
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
    expect(asked[1]).toBe("2026-11-12T09:55:00.000000Z")
    expect(next.status === "ok" && next.line).toBe("Since your last session in Growth: 1 skill added (late).")
    // Both are reported now: nothing more to say.
    const quiet = await WorkspaceActivity.changesSince(project, "tui")
    expect(quiet.status === "ok" && quiet.line).toBeUndefined()
  })

  test("an older server without ids is asked from the mark itself, as before", () => {
    expect(WorkspaceActivity.sinceOf({ at: "2026-11-12T10:00:00Z", ids: [], overlap: false, from: "" })).toBe(
      "2026-11-12T10:00:00Z",
    )
    // A mark written before ids, read back.
    expect(WorkspaceActivity.markOf("2026-11-12T10:00:00Z")).toEqual({
      at: "2026-11-12T10:00:00Z",
      ids: [],
      overlap: false,
      from: "",
    })
    // A server time without a zone is UTC.
    expect(WorkspaceActivity.sinceOf({ at: "2026-11-12T10:00:00", ids: [], overlap: true, from: "" })).toBe(
      "2026-11-12T09:55:00.000000Z",
    )
  })
})

describe("more changes than a page, under the overlap", () => {
  const bulk = (n: number, at: string) =>
    Array.from({ length: n }, (_, i) => tracked(`a${i}`, `bulk-${i}`, "added", at))

  test("changes it already saw in the overlap do not make the line say there were more", async () => {
    // 60 skills attached in one save: the first look reads 50 of them and records where to start.
    const changes = bulk(60, "2026-11-12T10:00:00Z")
    activity = server(changes)
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("first")
    // A day later, exactly two new changes.
    changes.push(tracked("n1", "naming", "added", "2026-11-13T09:00:00Z"), tracked("n2", "cost-guard", "removed", "2026-11-13T10:00:00Z"))
    const next = await WorkspaceActivity.changesSince(project, "tui")
    expect(next.status === "ok" && next.line).toBe(
      "Since your last session in Growth: 1 skill removed (cost-guard), 1 skill added (naming).",
    )
    // The page was cut inside the overlap, so it was read again with the most the server gives.
    expect(limits).toEqual([WorkspaceActivity.LIMIT, WorkspaceActivity.LIMIT, WorkspaceActivity.MAX_LIMIT])
    const quiet = await WorkspaceActivity.changesSince(project, "tui")
    expect(quiet.status === "ok" && quiet.line).toBeUndefined()
  })

  test("a page cut at the mark's own time still holds every change after it: the count is exact", async () => {
    // 120 changes at one time, more than the most one answer holds: the first look reads 50 of them.
    const changes = bulk(120, "2026-11-12T10:00:00Z")
    activity = server(changes)
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("first")
    changes.push(tracked("n1", "naming", "added", "2026-11-12T10:00:30Z"))
    const next = await WorkspaceActivity.changesSince(project, "tui")
    expect(next.status === "ok" && next.line).toBe("Since your last session in Growth: 1 skill added (naming).")
  })

  test("more changes after the mark than a page holds still say there were more", async () => {
    activity = server([tracked("o1", "old", "added", "2026-11-12T10:00:00Z")])
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("first")
    activity = server([tracked("o1", "old", "added", "2026-11-12T10:00:00Z"), ...bulk(70, "2026-11-13T10:00:00Z")])
    const next = await WorkspaceActivity.changesSince(project, "tui")
    expect(next.status === "ok" && next.line).toStartWith("Since your last session in Growth: more than 50 changes")
  })
})

describe("times to the microsecond, as the server keeps them", () => {
  test("a change in the same millisecond as the mark is reported once, then the mark moves past it", async () => {
    // A server without ids: each look asks from the mark itself.
    const changes: { at: string; kind: string; name: string; action: string }[] = [
      change("first", "added", "2026-11-12T09:00:00.123456Z"),
    ]
    activity = server(changes)
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("first")
    changes.push(change("same-millisecond", "added", "2026-11-12T09:00:00.123789Z"))
    const next = await WorkspaceActivity.changesSince(project, "tui")
    expect(next.status === "ok" && next.line).toBe("Since your last session in Growth: 1 skill added (same-millisecond).")
    expect(asked[1]).toBe("2026-11-12T09:00:00.123456Z")
    const quiet = await WorkspaceActivity.changesSince(project, "tui")
    expect(quiet.status === "ok" && quiet.line).toBeUndefined()
    expect(asked[2]).toBe("2026-11-12T09:00:00.123789Z")
  })

  test("times compare exactly, whatever their zone or digits", () => {
    expect(WorkspaceActivity.precise("2026-11-12T10:00:00.5+05:30")).toBe("2026-11-12T04:30:00.500000Z")
    expect(WorkspaceActivity.precise("2026-11-12T10:00:00")).toBe("2026-11-12T10:00:00.000000Z")
    expect(WorkspaceActivity.precise("not a time")).toBeUndefined()
  })
})

describe("when the server starts giving ids", () => {
  test("the change the last look reported without an id is not reported again", async () => {
    const changes: { at: string; id?: string }[] = [change("before", "added", "2026-11-12T10:00:00Z")]
    activity = server(changes)
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("first")
    // The server is updated: ids from now on, for old changes too.
    changes.splice(0, 1, tracked("e0", "before", "added", "2026-11-12T10:00:00Z"))
    changes.push(tracked("e1", "after", "added", "2026-11-12T10:01:00Z"))
    const next = await WorkspaceActivity.changesSince(project, "tui")
    expect(next.status === "ok" && next.line).toBe("Since your last session in Growth: 1 skill added (after).")
    // The next look reads from 5 minutes before the mark: "before" is in it, and is history.
    const quiet = await WorkspaceActivity.changesSince(project, "tui")
    expect(quiet.status === "ok" && quiet.line).toBeUndefined()
  })
})

describe("more ids in the window than a mark keeps", () => {
  test("the oldest go, and the cut point moves up to cover them", () => {
    const items = Array.from({ length: 250 }, (_, i) => ({
      id: `e${i}`,
      at: `2026-11-12T10:00:${String(Math.floor(i / 5)).padStart(2, "0")}.${String(i % 5).padStart(6, "0")}Z`,
    })).reverse()
    const mark = WorkspaceActivity.advance(undefined, items)
    expect(mark.ids).toHaveLength(200)
    // The 50 oldest went; the oldest kept is e50, and below it unknown ids are history.
    expect(mark.ids[0]).toEqual({ id: "e50", at: "2026-11-12T10:00:10.000000Z" })
    expect(mark.from).toBe("2026-11-12T10:00:10.000000Z")
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

  test("acknowledging a cut look after a complete one keeps its overflow from coming back", async () => {
    const changes: ReturnType<typeof tracked>[] = [tracked("o1", "old", "added", "2026-11-12T09:00:00Z")]
    activity = server(changes)
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("first")
    // A complete look: nothing new.
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("ok")
    // 70 skills attached in one save, an hour later.
    for (let i = 0; i < 70; i++) changes.push(tracked(`b${i}`, `bulk-${i}`, "added", "2026-11-12T10:00:00Z"))
    const shown = await WorkspaceActivity.changesSince(project, "tui", { defer: true })
    expect(shown.status === "ok" && shown.line).toStartWith("Since your last session in Growth: more than 50 changes")
    if (shown.status !== "ok" || !shown.seen) throw new Error("expected a mark to acknowledge")
    expect(await WorkspaceActivity.acknowledge(project, "tui", shown.seen)).toEqual({ status: "ok" })
    // The next start says nothing: the 20 it did not name were summed up as "more than 50".
    const next = await WorkspaceActivity.changesSince(project, "tui", { defer: true })
    expect(next.status === "ok" && next.line).toBeUndefined()
  })

  test("a mark from before a relink is refused, and the new workspace's look is untouched", async () => {
    activity = () => reply({ items: [], has_more: false })
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("first")
    activity = server([tracked("e1", "naming", "added", "2026-11-12T10:00:00Z")])
    const shown = await WorkspaceActivity.changesSince(project, "tui", { defer: true })
    if (shown.status !== "ok" || !shown.seen) throw new Error("expected a mark to acknowledge")
    // Relinked to another workspace while the line waited to be shown.
    await recordApprovedBinding(
      project,
      { datamateId: 43, datamateName: "Other", repoRemote: null, projectPath: project, linkedAt: Date.now() } as never,
      { awaitBackfill: true },
    )
    expect(await WorkspaceActivity.acknowledge(project, "tui", shown.seen)).toEqual({ status: "scope_changed" })
  })

  test("acknowledging an older look keeps what a look in between recorded", async () => {
    activity = () => reply({ items: [], has_more: false })
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("first")
    const changes = [tracked("e1", "naming", "added", "2026-11-12T10:00:00Z")]
    activity = server(changes)
    const older = await WorkspaceActivity.changesSince(project, "tui", { defer: true })
    if (older.status !== "ok" || !older.seen) throw new Error("expected a mark to acknowledge")
    // Another look, not deferred, records a newer change before the older one is acknowledged.
    changes.push(tracked("e2", "cost-guard", "added", "2026-11-12T11:00:00Z"))
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("ok")
    await WorkspaceActivity.acknowledge(project, "tui", older.seen)
    // The newer mark holds: nothing is said again.
    const after = await WorkspaceActivity.changesSince(project, "tui")
    expect(after.status === "ok" && after.line).toBeUndefined()
    expect(asked.at(-1)).toBe("2026-11-12T10:55:00.000000Z")
  })

  test("a cut look acknowledged after a complete one does not hide later changes as history", async () => {
    activity = () => reply({ items: [], has_more: false })
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("first")
    const changes = [tracked("e1", "naming", "added", "2026-11-12T10:00:00Z")]
    activity = server(changes)
    const older = await WorkspaceActivity.changesSince(project, "tui", { defer: true })
    if (older.status !== "ok" || !older.seen) throw new Error("expected a mark to acknowledge")
    // A look in between read its whole window; the deferred one is acknowledged as if its page had been cut.
    changes.push(tracked("e2", "cost-guard", "added", "2026-11-12T10:04:00Z"))
    expect((await WorkspaceActivity.changesSince(project, "tui")).status).toBe("ok")
    await WorkspaceActivity.acknowledge(project, "tui", { ...older.seen, from: "2026-11-12T10:00:00Z" })
    const stored = readdirSync(WorkspaceActivity.dir(), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(path.join(WorkspaceActivity.dir(), f), "utf8")))
    expect(stored.map((state) => state.seen?.tui?.from)).toEqual([""])
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

  test("without a subject, long names that share their first characters are still two items", () => {
    const items = [change(`${"x".repeat(40)}A`, "added", "2"), change(`${"x".repeat(40)}B`, "added", "1")] as never
    expect(WorkspaceActivity.summaryLine("Growth", items)).toStartWith("Since your last session in Growth: 2 skills added (")
  })

  test("a cut never splits a character", () => {
    const line = WorkspaceActivity.summaryLine("Growth", [change("😀".repeat(45), "added", "1")] as never)!
    expect(line).toBe(`Since your last session in Growth: 1 skill added (${"😀".repeat(39)}…).`)
    expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
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
