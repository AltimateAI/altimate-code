// altimate_change - new file
//
// `/altimate/workspace/{refresh,sync}`: the `/workspace` menu's Refresh and Sync for the IDE
// extension. These cover the ROUTE only — the flag gate, argument passthrough and report shape —
// with `Manage` stubbed; the operations themselves are covered by test/altimate/workspace/manage.test.ts.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Server } from "../../src/server/server"
import * as Manage from "../../src/altimate/workspace/manage"
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
    const refresh = spyOn(Manage, "refresh").mockResolvedValue({
      skillsChanged: true,
      memory: { ok: true, status: "reloaded", blocks: 4 } as unknown as Manage.RefreshReport["memory"],
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

  test("ignores a session id that is not a string", async () => {
    const refresh = spyOn(Manage, "refresh").mockResolvedValue({ skillsChanged: false, errors: [] })
    spies.push(refresh)

    await post("/altimate/workspace/refresh", { sessionID: 42 })
    expect(refresh.mock.calls[0][1]).toBeUndefined()
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
