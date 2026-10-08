// altimate_change - new file
//
// `/altimate/workspace/{refresh,sync}`: the `/workspace` menu's Refresh and Sync for the IDE
// extension. These cover the ROUTE only — the flag gate, argument passthrough and report shape —
// with `Manage` stubbed; the operations themselves are covered by test/altimate/workspace/manage.test.ts.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Server } from "../../src/server/server"
import * as Manage from "../../src/altimate/workspace/manage"
import * as State from "../../src/altimate/workspace/state"
import * as Starter from "../../src/altimate/workspace/starter"
import { Session } from "../../src/session"
import { NotFoundError } from "../../src/storage/db"
import { resetDatabase } from "./db"
import { disposeAllInstances } from "../fixture/fixture"

const ORIGINAL_FLAG = process.env.ALTIMATE_DISABLE_WORKSPACE
let spies: Array<{ mockRestore: () => void }> = []

function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return Server.Default().request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  delete process.env.ALTIMATE_DISABLE_WORKSPACE
})

afterEach(async () => {
  for (const spy of spies) spy.mockRestore()
  spies = []
  if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
  else process.env.ALTIMATE_DISABLE_WORKSPACE = ORIGINAL_FLAG
  await disposeAllInstances()
  await resetDatabase()
})

describe("POST /altimate/workspace/refresh", () => {
  test("returns the refresh report and passes the session through", async () => {
    spies.push(spyOn(Session, "get").mockResolvedValue({ directory: process.cwd() } as never))
    const refresh = spyOn(Manage, "refresh").mockResolvedValue({
      skillsChanged: true,
      skillsSkipped: [{ skill: "billing", reason: "it could not be downloaded" }],
      memory: { ok: true, status: "loaded", count: 4 },
      errors: [],
    })
    spies.push(refresh)

    const response = await post("/altimate/workspace/refresh", { sessionID: "ses_123" })
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.skillsChanged).toBe(true)
    // Non-empty on purpose: the IDE needs every skipped skill, so a route that
    // dropped the field would otherwise still pass.
    expect(body.skillsSkipped).toEqual([{ skill: "billing", reason: "it could not be downloaded" }])
    expect(body.errors).toEqual([])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh.mock.calls[0][1]).toBe("ses_123")
  })

  test("refuses a session that belongs to another project directory", async () => {
    spies.push(spyOn(Session, "get").mockResolvedValue({ directory: "/somewhere/else" } as never))
    const refresh = spyOn(Manage, "refresh")
    spies.push(refresh)

    const response = await post("/altimate/workspace/refresh", { sessionID: "ses_123" })
    expect(response.status).toBe(400)
    expect(refresh).not.toHaveBeenCalled()
  })

  test("reports a failed session lookup as a 500, not as a bad sessionID", async () => {
    spies.push(spyOn(Session, "get").mockRejectedValue(new Error("database is locked")))
    const refresh = spyOn(Manage, "refresh")
    spies.push(refresh)

    const response = await post("/altimate/workspace/refresh", { sessionID: "ses_123" })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, error: "database is locked" })
    expect(refresh).not.toHaveBeenCalled()
  })

  test("an arbitrary session id is looked up for real and answered, never escaping the route", async () => {
    const refresh = spyOn(Manage, "refresh")
    spies.push(refresh)

    const response = await post("/altimate/workspace/refresh", { sessionID: "not-a-session" })
    expect(response.status).toBe(404)
    expect(((await response.json()) as Record<string, unknown>).ok).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
  })

  test("answers 404 for a session that does not exist", async () => {
    spies.push(spyOn(Session, "get").mockRejectedValue(new NotFoundError({ message: "Session not found" })))
    const refresh = spyOn(Manage, "refresh")
    spies.push(refresh)

    expect((await post("/altimate/workspace/refresh", { sessionID: "ses_123" })).status).toBe(404)
    expect(refresh).not.toHaveBeenCalled()
  })

  test("works without a body, leaving the memory overlay to reload on the next turn", async () => {
    const refresh = spyOn(Manage, "refresh").mockResolvedValue({
      skillsChanged: false,
      skillsSkipped: [],
      memoryInvalidated: true,
      errors: [],
    })
    spies.push(refresh)

    const response = await post("/altimate/workspace/refresh")
    expect(response.status).toBe(200)
    expect(((await response.json()) as Record<string, unknown>).memoryInvalidated).toBe(true)
    expect(refresh.mock.calls[0][1]).toBeUndefined()
  })

  test("rejects a session id that is present but not a non-empty string", async () => {
    const refresh = spyOn(Manage, "refresh")
    spies.push(refresh)

    // Falling back to "no session" would widen the refresh to every session's memory overlay.
    expect((await post("/altimate/workspace/refresh", { sessionID: 42 })).status).toBe(400)
    expect((await post("/altimate/workspace/refresh", { sessionID: "" })).status).toBe(400)
    expect(refresh).not.toHaveBeenCalled()
  })

  test("is refused under the kill switch, without touching the snapshot", async () => {
    process.env.ALTIMATE_DISABLE_WORKSPACE = "1"
    const refresh = spyOn(Manage, "refresh")
    spies.push(refresh)

    const response = await post("/altimate/workspace/refresh")
    expect(response.status).toBe(409)
    // The refusal names the switch, so an operator knows what to unset.
    expect(await response.json()).toEqual({
      ok: false,
      error: "Workspaces are turned off on this server because ALTIMATE_DISABLE_WORKSPACE is set.",
    })
    expect(refresh).not.toHaveBeenCalled()
  })

  test("reports a thrown error as a 500 with its message", async () => {
    spies.push(spyOn(Manage, "refresh").mockRejectedValue(new Error("boom")))

    const response = await post("/altimate/workspace/refresh")
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, error: "boom" })
  })

  test("rejects malformed JSON rather than resetting every session's memory", async () => {
    const refresh = spyOn(Manage, "refresh")
    spies.push(refresh)

    const response = await post("/altimate/workspace/refresh", "{not json")
    expect(response.status).toBe(400)
    expect(((await response.json()) as Record<string, unknown>).ok).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
  })

  test("rejects a body that is not an object", async () => {
    const refresh = spyOn(Manage, "refresh")
    spies.push(refresh)

    expect((await post("/altimate/workspace/refresh", "[]")).status).toBe(400)
    expect((await post("/altimate/workspace/refresh", "null")).status).toBe(400)
    expect(refresh).not.toHaveBeenCalled()
  })

  test("refuses a browser origin on an unsecured server", async () => {
    const refresh = spyOn(Manage, "refresh")
    spies.push(refresh)

    const response = await post("/altimate/workspace/refresh", {}, { origin: "https://evil.test" })
    expect(response.status).toBe(403)
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe("POST /altimate/workspace/sync", () => {
  test("returns the sync report", async () => {
    const report: Manage.SyncReport = { gated: false, sent: 2, failed: 0, skipped: 5, declined: 0, deferred: 1 }
    spies.push(spyOn(Manage, "sync").mockResolvedValue(report))

    const response = await post("/altimate/workspace/sync")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, ...report })
  })

  test("passes a gated sweep through with its reason", async () => {
    spies.push(
      spyOn(Manage, "sync").mockResolvedValue({
        gated: true,
        gatedBecause: "memory-off",
        sent: 0,
        failed: 0,
        skipped: 0,
        declined: 0,
        deferred: 0,
      }),
    )

    const body = (await (await post("/altimate/workspace/sync")).json()) as Record<string, unknown>
    expect(body.gated).toBe(true)
    expect(body.gatedBecause).toBe("memory-off")
  })

  test("is refused outside the workspace pilot", async () => {
    process.env.ALTIMATE_DISABLE_WORKSPACE = "1"
    const sync = spyOn(Manage, "sync")
    spies.push(sync)

    expect((await post("/altimate/workspace/sync")).status).toBe(409)
    expect(sync).not.toHaveBeenCalled()
  })

  test("reports a thrown error as a 500 with its message", async () => {
    spies.push(spyOn(Manage, "sync").mockRejectedValue(new Error("boom")))

    const response = await post("/altimate/workspace/sync")
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, error: "boom" })
  })

  test("refuses a browser origin on an unsecured server", async () => {
    const sync = spyOn(Manage, "sync")
    spies.push(sync)

    expect((await post("/altimate/workspace/sync", undefined, { origin: "https://evil.test" })).status).toBe(403)
    expect(sync).not.toHaveBeenCalled()
  })
})

describe("GET /altimate/workspace/starter", () => {
  const get = (headers: Record<string, string> = {}) =>
    Server.Default().request("/altimate/workspace/starter", { method: "GET", headers })
  const binding = { datamateId: 7, datamateName: "acme", repoRemote: null, projectPath: "/p", linkedAt: 1 }
  const starter: Starter.Starter = { workspace: "acme", lines: ["Skills (1): a"], summary: "1 skill", prompts: ["Do it"], text: "t" }

  test("a linked project gets its starter, built for this directory and binding", async () => {
    spies.push(spyOn(State, "resolveBindingOutcome").mockResolvedValue({ status: "bound", binding }))
    const build = spyOn(Starter, "starterFor").mockResolvedValue(starter)
    spies.push(build)

    const response = await get()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, linked: true, starter })
    expect(build).toHaveBeenCalledTimes(1)
    expect(build.mock.calls[0][1]).toEqual(binding)
  })

  test("an unlinked project is answered as such, with no starter", async () => {
    spies.push(spyOn(State, "resolveBindingOutcome").mockResolvedValue({ status: "unbound" }))
    const build = spyOn(Starter, "starterFor")
    spies.push(build)

    expect(await (await get()).json()).toEqual({ ok: true, linked: false })
    expect(build).not.toHaveBeenCalled()
  })

  // A link served from the cache because the service could not be asked may since have changed; the prompt
  // skips the workspace's contents for it, and so does the starter.
  for (const outcome of [{ status: "bound", binding, stale: true }, { status: "unknown" }] as const) {
    test(`an unconfirmed link (${"stale" in outcome ? "stale" : outcome.status}) is a 503, not a starter`, async () => {
      spies.push(spyOn(State, "resolveBindingOutcome").mockResolvedValue(outcome as State.BindingOutcome))
      const build = spyOn(Starter, "starterFor")
      spies.push(build)

      expect((await get()).status).toBe(503)
      expect(build).not.toHaveBeenCalled()
    })
  }

  test("is refused outside the workspace pilot", async () => {
    process.env.ALTIMATE_DISABLE_WORKSPACE = "1"
    const resolve = spyOn(State, "resolveBindingOutcome")
    spies.push(resolve)

    expect((await get()).status).toBe(409)
    expect(resolve).not.toHaveBeenCalled()
  })

  test("refuses a browser origin on an unsecured server", async () => {
    const resolve = spyOn(State, "resolveBindingOutcome")
    spies.push(resolve)

    expect((await get({ origin: "https://evil.test" })).status).toBe(403)
    expect(resolve).not.toHaveBeenCalled()
  })

  test("reports a thrown error as a 500 with its message", async () => {
    spies.push(spyOn(State, "resolveBindingOutcome").mockRejectedValue(new Error("boom")))

    const response = await get()
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, error: "boom" })
  })
})

describe("origin policy with a server password set", () => {
  // The password flag is read once at module load, so the policy is exercised directly with one.
  test("lets a native client (no Origin) and this server's own page through", () => {
    expect(Server.workspaceRouteRefusal(undefined, "127.0.0.1:4096", "pw")).toBeUndefined()
    expect(Server.workspaceRouteRefusal("http://127.0.0.1:4096", "127.0.0.1:4096", "pw")).toBeUndefined()
  })

  test("refuses another origin even though Basic credentials would be replayed", () => {
    expect(Server.workspaceRouteRefusal("https://evil.test", "127.0.0.1:4096", "pw")?.status).toBe(403)
  })

  test("refuses every origin when no password is set", () => {
    expect(Server.workspaceRouteRefusal("http://127.0.0.1:4096", "127.0.0.1:4096", undefined)?.status).toBe(403)
    expect(Server.workspaceRouteRefusal(undefined, "127.0.0.1:4096", undefined)).toBeUndefined()
  })
})

describe("same-origin check used when a server password is set", () => {
  test("accepts this server's own pages only", () => {
    expect(Server.sameOrigin("http://127.0.0.1:4096", "127.0.0.1:4096")).toBe(true)
    expect(Server.sameOrigin("https://evil.test", "127.0.0.1:4096")).toBe(false)
    expect(Server.sameOrigin("http://127.0.0.1:9999", "127.0.0.1:4096")).toBe(false)
    expect(Server.sameOrigin("null", "127.0.0.1:4096")).toBe(false)
    expect(Server.sameOrigin("http://127.0.0.1:4096", undefined)).toBe(false)
  })
})
