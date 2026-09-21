// altimate_change - new file
//
// The async half of the workspace identity section: what `systemSection()` — the
// call `prompt.ts` makes on every step — renders for a real binding cache, a real
// instance context, and the pilot flag in each position. The pure `render()` is
// covered in identity.test.ts; this file is about the gate and the plumbing.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import os from "node:os"

// Global.Path.state resolves at module load, so the sandbox must exist first.
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
const ORIGINAL_PILOT = process.env.ALTIMATE_WORKSPACE
const SANDBOX = path.join(os.tmpdir(), `altimate-identity-${process.pid}-${Date.now()}`)
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")
process.env.ALTIMATE_WORKSPACE = "1"

afterAll(() => {
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  if (ORIGINAL_PILOT === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_PILOT
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

const { AltimateApi } = await import("../../../src/altimate/api/client")
const { systemSection } = await import("../../../src/altimate/workspace/identity")
const { recordApprovedBinding } = await import("../../../src/altimate/workspace/state")
const { Instance } = await import("../../../src/project/instance")

type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>
const originalIsConfigured = AltimateApi.isConfigured
const originalGetCreds = AltimateApi.getCredentials
;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () => true
;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
  ({ altimateInstanceName: "acme", altimateUrl: "https://api.example.com", altimateApiKey: "k" }) as Creds
afterAll(() => {
  ;(AltimateApi as unknown as { isConfigured: typeof originalIsConfigured }).isConfigured = originalIsConfigured
  ;(AltimateApi as unknown as { getCredentials: typeof originalGetCreds }).getCredentials = originalGetCreds
})

const originalFetch = globalThis.fetch
let projectDir = ""

beforeEach(() => {
  process.env.ALTIMATE_WORKSPACE = "1"
  projectDir = mkdtempSync(path.join(SANDBOX, "proj-"))
  // Nothing here should need the network; anything that asks gets an empty 200.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

const inProject = <T>(fn: () => Promise<T>) => Instance.provide({ directory: projectDir, fn })

describe("systemSection", () => {
  test("names the linked workspace for a bound project", async () => {
    await recordApprovedBinding(
      projectDir,
      { datamateId: 42, datamateName: "Growth", repoRemote: null, projectPath: projectDir, linkedAt: Date.now() } as never,
      { awaitBackfill: true },
    )
    const out = await inProject(systemSection)
    expect(out).toContain("## Altimate Workspace")
    expect(out).toContain('linked to Altimate Workspace "Growth" (id 42)')
    expect(out).toContain("never substitute")
  })

  test("renders nothing when the workspace pilot is off", async () => {
    // A user outside the pilot has no Altimate Workspace to be linked to, and
    // must not be told every turn that none is linked and how to link one.
    await recordApprovedBinding(
      projectDir,
      { datamateId: 42, datamateName: "Growth", repoRemote: null, projectPath: projectDir, linkedAt: Date.now() } as never,
      { awaitBackfill: true },
    )
    delete process.env.ALTIMATE_WORKSPACE
    expect(await inProject(systemSection)).toBe("")
  })

  test("says none is linked, and how to link one, for an unlinked project", async () => {
    // A confirmed miss: the server answers 404 for this project, which is the
    // definite "no" the unbound copy needs.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    const out = await inProject(systemSection)
    expect(out).toContain("No Altimate Workspace is linked to this project")
    expect(out).toContain("altimate-code link")
  })

  test("asserts nothing either way when the link cannot be verified", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    const out = await inProject(systemSection)
    expect(out).toContain("could not be verified")
    expect(out).not.toContain("No Altimate Workspace is linked")
    expect(out).not.toContain("linked to Altimate Workspace \"")
  })

  test("degrades to the unverified copy outside an instance context rather than throwing", async () => {
    // `Instance.directory` throws outside a context; prompt assembly must not.
    const out = await systemSection()
    expect(out).toContain("could not be verified")
  })
})
