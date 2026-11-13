// altimate_change - new file
//
// Workspace review on the CLI side: decision notices for the person's own skill and knowledge submissions
// (`review-notices.ts`) and the read-only `workspace review status` command. Network is stubbed at `globalThis.fetch`;
// files are real, in a sandbox state directory.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
const ORIGINAL_WORKSPACE_FLAG = process.env.ALTIMATE_DISABLE_WORKSPACE
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), "altimate-review-"))
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")

const { AltimateApi } = await import("../../../src/altimate/api/client")
const { ReviewNotices } = await import("../../../src/altimate/workspace/review-notices")
const { ReviewApi } = await import("../../../src/altimate/workspace/review-api")
const { recordApprovedBinding } = await import("../../../src/altimate/workspace/state")
const { EXIT, describeReviews, reviewStatusDeps, runReviewStatus } = await import("../../../src/cli/cmd/workspace")
const { RulesSummary } = await import("../../../src/altimate/rules/summary")

type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>
const originalIsConfigured = AltimateApi.isConfigured
const originalGetCreds = AltimateApi.getCredentials
const originalFetch = globalThis.fetch
const API = "https://api.example.com"
let apiKey = "k"
let configured = true
;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () => configured
;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
  ({ altimateInstanceName: "acme", altimateUrl: API, altimateApiKey: apiKey }) as Creds

let requests: { method: string; url: string }[] = []
/** Who `GET /users/me` says the caller is, per API key. */
let users: Record<string, number> = { k: 7, other: 8 }
/** The answer to `GET /datamates/42/reviews?view=mine`. */
let mine: () => Response = () => page([])
/** The answer to `GET /datamates/42/reviews/{id}`. */
let byId: (id: string) => Response = () => reply({ detail: { code: "not_found", message: "gone" } }, 404)
let project = ""

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const page = (items: unknown[], pages = 1, at = 1) => reply({ items, total: items.length, page: at, size: 50, pages })
const contribution = (over: Record<string, unknown> = {}) => ({
  public_id: "c-1",
  kind: "skill",
  subject_id: "pub-1",
  name: "deploy",
  description: "d",
  change: "add",
  status: "pending",
  version: 1,
  is_mine: true,
  proposed_by_name: "Sam",
  reviewed_by_name: null,
  reviewed_at: null,
  review_reason: null,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  expires_at: "2026-11-15T00:00:00Z",
  expired: false,
  file_count: 1,
  document_version: null,
  ...over,
})

beforeEach(async () => {
  ReviewNotices.resetForTest()
  delete process.env.ALTIMATE_DISABLE_WORKSPACE
  apiKey = "k"
  configured = true
  users = { k: 7, other: 8 }
  mine = () => page([])
  byId = () => reply({ detail: { code: "not_found", message: "gone" } }, 404)
  requests = []
  rmSync(ReviewNotices.dir(), { recursive: true, force: true })
  project = mkdtempSync(path.join(SANDBOX, "proj-"))
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url
    const method = (init?.method ?? "GET").toUpperCase()
    requests.push({ method, url })
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ""
    if (url.endsWith("/users/me")) return reply({ id: users[auth.replace("Bearer ", "")] })
    const one = url.match(/\/datamates\/42\/reviews\/([^/?]+)$/)
    if (one) return byId(decodeURIComponent(one[1]))
    if (url.includes("/datamates/42/reviews")) return mine()
    // The link's own background skill sync: an empty workspace.
    return reply({ items: [], total: 0, page: 1, size: 50, pages: 1 })
  }) as typeof fetch
  await link()
  requests = []
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (ORIGINAL_WORKSPACE_FLAG === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
  else process.env.ALTIMATE_DISABLE_WORKSPACE = ORIGINAL_WORKSPACE_FLAG
})

afterAll(() => {
  ;(AltimateApi as unknown as { isConfigured: typeof originalIsConfigured }).isConfigured = originalIsConfigured
  ;(AltimateApi as unknown as { getCredentials: typeof originalGetCreds }).getCredentials = originalGetCreds
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  rmSync(SANDBOX, { recursive: true, force: true })
})

const scopeA = () => ReviewNotices.scopeOf(API, "acme", "user:7", 42)
const ACT_AS = { url: API, instance: "acme", apiKey: "k" }
/** Link the project for the account signed in now (the binding cache is per credential). */
const link = () =>
  recordApprovedBinding(
    project,
    { datamateId: 42, datamateName: "Growth", repoRemote: null, projectPath: project, linkedAt: Date.now() } as never,
    { awaitBackfill: true },
  )
/** A poll; `shown` are the notices it recorded. `listening`: whether a client receives the announcement (a client that
 * is not listening makes it fail, as a publish with no subscriber reaches nobody). */
async function poll(listening = true) {
  const announced: string[] = []
  const result = await ReviewNotices.poll(project, {
    announce: async (notice) => {
      if (!listening) throw new Error("nobody listening")
      announced.push(notice.public_id)
    },
  })
  return { result, shown: result.status === "done" ? result.recorded : [], announced }
}
/** What a client replays when it starts: the summary's review notices. */
const replayed = async () => (await RulesSummary.summary(project, undefined, process.env, project)).review_notices

describe("decision notices", () => {
  test("a request seen pending and then approved is shown once; history is not", async () => {
    // Decided before this client ever saw it pending: history, not news.
    mine = () => page([contribution({ status: "pending" }), contribution({ public_id: "c-0", status: "active" })])
    expect((await poll()).shown).toEqual([])
    expect((await ReviewNotices.read(scopeA()))?.pending).toEqual(["c-1"])
    mine = () =>
      page([
        contribution({ status: "rejected", reviewed_by_name: "Olive", review_reason: "Too broad" }),
        contribution({ public_id: "c-0", status: "active" }),
      ])
    const second = await poll()
    expect(second.shown).toEqual([
      { public_id: "c-1", kind: "skill", name: "deploy", status: "rejected", reason: "Too broad", reviewer: "Olive", at: "2026-11-01T00:00:00Z" },
    ])
    expect(second.announced).toEqual(["c-1"])
    expect((await poll()).shown).toEqual([])
    const state = await ReviewNotices.read(scopeA())
    expect(state).toMatchObject({ pending: [], seen: ["c-1:rejected"] })
  })

  test("a decision announced with nobody listening is still shown when a client next starts", async () => {
    await ReviewNotices.recordSubmitted(scopeA(), { public_id: "c-1", status: "pending" })
    mine = () => page([contribution({ status: "active", reviewed_by_name: "Olive", reviewed_at: "2026-11-02T00:00:00Z" })])
    const nobody = await poll(false)
    expect(nobody.result.status).toBe("done")
    expect(nobody.announced).toEqual([])
    // Kept, not lost: the summary a starting client replays carries it.
    expect(await replayed()).toEqual([
      { public_id: "c-1", text: "deploy", status: "active", kind: "skill", reviewer: "Olive", at: "2026-11-02T00:00:00Z" },
    ])
    // Recorded once: a later poll neither records nor announces it again, and the client's own memory of what it showed
    // keeps it from showing twice.
    expect((await poll(true)).announced).toEqual([])
    expect(await replayed()).toHaveLength(1)
  })

  test("kept notices are bounded, and are not replayed with workspaces off", async () => {
    mine = () => page(Array.from({ length: ReviewNotices.MAX_NOTICES + 5 }, (_, i) => contribution({ public_id: `c-${i}` })))
    await poll()
    mine = () => page(Array.from({ length: ReviewNotices.MAX_NOTICES + 5 }, (_, i) => contribution({ public_id: `c-${i}`, status: "active" })))
    await poll()
    expect((await ReviewNotices.read(scopeA()))?.notices).toHaveLength(ReviewNotices.MAX_NOTICES)
    // Every kept decision is replayed, not only the newest few: a client away for many still shows each once.
    expect(await replayed()).toHaveLength(ReviewNotices.MAX_NOTICES)
    process.env.ALTIMATE_DISABLE_WORKSPACE = "1"
    expect(await replayed()).toEqual([])
  })

  test("a request replaced by the author's newer one is let go silently", async () => {
    await ReviewNotices.recordSubmitted(scopeA(), { public_id: "c-1", status: "pending" })
    mine = () => page([contribution({ status: "superseded" }), contribution({ public_id: "c-2", status: "pending" })])
    expect((await poll()).shown).toEqual([])
    expect((await ReviewNotices.read(scopeA()))?.pending).toEqual(["c-2"])
  })

  test("a request the author withdrew is let go silently, and the list stays complete", async () => {
    await ReviewNotices.recordSubmitted(scopeA(), { public_id: "c-1", status: "pending" })
    mine = () => page([contribution({ status: "withdrawn" }), contribution({ public_id: "c-2", status: "pending" })])
    expect((await poll()).shown).toEqual([])
    expect((await ReviewNotices.read(scopeA()))?.pending).toEqual(["c-2"])
    // Read as a known status, not skipped: a complete list lets go of ids it no longer holds.
    expect((await ReviewApi.listMine(42, ACT_AS)).skipped).toBe(0)
  })

  test("an approved request removed by someone else is shown once with the reason; your own removal is not", async () => {
    mine = () => page([contribution({ status: "active" }), contribution({ public_id: "c-2", status: "active" })])
    await poll()
    expect((await ReviewNotices.read(scopeA()))?.approved).toEqual(["c-1", "c-2"])
    mine = () =>
      page([
        contribution({ status: "retired", reviewed_by_name: "Olive", review_reason: "Out of date", decided_by_me: false }),
        contribution({ public_id: "c-2", status: "retired", decided_by_me: true }),
      ])
    const { shown } = await poll()
    expect(shown.map((n) => [n.public_id, n.status, n.reviewer, n.reason])).toEqual([["c-1", "retired", "Olive", "Out of date"]])
    expect((await poll()).shown).toEqual([])
    expect((await ReviewNotices.read(scopeA()))?.approved).toEqual([])
  })

  test("past the cap the tracked approved requests stay the same from one check to the next", async () => {
    // Two pages of approved requests, more than the client tracks; the server lists newest first.
    const ids = Array.from({ length: ReviewNotices.MAX_APPROVED + 50 }, (_, i) => `a-${i}`)
    mine = () => {
      const at = Number(new URL(requests[requests.length - 1].url).searchParams.get("page") ?? "1")
      const rows = ids.slice((at - 1) * 50, at * 50).map((id) => contribution({ public_id: id, status: "active" }))
      return page(rows, Math.ceil(ids.length / 50), at)
    }
    await poll()
    const first = (await ReviewNotices.read(scopeA()))?.approved
    expect(first).toHaveLength(ReviewNotices.MAX_APPROVED)
    const file = ReviewNotices.stateFile(scopeA())
    const before = statSync(file).mtimeMs
    await poll()
    expect((await ReviewNotices.read(scopeA()))?.approved).toEqual(first)
    // Nothing changed, so nothing was written.
    expect(statSync(file).mtimeMs).toBe(before)
  })

  test("a removal of an approved request the capped list no longer reaches is still noticed", async () => {
    mine = () => page([contribution({ public_id: "c-old", status: "active" })])
    await poll()
    let at = 0
    mine = () => {
      at++
      return page(Array.from({ length: 50 }, (_, i) => contribution({ public_id: `n-${at}-${i}`, status: "active" })), 99, at)
    }
    byId = (id) => reply(contribution({ public_id: id, status: "retired", reviewed_by_name: "Olive", review_reason: "Old", decided_by_me: false }))
    const { shown } = await poll()
    expect(shown.map((n) => [n.public_id, n.status])).toEqual([["c-old", "retired"]])
  })

  test("a request approved and removed between two checks is still told as removed", async () => {
    await ReviewNotices.recordSubmitted(scopeA(), { public_id: "c-1", status: "pending" })
    mine = () => page([contribution({ status: "retired", reviewed_by_name: "Olive", review_reason: "Duplicate" })])
    const { shown } = await poll()
    expect(shown.map((n) => n.status)).toEqual(["retired"])
    expect((await ReviewNotices.read(scopeA()))?.pending).toEqual([])
  })

  test("a decision made after this client began keeping state is noticed even if it never saw the request pending", async () => {
    mine = () => page([])
    await poll()
    expect((await ReviewNotices.read(scopeA()))?.since).toBeString()
    const later = new Date(Date.now() + 1_000).toISOString()
    mine = () =>
      page([
        // Sent from the web app and decided between two polls.
        contribution({ public_id: "c-web", status: "active", reviewed_at: later }),
        // The person's own decision (an owner approving their own request) is not news.
        contribution({ public_id: "c-own", status: "active", reviewed_at: later, decided_by_me: true }),
      ])
    expect((await poll()).shown.map((n) => n.public_id)).toEqual(["c-web"])
  })

  test("a request this client never saw is history: its removal shows nothing", async () => {
    mine = () => page([contribution({ status: "retired", review_reason: "Old" })])
    expect((await poll()).shown).toEqual([])
  })

  test("a state file written before approved requests were tracked still loads", async () => {
    const file = ReviewNotices.stateFile(scopeA())
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, scope: scopeA(), pending: ["c-1"], seen: [], notices: [] }))
    expect((await ReviewNotices.read(scopeA()))?.approved).toEqual([])
    mine = () => page([contribution({ status: "active" })])
    expect((await poll()).shown.map((n) => n.status)).toEqual(["active"])
  })

  test("a 401, a 403 or an outage shows nothing and keeps the state as it was", async () => {
    await ReviewNotices.recordSubmitted(scopeA(), { public_id: "c-1", status: "pending" })
    const before = await ReviewNotices.read(scopeA())
    for (const failure of [
      () => new Response("unauthorized", { status: 401 }),
      () => new Response("forbidden", { status: 403 }),
      () => reply({ detail: "boom" }, 503),
      () => {
        throw new TypeError("network down")
      },
    ]) {
      mine = failure
      const { result, shown } = await poll()
      expect(result.status).toBe("failed")
      expect(shown).toEqual([])
      expect(await ReviewNotices.read(scopeA())).toEqual(before)
    }
  })

  test("a server without review is left alone, and nothing is written", async () => {
    for (const absent of [() => reply({ detail: "Not Found" }, 404), () => reply({ detail: { code: "reviews_not_available", message: "x" } }, 404)]) {
      mine = absent
      expect((await poll()).result.status).toBe("unsupported")
    }
    expect(() => readdirSync(ReviewNotices.dir())).toThrow()
  })

  test("with workspaces turned off nothing is asked", async () => {
    process.env.ALTIMATE_DISABLE_WORKSPACE = "1"
    expect((await poll()).result.status).toBe("off")
    expect(requests).toEqual([])
  })

  test("signed out, nothing is asked", async () => {
    configured = false
    expect((await poll()).result.status).toBe("signed_out")
    expect(requests).toEqual([])
  })

  test("another account reads its own state: one account's pending request is never shown to, or advanced by, another", async () => {
    await ReviewNotices.recordSubmitted(scopeA(), { public_id: "c-1", status: "pending" })
    // The same project, linked to the same workspace by the second person.
    apiKey = "other"
    await link()
    mine = () => page([contribution({ status: "active" })])
    const other = await poll()
    expect(other.result.status).toBe("done")
    expect(other.shown).toEqual([])
    expect(await replayed()).toEqual([])
    // The first account's request is still waiting to be noticed, in its own file.
    expect((await ReviewNotices.read(scopeA()))?.pending).toEqual(["c-1"])
    expect((await ReviewNotices.read(ReviewNotices.scopeOf(API, "acme", "user:8", 42)))?.pending ?? []).toEqual([])
    apiKey = "k"
    await link()
    const back = await poll()
    expect(back.result.status).toBe("done")
    expect(back.shown.map((n) => n.public_id)).toEqual(["c-1"])
  })

  test("a pending request is kept when the list had a row this version could not read", async () => {
    mine = () => page([contribution({ status: "pending" })])
    await poll()
    expect((await ReviewNotices.read(scopeA()))?.pending).toEqual(["c-1"])
    // One page, complete, but its only row does not parse: it may be c-1, so c-1 is not let go.
    mine = () => page([{ public_id: "c-1", status: "weird" }])
    await poll()
    expect((await ReviewNotices.read(scopeA()))?.pending).toEqual(["c-1"])
    mine = () => page([contribution({ status: "rejected", review_reason: "No" })])
    expect((await poll()).shown.map((n) => n.public_id)).toEqual(["c-1"])
  })

  test("a list without page counts is read while pages are full; one short of its total is not complete", async () => {
    let calls = 0
    mine = () => {
      calls++
      const items = calls === 1 ? Array.from({ length: 50 }, (_, i) => contribution({ public_id: `c-${i}` })) : [contribution({ public_id: "c-last" })]
      return reply({ items, total: 51 })
    }
    const listed = await ReviewApi.listMine(42, ACT_AS)
    expect(calls).toBe(2)
    expect(listed.items).toHaveLength(51)
    expect(listed.complete).toBe(true)
    mine = () => reply({ items: [contribution()], total: 3, page: 1, pages: 1 })
    expect((await ReviewApi.listMine(42, ACT_AS)).complete).toBe(false)
  })

  test("a server that ignores the page number is read twice, not to the cap, and the list is not complete", async () => {
    let calls = 0
    mine = () => {
      calls++
      return reply({ items: Array.from({ length: 50 }, (_, i) => contribution({ public_id: `c-${i}` })) })
    }
    const listed = await ReviewApi.listMine(42, ACT_AS)
    expect(calls).toBe(2)
    expect(listed.complete).toBe(false)
  })

  test("decisions kept before are replayed for a credential this process has not polled with yet", async () => {
    mine = () => page([contribution({ status: "pending" })])
    await poll()
    mine = () => page([contribution({ status: "active", reviewed_by_name: "Olive" })])
    await poll()
    // The same person signs in with a rotated key (as after a restart, nothing is known about it in this process).
    apiKey = "rotated"
    users = { ...users, rotated: 7 }
    await link()
    // The first replay does not wait on the network: it starts the lookup and shows nothing yet.
    expect(await replayed()).toEqual([])
    let shown: string[] = []
    for (let i = 0; i < 50 && !shown.length; i++) {
      await new Promise((r) => setTimeout(r, 10))
      shown = (await replayed()).map((n) => n.public_id)
    }
    expect(shown).toEqual(["c-1"])
  })

  test("a server without review is not asked again for a while, and its 404 is not reported as an API error", async () => {
    mine = () => reply({ detail: { code: "reviews_not_available", message: "x" } }, 404)
    expect((await poll()).result.status).toBe("unsupported")
    const asked = requests.filter((r) => r.url.includes("/reviews")).length
    expect(asked).toBe(1)
    expect((await poll()).result.status).toBe("unsupported")
    expect(requests.filter((r) => r.url.includes("/reviews")).length).toBe(asked)
  })

  test("stored notices follow the IDE's pin for this tree, from what is on hand", async () => {
    mine = () => page([contribution({ status: "pending" })])
    await poll()
    mine = () => page([contribution({ status: "active" })])
    await poll()
    expect((await replayed()).map((n) => n.public_id)).toEqual(["c-1"])
    // Pinned to another workspace: its notices, not the link's (none kept for it here); pinned to this one: shown.
    const keys = ["ALTIMATE_CODE_SERVE", "ALTIMATE_PINNED_WORKSPACE_ID", "ALTIMATE_PINNED_WORKSPACE_NAME", "ALTIMATE_PINNED_WORKSPACE_ROOT"]
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    try {
      Object.assign(process.env, { ALTIMATE_CODE_SERVE: "1", ALTIMATE_PINNED_WORKSPACE_NAME: "Pinned", ALTIMATE_PINNED_WORKSPACE_ROOT: project })
      process.env.ALTIMATE_PINNED_WORKSPACE_ID = "77"
      expect(await replayed()).toEqual([])
      process.env.ALTIMATE_PINNED_WORKSPACE_ID = "42"
      expect((await replayed()).map((n) => n.public_id)).toEqual(["c-1"])
      // A pin for another tree names no workspace here.
      process.env.ALTIMATE_PINNED_WORKSPACE_ROOT = path.join(SANDBOX, "elsewhere")
      expect(await replayed()).toEqual([])
    } finally {
      for (const key of keys)
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
    }
  })

  test("a pending request the capped list no longer reaches is asked for by id, and its decision is noticed", async () => {
    mine = () => page([contribution({ public_id: "c-old", status: "pending" })])
    await poll()
    // Newer requests fill every page up to the cap; c-old is past it.
    let at = 0
    mine = () => {
      at++
      return page(Array.from({ length: 50 }, (_, i) => contribution({ public_id: `n-${at}-${i}` })), 99, at)
    }
    byId = (id) => reply(contribution({ public_id: id, status: "active", reviewed_by_name: "Olive" }))
    const { shown } = await poll()
    expect(shown.map((n) => n.public_id)).toEqual(["c-old"])
    expect((await ReviewNotices.read(scopeA()))?.pending).not.toContain("c-old")
  })

  test("past the cap, a request the server no longer has is let go, and one that fails moves behind the others", async () => {
    mine = () => page([contribution({ public_id: "c-gone", status: "pending" }), contribution({ public_id: "c-flaky", status: "pending" })])
    await poll()
    let at = 0
    mine = () => {
      at++
      return page(Array.from({ length: 50 }, (_, i) => contribution({ public_id: `n-${at}-${i}` })), 99, at)
    }
    byId = (id) => (id === "c-gone" ? reply({ detail: { code: "not_found", message: "gone" } }, 404) : reply({ detail: "boom" }, 502))
    await poll()
    const pending = (await ReviewNotices.read(scopeA()))?.pending ?? []
    expect(pending).not.toContain("c-gone")
    expect(pending).toContain("c-flaky")
    // Asked this time, so it waits behind the requests not asked yet.
    expect(pending.indexOf("c-flaky")).toBe(pending.length - 1)
  })

  test("the state is bounded", async () => {
    mine = () => page(Array.from({ length: ReviewNotices.MAX_PENDING + 25 }, (_, i) => contribution({ public_id: `c-${i}` })))
    await poll()
    expect((await ReviewNotices.read(scopeA()))?.pending).toHaveLength(ReviewNotices.MAX_PENDING)
  })

  test("every page of the person's requests is read, up to the cap", async () => {
    let calls = 0
    mine = () => {
      calls++
      return page([contribution({ public_id: `c-${calls}` })], 99, calls)
    }
    const listed = await ReviewApi.listMine(42, ACT_AS)
    expect(calls).toBe(ReviewApi.MAX_PAGES)
    expect(listed.complete).toBe(false)
    expect(listed.items).toHaveLength(ReviewApi.MAX_PAGES)
  })
})

describe("workspace review status", () => {
  const capture = () => {
    const out: string[] = []
    const err: string[] = []
    const json: unknown[] = []
    return {
      out,
      err,
      json,
      deps: {
        ...reviewStatusDeps,
        print: (line: string) => void out.push(line),
        printError: (line: string) => void err.push(line),
        printJson: (payload: unknown) => void json.push(payload),
      },
    }
  }

  test("lists kind, name, status, change, the reviewer's reason and the expired label", () => {
    const lines = describeReviews("Growth", {
      items: [
        ReviewApi.Contribution.parse(contribution({ expired: true })),
        ReviewApi.Contribution.parse(
          contribution({ public_id: "c-2", kind: "knowledge", name: "FAQ", change: "edit", status: "rejected", reviewed_by_name: "Olive", review_reason: "Out of date" }),
        ),
        ReviewApi.Contribution.parse(contribution({ public_id: "c-3", status: "active", reviewed_by_name: "Olive" })),
      ],
      skipped: 1,
      complete: true,
    })
    expect(lines).toEqual([
      'Your review requests in "Growth", newest first:',
      '  skill "deploy" (new): pending review (expired: waiting longer than 14 days)',
      '  knowledge "FAQ" (update): rejected by Olive: Out of date',
      '  skill "deploy" (new): approved by Olive',
      "1 request could not be read by this version of altimate-code.",
    ])
  })

  test("withdrawn and removed requests read as such, a removal with who and why", () => {
    const lines = describeReviews("Growth", {
      items: [
        ReviewApi.Contribution.parse(contribution({ status: "withdrawn" })),
        ReviewApi.Contribution.parse(contribution({ public_id: "c-2", status: "retired", reviewed_by_name: "Olive", review_reason: "Duplicate" })),
      ],
      skipped: 0,
      complete: true,
    })
    expect(lines[1]).toContain(": withdrawn")
    expect(lines[2]).toContain(": removed from the workspace by Olive: Duplicate")
  })

  test("--json carries the server's rows; exit 0", async () => {
    mine = () => page([contribution()])
    const c = capture()
    expect(await runReviewStatus(project, true, c.deps)).toBe(EXIT.OK)
    expect(c.json[0]).toMatchObject({ ok: true, workspace_id: 42, workspace_name: "Growth", complete: true, items: [{ public_id: "c-1", status: "pending" }] })
  })

  test("writes nothing: no state file, no request but GETs", async () => {
    mine = () => page([contribution({ status: "rejected", review_reason: "no" })])
    const snapshot = () =>
      readdirSync(SANDBOX, { recursive: true })
        .map(String)
        .sort()
        .map((rel) => `${rel}@${statSync(path.join(SANDBOX, rel)).mtimeMs}`)
    const before = snapshot()
    const c = capture()
    expect(await runReviewStatus(project, false, c.deps)).toBe(EXIT.OK)
    expect(c.out.join("\n")).toContain("rejected")
    expect(snapshot()).toEqual(before)
    expect(requests.every((r) => r.method === "GET")).toBe(true)
  })

  test("a sign-in switch while the link is resolved lists nothing for the other account", async () => {
    const { spyOn } = await import("bun:test")
    const WorkspaceState = await import("../../../src/altimate/workspace/state")
    mine = () => page([contribution()])
    const switched = spyOn(WorkspaceState, "accountDigest").mockResolvedValue("someone-else")
    try {
      const c = capture()
      expect(await runReviewStatus(project, true, c.deps)).toBe(EXIT.FAILED)
      expect(requests.some((r) => r.url.includes("/reviews"))).toBe(false)
    } finally {
      switched.mockRestore()
    }
  })

  test("failures exit non-zero: 401, an outage, a server without review", async () => {
    for (const failure of [
      () => new Response("unauthorized", { status: 401 }),
      () => reply({ detail: "boom" }, 500),
      () => reply({ detail: "Not Found" }, 404),
    ]) {
      mine = failure
      const c = capture()
      expect(await runReviewStatus(project, true, c.deps)).toBe(EXIT.FAILED)
      expect(c.json[0]).toMatchObject({ ok: false })
    }
  })

  test("not signed in is a request to change (2); not linked is 3", async () => {
    configured = false
    expect(await runReviewStatus(project, true, capture().deps)).toBe(EXIT.USAGE)
    configured = true
    const c = capture()
    expect(await runReviewStatus(project, true, { ...c.deps, binding: async () => ({ status: "unbound" }) })).toBe(EXIT.NOT_LINKED)
  })
})

describe("requests for other clients", () => {
  const { ReviewRequests } = require("../../../src/altimate/workspace/review-requests") as typeof import("../../../src/altimate/workspace/review-requests")
  const { RulesHost } = require("../../../src/altimate/rules/host") as typeof import("../../../src/altimate/rules/host")

  /** Answer `POST .../reviews/<id>/<action>` with `answer`, everything else as the harness does. */
  const onAction = (answer: (action: string, body: any) => Response) => {
    const harness = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url
      const hit = url.match(/\/datamates\/42\/reviews\/[^/?]+\/(withdraw|retire)$/)
      if (hit) return answer(hit[1], JSON.parse(init?.body ?? "{}"))
      return harness(input, init)
    }) as typeof fetch
  }

  test("each request says what the person may do with it", async () => {
    mine = () =>
      page([
        contribution({ public_id: "c-1", status: "pending" }),
        contribution({ public_id: "c-2", status: "active", name: "two" }),
        contribution({ public_id: "c-3", status: "rejected", review_reason: "No" }),
      ])
    const listed = await ReviewRequests.listReview(project)
    expect(listed.status).toBe("ok")
    if (listed.status !== "ok") return
    expect(listed.workspace).toEqual({ id: 42, name: "Growth" })
    expect(listed.items.map(ReviewRequests.fromContribution).map((r) => [r.public_id, r.actions])).toEqual([
      ["c-1", ["withdraw"]],
      ["c-2", ["remove"]],
      ["c-3", []],
    ])
  })

  test("withdraw and remove go to the server with the version and say what it answered", async () => {
    const sent: [string, any][] = []
    onAction((action, body) => {
      sent.push([action, body])
      return reply(contribution({ status: action === "withdraw" ? "withdrawn" : "retired", version: 2 }))
    })
    const withdrawn = await ReviewRequests.act(project, "c-1", "withdraw", { expected_version: 1 })
    expect(withdrawn).toMatchObject({ ok: true, request: { status: "withdrawn", actions: [] } })
    const removed = await ReviewRequests.act(project, "c-1", "remove", { expected_version: 1, reason: "old" })
    expect(removed).toMatchObject({ ok: true, request: { status: "retired" } })
    expect(sent).toEqual([
      ["withdraw", { expected_version: 1, source: "cli" }],
      ["retire", { expected_version: 1, reason: "old", source: "cli" }],
    ])
  })

  test("a refusal keeps its code and status", async () => {
    onAction(() => reply({ detail: { code: "already_decided", message: "The request is active" } }, 409))
    expect(await ReviewRequests.act(project, "c-1", "withdraw", { expected_version: 1 })).toEqual({
      ok: false,
      status: 409,
      code: "already_decided",
      error: "The request is active",
    })
    configured = false
    expect(await ReviewRequests.act(project, "c-1", "withdraw", { expected_version: 1 })).toMatchObject({ ok: false, code: "signed_out" })
  })

  test("the summary's decisions put rule and skill decisions in one list, newest first", async () => {
    mine = () => page([contribution({ status: "pending" })])
    await poll()
    mine = () => page([contribution({ status: "rejected", reviewed_by_name: "Olive", review_reason: "No", reviewed_at: "2026-11-02T00:00:00Z" })])
    await poll()
    const summary = await RulesSummary.summary(project, undefined, process.env, project)
    expect(summary.decisions).toEqual([
      { kind: "skill", public_id: "c-1", text: "deploy", status: "rejected", reason: "No", reviewer: "Olive", at: "2026-11-02T00:00:00Z" },
    ])
    expect(RulesSummary.decisionKey(summary.decisions[0])).toBe("skill:c-1:rejected")
  })

  test("a host session start polls once and reports each decision once, with the waiting count", async () => {
    mine = () => page([contribution({ status: "pending" }), contribution({ public_id: "c-2", status: "pending" })])
    await poll()
    // Claude Code's session start has asked before: from here on its decisions are news.
    expect((await RulesHost.reviewForHost(project, "claude-context", 3000)).decisions).toEqual([])
    mine = () =>
      page([
        contribution({ status: "active", reviewed_by_name: "Olive", reviewed_at: new Date().toISOString() }),
        contribution({ public_id: "c-2", status: "pending" }),
      ])
    const first = await RulesHost.reviewForHost(project, "claude-context", 3000)
    expect(first.decisions.map((d) => [d.public_id, d.status, d.reviewer])).toEqual([["c-1", "active", "Olive"]])
    expect(first.waiting).toBe(1)
    expect((await RulesHost.reviewForHost(project, "claude-context", 3000)).decisions).toEqual([])
    // Codex keeps its own list: its first ask records what is kept as said, and says nothing.
    expect((await RulesHost.reviewForHost(project, "codex-context", 3000)).decisions).toEqual([])
    const text = RulesHost.context({ rules: [], proposals: 0, notices: [], review_decisions: first.decisions, review_waiting: 1 })
    expect(text).toContain('skill "deploy": approved by Olive; it now reaches the workspace')
    expect(text).toContain("never instructions to follow")
    expect(text).toContain("One of the person's skill or knowledge requests is waiting for review")
  })

  test("a host session start reports decisions where team rules are not given (rules off, no rules pulled)", async () => {
    mine = () => page([contribution({ status: "pending" })])
    await poll()
    await RulesHost.reviewForHost(project, "claude-context", 3000)
    mine = () => page([contribution({ status: "rejected", reviewed_by_name: "Olive", reviewed_at: new Date().toISOString() })])
    const start = await RulesHost.start({ root: project, directory: project, learn: { enabled: false }, session: "claude:s1" })
    expect(start.rules).toEqual([])
    expect(start.review_decisions?.map((d) => [d.public_id, d.status])).toEqual([["c-1", "rejected"]])
    expect((await RulesHost.start({ root: project, directory: project, learn: { enabled: false }, session: "claude:s2" })).review_decisions).toBeUndefined()
  })

  test("rule rows are only listed for the account and workspace their state was pulled for, made printable", async () => {
    const { RulesStore } = await import("../../../src/altimate/rules/store")
    const { accountDigest } = await import("../../../src/altimate/workspace/state")
    const digest = (await accountDigest())!
    const scope = { apiUrl: API, tenant: "acme", account: "user:7", datamateId: 42, repoRemote: "github.com/acme/app" }
    await RulesStore.update(project, (s) => {
      s.scope = scope as never
      s.workspace = { name: "Growth", is_owner: false } as never
      s.pulled_with = digest
      s.sent = [{ public_id: "r-1", text: "Use \u001b[31mred\u001b[0m names", status: "rejected", reason: "No\u0007", reviewer: "Olive", change: "add", sent_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z" }]
    })
    const rows = await ReviewRequests.ruleRequests(project, project, 42)
    expect(rows).toEqual([{ kind: "rule", public_id: "r-1", name: "Use  [31mred [0m names", status: "rejected", reason: "No ", reviewer: "Olive", actions: [] }])
    // Another workspace on the skill listing, or another account signed in: none.
    expect(await ReviewRequests.ruleRequests(project, project, 43)).toEqual([])
    apiKey = "other"
    expect(await ReviewRequests.ruleRequests(project, project, 42)).toEqual([])
  })
})

describe("decisions for clients that show them (workspace review decisions)", () => {
  test("each decision is given once per host, newest first, with the waiting count", async () => {
    mine = () => page([contribution({ status: "pending" }), contribution({ public_id: "c-2", status: "pending" })])
    await poll()
    await ReviewNotices.hostDecisions(project, { host: "claude-ui", unseen: true })
    await ReviewNotices.hostDecisions(project, { host: "other", unseen: true })
    mine = () =>
      page([
        contribution({ status: "rejected", review_reason: "No", reviewed_by_name: "Olive", reviewed_at: new Date().toISOString() }),
        contribution({ public_id: "c-2", status: "pending" }),
      ])
    const first = await ReviewNotices.hostDecisions(project, { host: "claude-ui", unseen: true, markSeen: true })
    expect(first).toMatchObject({ ok: true, waiting: 1 })
    if (!first.ok) return
    expect(first.decisions.map((d) => [d.public_id, d.status, d.reason])).toEqual([["c-1", "rejected", "No"]])
    // Given to claude-ui: not again for it, still for another host.
    expect(await ReviewNotices.hostDecisions(project, { host: "claude-ui", unseen: true })).toMatchObject({ ok: true, decisions: [] })
    const other = await ReviewNotices.hostDecisions(project, { host: "other", unseen: true })
    expect(other.ok && other.decisions.length).toBe(1)
  })

  test("a client's first ask records what is kept as shown and answers none: history, not news", async () => {
    mine = () => page([contribution({ status: "pending" })])
    await poll()
    mine = () => page([contribution({ status: "active", reviewed_at: new Date().toISOString() })])
    await poll()
    expect((await ReviewNotices.read(scopeA()))?.notices.map((n) => n.public_id)).toEqual(["c-1"])
    expect(await ReviewNotices.hostDecisions(project, { host: "claude-ui", unseen: true, markSeen: true })).toMatchObject({ ok: true, decisions: [] })
    mine = () => page([contribution({ status: "retired", reviewed_at: new Date().toISOString(), decided_by_me: false })])
    const next = await ReviewNotices.hostDecisions(project, { host: "claude-ui", unseen: true, markSeen: true })
    expect(next.ok && next.decisions.map((d) => d.status)).toEqual(["retired"])
  })

  test("two sessions asking at once never both get a decision", async () => {
    mine = () => page([contribution({ status: "pending" })])
    await poll()
    await ReviewNotices.hostDecisions(project, { host: "claude-ui", unseen: true })
    mine = () => page([contribution({ status: "active", reviewed_at: new Date().toISOString() })])
    await poll()
    const both = await Promise.all([
      ReviewNotices.hostDecisions(project, { host: "claude-ui", unseen: true, markSeen: true }),
      ReviewNotices.hostDecisions(project, { host: "claude-ui", unseen: true, markSeen: true }),
    ])
    expect(both.flatMap((answer) => (answer.ok ? answer.decisions : [])).map((d) => d.public_id)).toEqual(["c-1"])
  })

  test("a claimed decision is held until acknowledged, and handed out again when the claim lapses", async () => {
    mine = () => page([contribution({ status: "pending" }), contribution({ public_id: "c-2", status: "pending" })])
    await poll()
    await ReviewNotices.hostDecisions(project, { host: "claude-ui", unseen: true })
    mine = () =>
      page([
        contribution({ status: "active", reviewed_at: new Date().toISOString() }),
        contribution({ public_id: "c-2", status: "rejected", reviewed_at: new Date().toISOString() }),
      ])
    const claimed = await ReviewNotices.hostDecisions(project, { host: "claude-ui", unseen: true, claim: true })
    expect(claimed.ok && claimed.decisions.length).toBe(2)
    // Held: another session does not get them while the first shows them.
    expect(await ReviewNotices.hostDecisions(project, { host: "claude-ui", unseen: true, claim: true })).toMatchObject({ ok: true, decisions: [] })
    expect(await ReviewNotices.ackHostDecisions(project, "claude-ui", ["skill:c-1:active"])).toEqual({ ok: true })
    // The one never acknowledged (its toast failed) lapses and is handed out again; the acknowledged one never is.
    const file = ReviewNotices.stateFile(scopeA())
    const state = JSON.parse(await Bun.file(file).text())
    state.host_claims["claude-ui"] = Object.fromEntries(Object.keys(state.host_claims["claude-ui"]).map((k) => [k, Date.now() - 1]))
    writeFileSync(file, JSON.stringify(state))
    const again = await ReviewNotices.hostDecisions(project, { host: "claude-ui", unseen: true, claim: true })
    expect(again.ok && again.decisions.map(ReviewNotices.decisionKey)).toEqual(["skill:c-2:rejected"])
  })

  test("past the caller's deadline nothing is marked: the decision is given next time", async () => {
    mine = () => page([contribution({ status: "pending" })])
    await poll()
    await ReviewNotices.hostDecisions(project, { host: "claude-ui", unseen: true })
    mine = () => page([contribution({ status: "active", reviewed_at: new Date().toISOString() })])
    await poll()
    expect(await ReviewNotices.hostDecisions(project, { host: "claude-ui", unseen: true, markSeen: true, deadline: Date.now() })).toEqual({ ok: false, status: "failed" })
    const later = await ReviewNotices.hostDecisions(project, { host: "claude-ui", unseen: true, markSeen: true })
    expect(later.ok && later.decisions.map((d) => d.public_id)).toEqual(["c-1"])
  })

  test("a linked person with nothing decided yet gets an empty answer, not 'not linked'", async () => {
    mine = () => page([])
    expect(await ReviewNotices.hostDecisions(project, { host: "claude-ui", unseen: true })).toEqual({ ok: true, decisions: [], waiting: 0 })
  })

  test("without a link or a sign-in it says why", async () => {
    configured = false
    expect(await ReviewNotices.hostDecisions(project, { host: "claude-ui", unseen: true, waitMs: 500 })).toMatchObject({ ok: false })
  })
})
