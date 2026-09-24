// altimate_change - new file
//
// `/altimate/workspace/{refresh,sync}`: the `/workspace` menu's Refresh and Sync for the IDE
// extension. These cover the ROUTE only — the flag gate, argument passthrough and report shape —
// with `Manage` stubbed; the operations themselves are covered by test/altimate/workspace/manage.test.ts.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Server } from "../../src/server/server"
import * as Manage from "../../src/altimate/workspace/manage"
import { Session } from "../../src/session"
import { NotFoundError } from "../../src/storage/db"
import { resetDatabase } from "./db"
import { disposeAllInstances } from "../fixture/fixture"

const ORIGINAL_FLAG = process.env.ALTIMATE_WORKSPACE
let spies: Array<{ mockRestore: () => void }> = []

function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return Server.Default().request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  process.env.ALTIMATE_WORKSPACE = "1"
})

afterEach(async () => {
  for (const spy of spies) spy.mockRestore()
  spies = []
  if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_FLAG
  await disposeAllInstances()
  await resetDatabase()
})

describe("POST /altimate/workspace/refresh", () => {
  test("returns the refresh report and passes the session through", async () => {
    spies.push(spyOn(Session, "get").mockResolvedValue({ directory: process.cwd() } as never))
    const refresh = spyOn(Manage, "refresh").mockResolvedValue({
      skillsChanged: true,
      memory: { ok: true, status: "loaded", count: 4 },
      errors: [],
    })
    spies.push(refresh)

    const response = await post("/altimate/workspace/refresh", { sessionID: "ses_123" })
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.skillsChanged).toBe(true)
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

  test("is refused outside the workspace pilot, without touching the snapshot", async () => {
    delete process.env.ALTIMATE_WORKSPACE
    const refresh = spyOn(Manage, "refresh")
    spies.push(refresh)

    const response = await post("/altimate/workspace/refresh")
    expect(response.status).toBe(409)
    expect(((await response.json()) as Record<string, unknown>).ok).toBe(false)
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
    delete process.env.ALTIMATE_WORKSPACE
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
