// altimate_change - new file
//
// Unit coverage for the `/workspace` operations (src/altimate/workspace/manage.ts).
//
// These tests are about ORCHESTRATION, not about what the underlying sync modules
// do — `memory-sync` and `skill-sync` have their own suites. What is asserted here
// is the ordering and the gating that only this module decides: that unlink asks
// the server before touching local state, that it still cleans up when the server
// says there was nothing to remove, and that it leaves local state alone when the
// server fails.
//
// House style, matching memory-sync.test.ts: no `mock.module()`. The network is
// stubbed at `globalThis.fetch` so assertions are about the requests actually
// issued — method, path, query — and the binding cache is a real file in a real
// sandbox directory.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import os from "node:os"

// Global.Path.state resolves at module load, so the sandbox must exist first.
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
const ORIGINAL_WORKSPACE_FLAG = process.env.ALTIMATE_WORKSPACE
const SANDBOX = path.join(os.tmpdir(), `altimate-manage-${process.pid}-${Date.now()}`)
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")
process.env.ALTIMATE_WORKSPACE = "1"

afterAll(() => {
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
  if (ORIGINAL_WORKSPACE_FLAG === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_WORKSPACE_FLAG
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

const { AltimateApi } = await import("../../../src/altimate/api/client")
const { unlink, sync, status } = await import("../../../src/altimate/workspace/manage")
const { readLocalBinding, recordApprovedBinding, onBindingChanged } = await import(
  "../../../src/altimate/workspace/state",
)
const { resetPollMemoForTests } = await import("../../../src/altimate/workspace/memory-sync")

type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>
const originalIsConfigured = AltimateApi.isConfigured
const originalGetCreds = AltimateApi.getCredentials
;(AltimateApi as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () => true
;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
  ({
    altimateInstanceName: "acme",
    altimateUrl: "https://api.example.com",
    altimateApiKey: "key-a",
  }) as Creds

const originalFetch = globalThis.fetch
let requests: { method: string; url: string }[] = []
/** Status returned for `DELETE /datamate-project-bindings/`. Everything else
 * answers an empty 200, which is enough for the sync modules to no-op. */
let deleteStatus = 204

let projectDir = ""

beforeEach(() => {
  requests = []
  deleteStatus = 204
  projectDir = mkdtempSync(path.join(SANDBOX, "proj-"))
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url
    const method = (init?.method ?? "GET").toUpperCase()
    requests.push({ method, url })
    if (method === "DELETE" && url.includes("/datamate-project-bindings/")) {
      return new Response(deleteStatus === 204 ? null : JSON.stringify({ detail: "nope" }), {
        status: deleteStatus,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

afterAll(() => {
  ;(AltimateApi as unknown as { isConfigured: typeof originalIsConfigured }).isConfigured = originalIsConfigured
  ;(AltimateApi as unknown as { getCredentials: typeof originalGetCreds }).getCredentials = originalGetCreds
})

async function bind(dir: string) {
  await recordApprovedBinding(dir, {
    datamateId: 42,
    datamateName: "Growth",
    repoRemote: "git@github.com:acme/app.git",
    projectPath: dir,
    linkedAt: Date.now(),
  } as any)
}

const deletes = () => requests.filter((r) => r.method === "DELETE")

describe("unlink", () => {
  test("asks the server to remove the binding, naming one identifier", async () => {
    await bind(projectDir)
    const report = await unlink(projectDir)

    expect(report.removedServerSide).toBe(true)
    expect(report.was?.datamateName).toBe("Growth")
    expect(deletes()).toHaveLength(1)
    const url = new URL(deletes()[0].url)
    // Exactly one identifier. Sending both risks the endpoint's 409 when they
    // resolve to different bindings, and the remote is what `getBindingForProject`
    // matches on first — so unlink removes the binding lookup would have found.
    expect(url.searchParams.get("repo_remote")).toBe("git@github.com:acme/app.git")
    expect(url.searchParams.has("project_path")).toBe(false)
  })

  test("clears the local binding once the server has removed it", async () => {
    await bind(projectDir)
    expect(await readLocalBinding(projectDir)).not.toBeNull()

    await unlink(projectDir)

    expect(await readLocalBinding(projectDir)).toBeNull()
  })

  test("still clears local state when the server had nothing to remove", async () => {
    // 404 means the binding is already gone server-side — unlinked on another
    // machine, or by someone else. That is precisely when a stale local row most
    // needs clearing, so the cleanup must not be conditional on a 204.
    await bind(projectDir)
    deleteStatus = 404

    const report = await unlink(projectDir)

    expect(report.removedServerSide).toBe(false)
    expect(await readLocalBinding(projectDir)).toBeNull()
  })

  test("leaves the local binding intact when the server fails", async () => {
    // The ordering invariant. The server-side binding is the source of truth and
    // is re-read whenever the cache misses, so clearing local state after a failed
    // delete would produce a project that looks unlinked and silently re-links
    // itself on the next resolve.
    await bind(projectDir)
    deleteStatus = 500

    await expect(unlink(projectDir)).rejects.toThrow()

    expect(await readLocalBinding(projectDir)).not.toBeNull()
  })
})

describe("sync", () => {
  test("is gated, not merely empty, on an unlinked project", async () => {
    // `gated` says the sweep never ran. Reporting `sent: 0` without it reads as
    // "nothing to send", which is a different and misleading answer.
    const report = await sync(projectDir)

    expect(report.gated).toBe(true)
    expect(report.sent).toBe(0)
  })
})

describe("status", () => {
  test("reports the binding a project is linked to", async () => {
    await bind(projectDir)

    const report = await status(projectDir)

    expect(report.binding?.datamateId).toBe(42)
    expect(report.binding?.datamateName).toBe("Growth")
  })

  test("reports no binding for an unlinked project rather than throwing", async () => {
    const report = await status(projectDir)

    expect(report.binding).toBeNull()
  })

  test("a poller resolves the workspace setting once, not on every tick", async () => {
    // The sidebar calls this every 30 seconds. The shared enablement cache is
    // positive-only — a workspace with memory switched OFF is never memoized —
    // so asking it directly on each tick would put a request on the wire every
    // 30 seconds, forever, for exactly the workspaces whose answer is "no".
    //
    // The fix is a bound, NOT a ban. An earlier version refused the network
    // outright and the counts then never appeared at all on a session where
    // nothing else warmed the cache — the very drift the line exists to surface.
    await bind(projectDir)
    resetPollMemoForTests()
    // Counted against the workspace-list endpoint specifically, not every
    // request: `recordApprovedBinding` starts a fire-and-forget backfill whose
    // traffic lands at an unpredictable moment, so a total-request assertion
    // passes alone and fails in a full run.
    const listCalls = () => requests.filter((r) => r.url.includes("/datamates")).length
    const before = listCalls()

    await status(projectDir, { allowNetwork: false })
    const afterFirst = listCalls()
    await status(projectDir, { allowNetwork: false })
    await status(projectDir, { allowNetwork: false })

    // The first poll asks.
    expect(afterFirst).toBeGreaterThan(before)
    // The next two do not.
    expect(listCalls()).toBe(afterFirst)
  })

  test("a poller still reports the local block count when memory is off", async () => {
    // "How many memories do I have" is answerable without the service; only
    // "how many are outstanding" depends on the workspace setting. Reporting
    // nothing at all would hide the first fact to protect the second.
    await bind(projectDir)
    resetPollMemoForTests()

    const report = await status(projectDir, { allowNetwork: false })

    expect(report.memory).not.toBeNull()
    // The stub workspace has memory off, so nothing is outstanding — a sweep
    // would refuse to send any of it.
    expect(report.memory?.unsynced).toBe(0)
    expect(report.binding?.datamateName).toBe("Growth")
  })
})

describe("binding-change notifications", () => {
  // The sidebar tile polls every 30s. Without these, Unlink shows a success
  // toast while the pane beside it keeps naming the workspace until the next
  // tick — the UI contradicting itself, with the stale half looking
  // authoritative. Found by watching the real TUI, like the rest of this file.
  test("unlink wakes subscribers so the tile does not wait out the poll", async () => {
    await bind(projectDir)
    let fired = 0
    const stop = onBindingChanged(() => {
      fired++
    })
    try {
      await unlink(projectDir)
      expect(fired).toBeGreaterThan(0)
    } finally {
      stop()
    }
  })

  test("a new bind wakes subscribers", async () => {
    let fired = 0
    const stop = onBindingChanged(() => {
      fired++
    })
    try {
      await bind(projectDir)
      expect(fired).toBeGreaterThan(0)
    } finally {
      stop()
    }
  })

  test("re-recording the SAME binding does not", async () => {
    // A warm cache re-read is not a change. Waking the tile on every resolve
    // would undo the point of the poll interval.
    await bind(projectDir)
    let fired = 0
    const stop = onBindingChanged(() => {
      fired++
    })
    try {
      await bind(projectDir)
      expect(fired).toBe(0)
    } finally {
      stop()
    }
  })

  test("unsubscribing stops them", async () => {
    let fired = 0
    const stop = onBindingChanged(() => {
      fired++
    })
    stop()
    await bind(projectDir)
    expect(fired).toBe(0)
  })

  test("a listener that throws does not fail the unlink", async () => {
    await bind(projectDir)
    const stop = onBindingChanged(() => {
      throw new Error("subscriber blew up")
    })
    try {
      const report = await unlink(projectDir)
      expect(report.removedServerSide).toBe(true)
    } finally {
      stop()
    }
  })
})
