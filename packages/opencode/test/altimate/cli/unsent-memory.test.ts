// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { unsentMemoryNotice, unsentMemoryNoticeAfterRun, type UnsentMemoryDeps } from "../../../src/altimate/cli/unsent-memory"
import type { MirrorTarget } from "../../../src/altimate/workspace/memory-sync"

const binding = { datamateId: 46, datamateName: "Growth" } as any

function deps(over: Partial<UnsentMemoryDeps> = {}): UnsentMemoryDeps & { calls: number; dirs: string[] } {
  const d = {
    calls: 0,
    dirs: [] as string[],
    target: (): MirrorTarget | undefined => ({ directory: "/bound", binding }),
    status: async (directory: string) => {
      d.dirs.push(directory)
      d.calls++
      return { binding, memory: { local: 3, unsynced: 2 }, skillsEnabled: true, skillsSyncedAt: null } as any
    },
    ...over,
  }
  return d
}

describe("unsentMemoryNotice", () => {
  test("says nothing when every memory reached the workspace", () => {
    expect(unsentMemoryNotice(0)).toBeNull()
  })

  test("counts what is pending and points at workspace sync", () => {
    expect(unsentMemoryNotice(1)).toBe(
      "1 memory on this machine is not in the workspace yet. Run `altimate-code workspace sync` to send it.",
    )
    expect(unsentMemoryNotice(3)).toBe(
      "3 memories on this machine are not in the workspace yet. Run `altimate-code workspace sync` to send them.",
    )
  })

  test("an unknown count is reported as unknown, never as zero", () => {
    expect(unsentMemoryNotice(null)).toBe(
      "Could not confirm that the memory saved here reached the workspace. Run `altimate-code workspace status` to check.",
    )
  })
})

describe("unsentMemoryNoticeAfterRun", () => {
  test("a run that uploaded no memory to a linked workspace does not check at all", async () => {
    const d = deps({ target: () => undefined })
    expect(await unsentMemoryNoticeAfterRun("/p", 1000, d)).toBeNull()
    expect(d.calls).toBe(0)
  })

  test("a run that saved memory reports the pending count of the directory it uploaded from", async () => {
    const d = deps()
    expect(await unsentMemoryNoticeAfterRun("/p", 1000, d)).toContain("2 memories on this machine")
    expect(d.dirs).toEqual(["/bound"])
    const unscoped = deps({ target: () => ({ directory: undefined, binding }) })
    await unsentMemoryNoticeAfterRun("/p", 1000, unscoped)
    expect(unscoped.dirs).toEqual(["/p"])
  })

  test("an unreadable local count, a failed check or a slow one is reported as unknown", async () => {
    const unreadable = deps({ status: async () => ({ binding, memory: null, memoryUnreadable: true }) as any })
    expect(await unsentMemoryNoticeAfterRun("/p", 1000, unreadable)).toContain("Could not confirm")
    const failed = deps({ status: async () => Promise.reject(new Error("down")) })
    expect(await unsentMemoryNoticeAfterRun("/p", 1000, failed)).toContain("Could not confirm")
    const slow = deps({ status: () => new Promise(() => {}) })
    const started = Date.now()
    expect(await unsentMemoryNoticeAfterRun("/p", 20, slow)).toContain("Could not confirm")
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("an unlinked project, or memory off in this build, says nothing", async () => {
    const unlinked = deps({ status: async () => ({ binding: null, memory: { local: 1, unsynced: 0 } }) as any })
    expect(await unsentMemoryNoticeAfterRun("/p", 1000, unlinked)).toBeNull()
    const off = deps({ status: async () => ({ binding, memory: null }) as any })
    expect(await unsentMemoryNoticeAfterRun("/p", 1000, off)).toBeNull()
  })
})
