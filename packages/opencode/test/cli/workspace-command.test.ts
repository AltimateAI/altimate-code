// altimate_change - new file
import { afterEach, describe, expect, test } from "bun:test"
import {
  EXIT,
  ago,
  describeRefresh,
  describeStatus,
  describeSync,
  runRefresh,
  runStatus,
  runSync,
  runUnlink,
  type WorkspaceDeps,
} from "../../src/cli/cmd/workspace"
import { linkHeadless, matchWorkspace, type LinkHeadlessDeps } from "../../src/cli/cmd/link"

const binding = {
  datamateId: 35,
  datamateName: "Growth",
  repoRemote: "git@github.com:acme/analytics.git",
  projectPath: null,
  linkedAt: 0,
} as any

describe("workspace status wording", () => {
  test("an unlinked project says so and how to link", () => {
    const lines = describeStatus({ binding: null, memory: null, skillsEnabled: true, skillsSyncedAt: null })
    expect(lines[0]).toBe("This project is not linked to a workspace.")
    expect(lines.join("\n")).toContain("altimate-code link")
  })

  test("unknown is never rendered as zero, and off is not rendered as synced", () => {
    const unknown = describeStatus({ binding, memory: { local: 4, unsynced: null }, skillsEnabled: true, skillsSyncedAt: null })
    expect(unknown.join("\n")).toContain("not known")
    expect(unknown.join("\n")).not.toContain("all in the workspace")
    expect(unknown.join("\n")).toContain("not synced by this process yet")

    const off = describeStatus({ binding, memory: null, skillsEnabled: false, skillsSyncedAt: null })
    expect(off).toContain("Memory: off.")
    expect(off).toContain("Workspace skills: off.")
  })

  test("pending memory points at the sync command", () => {
    const now = 1_000_000_000
    const lines = describeStatus(
      { binding, memory: { local: 4, unsynced: 3 }, skillsEnabled: true, skillsSyncedAt: now - 6 * 60_000 },
      now,
    )
    expect(lines[0]).toBe('Linked to workspace "Growth" (id 35).')
    expect(lines).toContain("Matched by git remote: git@github.com:acme/analytics.git")
    expect(lines.join("\n")).toContain("3 not yet in the workspace — run `altimate-code workspace sync`")
    expect(lines).toContain("Workspace skills: last synced 6m ago.")
  })
})

describe("ago", () => {
  test("boundaries", () => {
    const now = 10_000_000_000
    expect(ago(null, now)).toBeNull()
    expect(ago(now + 5_000, now)).toBe("just now") // clock skew is not negative time
    expect(ago(now - 59_999, now)).toBe("just now")
    expect(ago(now - 60_000, now)).toBe("1m ago")
    expect(ago(now - 3_600_000, now)).toBe("1h ago")
    expect(ago(now - 48 * 3_600_000, now)).toBe("2d ago")
  })
})

describe("workspace sync exit codes", () => {
  const base = { gated: false, sent: 0, failed: 0, skipped: 0, declined: 0, deferred: 0 }
  test("not linked is its own code; memory off is not a failure; unreadable state is", () => {
    expect(describeSync({ ...base, gated: true, gatedBecause: "no-binding" }).code).toBe(EXIT.NOT_LINKED)
    expect(describeSync({ ...base, gated: true, gatedBecause: "memory-off" }).code).toBe(EXIT.OK)
    expect(describeSync({ ...base, gated: true, gatedBecause: "read-failed" }).code).toBe(EXIT.FAILED)
    expect(describeSync({ ...base, gated: true, gatedBecause: "setting-unavailable" }).code).toBe(EXIT.FAILED)
    expect(describeSync({ ...base, gated: true, gatedBecause: "pin-unresolved" }).code).toBe(EXIT.FAILED)
  })
  test("a sweep with failures or refusals fails; held-back items alone do not", () => {
    expect(describeSync({ ...base, sent: 2, skipped: 1 }).code).toBe(EXIT.OK)
    expect(describeSync({ ...base, sent: 2, failed: 1 }).code).toBe(EXIT.FAILED)
    expect(describeSync({ ...base, declined: 1 }).code).toBe(EXIT.FAILED)
    const deferred = describeSync({ ...base, deferred: 2 })
    expect(deferred.code).toBe(EXIT.OK)
    expect(deferred.lines.join("\n")).toContain("retried")
  })
})

describe("workspace refresh", () => {
  test("errors fail the command; skipped skills are listed", () => {
    const ok = describeRefresh({ skillsChanged: true, skillsSkipped: [{ skill: "a", reason: "it is too large for this client" }], errors: [] } as any)
    expect(ok.code).toBe(EXIT.OK)
    expect(ok.lines.join("\n")).toContain("a: it is too large for this client")
    expect(describeRefresh({ skillsChanged: false, skillsSkipped: [], errors: ["offline"] } as any).code).toBe(EXIT.FAILED)
  })
})

describe("link --workspace matching", () => {
  const list = [
    { id: 7, name: "Growth" },
    { id: 35, name: "growth " },
    { id: 9, name: "Finance" },
    { id: 12, name: "35" },
  ] as any
  test("an id wins over a name that looks like an id", () => {
    expect(matchWorkspace(list, "35")).toEqual({ kind: "one", workspace: list[1] })
  })
  test("a name matches case-insensitively and trimmed", () => {
    expect(matchWorkspace(list, " finance ")).toEqual({ kind: "one", workspace: list[2] })
  })
  test("a name shared by two workspaces is ambiguous", () => {
    const r = matchWorkspace(list, "GROWTH")
    expect(r.kind).toBe("many")
  })
  test("an id matches its workspace, and nothing matches otherwise", () => {
    expect(matchWorkspace(list, "12")).toEqual({ kind: "one", workspace: list[3] })
    expect(matchWorkspace(list, "Marketing")).toEqual({ kind: "none" })
    expect(matchWorkspace(list, "")).toEqual({ kind: "none" })
  })
})

// ---------------------------------------------------------------------------
// Handlers: exit codes, refusals, and that a refusal changes nothing
// ---------------------------------------------------------------------------

const statusReport = { binding, memory: null, skillsEnabled: true, skillsSyncedAt: null } as any
const unlinkReport = { was: binding, removedServerSide: true, skillsPurged: true, skillsLeftBehind: false } as any

function fakeDeps(over: Partial<WorkspaceDeps> = {}) {
  const calls: string[] = []
  const out: string[] = []
  const err: string[] = []
  const json: any[] = []
  const deps: WorkspaceDeps = {
    isConfigured: async () => true,
    resolve: async () => ({ status: "bound", binding }),
    status: async () => (calls.push("status"), statusReport),
    refresh: async () => (calls.push("refresh"), { skillsChanged: false, skillsSkipped: [], errors: [] } as any),
    sync: async () => (calls.push("sync"), { gated: false, sent: 1, failed: 0, skipped: 0, declined: 0, deferred: 0 }),
    unlink: async () => (calls.push("unlink"), unlinkReport),
    confirm: async () => (calls.push("confirm"), true),
    isTTY: () => true,
    print: (l) => void out.push(l),
    printError: (l) => void err.push(l),
    printJson: (p) => void json.push(p),
    ...over,
  }
  return { deps, calls, out, err, json }
}

describe("workspace subcommands", () => {
  test("not signed in: every subcommand exits 2 and touches nothing", async () => {
    for (const run of [
      (d: WorkspaceDeps) => runStatus("/p", false, d),
      (d: WorkspaceDeps) => runRefresh("/p", false, d),
      (d: WorkspaceDeps) => runSync("/p", false, d),
      (d: WorkspaceDeps) => runUnlink("/p", false, true, d),
    ]) {
      const f = fakeDeps({ isConfigured: async () => false })
      expect(await run(f.deps)).toBe(EXIT.USAGE)
      expect(f.calls).toEqual([])
    }
  })

  test("a service that cannot be reached is a failure (1), never 'not linked' (3)", async () => {
    for (const run of [
      (d: WorkspaceDeps) => runStatus("/p", true, d),
      (d: WorkspaceDeps) => runRefresh("/p", true, d),
      (d: WorkspaceDeps) => runSync("/p", true, d),
      (d: WorkspaceDeps) => runUnlink("/p", true, true, d),
    ]) {
      const f = fakeDeps({ resolve: async () => ({ status: "unknown" }) })
      expect(await run(f.deps)).toBe(EXIT.FAILED)
      expect(f.calls).toEqual([])
      expect(f.json[0]).toMatchObject({ ok: false })
    }
  })

  test("a confirmed 'not linked' is 3 for every subcommand, with ok false", async () => {
    for (const run of [
      (d: WorkspaceDeps) => runStatus("/p", true, d),
      (d: WorkspaceDeps) => runRefresh("/p", true, d),
      (d: WorkspaceDeps) => runSync("/p", true, d),
      (d: WorkspaceDeps) => runUnlink("/p", true, true, d),
    ]) {
      const f = fakeDeps({ resolve: async () => ({ status: "unbound" }) })
      expect(await run(f.deps)).toBe(EXIT.NOT_LINKED)
      expect(f.calls).toEqual([])
      expect(f.json[0]).toMatchObject({ ok: false, linked: false })
    }
  })

  test("status of a linked project exits 0; a link the service could not confirm says so", async () => {
    const f = fakeDeps({ resolve: async () => ({ status: "bound", binding, stale: true }) })
    expect(await runStatus("/p", false, f.deps)).toBe(EXIT.OK)
    expect(f.out.join("\n")).toContain("Last known link")
  })

  test("sync on a fresh clone uses the link found on the service, but refuses to send to one never confirmed here", async () => {
    const fresh = fakeDeps()
    expect(await runSync("/p", false, fresh.deps)).toBe(EXIT.OK)
    expect(fresh.calls).toEqual(["sync"])

    const adopted = fakeDeps({ resolve: async () => ({ status: "bound", binding: { ...binding, adopted: true } }) })
    expect(await runSync("/p", false, adopted.deps)).toBe(EXIT.USAGE)
    expect(adopted.calls).toEqual([])
    expect(adopted.err.join("\n")).toContain("altimate-code link --workspace 35")
  })

  test("unlink without --yes and without a terminal, or with --json, refuses and unlinks nothing", async () => {
    const noTty = fakeDeps({ isTTY: () => false })
    expect(await runUnlink("/p", false, false, noTty.deps)).toBe(EXIT.USAGE)
    expect(noTty.calls).toEqual([])
    const json = fakeDeps()
    expect(await runUnlink("/p", true, false, json.deps)).toBe(EXIT.USAGE)
    expect(json.calls).toEqual([])
  })

  test("a declined unlink changes nothing and exits 0; a confirmed one unlinks", async () => {
    const declined = fakeDeps({ confirm: async () => false })
    expect(await runUnlink("/p", false, false, declined.deps)).toBe(EXIT.OK)
    expect(declined.calls).not.toContain("unlink")
    const confirmed = fakeDeps()
    expect(await runUnlink("/p", false, false, confirmed.deps)).toBe(EXIT.OK)
    expect(confirmed.calls).toEqual(["confirm", "unlink"])
  })

  test("an unlink that left the workspace's skills on disk is not a success", async () => {
    const f = fakeDeps({ unlink: async () => ({ ...unlinkReport, skillsLeftBehind: true }) })
    expect(await runUnlink("/p", true, true, f.deps)).toBe(EXIT.FAILED)
    expect(f.json[0]).toMatchObject({ ok: false, unlinked: true, skillsLeftBehind: true })
  })

  test("a workspace name cannot rewrite the terminal; --json keeps it as sent", async () => {
    const evil = { ...binding, datamateName: "Gro\u001b]8;;http://x\u0007wth" }
    let asked = ""
    const f = fakeDeps({
      resolve: async () => ({ status: "bound", binding: evil }),
      unlink: async () => ({ ...unlinkReport, was: evil }),
      confirm: async (m) => ((asked = m), true),
    })
    await runUnlink("/p", false, false, f.deps)
    expect(asked).toContain("Gro")
    expect(asked).not.toContain("\u001b")
    expect(f.out.join("\n")).not.toContain("\u001b")
    const j = fakeDeps({ resolve: async () => ({ status: "bound", binding: evil }), status: async () => ({ ...statusReport, binding: evil }) })
    await runStatus("/p", true, j.deps)
    expect(j.json[0].binding.datamateName).toBe(evil.datamateName)
  })

  test("--json: ok is true exactly when the exit code is 0", async () => {
    const f = fakeDeps({ sync: async () => ({ gated: false, sent: 0, failed: 1, skipped: 0, declined: 0, deferred: 0 }) })
    expect(await runSync("/p", true, f.deps)).toBe(EXIT.FAILED)
    expect(f.json[0].ok).toBe(false)
  })
})

describe("link --workspace / --create without prompting", () => {
  const dir = process.cwd()
  const actAs = { token: "t" } as any
  const growth = { id: 35, name: "Growth" }
  function linkDeps(over: Partial<LinkHeadlessDeps> = {}) {
    const calls: string[] = []
    const out: string[] = []
    const err: string[] = []
    const deps: LinkHeadlessDeps = {
      isConfigured: async () => true,
      getBindingForProject: async () => null,
      captureCredentials: async () => actAs,
      listDatamates: async () => [growth, { id: 9, name: "Finance" }] as any,
      bindOrRebind: async (_i, id) => void calls.push(`bind:${id}`),
      create: async (_i, name) => void calls.push(`create:${name}`),
      print: (l) => void out.push(l),
      printError: (l) => void err.push(l),
      ...over,
    }
    return { deps, calls, out, err }
  }
  afterEach(() => {
    process.exitCode = 0
  })

  test("both flags, an empty --workspace, or no sign-in: exit 2 and nothing changes", async () => {
    for (const [args, over] of [
      [{ workspace: "35", create: "x" }, {}],
      [{ workspace: " " }, {}],
      [{ workspace: "35" }, { isConfigured: async () => false }],
    ] as const) {
      const f = linkDeps(over as any)
      process.exitCode = 0
      await linkHeadless({ directory: dir, yes: false, ...(args as any) }, f.deps)
      expect(process.exitCode).toBe(2)
      expect(f.calls).toEqual([])
    }
  })

  test("a pre-check that fails stops with exit 1 and binds nothing", async () => {
    const f = linkDeps({ getBindingForProject: async () => { throw new Error("offline") } })
    await linkHeadless({ directory: dir, workspace: "35", yes: true }, f.deps)
    expect(process.exitCode).toBe(1)
    expect(f.calls).toEqual([])
  })

  test("already linked to the requested workspace: exit 0, nothing changed", async () => {
    const f = linkDeps({ getBindingForProject: async () => ({ datamate: growth }) as any })
    await linkHeadless({ directory: dir, workspace: "35", yes: false }, f.deps)
    expect(process.exitCode ?? 0).toBe(0)
    expect(f.calls).toEqual([])
    expect(f.out.join("\n")).toContain("nothing changed")
  })

  test("re-linking to a different workspace needs --yes", async () => {
    const f = linkDeps({ getBindingForProject: async () => ({ datamate: growth }) as any })
    await linkHeadless({ directory: dir, workspace: "9", yes: false }, f.deps)
    expect(process.exitCode).toBe(2)
    expect(f.calls).toEqual([])
    process.exitCode = 0
    await linkHeadless({ directory: dir, workspace: "9", yes: true }, f.deps)
    expect(f.calls).toEqual(["bind:9"])
  })

  test("--create run again on a project linked to that name changes nothing (devcontainer rebuilds)", async () => {
    const f = linkDeps({ getBindingForProject: async () => ({ datamate: growth }) as any })
    await linkHeadless({ directory: dir, create: "growth", yes: true }, f.deps)
    expect(process.exitCode ?? 0).toBe(0)
    expect(f.calls).toEqual([])
  })

  test("--create refuses a name another workspace already has, unless --allow-duplicate", async () => {
    const f = linkDeps()
    await linkHeadless({ directory: dir, create: "Growth", yes: false }, f.deps)
    expect(process.exitCode).toBe(2)
    expect(f.calls).toEqual([])
    expect(f.err.join("\n")).toContain("--workspace 35")
    process.exitCode = 0
    await linkHeadless({ directory: dir, create: "Growth", yes: false, allowDuplicate: true }, f.deps)
    expect(f.calls).toEqual(["create:Growth"])
  })

  test("--create with a new name creates it", async () => {
    const f = linkDeps()
    await linkHeadless({ directory: dir, create: "Marketing", yes: false }, f.deps)
    expect(f.calls).toEqual(["create:Marketing"])
  })
})
