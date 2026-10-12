// altimate_change - new file
//
// Regression for #1349: a publish name conflict said "in this workspace", but
// skill names are unique per creator across the whole ACCOUNT — the conflicting
// skill usually lives in a different workspace, so the user looked in the wrong
// place. The message must name the account scope, and the owning workspace when
// the 409 detail carries it.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
const SANDBOX = path.join(os.tmpdir(), `altimate-publish-scope-${process.pid}-${Date.now()}`)
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")

const { AltimateApi } = await import("../../../src/altimate/api/client")
const { SkillNameConflictError, publishSkill } = await import("../../../src/altimate/workspace/skill-publish")
const { recordApprovedBinding } = await import("../../../src/altimate/workspace/state")

const originalIsConfigured = AltimateApi.isConfigured
const originalGetCreds = AltimateApi.getCredentials
const originalFetch = globalThis.fetch
;(AltimateApi as any).isConfigured = async () => true
;(AltimateApi as any).getCredentials = async () => ({
  altimateInstanceName: "acme",
  altimateUrl: "https://api.example.com",
  altimateApiKey: "k",
})

afterAll(() => {
  ;(AltimateApi as any).isConfigured = originalIsConfigured
  ;(AltimateApi as any).getCredentials = originalGetCreds
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  rmSync(SANDBOX, { recursive: true, force: true })
})

let conflictDetail: unknown = "You already have a skill named 'team-greeting'"
let project = ""
let skillDir = ""

beforeEach(async () => {
  conflictDetail = "You already have a skill named 'team-greeting'"
  project = mkdtempSync(path.join(SANDBOX, "proj-"))
  skillDir = path.join(project, "skills", "team-greeting")
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: team-greeting\n---\nhi\n")
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url
    const method = (init?.method ?? "GET").toUpperCase()
    if (method === "GET" && url.endsWith("/users/me")) return json({ id: 7 })
    if (method === "GET" && url.endsWith("/datamates/"))
      return json({ datamates: [{ id: 14, name: "quick", memory_enabled: false, user_id: 7 }] })
    if (method === "POST" && /\/skills\/?$/.test(url)) return json({ detail: conflictDetail }, 409)
    return json({ skills: [], items: [] })
  }) as typeof fetch
  // Project B: freshly linked to an empty workspace 14.
  await recordApprovedBinding(
    project,
    { datamateId: 14, datamateName: "quick", repoRemote: null, projectPath: project, linkedAt: Date.now() } as never,
    { awaitBackfill: true },
  )
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

const publish = () =>
  publishSkill({ projectDirectory: project, skillDirectory: skillDir, name: "team-greeting", description: "d" })

test("a create conflict names the account, not the linked workspace", async () => {
  const err = await publish().catch((e) => e)

  expect(err).toBeInstanceOf(SkillNameConflictError)
  expect(String(err)).not.toContain("in this workspace")
  expect(String(err)).toContain('"team-greeting" already exists in your account')
  expect(String(err)).toContain("another project or machine")
})

test("a create conflict names the owning workspace when the 409 detail carries it", async () => {
  conflictDetail = { message: "exists", existing_datamate_id: 11, existing_datamate_name: "analytics" }

  const err = await publish().catch((e) => e)

  expect(err).toBeInstanceOf(SkillNameConflictError)
  expect(String(err)).toContain('in workspace "analytics" (id 11)')
})

test("a rename conflict also names the account scope", () => {
  const err = new SkillNameConflictError("release", "rename", { existing_datamate_id: 11 })

  expect(err.message).not.toContain("in this workspace")
  expect(err.message).toContain("in your account (in workspace id 11)")
  expect(err.message).toContain("Choose a different name")
})
