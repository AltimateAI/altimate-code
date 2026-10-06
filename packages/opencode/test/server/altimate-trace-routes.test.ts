// altimate_change - new file
//
// `GET /altimate/trace` and `GET /altimate/trace/:sessionID/view`: the TUI's `/traces` for the IDE
// extension. Traces are real files in a temp `tracing.dir`, so these also cover that the routes
// honor the configured directory.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Server } from "../../src/server/server"
import { Config } from "../../src/config/config"
import { resetDatabase } from "./db"
import { disposeAllInstances } from "../fixture/fixture"

let dir: string
let spies: Array<{ mockRestore: () => void }> = []

function get(urlPath: string, headers: Record<string, string> = {}) {
  return Server.Default().request(urlPath, { method: "GET", headers })
}

async function writeTrace(sessionId: string, startedAt: string, metadata: Record<string, unknown> = {}) {
  const trace = {
    version: 2,
    traceId: `trace-${sessionId}`,
    sessionId,
    startedAt,
    metadata,
    spans: [],
    summary: {
      totalTokens: 1200,
      totalCost: 0.0123,
      totalToolCalls: 3,
      totalGenerations: 2,
      duration: 4500,
      status: "completed",
      tokens: { input: 1000, output: 200, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    },
  }
  await fs.writeFile(path.join(dir, `${sessionId}.json`), JSON.stringify(trace))
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "altimate-trace-routes-"))
  spies.push(spyOn(Config, "get").mockResolvedValue({ tracing: { dir } } as never))
})

afterEach(async () => {
  for (const spy of spies) spy.mockRestore()
  spies = []
  await fs.rm(dir, { recursive: true, force: true })
  await disposeAllInstances()
  await resetDatabase()
})

describe("GET /altimate/trace", () => {
  test("lists traces newest first with their summary", async () => {
    await writeTrace("ses_old", "2026-10-01T10:00:00.000Z", { title: "Old session" })
    await writeTrace("ses_new", "2026-10-02T10:00:00.000Z", { prompt: "Explain the orders model" })

    const response = await get("/altimate/trace")
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, any>
    expect(body.ok).toBe(true)
    expect(body.total).toBe(2)
    expect(body.traces.map((t: { sessionID: string }) => t.sessionID)).toEqual(["ses_new", "ses_old"])
    // Title falls back to the prompt when the session has no title.
    expect(body.traces[0]).toEqual({
      sessionID: "ses_new",
      title: "Explain the orders model",
      startedAt: "2026-10-02T10:00:00.000Z",
      status: "completed",
      duration: 4500,
      totalTokens: 1200,
      totalCost: 0.0123,
      totalToolCalls: 3,
    })
    expect(body.traces[1].title).toBe("Old session")
  })

  test("pages with offset and limit", async () => {
    await writeTrace("ses_a", "2026-10-01T10:00:00.000Z")
    await writeTrace("ses_b", "2026-10-02T10:00:00.000Z")
    await writeTrace("ses_c", "2026-10-03T10:00:00.000Z")

    const body = (await (await get("/altimate/trace?offset=1&limit=1")).json()) as Record<string, any>
    expect(body.total).toBe(3)
    expect(body.offset).toBe(1)
    expect(body.limit).toBe(1)
    expect(body.traces.map((t: { sessionID: string }) => t.sessionID)).toEqual(["ses_b"])
  })

  test("returns an empty page when there are no traces", async () => {
    const body = (await (await get("/altimate/trace")).json()) as Record<string, any>
    expect(body).toEqual({ ok: true, total: 0, offset: 0, limit: 50, traces: [] })
  })

  test("refuses a cross-site browser request", async () => {
    await writeTrace("ses_a", "2026-10-01T10:00:00.000Z")
    const response = await get("/altimate/trace", { "sec-fetch-site": "cross-site" })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ ok: false, error: "Traces cannot be run from another site." })
  })
})

describe("GET /altimate/trace/:sessionID/view", () => {
  test("serves the viewer page for the trace", async () => {
    await writeTrace("ses_view", "2026-10-01T10:00:00.000Z", { title: "Viewer session" })

    const response = await get("/altimate/trace/ses_view/view")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
    const html = await response.text()
    expect(html).toContain("<title>Altimate Trace</title>")
    expect(html).toContain("Viewer session")
    // The IDE's editor tab has no shareable URL, so the viewer leaves Copy Link out.
    expect(html).not.toContain('id="btn-copy-link"')
    expect(html).toContain('id="btn-share"')
  })

  test("returns 404 for an unknown trace", async () => {
    const response = await get("/altimate/trace/ses_missing/view")
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ ok: false, error: "Trace not found: ses_missing" })
  })

  test("rejects a session ID that could name a path outside the traces dir", async () => {
    const response = await get("/altimate/trace/..%2Fsecrets/view")
    expect(response.status).toBe(400)
  })

  test("refuses a browser origin on an unsecured server", async () => {
    await writeTrace("ses_view", "2026-10-01T10:00:00.000Z")
    const response = await get("/altimate/trace/ses_view/view", { origin: "https://evil.example" })
    expect(response.status).toBe(403)
  })
})
