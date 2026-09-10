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
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
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
const { resolveProjectIdentifier } = await import("../../../src/altimate/workspace/detect")
const { resetPollMemoForTests, pendingCount } = await import(
  "../../../src/altimate/workspace/memory-sync",
)

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

describe("what the status line is allowed to claim", () => {
  test("does not report '0 not synced' when the workspace setting cannot be resolved", async () => {
    // The write path folds "unreachable" into "disabled" on purpose — it fails
    // closed so an outage cannot leak a mirror. A status line must not inherit
    // that: rendering an unreachable service as "nothing outstanding" tells the
    // user their memory is current on the strength of a failed request.
    await bind(projectDir)
    resetPollMemoForTests()
    const failing = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url
      if (url.includes("/datamates")) throw new Error("network down")
      return failing(input, init)
    }) as typeof fetch

    const report = await status(projectDir, { allowNetwork: false })
    expect(report.memory).not.toBeNull()
    // Local blocks are still countable without a service; how many are
    // outstanding is genuinely unknown, and null is how that is said.
    expect(report.memory?.unsynced).toBeNull()
  })

  test("still reports 0 outstanding when memory is genuinely off", async () => {
    // The contrast that gives the test above its meaning: "disabled" IS an
    // answer, and 0 is the truth for it.
    await bind(projectDir)
    resetPollMemoForTests()
    const report = await status(projectDir, { allowNetwork: false })
    expect(report.memory?.unsynced).toBe(0)
  })
})

describe("renames", () => {
  test("wake the sidebar even though the binding identity is unchanged", async () => {
    // `sameBinding` compares id/remote/path because it also gates the memory
    // seed — widening it would re-seed a workspace on every rename. But the
    // tile renders the NAME, so a rename is a visible change that the identity
    // check alone would swallow.
    await bind(projectDir)
    let fired = 0
    const stop = onBindingChanged(() => {
      fired++
    })
    try {
      await recordApprovedBinding(projectDir, {
        datamateId: 42,
        datamateName: "Growth Renamed",
        repoRemote: "git@github.com:acme/app.git",
        projectPath: projectDir,
        linkedAt: Date.now(),
      } as any)
      expect(fired).toBeGreaterThan(0)
    } finally {
      stop()
    }
  })
})

describe("which identifier unlink deletes on", () => {
  test("uses the arm the server actually matched when there is no cached row", async () => {
    // The repair case: no local binding. `unbindProject` sends the remote
    // whenever one is detected, so a project the server bound by PATH would be
    // deleted by an identifier it never stored — 404, which this client reads
    // as "nothing to remove", clearing local state while the binding stays live
    // to be re-adopted on the next resolve.
    // The project MUST have a detectable remote, or this test passes for the
    // wrong reason: with no remote, `resolveProjectIdentifier` returns a path
    // only and the DELETE goes out on the path whether the fix is present or
    // not. (It did exactly that on the first draft — the mutation survived.)
    execFileSync("git", ["init", "-q"], { cwd: projectDir })
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/app.git"], {
      cwd: projectDir,
    })
    expect(resolveProjectIdentifier(projectDir).repoRemote).toBeTruthy()

    const originalFetch2 = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      requests.push({ method, url })
      if (method === "GET" && url.includes("/by-remote")) {
        // The server has no binding under this remote...
        return new Response(JSON.stringify({ detail: "nope" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      }
      if (method === "GET" && url.includes("/by-path")) {
        // ...but it does under the path.
        return new Response(
          JSON.stringify({
            binding: { id: 1, datamate_id: 42, datamate_name: "Growth", repo_remote: null, project_path: projectDir },
            datamate: { id: 42, name: "Growth" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (method === "DELETE") return new Response(null, { status: 204 })
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    try {
      await unlink(projectDir)
    } finally {
      globalThis.fetch = originalFetch2
    }

    const del = requests.filter((r) => r.method === "DELETE")
    expect(del).toHaveLength(1)
    const url = new URL(del[0].url)
    // The property that matters: it deleted on the path, not the remote.
    // Compared through realpath — `resolveProjectIdentifier` canonicalizes, and
    // on macOS the sandbox lives under /var, a symlink to /private/var.
    expect(url.searchParams.get("project_path")).toBe(realpathSync(projectDir))
    expect(url.searchParams.get("repo_remote")).toBeNull()
  })
})

describe("status and the sweep must agree", () => {
  test("an unlinked project does not report global blocks as outstanding", async () => {
    // `pendingCount` is documented as a promise about what `backfill` would do.
    // With no binding, `backfill` gates and sends nothing, but `partitionPending`
    // only skips PROJECT-scope blocks for want of somewhere to put them — global
    // blocks fell through and were counted as pending. Status said "N not
    // synced" about a sweep that would refuse to run.
    //
    // Asserted on `pendingCount` directly. Going through `status` made this
    // vacuous: `memory` can be null there for unrelated reasons and the
    // optional-chain swallowed it, so the mutation survived.
    const globalBlock = {
      id: "g1",
      scope: "global",
      content: "a global memory",
      tags: [],
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    }
    expect(await pendingCount([globalBlock as never], null)).toBe(0)
  })

  test("an empty sweep on a memory-off workspace reports gated, not 'nothing to do'", async () => {
    // The stub workspace has memory off (listDatamates returns nothing), so
    // `backfill` refuses to run. Answering `gated: false` here told the caller
    // the sweep ran and found nothing.
    await bind(projectDir)
    const result = await sync(projectDir)
    expect(result.gated).toBe(true)
    expect(result.sent).toBe(0)
  })
})
