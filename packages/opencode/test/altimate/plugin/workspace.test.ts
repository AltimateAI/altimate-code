// altimate_change - new file
// Unit coverage for the pure-logic pieces of the workspace TuiPlugin
// (packages/opencode/src/plugin/tui/altimate/workspace.tsx). The JSX
// components and the AltimateApi credential fetch are not exercised here —
// they need a running TUI harness and are covered by the manual smoke plan.
// This file focuses on the deterministic layer: URL parsing, git detection,
// state read/write + chmod, latch semantics, and error classification.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"

// Redirect Global.Path.state BEFORE importing the module under test so its
// module-level cachePath() resolves inside the sandbox. Restore the original
// XDG_STATE_HOME in afterAll so parallel test files aren't polluted by our
// process-scoped tempdir. (CR round 2 — test isolation.)
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
const SANDBOX = path.join(os.tmpdir(), `altimate-workspace-test-${process.pid}-${Date.now()}`)
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
    // Cubic round 3 caught that "empty dir under SANDBOX" still shares
    // ``os.tmpdir()``'s ancestor chain — if any ancestor is a git worktree,
    // ``git remote get-url`` walks up and returns that repo's remote. Set
    // ``GIT_CEILING_DIRECTORIES`` to stop the walk at SANDBOX so this test
    // is deterministic regardless of where ``os.tmpdir()`` lives on the
    // runner.
    const emptyDir = path.join(SANDBOX, `empty-${Date.now()}`)
    mkdirSync(emptyDir, { recursive: true })
    const prevCeiling = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = SANDBOX
    try {
      const result = detectProjectRemote(emptyDir)
      expect(result).toBeUndefined()
    } finally {
      if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = prevCeiling
    }
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
      projectPath: "/work/proj-a",
      linkedAt: 1_700_000_000_000,
    })

    const read = await readLocalBinding("/work/proj-a")
    expect(read).not.toBeNull()
    expect(read!.datamateId).toBe(42)
    expect(read!.datamateName).toBe("Marketing")
  })

  test("awaitBackfill holds the bind open until the seed has run", async () => {
    // `altimate-code link` runs in a plain yargs handler and src/index.ts calls
    // process.exit() the moment it returns, so a detached seed is killed
    // mid-flight: the bind reports success having stored nothing.
    const ORIGINAL_FLAG = process.env.ALTIMATE_WORKSPACE
    process.env.ALTIMATE_WORKSPACE = "1"
    const proj = path.join(SANDBOX, "seed-proj")
    mkdirSync(path.join(proj, ".altimate-code", "memory"), { recursive: true })
    const now = new Date().toISOString()
    writeFileSync(
      path.join(proj, ".altimate-code", "memory", "seed.md"),
      ["---", "id: seed", "scope: project", `created: ${now}`, `updated: ${now}`, "---", "", "A fact.", ""].join("\n"),
    )

    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => (release = r))
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input?: unknown, _init?: unknown) => {
      await gate
      return new Response(JSON.stringify({ datamates: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      const binding = {
        datamateId: 7,
        datamateName: "Seeded",
        repoRemote: null,
        projectPath: proj,
        linkedAt: 1,
      }
      const pending = recordApprovedBinding(proj, binding, { awaitBackfill: true })
      const outcome = await Promise.race([
        pending.then(() => "resolved"),
        new Promise((r) => setTimeout(() => r("still-pending"), 200)),
      ])
      expect(outcome).toBe("still-pending")
      release?.()
      await pending
    } finally {
      release?.()
      globalThis.fetch = originalFetch
      if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
      else process.env.ALTIMATE_WORKSPACE = ORIGINAL_FLAG
    }
  })

  test("re-recording an unchanged binding does not re-seed", async () => {
    // A flow that merely warms the cache must not sweep: the seed is for a new
    // or changed bind. `link` now awaits the seed, so a redundant one is paid
    // synchronously by the user.
    const ORIGINAL_FLAG = process.env.ALTIMATE_WORKSPACE
    process.env.ALTIMATE_WORKSPACE = "1"
    const proj = path.join(SANDBOX, "warm-proj")
    mkdirSync(path.join(proj, ".altimate-code", "memory"), { recursive: true })
    const now = new Date().toISOString()
    writeFileSync(
      path.join(proj, ".altimate-code", "memory", "warm.md"),
      ["---", "id: warm", "scope: project", `created: ${now}`, `updated: ${now}`, "---", "", "A fact.", ""].join("\n"),
    )
    const binding = {
      datamateId: 9,
      datamateName: "Warm",
      repoRemote: null,
      projectPath: proj,
      linkedAt: 1,
    }

    let calls = 0
    const originalFetch = globalThis.fetch
    // Return URL-shaped responses. The mem-POST endpoint must return the
    // ``{result:{results:[{id}]}}`` envelope the mirror code expects — a
    // response without an id classifies as ``declined``, which by design
    // leaves the seed unfinished and forces a retry on the next warm.
    // (harness-bot #1116 comment 3840503346 hardened that gate.)
    let memPostSerial = 0
    globalThis.fetch = (async (_input?: unknown, _init?: unknown) => {
      const url = String(_input)
      // Count memory traffic only. Skills re-sync on every bind by design, and
      // a cached binding is revalidated against the server — neither is the
      // memory seed this test is about.
      if (!url.includes("/skills") && !url.includes("/datamate-project-bindings/by-")) calls++
      if (url.includes("/datamates/memory/") && !url.includes("/list")) {
        memPostSerial += 1
        return new Response(
          JSON.stringify({
            result: { results: [{ id: `mock-mem-${memPostSerial}`, event: "ADD" }] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      if (url.includes("/datamates/memory/list")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ datamates: [{ id: 9, name: "Warm", memory_enabled: true }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      await recordApprovedBinding(proj, binding, { awaitBackfill: true })
      const afterFirst = calls
      expect(afterFirst).toBeGreaterThan(0)

      // Same workspace, same project, later timestamp: a warm, not a rebind.
      await recordApprovedBinding(proj, { ...binding, linkedAt: 2 }, { awaitBackfill: true })
      expect(calls).toBe(afterFirst)

      // A genuine rebind to another workspace must still seed.
      await recordApprovedBinding(proj, { ...binding, datamateId: 10 }, { awaitBackfill: true })
      expect(calls).toBeGreaterThan(afterFirst)
    } finally {
      globalThis.fetch = originalFetch
      if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
      else process.env.ALTIMATE_WORKSPACE = ORIGINAL_FLAG
    }
  })

  test("a warm bind still syncs skills even though the memory seed is skipped", async () => {
    // The ``alreadySeeded`` marker is memory's one-shot gate. Skills have a
    // different lifecycle — the workspace's bundles can change at any time — so
    // the skill pull sits above that early return. Without it, every bind after
    // the first would silently stop refreshing skills.
    const ORIGINAL_FLAG = process.env.ALTIMATE_WORKSPACE
    process.env.ALTIMATE_WORKSPACE = "1"
    const proj = path.join(SANDBOX, "warm-skills-proj")
    mkdirSync(proj, { recursive: true })
    const binding = {
      datamateId: 11,
      datamateName: "WarmSkills",
      repoRemote: null,
      projectPath: proj,
      linkedAt: 1,
    }

    let skillListCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input?: unknown) => {
      const url = String(_input)
      if (url.includes("/skills")) {
        skillListCalls++
        return new Response(JSON.stringify({ items: [], total: 0, page: 1, size: 50, pages: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      if (url.includes("/datamates/memory/") && !url.includes("/list")) {
        return new Response(JSON.stringify({ result: { results: [{ id: "m1", event: "ADD" }] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ datamates: [{ id: 11, name: "WarmSkills", memory_enabled: true }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      await recordApprovedBinding(proj, binding, { awaitBackfill: true })
      const afterFirst = skillListCalls
      expect(afterFirst).toBeGreaterThan(0)

      // Same workspace, same project: memory will skip, skills must not.
      await recordApprovedBinding(proj, { ...binding, linkedAt: 2 }, { awaitBackfill: true })
      expect(skillListCalls).toBeGreaterThan(afterFirst)
    } finally {
      globalThis.fetch = originalFetch
      if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
      else process.env.ALTIMATE_WORKSPACE = ORIGINAL_FLAG
    }
  })

  test("a seed that never ran stays retryable on the next warm", async () => {
    // Memory disabled at bind time means the sweep is a no-op, not a completed
    // seed. Treating it as done left the blocks this machine already holds
    // absent from the workspace until a rebind or an unrelated edit.
    const ORIGINAL_FLAG = process.env.ALTIMATE_WORKSPACE
    process.env.ALTIMATE_WORKSPACE = "1"
    const proj = path.join(SANDBOX, "gated-proj")
    mkdirSync(path.join(proj, ".altimate-code", "memory"), { recursive: true })
    const now = new Date().toISOString()
    writeFileSync(
      path.join(proj, ".altimate-code", "memory", "gated.md"),
      ["---", "id: gated", "scope: project", `created: ${now}`, `updated: ${now}`, "---", "", "A fact.", ""].join("\n"),
    )
    const binding = {
      datamateId: 11,
      datamateName: "Gated",
      repoRemote: null,
      projectPath: proj,
      linkedAt: 1,
    }

    let memoryEnabled = false
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input?: unknown, _init?: unknown) => {
      calls++
      return new Response(
        JSON.stringify({ datamates: [{ id: 11, name: "Gated", memory_enabled: memoryEnabled }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    try {
      await recordApprovedBinding(proj, binding, { awaitBackfill: true })
      const afterGated = calls
      // Memory switched on later: the same binding must sweep this time.
      memoryEnabled = true
      await recordApprovedBinding(proj, { ...binding, linkedAt: 2 }, { awaitBackfill: true })
      expect(calls).toBeGreaterThan(afterGated)
    } finally {
      globalThis.fetch = originalFetch
      if (ORIGINAL_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
      else process.env.ALTIMATE_WORKSPACE = ORIGINAL_FLAG
    }
  })

  test("chmods the cache file to 0o600 after write", async () => {
    await recordApprovedBinding("/work/proj-a", {
      datamateId: 1,
      datamateName: "X",
      repoRemote: "git@github.com:acme/x.git",
      projectPath: "/work/proj-a",
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
      projectPath: "/work/proj-a",
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
      projectPath: "/work/proj-a",
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
      projectPath: "/work/proj-a",
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
  const ident = { repoRemote: "git@github.com:acme/proj-a.git", projectPath: "/work/proj-a" }
  const scope = { tenant: "acme", apiUrl: "https://api.acme.example.com" }

  test("no record → not active", () => {
    const api = { kv: makeKv() } as any
    expect(isSkipActive(api, ident, scope, Date.now())).toBe(false)
  })

  test("recorded within 7 days → active", () => {
    const api = { kv: makeKv() } as any
    const now = 1_700_000_000_000
    recordSkip(api, ident, scope, now)
    expect(isSkipActive(api, ident, scope, now + 6 * 24 * 60 * 60 * 1000)).toBe(true)
  })

  test("recorded past 7 days → not active", () => {
    const api = { kv: makeKv() } as any
    const now = 1_700_000_000_000
    recordSkip(api, ident, scope, now)
    expect(isSkipActive(api, ident, scope, now + 8 * 24 * 60 * 60 * 1000)).toBe(false)
  })

  test("boundary at exactly 7 days → not active (>= rejects)", () => {
    const api = { kv: makeKv() } as any
    const now = 1_700_000_000_000
    recordSkip(api, ident, scope, now)
    expect(isSkipActive(api, ident, scope, now + 7 * 24 * 60 * 60 * 1000)).toBe(false)
  })

  test("different remotes have independent latches", () => {
    const api = { kv: makeKv() } as any
    const now = 1_700_000_000_000
    recordSkip(
      api,
      { repoRemote: "git@github.com:acme/one.git", projectPath: "/w/one" },
      scope,
      now,
    )
    expect(
      isSkipActive(
        api,
        { repoRemote: "git@github.com:acme/two.git", projectPath: "/w/two" },
        scope,
        now,
      ),
    ).toBe(false)
  })

  test("path-only projects (no remote) also get a latch — key derives from path", () => {
    const api = { kv: makeKv() } as any
    const now = 1_700_000_000_000
    const pathOnly = { projectPath: "/scratch/sample-dbt" }
    recordSkip(api, pathOnly, scope, now)
    expect(isSkipActive(api, pathOnly, scope, now + 3 * 24 * 60 * 60 * 1000)).toBe(true)
    // A different path is not affected.
    expect(isSkipActive(api, { projectPath: "/scratch/other" }, scope, now)).toBe(false)
  })

  test("different tenant scopes are independent latches (cubic round 3)", () => {
    const api = { kv: makeKv() } as any
    const now = 1_700_000_000_000
    recordSkip(api, ident, { tenant: "acme", apiUrl: "https://api.acme.example.com" }, now)
    expect(
      isSkipActive(api, ident, { tenant: "other", apiUrl: "https://api.acme.example.com" }, now),
    ).toBe(false)
    expect(
      isSkipActive(api, ident, { tenant: "acme", apiUrl: "https://api.other.example.com" }, now),
    ).toBe(false)
  })
})
