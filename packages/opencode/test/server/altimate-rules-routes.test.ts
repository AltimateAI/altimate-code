// altimate_change - new file
//
// The workspace-rules routes: `/rule-proposal` (list, reply, renderer lease) and `/altimate/rules/learning`. These
// cover the ROUTES: browser-origin refusal, input validation and status mapping. What each reply does is covered by
// test/altimate/rules/rules.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Server } from "../../src/server/server"
import { RuleProposal } from "../../src/altimate/rules/proposal"
import { resetDatabase } from "./db"
import { disposeAllInstances } from "../fixture/fixture"

const ORIGINAL_FLAG = process.env.ALTIMATE_DISABLE_WORKSPACE

function request(method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}) {
  return Server.Default().request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  })
}

// The instance directory in these tests is the process's cwd (no directory header): cards are asked for it.
const draft = (text: string) => ({
  text,
  applies_to: [],
  change: "add" as const,
  origin: "explicit" as const,
  evidence: { sessions: 1 },
  topics: [],
})

beforeEach(() => {
  delete process.env.ALTIMATE_DISABLE_WORKSPACE
})

afterEach(async () => {
  RuleProposal.drop(process.cwd())
  RuleProposal.setRendererForTest(false)
  if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
  else process.env.ALTIMATE_DISABLE_WORKSPACE = ORIGINAL_FLAG
  await disposeAllInstances()
  await resetDatabase()
})

describe("rule proposal routes", () => {
  test("a browser origin is refused on every route", async () => {
    const origin = { origin: "https://evil.example", "sec-fetch-site": "cross-site" }
    for (const [method, url, body] of [
      ["GET", "/rule-proposal"],
      ["POST", "/rule-proposal/x/reply", { action: "dismiss" }],
      ["POST", "/rule-proposal/renderer", { client: "tui" }],
      ["POST", "/altimate/rules/learning", { on: true }],
    ] as const) {
      const response = await request(method, url, body, origin)
      expect([403, 409]).toContain(response.status)
      expect(await response.json()).toMatchObject({ ok: false })
    }
  })

  test("a reply is validated, and its failure codes map to HTTP statuses", async () => {
    expect((await request("POST", "/rule-proposal/x/reply", { action: "share" })).status).toBe(400)
    expect((await request("POST", "/rule-proposal/x/reply", { action: "edit", text: 3 })).status).toBe(400)
    expect((await request("POST", "/rule-proposal/x/reply", "not json")).status).toBe(400)
    const gone = await request("POST", "/rule-proposal/no-such-card/reply", { action: "dismiss" })
    expect(gone.status).toBe(404)
    expect(await gone.json()).toMatchObject({ ok: false, code: "not_open" })

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rules-routes-"))
    const card = (await RuleProposal.ask({ sessionID: "r1", root, directory: process.cwd(), learn: undefined, draft: draft("Prefix seeds with seed_.") }))!
    const unavailable = await request("POST", `/rule-proposal/${card.id}/reply`, { action: "approve" })
    expect(unavailable.status).toBe(409)
    expect(await unavailable.json()).toMatchObject({ ok: false, code: "not_available" })
    const invalid = await request("POST", `/rule-proposal/${card.id}/reply`, { action: "edit", text: "line one\nline two" })
    expect(invalid.status).toBe(422)
    expect(await invalid.json()).toMatchObject({ ok: false, code: "invalid_text" })
    const listed = await request("GET", "/rule-proposal?session=r1")
    expect(await listed.json()).toEqual([expect.objectContaining({ id: card.id })])
  })

  test("a renderer lease is validated, and attaches a renderer", async () => {
    expect(RuleProposal.rendererAttached()).toBe(false)
    expect((await request("POST", "/rule-proposal/renderer", { client: "has spaces" })).status).toBe(400)
    expect((await request("POST", "/rule-proposal/renderer", {})).status).toBe(400)
    expect(RuleProposal.rendererAttached()).toBe(false)
    const response = await request("POST", "/rule-proposal/renderer", { client: "vscode" })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, renew_ms: RuleProposal.RENDERER_RENEW_MS, lease_ms: RuleProposal.RENDERER_LEASE_MS })
    expect(RuleProposal.rendererAttached()).toBe(true)
    // A lease lapses when it is not renewed.
    expect(RuleProposal.rendererAttached(Date.now() + RuleProposal.RENDERER_LEASE_MS + 1)).toBe(false)
  })

  test("the learning choice accepts only true, false or null", async () => {
    expect((await request("POST", "/altimate/rules/learning", { on: "yes" })).status).toBe(400)
    expect((await request("POST", "/altimate/rules/learning", {})).status).toBe(400)
  })
})
