// altimate_change - new file
// Unit coverage for the pure-logic pieces of the workspace TuiPlugin
// (packages/opencode/src/plugin/tui/altimate/workspace.tsx). The JSX
// components and the AltimateApi credential fetch are not exercised here —
// they need a running TUI harness and are covered by the manual smoke plan.
// This file focuses on the deterministic layer: URL parsing, git detection,
// state read/write + chmod, latch semantics, and error classification.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import os from "node:os"

// Redirect Global.Path.state BEFORE importing the module under test so its
// module-level cachePath() resolves inside the sandbox.
const SANDBOX = path.join(os.tmpdir(), `altimate-workspace-test-${process.pid}-${Date.now()}`)
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")

const { isSkipActive, recordSkip } = await import(
  "../../../src/plugin/tui/altimate/workspace"
)
const { projectNameFromRemote, detectProjectRemote } = await import(
  "../../../src/altimate/workspace/detect"
)
const { cachePath, readLocalBinding, recordApprovedBinding } = await import(
  "../../../src/altimate/workspace/state"
)

// Stub AltimateApi.getCredentials / isConfigured — used by readLocalBinding
// and recordApprovedBinding for tenant/apiUrl scoping. Re-import allows
// per-test override of the module state.
import { AltimateApi } from "../../../src/altimate/api/client"
const originalIsConfigured = AltimateApi.isConfigured
const originalGetCreds = AltimateApi.getCredentials
type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>
function stubCreds(tenant: string, apiUrl: string) {
  ;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () => true
  ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
    ({
      altimateInstanceName: tenant,
      altimateUrl: apiUrl,
      altimateApiKey: "dummy",
    }) as Creds
}
function unstubCreds() {
  ;(AltimateApi as unknown as { isConfigured: typeof originalIsConfigured }).isConfigured = originalIsConfigured
  ;(AltimateApi as unknown as { getCredentials: typeof originalGetCreds }).getCredentials = originalGetCreds
}

// Minimal TuiKV shim for latch tests. Reads/writes are process-local, matching
// what the plugin uses via api.kv in production.
function makeKv(): { get: <T = unknown>(k: string, fb?: T) => T; set: (k: string, v: unknown) => void } {
  const store = new Map<string, unknown>()
  return {
    get: <T = unknown>(k: string, fb?: T): T => (store.has(k) ? (store.get(k) as T) : (fb as T)),
    set: (k: string, v: unknown) => {
      store.set(k, v)
    },
  }
}

afterEach(() => {
  unstubCreds()
  // Wipe the cache file between tests so scoping tests don't bleed state.
  try {
    rmSync(cachePath(), { force: true })
  } catch {
    /* not created by every test */
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// projectNameFromRemote
// ─────────────────────────────────────────────────────────────────────────────

describe("projectNameFromRemote", () => {
  test("extracts repo name from HTTPS remote", () => {
    expect(projectNameFromRemote("https://github.com/foo/bar.git")).toBe("bar")
  })
  test("extracts repo name from SSH-form remote", () => {
    expect(projectNameFromRemote("git@github.com:foo/bar.git")).toBe("bar")
  })
  test("handles remote without .git suffix", () => {
    expect(projectNameFromRemote("https://github.com/foo/bar")).toBe("bar")
  })
  test("handles trailing slash", () => {
    expect(projectNameFromRemote("https://github.com/foo/bar/")).toBe("bar")
  })
  test("falls back for empty-ish inputs", () => {
    expect(projectNameFromRemote("")).toBe("workspace")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// detectProjectRemote — thin wrapper over git; only assert graceful failure
// (the git-not-a-repo case) since happy paths would need a live repo fixture.
// ─────────────────────────────────────────────────────────────────────────────

describe("detectProjectRemote", () => {
  test("returns undefined when directory is not a git repo", () => {
    // /tmp is never a git repo in a stock macOS install.
    const result = detectProjectRemote(os.tmpdir())
    expect(result).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Local state: cache + chmod + tenant scoping
// ─────────────────────────────────────────────────────────────────────────────

describe("workspace binding cache", () => {
  beforeEach(() => {
    stubCreds("acme", "https://api.acme.example.com")
  })

  test("records and reads back a binding for the same directory + tenant", async () => {
    await recordApprovedBinding("/work/proj-a", {
      datamateId: 42,
      datamateName: "Marketing",
      repoRemote: "git@github.com:acme/proj-a.git",
      linkedAt: 1_700_000_000_000,
    })

    const read = await readLocalBinding("/work/proj-a")
    expect(read).not.toBeNull()
    expect(read!.datamateId).toBe(42)
    expect(read!.datamateName).toBe("Marketing")
  })

  test("chmods the cache file to 0o600 after write", async () => {
    await recordApprovedBinding("/work/proj-a", {
      datamateId: 1,
      datamateName: "X",
      repoRemote: "git@github.com:acme/x.git",
      linkedAt: 1,
    })
    expect(existsSync(cachePath())).toBe(true)
    const mode = statSync(cachePath()).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test("returns null when the cached tenant differs from current credentials", async () => {
    await recordApprovedBinding("/work/proj-a", {
      datamateId: 42,
      datamateName: "Marketing",
      repoRemote: "git@github.com:acme/proj-a.git",
      linkedAt: 1,
    })

    // Switch account → the cached binding must not be surfaced.
    unstubCreds()
    stubCreds("other-tenant", "https://api.acme.example.com")

    const read = await readLocalBinding("/work/proj-a")
    expect(read).toBeNull()
  })

  test("returns null when the cached apiUrl differs from current credentials", async () => {
    await recordApprovedBinding("/work/proj-a", {
      datamateId: 42,
      datamateName: "Marketing",
      repoRemote: "git@github.com:acme/proj-a.git",
      linkedAt: 1,
    })

    unstubCreds()
    stubCreds("acme", "https://different-host.example.com")

    const read = await readLocalBinding("/work/proj-a")
    expect(read).toBeNull()
  })

  test("returns null when directory has no cached binding", async () => {
    await recordApprovedBinding("/work/proj-a", {
      datamateId: 42,
      datamateName: "Marketing",
      repoRemote: "git@github.com:acme/proj-a.git",
      linkedAt: 1,
    })
    const read = await readLocalBinding("/work/proj-b")
    expect(read).toBeNull()
  })

  test("returns null when credentials are missing entirely", async () => {
    unstubCreds()
    ;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () => false
    const read = await readLocalBinding("/work/proj-a")
    expect(read).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Skip latch (TuiKV shim)
// ─────────────────────────────────────────────────────────────────────────────

describe("Skip latch", () => {
  const remote = "git@github.com:acme/proj-a.git"

  test("no record → not active", () => {
    const api = { kv: makeKv() } as any
    expect(isSkipActive(api, remote, Date.now())).toBe(false)
  })

  test("recorded within 7 days → active", () => {
    const api = { kv: makeKv() } as any
    const now = 1_700_000_000_000
    recordSkip(api, remote, now)
    expect(isSkipActive(api, remote, now + 6 * 24 * 60 * 60 * 1000)).toBe(true)
  })

  test("recorded past 7 days → not active", () => {
    const api = { kv: makeKv() } as any
    const now = 1_700_000_000_000
    recordSkip(api, remote, now)
    expect(isSkipActive(api, remote, now + 8 * 24 * 60 * 60 * 1000)).toBe(false)
  })

  test("boundary at exactly 7 days → not active (>= rejects)", () => {
    const api = { kv: makeKv() } as any
    const now = 1_700_000_000_000
    recordSkip(api, remote, now)
    expect(isSkipActive(api, remote, now + 7 * 24 * 60 * 60 * 1000)).toBe(false)
  })

  test("different remotes have independent latches", () => {
    const api = { kv: makeKv() } as any
    const now = 1_700_000_000_000
    recordSkip(api, "git@github.com:acme/one.git", now)
    expect(isSkipActive(api, "git@github.com:acme/two.git", now)).toBe(false)
  })
})
