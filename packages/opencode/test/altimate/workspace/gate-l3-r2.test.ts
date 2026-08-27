// L3 round-2 experiments against 16b47ddb4. Not part of the suite.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ensure, resetForTests, syncInternals, type LocalMcpConfig } from "../../../src/altimate/workspace/engine-sync"
import type { CachedBinding } from "../../../src/altimate/workspace/state"
import type { ExistingEntry } from "../../../src/altimate/workspace/engine-sync"
import { Config } from "../../../src/config/config"
import { addMcpToConfig, readMcpEntryFromDisk } from "../../../src/mcp/config"

const binding: CachedBinding = {
  datamateId: 42,
  datamateName: "analytics",
  repoRemote: "git@github.com:acme/analytics.git",
  projectPath: "/tmp/analytics",
} as CachedBinding

type H = {
  added: Array<{ name: string; cfg: LocalMcpConfig }>
  persisted: Array<{ name: string; cfg: LocalMcpConfig }>
  connects: string[]
  removes: string[]
  toasts: string[]
  statusQueue: Array<Record<string, { status: string; error?: string } | undefined>>
  reads: Array<boolean | undefined>
  spawnedNow?: ExistingEntry
  bindingCalls: number
}

function install(
  statuses: H["statusQueue"],
  entry: () => ExistingEntry | null,
  opts: { realPersist?: boolean; spawned?: ExistingEntry } = {},
): H {
  const h: H = {
    added: [],
    persisted: [],
    connects: [],
    removes: [],
    toasts: [],
    statusQueue: statuses,
    reads: [],
    spawnedNow: opts.spawned,
    bindingCalls: 0,
  }
  syncInternals.resolveBinding = async () => {
    h.bindingCalls += 1
    return binding
  }
  syncInternals.which = () => "/usr/local/bin/datamate"
  syncInternals.versionOf = async () => "0.7.0"
  syncInternals.declared = async () => ({ keys: ["dbt_build_model"], extensionKeys: [] })
  if (!opts.realPersist) {
    syncInternals.persist = async (name, cfg) => {
      h.persisted.push({ name, cfg })
    }
  }
  syncInternals.existingEntry = async () => {
    const e = entry()
    h.reads.push(e?.enabled)
    return e
  }
  syncInternals.notify = async (t) => {
    h.toasts.push(t.title)
  }
  syncInternals.toolsChanged = async () => {}
  syncInternals.persistRestore = async () => {}
  syncInternals.projectEntry = async () => null
  syncInternals.projectConfigPath = async () => "/tmp/test/.altimate-code/altimate-code.json"
  syncInternals.mcp = {
    status: async () => (h.statusQueue.length > 1 ? h.statusQueue.shift()! : h.statusQueue[0]!),
    add: async (name, cfg) => {
      h.added.push({ name, cfg })
      h.spawnedNow = cfg as ExistingEntry
    },
    remove: async (name) => {
      h.removes.push(name)
      h.spawnedNow = undefined
    },
    spawned: async () => h.spawnedNow,
    tools: async () => ({ datamate_dbt_build_model: 1 }),
  }
  return h
}

beforeEach(() => {
  process.env.ALTIMATE_WORKSPACE = "1"
  resetForTests()
})
afterEach(() => {
  for (const key of Object.keys(syncInternals) as Array<keyof typeof syncInternals>) delete syncInternals[key]
})

describe("R1 — the world guard's intent read vs the write: REAL persist on a real file", () => {
  // No persist seam: the production `persist` → `addMcpToConfig` runs against a
  // temp file. Only `Config.invalidate` is spied to a no-op (no instance here).
  let dir: string
  let file: string
  let invalidateSpy: ReturnType<typeof spyOn>
  const unpinned: ExistingEntry = { type: "local", command: ["datamate", "start-stdio"], enabled: true }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "l3r2-"))
    file = path.join(dir, "altimate-code.json")
    await addMcpToConfig("datamate", unpinned as never, file)
    invalidateSpy = spyOn(Config, "invalidate").mockImplementation(async () => {})
  })
  afterEach(() => invalidateSpy.mockRestore())

  const diskEntry = async () => (await readMcpEntryFromDisk("datamate", file)) as ExistingEntry | undefined

  function realInstall(landDisableAtIntentReads: number) {
    let landed = false
    const h = install([{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }], () => null, {
      realPersist: true,
    })
    syncInternals.projectConfigPath = async () => file
    // RE-STAGED ON LIFT. The guard now reads the binding FIRST and intent LAST,
    // so "after the guard's intent read and before the write" is no longer a
    // window that a later binding read can be used to land in — the intent read
    // IS the last thing before persist. The disable therefore lands at the end
    // of that read, which is the narrowest and only remaining gap, and exactly
    // the one persist's own re-read of the node it replaces exists to close.
    syncInternals.existingEntry = async () => {
      const e = (await diskEntry()) ?? null
      h.reads.push(e?.enabled)
      if (!landed && h.reads.length === landDisableAtIntentReads) {
        landed = true
        const now = (await diskEntry())!
        await addMcpToConfig("datamate", { ...now, enabled: false } as never, file)
      }
      return e
    }
    syncInternals.projectEntry = async () => (await diskEntry()) ?? null
    syncInternals.resolveBinding = async () => {
      h.bindingCalls += 1
      return binding
    }
    return h
  }

  test("disable lands between the guard's intent read and persist's write → written over, memo stands", async () => {
    // reads: inspect#1 (1), worldUnchanged intent (2) → land during the binding read that follows.
    const h = realInstall(2)
    const first = await ensure("s1")
    const after = await diskEntry()
    console.log("R1 outcome:", JSON.stringify(first), "disk:", JSON.stringify(after), "reads:", h.reads)
    // INVERTED ON LIFT — this is the finding, and it is closed at the syscall.
    // No guard the caller can hold covers the gap between confirming intent and
    // the write itself, so `persist` re-reads the node it is about to replace
    // and refuses when that node says disabled. The write never happens, and
    // because it never happens the post-install check no longer reads a file we
    // wrote and conclude there is nothing to undo.
    expect(first.kind).toBe("entry-disabled")
    expect(after?.enabled, "the user's disable was written over").toBe(false)
    expect(after?.command, "disk still holds the USER's entry").toEqual(["datamate", "start-stdio"])
    expect(h.added, "installed over a disable").toHaveLength(0)
    // Next turn re-decides from disk and reaches the same answer.
    const second = await ensure("s1")
    expect(second.kind).toBe("entry-disabled")
    expect(readFileSync(file, "utf8")).toContain('"enabled": false')
  })

  test("control: the same disable landing BEFORE the guard's intent read is caught → superseded, disk keeps it", async () => {
    // reads: inspect#1 (1) → land during detachRejected's binding read (before worldUnchanged reads intent).
    const h = realInstall(1)
    const first = await ensure("s1")
    const after = await diskEntry()
    console.log("R1 control:", JSON.stringify(first), "disk:", JSON.stringify(after), "reads:", h.reads)
    // ADAPTED ON LIFT: still caught, and now reported by name. The guard knows
    // WHICH half of the world moved, and "you switched this off" is a more
    // useful answer than "something changed, try again".
    expect(first.kind).toBe("entry-disabled")
    expect(after?.enabled).toBe(false)
    expect(after?.command).toEqual(["datamate", "start-stdio"])
    expect(h.added).toHaveLength(0)
  })
})

describe("R2 — retry path: a disable between inspection #1 and the revive add", () => {
  test("spawns then tears down; writes nothing", async () => {
    let enabled = true
    const h = install(
      [{ datamate: { status: "failed", error: "exit 1" } }, { datamate: { status: "connected" } }],
      () => ({ type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled }),
    )
    // RE-STAGED ON LIFT (twice). The disable has to land after inspection #1 and
    // before the revive guard reads intent, and the guard's read order moved
    // under this test — binding-first, then back to intent-first — so keying the
    // trigger to a binding read no longer places it in the intended window. It
    // lands at the end of inspection #1 instead, which is that window's opening
    // edge and is stable against the guard's internal ordering.
    const realEntry = syncInternals.existingEntry!
    syncInternals.existingEntry = async (name: string) => {
      const e = await realEntry(name)
      if (h.reads.length === 1) enabled = false
      return e
    }
    const outcome = await ensure("s1")
    // INVERTED ON LIFT: the revive guard checks the whole world now, so the
    // entry is never started. Start-then-tear-down was the shape this branch
    // already judged worse than never-started.
    expect(outcome.kind).toBe("entry-disabled")
    expect(h.added, "revived the entry the user had just disabled").toHaveLength(0)
    expect(h.removes).toEqual(["datamate"])
    expect(h.persisted).toHaveLength(0)
    expect(h.connects).toHaveLength(0)
  })
})

describe("R3 — an IDE rewrite between persist and add", () => {
  test("this turn: attached with disk unpinned; next turn: our own engine is replaced", async () => {
    let onDisk: ExistingEntry | null = null
    const h = install([{}, { datamate: { status: "connected" } }, { datamate: { status: "connected" } }], () => onDisk)
    syncInternals.persist = async (name, cfg) => {
      h.persisted.push({ name, cfg })
      onDisk = { type: "local", command: cfg.command, enabled: true }
    }
    const prevAdd = syncInternals.mcp!.add
    syncInternals.mcp!.add = async (n, c) => {
      // IDE sync lands after our persist, before our add
      if (h.persisted.length === 1 && h.added.length === 0) onDisk = { type: "local", command: ["datamate", "start-stdio"], enabled: true }
      return prevAdd(n, c)
    }
    const first = await ensure("s1")
    expect(first.kind).toBe("attached")
    expect((onDisk as unknown as ExistingEntry)?.command).toEqual(["datamate", "start-stdio"])
    expect(h.spawnedNow?.command).toEqual(["datamate", "start-stdio", "--datamate", "42"])
    const second = await ensure("s1")
    console.log("R3 second:", JSON.stringify(second), "removes:", h.removes, "persisted:", h.persisted.length)
    expect(second).not.toBe(first)
    expect(h.removes).toEqual(["datamate"]) // tore down OUR correctly pinned engine because the file says unpinned
    expect(h.persisted).toHaveLength(2)
  })
})

describe("R4 — the spawned record: absent, stale, and cross-process", () => {
  test("(i) bootstrap failed (no record), config pinned to us → revived via add, never connect", async () => {
    const h = install(
      [{ datamate: { status: "failed", error: "spawn ENOENT" } }, { datamate: { status: "connected" } }],
      () => ({ type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: true }),
    )
    const outcome = await ensure("s1")
    expect(outcome.kind).toBe("reused")
    expect(h.added).toHaveLength(1)
    expect(h.connects).toHaveLength(0)
    expect(h.spawnedNow?.command).toEqual(["datamate", "start-stdio", "--datamate", "42"])
  })

  test("(ii) dead child, record still says pinned 5 (onclose does not clear it), file re-pinned to 42 → replaced, not revived", async () => {
    const h = install(
      [{ datamate: { status: "failed", error: "Connection closed" } }, { datamate: { status: "connected" } }],
      () => ({ type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: true }),
      { spawned: { type: "local", command: ["datamate", "start-stdio", "--datamate", "5"] } },
    )
    const outcome = await ensure("s1")
    expect(outcome).toMatchObject({ kind: "attached", replaced: "datamate start-stdio --datamate 5" })
    expect(h.removes).toEqual(["datamate"])
    expect(h.persisted).toHaveLength(1)
  })

  test("(iii) cross-process: B bootstrapped pinned 5, A re-pinned the shared file to 7, B now bound to 7 → B replaces its own client", async () => {
    syncInternals.resolveBinding = async () => ({ ...binding, datamateId: 7, datamateName: "seven" }) as CachedBinding
    const h = install(
      [{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }],
      () => ({ type: "local", command: ["datamate", "start-stdio", "--datamate", "7"], enabled: true }),
      { spawned: { type: "local", command: ["datamate", "start-stdio", "--datamate", "5"] } },
    )
    syncInternals.resolveBinding = async () => ({ ...binding, datamateId: 7, datamateName: "seven" }) as CachedBinding
    const outcome = await ensure("s1")
    expect(outcome).toMatchObject({ kind: "attached", replaced: "datamate start-stdio --datamate 5" })
    expect(h.removes).toEqual(["datamate"])
    expect(h.added[0]!.cfg.command).toEqual(["datamate", "start-stdio", "--datamate", "7"])
  })

  test("(iv) record present but the file entry was removed by another process → plan is spawn; runtime ignored", async () => {
    const h = install([{}, { datamate: { status: "connected" } }], () => null, {
      spawned: { type: "local", command: ["datamate", "start-stdio", "--datamate", "5"] },
    })
    const outcome = await ensure("s1")
    expect(outcome.kind).toBe("attached")
    expect((outcome as { replaced?: string }).replaced).toBeUndefined() // the 5-engine's replacement is unreported
    expect(h.removes).toHaveLength(0) // storeClient closes the previous client inside MCP; this module never says so
  })

  test("(v) memo path: record diverges from file after attach (file re-pinned to 7 under a 42 binding) → memo invalid, re-decided", async () => {
    let onDisk: ExistingEntry = { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: true }
    const h = install(
      [{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }, { datamate: { status: "connected" } }],
      () => onDisk,
      { spawned: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] } },
    )
    const first = await ensure("s1")
    expect(first.kind).toBe("reused")
    onDisk = { type: "local", command: ["datamate", "start-stdio", "--datamate", "7"], enabled: true }
    const second = await ensure("s1")
    expect(second).not.toBe(first)
    expect(h.removes).toEqual(["datamate"])
  })
})

describe("R5 — (a)/(b) between the two reads inside inspectEntry, unchanged from round 1", () => {
  test("(a) disable after the config read, client live → reused one turn, repaired next turn, no persist", async () => {
    let enabled = true
    const h = install([{ datamate: { status: "connected" } }], () => ({
      type: "local",
      command: ["datamate", "start-stdio", "--datamate", "42"],
      enabled,
    }), { spawned: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"] } })
    const realStatus = syncInternals.mcp!.status
    syncInternals.mcp!.status = async () => {
      enabled = false
      return realStatus()
    }
    expect((await ensure("s1")).kind).toBe("reused")
    expect(h.persisted).toEqual([])
    expect((await ensure("s1")).kind).toBe("entry-disabled")
    expect(h.removes).toEqual(["datamate"])
  })
})
