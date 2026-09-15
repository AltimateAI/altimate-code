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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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
const { unlink, sync, status, refresh } = await import("../../../src/altimate/workspace/manage")
const {
  readLocalBinding,
  recordApprovedBinding,
  onBindingChanged,
  resolveBindingOutcome,
  expireValidationForTests,
  cachePath,
} = await import("../../../src/altimate/workspace/state")
const { resolveProjectIdentifier } = await import("../../../src/altimate/workspace/detect")
const { resetPollMemoForTests, resetEnablementMemoForTests, pendingCount, memoryEnabledCache, memoryEnabledForPoller } =
  await import("../../../src/altimate/workspace/memory-sync")

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

async function bind(dir: string, datamateId = 42) {
  // Awaited, so the bind's skill sync and memory backfill finish inside this
  // test's stubbed `fetch` and its `requests` log. Detached, they straddled
  // `afterEach` — landing in another test's log, or on the real network.
  await recordApprovedBinding(
    dir,
    {
      datamateId,
      datamateName: "Growth",
      repoRemote: "git@github.com:acme/app.git",
      projectPath: dir,
      linkedAt: Date.now(),
    } as any,
    { awaitBackfill: true },
  )
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

    await status(projectDir, { poll: true })
    const afterFirst = listCalls()
    await status(projectDir, { poll: true })
    await status(projectDir, { poll: true })

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

    const report = await status(projectDir, { poll: true })

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

    const report = await status(projectDir, { poll: true })
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
    const report = await status(projectDir, { poll: true })
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

describe("what unlink leaves on disk", () => {
  /** Stub whose DELETE relinks the project mid-request, and answers 204. */
  const relinkDuringDelete = (to: number) => {
    const originalFetch2 = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      requests.push({ method, url })
      if (method === "DELETE" && url.includes("/datamate-project-bindings/")) {
        await bind(projectDir, to)
        // The relink's own sync left a snapshot this client owns. The unlink
        // that lost the race must not purge it.
        const snapshot = path.join(projectDir, ".altimate-code", "skill", "_workspace")
        mkdirSync(path.join(snapshot, "pub-x"), { recursive: true })
        writeFileSync(path.join(snapshot, "pub-x", "SKILL.md"), "theirs now")
        writeFileSync(
          path.join(snapshot, ".manifest.json"),
          JSON.stringify({ version: 1, tenant: "acme", apiUrl: "https://api.example.com", datamateId: to, skills: {} }),
        )
        return new Response(null, { status: 204 })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch
    return () => {
      globalThis.fetch = originalFetch2
    }
  }
  const snapshotSurvives = () =>
    expect(existsSync(path.join(projectDir, ".altimate-code", "skill", "_workspace", "pub-x", "SKILL.md"))).toBe(true)

  /** The row survives, and no lookup miss was memoized over it: past the
   * validation window the resolver asks the server (which answers nothing
   * recognisable here, so the local row stands) rather than reading a memo
   * that says "unbound" and dropping the row. */
  const expectKept = async (datamateId: number) => {
    expect((await readLocalBinding(projectDir))?.datamateId).toBe(datamateId)
    expireValidationForTests(projectDir)
    const outcome = await resolveBindingOutcome(projectDir)
    expect(outcome.status).toBe("bound")
    if (outcome.status === "bound") expect(outcome.binding.datamateId).toBe(datamateId)
  }

  test("a relink that completed while the DELETE was in flight is kept", async () => {
    // The server round trip is the window. A relink to another workspace that
    // lands inside it writes a new row; the cleanup must recognise the row is
    // no longer the one unlink started from, and neither remove it nor memoize
    // a five-minute "unbound" over it.
    await bind(projectDir, 42)
    const restore = relinkDuringDelete(77)
    try {
      const report = await unlink(projectDir)
      expect(report.removedServerSide).toBe(true)
      // And nothing of the new binding's was removed: the snapshot and the
      // overlay now belong to it.
      expect(report.skillsPurged).toBe(false)
    } finally {
      restore()
    }
    snapshotSurvives()
    await expectKept(77)
  })

  test("a relink the DELETE itself removed server-side is not kept", async () => {
    // Ordering matters. A relink that reached the server BEFORE the DELETE
    // was removed by it — the DELETE names the project, not a row — so the
    // local row the relink wrote now describes a binding the server no
    // longer holds. Unlink asks, and clears it.
    await bind(projectDir, 42)
    let deleted = false
    const originalFetch2 = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      requests.push({ method, url })
      if (method === "DELETE" && url.includes("/datamate-project-bindings/")) {
        await bind(projectDir, 77)
        deleted = true
        return new Response(null, { status: 204 })
      }
      if (deleted && method === "GET" && url.includes("/datamate-project-bindings/by-")) {
        return new Response(JSON.stringify({ detail: "gone" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch
    try {
      await unlink(projectDir)
    } finally {
      globalThis.fetch = originalFetch2
    }
    expect(await readLocalBinding(projectDir)).toBeNull()
  })

  test("a stale alias beside the current row is not mistaken for a relink", async () => {
    // A cache written before keys were canonicalised can hold the same
    // directory under a raw path as well. Reads take the canonical row and
    // never look at the alias, so it lingers; the relink guard must judge on
    // the row reads win, or the alias's older link time reads as a
    // concurrent relink and the unlink leaves everything in place.
    await bind(projectDir, 42)
    const file = cachePath()
    const cache = JSON.parse(readFileSync(file, "utf8"))
    // THIS directory's row, by its canonical key — the file is shared across
    // the module and holds other tests' rows too.
    const canon = realpathSync(projectDir)
    const row = cache.bindings[canon] as { linkedAt: number }
    expect(row).toBeDefined()
    cache.bindings[canon + "/"] = { ...row, linkedAt: row.linkedAt - 60_000 }
    writeFileSync(file, JSON.stringify(cache))
    expect((await readLocalBinding(projectDir))?.datamateId).toBe(42)

    await unlink(projectDir)

    expect(await readLocalBinding(projectDir)).toBeNull()
  })

  test("the server check after a kept relink asks by the relinked row's identifiers", async () => {
    // Re-detecting the checkout would miss a remote-only server row when the
    // remote changed during the request; the relink recorded what the server
    // matched on, so that is what is asked. Here the checkout has NO remote,
    // so a re-detect asks by path — and the relinked row says remote.
    await bind(projectDir, 42)
    const originalFetch2 = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      requests.push({ method, url })
      if (method === "DELETE" && url.includes("/datamate-project-bindings/")) {
        await bind(projectDir, 77)
        return new Response(null, { status: 204 })
      }
      if (method === "GET" && url.includes("/by-remote")) {
        return new Response(
          JSON.stringify({
            binding: { id: 2, datamate_id: 77, datamate_name: "Growth", repo_remote: "git@github.com:acme/app.git", project_path: null },
            datamate: { id: 77, name: "Growth" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (method === "GET" && url.includes("/by-path")) {
        return new Response(JSON.stringify({ detail: "gone" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch
    try {
      await unlink(projectDir)
    } finally {
      globalThis.fetch = originalFetch2
    }
    expect(requests.some((r) => r.method === "GET" && r.url.includes("/by-remote"))).toBe(true)
    expect((await readLocalBinding(projectDir))?.datamateId).toBe(77)
  })

  test("a relink that lands after the server check is kept by the second cleanup", async () => {
    // The check said the relinked row was gone server-side; between that
    // answer and the cleanup, another relink wrote a newer row. The cleanup
    // is guarded on the row the check was about, not unguarded.
    await bind(projectDir, 42)
    let deleted = false
    const originalFetch2 = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      requests.push({ method, url })
      if (method === "DELETE" && url.includes("/datamate-project-bindings/")) {
        await bind(projectDir, 77)
        deleted = true
        return new Response(null, { status: 204 })
      }
      if (deleted && method === "GET" && url.includes("/datamate-project-bindings/by-")) {
        await bind(projectDir, 99)
        const snapshot = path.join(projectDir, ".altimate-code", "skill", "_workspace")
        mkdirSync(path.join(snapshot, "pub-x"), { recursive: true })
        writeFileSync(path.join(snapshot, "pub-x", "SKILL.md"), "theirs now")
        writeFileSync(
          path.join(snapshot, ".manifest.json"),
          JSON.stringify({ version: 1, tenant: "acme", apiUrl: "https://api.example.com", datamateId: 99, skills: {} }),
        )
        return new Response(JSON.stringify({ detail: "gone" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch
    try {
      await unlink(projectDir)
    } finally {
      globalThis.fetch = originalFetch2
    }
    expect((await readLocalBinding(projectDir))?.datamateId).toBe(99)
    // And its snapshot was not purged either.
    snapshotSurvives()
  })

  test("a relink under another account during the DELETE is kept, snapshot included", async () => {
    // The cache file is single-scope. Credentials switch to another account
    // mid-unlink and the project is relinked there: the file now belongs to
    // that account. The cleanup, pinned to the first, must read that as a
    // relink to keep — not as "nothing of ours here" and go on to purge the
    // snapshot the relink just synced.
    await bind(projectDir, 42)
    const originalFetch2 = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      requests.push({ method, url })
      if (method === "DELETE" && url.includes("/datamate-project-bindings/")) {
        ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
          ({ altimateInstanceName: "other", altimateUrl: "https://api.example.com", altimateApiKey: "key-b" }) as Creds
        await bind(projectDir, 77)
        const snapshot = path.join(projectDir, ".altimate-code", "skill", "_workspace")
        mkdirSync(path.join(snapshot, "pub-x"), { recursive: true })
        writeFileSync(path.join(snapshot, "pub-x", "SKILL.md"), "theirs now")
        writeFileSync(
          path.join(snapshot, ".manifest.json"),
          JSON.stringify({ version: 1, tenant: "other", apiUrl: "https://api.example.com", datamateId: 77, skills: {} }),
        )
        return new Response(null, { status: 204 })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch
    try {
      const report = await unlink(projectDir)
      expect(report.skillsPurged).toBe(false)
    } finally {
      globalThis.fetch = originalFetch2
      ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
        ({ altimateInstanceName: "acme", altimateUrl: "https://api.example.com", altimateApiKey: "key-a" }) as Creds
    }
    snapshotSurvives()
  })

  test("a cache that already belonged to another account is not mistaken for a relink", async () => {
    // The file was written under a previous account and never touched during
    // this unlink. Reading its foreign scope as "a relink landed" would keep
    // the OLD workspace's snapshot active; instead the cleanup proceeds past
    // the row (not ours to touch) and the purge removes the snapshot this
    // client wrote.
    ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
      ({ altimateInstanceName: "other", altimateUrl: "https://api.example.com", altimateApiKey: "key-b" }) as Creds
    try {
      await bind(projectDir, 77)
    } finally {
      ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
        ({ altimateInstanceName: "acme", altimateUrl: "https://api.example.com", altimateApiKey: "key-a" }) as Creds
    }
    const snapshot = path.join(projectDir, ".altimate-code", "skill", "_workspace")
    mkdirSync(path.join(snapshot, "pub-x"), { recursive: true })
    writeFileSync(path.join(snapshot, "pub-x", "SKILL.md"), "stale")
    writeFileSync(
      path.join(snapshot, ".manifest.json"),
      JSON.stringify({ version: 1, tenant: "other", apiUrl: "https://api.example.com", datamateId: 77, skills: {} }),
    )

    const report = await unlink(projectDir)

    // Not the kept path: the purge ran.
    expect(report.skillsPurged).toBe(true)
    expect(existsSync(path.join(snapshot, "pub-x", "SKILL.md"))).toBe(false)
    // And the other account's row was not touched — it is not ours.
    const cache = JSON.parse(readFileSync(cachePath(), "utf8"))
    expect(cache.tenant).toBe("other")
    expect(cache.bindings[realpathSync(projectDir)]?.datamateId).toBe(77)
  })

  test("a relink to the SAME workspace during the DELETE is kept", async () => {
    // Comparing the workspace id alone would call this row unchanged and
    // remove it. The link time tells the two rows apart.
    await bind(projectDir, 42)
    // A later millisecond, so the relink's `linkedAt` differs.
    await new Promise((r) => setTimeout(r, 2))
    const restore = relinkDuringDelete(42)
    try {
      await unlink(projectDir)
    } finally {
      restore()
    }
    snapshotSurvives()
    await expectKept(42)
  })

  test("a relink during an unlink that started with no cached row is kept", async () => {
    // The repair case: no local row, so unlink resolves the identifier by
    // asking the server. Any row present when the cleanup runs was written
    // during the request, and is not this unlink's to remove.
    execFileSync("git", ["init", "-q"], { cwd: projectDir })
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/app.git"], { cwd: projectDir })
    const originalFetch2 = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      requests.push({ method, url })
      if (method === "GET" && url.includes("/by-remote")) {
        return new Response(
          JSON.stringify({
            binding: { id: 1, datamate_id: 42, datamate_name: "Growth", repo_remote: "git@github.com:acme/app.git", project_path: null },
            datamate: { id: 42, name: "Growth" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (method === "DELETE") {
        await bind(projectDir, 77)
        return new Response(null, { status: 204 })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch
    try {
      await unlink(projectDir)
    } finally {
      globalThis.fetch = originalFetch2
    }
    await expectKept(77)
  })
})

describe("which identifier unlink deletes on", () => {
  test("a lookup that cannot be made fails the unlink, with local state untouched", async () => {
    // No cached row, and the pre-check that decides which arm to delete on
    // cannot reach the server. Swallowing that fell back to the detected
    // identifier — the wrong-arm delete the pre-check exists to avoid — and
    // then cleared local state behind a 404. Nothing must be deleted.
    execFileSync("git", ["init", "-q"], { cwd: projectDir })
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/app.git"], { cwd: projectDir })
    const originalFetch2 = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      requests.push({ method, url })
      if (method === "GET" && url.includes("/by-remote")) {
        return new Response(JSON.stringify({ detail: "down" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
      }
      if (method === "DELETE") return new Response(null, { status: 204 })
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch
    try {
      await expect(unlink(projectDir)).rejects.toThrow()
    } finally {
      globalThis.fetch = originalFetch2
    }
    expect(deletes()).toHaveLength(0)
  })


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

describe("what /workspace status may cost and claim (review round 2)", () => {
  test("status adopts a server-side binding the local cache has never seen", async () => {
    // A fresh clone or a new machine: the project is bound server-side but has
    // no cached row. Reading only the cache answered "not linked" with a lone
    // Done. Status now goes through the resolver.
    const originalFetch2 = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      requests.push({ method, url })
      if (method === "GET" && url.includes("/by-path")) {
        return new Response(
          JSON.stringify({
            binding: { id: 1, datamate_id: 42, datamate_name: "Growth", repo_remote: null, project_path: projectDir },
            datamate: { id: 42, name: "Growth" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (method === "GET" && url.includes("/by-remote")) {
        return new Response(JSON.stringify({ detail: "nope" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch
    try {
      const report = await status(projectDir)
      expect(report.binding?.datamateName).toBe("Growth")
    } finally {
      globalThis.fetch = originalFetch2
    }
  })

  test("status takes a cached row as it is, without asking the server", async () => {
    // The menu awaits this before it can appear. The resolver revalidates a
    // cached row on the first call of a process, and on a dead link that was
    // the API's full timeout before the menu showed. The cached row is enough
    // here; the poll and the operations behind the menu revalidate.
    await bind(projectDir)
    // As on the first call of a fresh process: the row is on disk, nothing
    // in memory says it was validated.
    expireValidationForTests(projectDir)
    requests = []
    const report = await status(projectDir)
    expect(report.binding?.datamateId).toBe(42)
    expect(requests.filter((r) => r.url.includes("/datamate-project-bindings/"))).toHaveLength(0)
  })

  test("status never asks the service whether memory is on", async () => {
    // It is awaited before the /workspace dialog can appear. The enablement
    // check is a GET with a 15s budget; on a dead link the menu looked frozen.
    // Earlier cases in this file memoize workspace 42's setting; from cache
    // that is a real answer, and the point here is the UNKNOWN case.
    resetEnablementMemoForTests()
    // Awaited, so the bind's own background backfill (which DOES ask the
    // service) has settled before the request log is cleared — otherwise it
    // lands mid-test and is blamed on status.
    await recordApprovedBinding(
      projectDir,
      { datamateId: 42, datamateName: "Growth", repoRemote: null, projectPath: projectDir, linkedAt: Date.now() } as any,
      { awaitBackfill: true },
    )
    // A real block, or `pendingCount` returns 0 before it ever consults the
    // cache and the test proves nothing.
    const memDir = path.join(projectDir, ".altimate-code", "memory")
    mkdirSync(memDir, { recursive: true })
    writeFileSync(
      path.join(memDir, "one.md"),
      "---\nid: one\nscope: project\ncreated: 2026-09-01T00:00:00Z\nupdated: 2026-09-01T00:00:00Z\n---\n\nA block.\n",
    )
    requests = []
    const report = await status(projectDir)
    expect(requests.filter((r) => r.url.includes("/datamates/") && !r.url.includes("bindings"))).toHaveLength(0)
    // And it does not pretend to know: unknown is null, not zero.
    expect(report.memory?.local).toBe(1)
    expect(report.memory?.unsynced).toBeNull()
  })

  test("refresh hands its directory to the memory half, not the ambient instance", async () => {
    // The palette passes no session, so this only mattered for the headless
    // adapter — which has no ambient instance to fall back on.
    // Observed through behaviour, since an ESM namespace cannot be spied on.
    // With the directory threaded through, the memory half resolves THIS
    // project's binding and goes on to ask the service about it. Without it,
    // `currentBinding()` falls back to the ambient instance — absent in a test,
    // as in the headless adapter — resolves nothing, and never asks.
    await bind(projectDir)
    requests = []
    await refresh(projectDir, "ses_1")
    const asked = requests.filter((r) => r.method === "GET" && r.url.endsWith("/datamates/"))
    expect(asked.length).toBeGreaterThan(0)
  })

  test("unlink says when the workspace's skills were left on disk", async () => {
    // A symlinked `.altimate-code` makes the purge refuse. Reporting a clean
    // "Unlinked" there is false in the way that matters: those skills keep
    // loading into every later session of this project.
    const { symlinkSync, mkdirSync: mk, writeFileSync: wf } = await import("node:fs")
    const outside = mkdtempSync(path.join(SANDBOX, "outside-"))
    mk(path.join(outside, "skill", "_workspace", "pub-x"), { recursive: true })
    wf(path.join(outside, "skill", "_workspace", "pub-x", "SKILL.md"), "x")
    const proj = mkdtempSync(path.join(SANDBOX, "symproj-"))
    symlinkSync(outside, path.join(proj, ".altimate-code"))
    await bind(proj)

    const report = await unlink(proj)

    expect(report.skillsPurged).toBe(false)
    expect(report.skillsLeftBehind).toBe(true)
  })

  test("unlink does not warn when there was simply nothing to purge", async () => {
    await bind(projectDir)
    const report = await unlink(projectDir)
    expect(report.skillsLeftBehind).toBe(false)
  })
})

const manifestFor = (datamateId: number) =>
  JSON.stringify({ version: 1, tenant: "acme", apiUrl: "https://api.example.com", datamateId, skills: {} })

describe("the sidebar's skills-synced age", () => {
  test("comes from the snapshot on disk, not a per-thread map", async () => {
    // The per-message sync stamps its map in the server worker; the sidebar
    // reads on the main thread, which has its own `globalThis` and so its own
    // map. The marker the sync writes on every clean run is the answer both
    // threads can see.
    await bind(projectDir)
    const managed = path.join(projectDir, ".altimate-code", "skill", "_workspace")
    mkdirSync(managed, { recursive: true })
    writeFileSync(path.join(managed, ".manifest.json"), manifestFor(42))
    const before = Date.now() - 5 * 60_000
    writeFileSync(path.join(managed, ".synced-at"), String(before))

    const report = await status(projectDir)

    expect(report.skillsSyncedAt).toBe(before)
  })

  test("is nothing when the snapshot beside the marker belongs to another workspace", async () => {
    // After a rebind the sidebar can refresh before the detached sync has
    // replaced the previous workspace's snapshot, and would otherwise render
    // A's age under B's name.
    await bind(projectDir)
    const managed = path.join(projectDir, ".altimate-code", "skill", "_workspace")
    mkdirSync(managed, { recursive: true })
    writeFileSync(path.join(managed, ".manifest.json"), manifestFor(7))
    writeFileSync(path.join(managed, ".synced-at"), String(Date.now() - 60_000))

    expect((await status(projectDir)).skillsSyncedAt).toBeNull()
  })

  test("is nothing when the marker is empty or garbage", async () => {
    // A truncated marker must read as unknown, not as a sync from 1970.
    await bind(projectDir)
    const managed = path.join(projectDir, ".altimate-code", "skill", "_workspace")
    mkdirSync(managed, { recursive: true })
    writeFileSync(path.join(managed, ".manifest.json"), manifestFor(42))
    for (const junk of ["", " \n", "soon", "12abc"]) {
      writeFileSync(path.join(managed, ".synced-at"), junk)
      expect((await status(projectDir)).skillsSyncedAt).toBeNull()
    }
  })

  test("is nothing when there is no snapshot", async () => {
    // After an unlink, a rebind or an empty workspace the root is gone, and an
    // in-memory stamp from before would describe a sync that no longer is.
    await bind(projectDir)
    const report = await status(projectDir)
    expect(report.skillsSyncedAt).toBeNull()
  })
})

describe("the poller does not drip", () => {
  test("once enablement is memoized as enabled, computing the count asks nothing", async () => {
    await bind(projectDir)
    resetPollMemoForTests()
    // A real block, or `pendingCount` returns before its gate and the test
    // cannot see whether the gate asks.
    const memDir = path.join(projectDir, ".altimate-code", "memory")
    mkdirSync(memDir, { recursive: true })
    writeFileSync(
      path.join(memDir, "one.md"),
      "---\nid: one\nscope: project\ncreated: 2026-09-01T00:00:00Z\nupdated: 2026-09-01T00:00:00Z\n---\n\nA block.\n",
    )
    // Warm the poller memo: the stub answers a workspace with memory ON.
    const originalFetch3 = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      requests.push({ method, url })
      if (method === "GET" && url.endsWith("/datamates/"))
        return new Response(JSON.stringify({ datamates: [{ id: 42, name: "Growth", memory_enabled: true }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      return originalFetch3(input, init)
    }) as typeof fetch
    try {
      await status(projectDir, { poll: true }) // asks once, memoizes "enabled"
      // The drip only starts once the write path's 60s positive has expired
      // while the poller's 5-minute memo has not. Expire it explicitly — this
      // is the state every poll after the first minute is in.
      memoryEnabledCache.clear()
      requests = []
      await status(projectDir, { poll: true })
      await status(projectDir, { poll: true })
      expect(requests.filter((r) => r.method === "GET" && r.url.endsWith("/datamates/"))).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch3
    }
  })
})

describe("the poller coalesces overlapping misses", () => {
  test("two refreshes on a cold memo put one request on the wire", async () => {
    // A remount while a slow refresh is still out started a second one; both
    // saw the memo empty and both asked. The in-flight ask is memoized too.
    await bind(projectDir)
    resetPollMemoForTests()
    const originalFetch3 = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      requests.push({ method, url })
      if (method === "GET" && url.endsWith("/datamates/")) {
        await new Promise((r) => setTimeout(r, 20))
        return new Response(JSON.stringify({ datamates: [{ id: 42, name: "Growth", memory_enabled: true }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return originalFetch3(input, init)
    }) as typeof fetch
    try {
      requests = []
      const b = (await readLocalBinding(projectDir))!
      const [a, c] = await Promise.all([memoryEnabledForPoller(b), memoryEnabledForPoller(b)])
      expect(a).toBe("enabled")
      expect(c).toBe("enabled")
      expect(requests.filter((r) => r.method === "GET" && r.url.endsWith("/datamates/"))).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch3
    }
  })
})

describe("the poller after an account switch", () => {
  test("does not serve the previous tenant's positive to a same-numbered workspace", async () => {
    // Workspace ids are tenant-local. The write path's positive cache is keyed
    // by bare id — fine there, its credentials are fixed — but the poller
    // consulting it first reopened a 60s window in which tenant A's "enabled"
    // was served to tenant B's workspace 42.
    await bind(projectDir)
    resetPollMemoForTests()
    const binding = (await readLocalBinding(projectDir))!
    const originalFetch4 = globalThis.fetch
    let tenantMemory = true
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      requests.push({ method, url })
      if (method === "GET" && url.endsWith("/datamates/"))
        return new Response(JSON.stringify({ datamates: [{ id: 42, name: "W", memory_enabled: tenantMemory }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      return originalFetch4(input, init)
    }) as typeof fetch
    try {
      expect(await memoryEnabledForPoller(binding)).toBe("enabled") // tenant A, warms the bare-id positive
      // Switch accounts: same workspace id, memory OFF there.
      ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
        ({ altimateInstanceName: "other", altimateUrl: "https://api.example.com", altimateApiKey: "k" }) as Creds
      tenantMemory = false
      expect(await memoryEnabledForPoller(binding)).toBe("disabled")
    } finally {
      globalThis.fetch = originalFetch4
      ;(AltimateApi as unknown as { getCredentials: () => Promise<Creds> }).getCredentials = async () =>
        ({ altimateInstanceName: "acme", altimateUrl: "https://api.example.com", altimateApiKey: "key-a" }) as Creds
    }
  })
})
