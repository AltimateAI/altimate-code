// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { EXIT, ago, describeRefresh, describeStatus, describeSync } from "../../src/cli/cmd/workspace"
import { matchWorkspace } from "../../src/cli/cmd/link"

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
