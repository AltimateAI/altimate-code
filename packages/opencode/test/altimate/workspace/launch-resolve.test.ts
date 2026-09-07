// altimate_change - new file
//
// Unit coverage for the --workspace launch resolver. Exercises the pure
// name-match helper directly, and the wired-up resolveWorkspaceForLaunch
// with the local binding cache + ALTIMATE_WORKSPACE flag stubbed. Does
// NOT exercise the tui.ts wiring or the worker subprocess env-var pickup
// — those are integration territory.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import os from "node:os"

// Redirect Global.Path.state BEFORE importing state.ts so cachePath()
// resolves inside the sandbox. Same isolation pattern as workspace.test.ts.
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
const SANDBOX = path.join(
  os.tmpdir(),
  `altimate-launch-resolve-test-${process.pid}-${Date.now()}`,
)
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")
afterAll(() => {
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

const { nameMatches, resolveWorkspaceForLaunch } = await import(
  "../../../src/altimate/workspace/launch-resolve"
)
const { getResolvedWorkspaceId, setResolvedWorkspaceId } = await import(
  "../../../src/altimate/workspace/session-context"
)
const { recordApprovedBinding, cachePath } = await import(
  "../../../src/altimate/workspace/state"
)

// Stub credentials so state.ts's tenant/apiUrl scoping is deterministic.
import { AltimateApi } from "../../../src/altimate/api/client"
type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>
const originalIsConfigured = AltimateApi.isConfigured
const originalGetCreds = AltimateApi.getCredentials
function stubCreds() {
  ;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () =>
    true
  ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials =
    async () =>
      ({
        altimateInstanceName: "altimate2",
        altimateUrl: "http://localhost:5001",
        altimateApiKey: "dummy",
      }) as Creds
}
function unstubCreds() {
  ;(AltimateApi as unknown as { isConfigured: typeof originalIsConfigured }).isConfigured =
    originalIsConfigured
  ;(AltimateApi as unknown as { getCredentials: typeof originalGetCreds }).getCredentials =
    originalGetCreds
}

beforeEach(() => {
  stubCreds()
  setResolvedWorkspaceId(null)
  // Clean cache file between tests so state doesn't leak across cases.
  try {
    rmSync(cachePath(), { force: true })
  } catch {
    /* best effort */
  }
  // Explicitly enable the pilot flag for every test. Restored per-test in
  // afterEach so the "flag off" test can override.
  process.env.ALTIMATE_WORKSPACE = "1"
})
afterEach(() => {
  unstubCreds()
  setResolvedWorkspaceId(null)
  delete process.env.ALTIMATE_WORKSPACE
})

describe("nameMatches", () => {
  const binding = {
    datamateId: 42,
    datamateName: "Growth",
    repoRemote: "ssh://git@github.com/foo/bar",
    projectPath: "/tmp/foo",
    linkedAt: 0,
  }

  test("exact match", () => {
    expect(nameMatches("Growth", binding)).toBe(true)
  })
  test("case-insensitive match", () => {
    expect(nameMatches("GROWTH", binding)).toBe(true)
    expect(nameMatches("growth", binding)).toBe(true)
  })
  test("whitespace-trimmed match", () => {
    expect(nameMatches("  Growth  ", binding)).toBe(true)
  })
  test("mismatch", () => {
    expect(nameMatches("Other", binding)).toBe(false)
  })
  test("substring is not a hit (no fuzzy match)", () => {
    expect(nameMatches("Grow", binding)).toBe(false)
    expect(nameMatches("Growthy", binding)).toBe(false)
  })
})

describe("resolveWorkspaceForLaunch", () => {
  const DIRECTORY = path.join(SANDBOX, "project")

  beforeEach(async () => {
    mkdirSync(DIRECTORY, { recursive: true })
    await recordApprovedBinding(DIRECTORY, {
      datamateId: 42,
      datamateName: "Growth",
      repoRemote: null,
      projectPath: DIRECTORY,
      linkedAt: 0,
    })
  })

  test("no --workspace arg → no env var set, no-op", async () => {
    await resolveWorkspaceForLaunch(DIRECTORY, undefined)
    expect(getResolvedWorkspaceId()).toBeNull()
  })

  test("ALTIMATE_WORKSPACE flag off → no env var set even when --workspace given", async () => {
    delete process.env.ALTIMATE_WORKSPACE
    await resolveWorkspaceForLaunch(DIRECTORY, "Growth")
    expect(getResolvedWorkspaceId()).toBeNull()
  })

  test("matching name → env var set to the binding's datamateId", async () => {
    await resolveWorkspaceForLaunch(DIRECTORY, "Growth")
    expect(getResolvedWorkspaceId()).toBe(42)
  })

  test("case-insensitive matching name → env var set", async () => {
    await resolveWorkspaceForLaunch(DIRECTORY, "growth")
    expect(getResolvedWorkspaceId()).toBe(42)
  })

  test("mismatched name → env var STILL set (attaches to linked workspace with a note per AI-8504 spec)", async () => {
    await resolveWorkspaceForLaunch(DIRECTORY, "Other")
    expect(getResolvedWorkspaceId()).toBe(42)
  })

  test("no binding for this directory → env var NOT set (fail-fast)", async () => {
    const unlinkedDir = path.join(SANDBOX, "unlinked")
    mkdirSync(unlinkedDir, { recursive: true })
    await resolveWorkspaceForLaunch(unlinkedDir, "Growth")
    expect(getResolvedWorkspaceId()).toBeNull()
  })
})

describe("session-context env-var round trip", () => {
  test("set/get/clear cycle", () => {
    setResolvedWorkspaceId(123)
    expect(getResolvedWorkspaceId()).toBe(123)
    setResolvedWorkspaceId(null)
    expect(getResolvedWorkspaceId()).toBeNull()
  })

  test("malformed env value returns null (defense against poisoned env)", () => {
    process.env.ALTIMATE_RESOLVED_WORKSPACE_ID = "not-a-number"
    expect(getResolvedWorkspaceId()).toBeNull()
    process.env.ALTIMATE_RESOLVED_WORKSPACE_ID = "0"
    expect(getResolvedWorkspaceId()).toBeNull()
    process.env.ALTIMATE_RESOLVED_WORKSPACE_ID = "-5"
    expect(getResolvedWorkspaceId()).toBeNull()
    delete process.env.ALTIMATE_RESOLVED_WORKSPACE_ID
  })
})
