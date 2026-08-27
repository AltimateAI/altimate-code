// L3 gate experiments (v2, against 2d8bea2d0) — snapshot freshness around planForEntry / Inspection.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ensure, resetForTests, syncInternals, type LocalMcpConfig } from "../../../src/altimate/workspace/engine-sync"
import type { CachedBinding } from "../../../src/altimate/workspace/state"
import type { ExistingEntry } from "../../../src/altimate/workspace/engine-sync"

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
  probes: string[]
}

function install(statuses: H["statusQueue"], entry: () => ExistingEntry | null): H {
  const h: H = { added: [], persisted: [], connects: [], removes: [], toasts: [], statusQueue: statuses, reads: [], probes: [] }
  syncInternals.resolveBinding = async () => binding
  syncInternals.which = () => "/usr/local/bin/datamate"
  syncInternals.versionOf = async (bin) => {
    h.probes.push(bin)
    return "0.7.0"
  }
  syncInternals.declared = async () => ({ keys: ["dbt_build_model"], extensionKeys: [] })
  syncInternals.persist = async (name, cfg) => {
    h.persisted.push({ name, cfg })
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
  syncInternals.mcp = {
    status: async () => (h.statusQueue.length > 1 ? h.statusQueue.shift()! : h.statusQueue[0]!),
    add: async (name, cfg) => {
      h.added.push({ name, cfg })
    },
    connect: async (name) => {
      h.connects.push(name)
    },
    remove: async (name) => {
      h.removes.push(name)
    },
    tools: async () => ({ datamate_dbt_build_model: 1 }),
  }
  // The project file has no entry of its own unless a test says otherwise.
  // Required since the project reader stopped swallowing its own errors.
  if (!syncInternals.projectEntry) syncInternals.projectEntry = async () => null
  if (!syncInternals.projectConfigPath)
    syncInternals.projectConfigPath = async () => "/tmp/test/.altimate-code/altimate-code.json"
  return h
}

beforeEach(() => {
  process.env.ALTIMATE_WORKSPACE = "1"
  resetForTests()
})
afterEach(() => {
  for (const key of Object.keys(syncInternals) as Array<keyof typeof syncInternals>) delete syncInternals[key]
})

describe("L3 (a') — a disable lands INSIDE the retry's connect window", () => {
  test("FIXED by 5fe9d8a6a: the retry re-inspects both halves, so a disable that survives on disk is honoured", async () => {
    let enabled = true
    const h = install(
      [{ datamate: { status: "failed", error: "exit 1" } }, { datamate: { status: "connected" } }],
      () => ({ type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled }),
    )
    // ADAPTED ON LIFT: the retry re-adds instead of connecting.
    const previousAddA = syncInternals.mcp!.add
    syncInternals.mcp!.add = async (name, cfg) => {
      enabled = false
      return previousAddA(name, cfg)
    }
    const outcome = await ensure("s1")
    expect(h.connects, "repaired with the config-writing primitive").toHaveLength(0)
    expect(h.reads, "inspection, pre-revive guard, re-inspection").toEqual([true, true, false]) // two inspections
    expect(outcome.kind).toBe("entry-disabled")
    expect(h.removes).toEqual(["datamate"])
  })

  test("RESIDUAL: MCP.connect's persistMcpEnabled(true) RMW rewrites the disable before the re-inspection can see it", async () => {
    let enabled = true
    const h = install(
      [
        { datamate: { status: "failed", error: "exit 1" } },
        { datamate: { status: "connected" } },
        { datamate: { status: "connected" } },
        { datamate: { status: "connected" } },
      ],
      () => ({ type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled }),
    )
    syncInternals.mcp!.connect = async (name) => {
      h.connects.push(name)
      enabled = false // the user's disable lands during the handshake (mcp/index.ts:914 createAndStore)
      enabled = true // ...and connect's persistMcpEnabled(name, true) RMW (mcp/index.ts:917 → 986-988) writes over it
    }
    expect((await ensure("s1")).kind).toBe("reused")
    expect((await ensure("s1")).kind).toBe("reused")
    // One more read than before: the pre-revive guard now confirms intent as
    // well as the binding before starting anything.
    expect(h.reads).toEqual([true, true, true, true])
    expect(h.removes).toEqual([])
  })
})

describe("L3 (c) — MCP.disconnect lands between the config read and the status read inside inspectEntry", () => {
  test("RESIDUAL: planForEntry sees enabled+disabled → retry-connect → MCP.connect is invoked", async () => {
    let enabled = true
    const h = install([{ datamate: { status: "disabled" } }, { datamate: { status: "connected" } }], () => ({
      type: "local",
      command: ["datamate", "start-stdio", "--datamate", "42"],
      enabled,
    }))
    const realStatus = syncInternals.mcp!.status
    syncInternals.mcp!.status = async () => {
      // disconnect (prompt.ts:3004 / routes/mcp.ts:228): status → disabled, disk → enabled:false
      enabled = false
      return realStatus()
    }
    // ADAPTED ON LIFT — the residual this documented is closed. It existed
    // because `MCP.connect` performed a read-modify-write of `enabled: true`,
    // reverting a disable that had just landed. The retry re-adds now and writes
    // no config, so nothing reverts the user's edit.
    const previousAddC = syncInternals.mcp!.add
    syncInternals.mcp!.add = async (name, cfg) => previousAddC(name, cfg)
    const outcome = await ensure("s1")
    expect(h.connects, "reverted a disable by repairing through the config-writing primitive").toHaveLength(0)
    // Better than the `reused` this documented, and better than a bare
    // `superseded`: the re-inspection sees the disable and names it.
    expect(outcome.kind).toBe("entry-disabled")
  })

  test("control: the same disconnect landing BEFORE the config read is honoured", async () => {
    const h = install([{ datamate: { status: "disabled" } }], () => ({
      type: "local",
      command: ["datamate", "start-stdio", "--datamate", "42"],
      enabled: false,
    }))
    expect((await ensure("s1")).kind).toBe("entry-disabled")
    expect(h.connects).toEqual([])
  })
})

describe("L3 (f) — the plan derived from an Inspection is held across the probes, then persist writes enabled:true", () => {
  test("replace-unattributable: a disable landing during the PATH probe is persisted over, and the memo never re-checks", async () => {
    // The extension's own entry: unpinned, live. Rule 1 replaces it.
    let onDisk: ExistingEntry = { type: "local", command: ["datamate", "start-stdio"], enabled: true }
    const h = install(
      [{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }, { datamate: { status: "connected" } }],
      () => onDisk,
    )
    // The user disables the entry while the flow is probing `datamate --version`
    // on PATH (seconds: declaredBounded up to 4s, versionOf ~1s, projectEntry).
    syncInternals.versionOf = async (bin) => {
      h.probes.push(bin)
      onDisk = { ...onDisk, enabled: false }
      return "0.7.0"
    }
    // persist() replaces the whole `mcp.datamate` node in the project file
    // (mcp/config.ts:54-59), so a later fresh read returns OUR entry.
    syncInternals.persist = async (name, cfg) => {
      h.persisted.push({ name, cfg })
      onDisk = { type: "local", command: cfg.command, enabled: cfg.enabled }
    }
    const first = await ensure("s1")
    // INVERTED ON LIFT. This file documents current behaviour, and the behaviour
    // it documented was the defect: the plan was held across the probes and then
    // persisted our `enabled: true` over a disable that had landed meanwhile,
    // after which the memo read our own entry and stood forever. The guard
    // re-reads intent as well as the binding now, so the write never happens —
    // and it reports WHICH half moved, so the user learns their edit took
    // effect rather than being told about a generic race.
    expect(first.kind).toBe("entry-disabled")
    expect(h.persisted, "wrote our pinned enabled:true over a disable that landed during the probes").toHaveLength(0)
    expect(h.added, "installed over a disable that landed during the probes").toHaveLength(0)

    // Next turn: the memo validator reads fresh config — which is now our pinned, enabled entry.
    const second = await ensure("s1")
    // The next turn re-decides rather than riding a memo: it reads the disable
    // and reports it by name.
    expect(second.kind).toBe("entry-disabled")
    // Three teardowns now, all correct: the pre-spawn detach of the unpinned
    // entry, the disabled entry's teardown when the guard catches the disable
    // before the write, and its teardown again on the next turn. A disabled
    // entry serves nothing, so it is never left registered.
    expect(h.removes).toEqual(["datamate", "datamate", "datamate"])
  })

  test("same shape on the pinned-but-below-floor path", async () => {
    let onDisk: ExistingEntry = { type: "local", command: ["/opt/old/datamate", "start-stdio", "--datamate", "42"], enabled: true }
    const h = install([{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }], () => onDisk)
    syncInternals.versionOf = async (bin) => {
      h.probes.push(bin)
      if (bin.startsWith("/opt/old")) return "0.6.3"
      onDisk = { ...onDisk, enabled: false } // disable lands during the PATH probe
      return "0.7.0"
    }
    syncInternals.persist = async (name, cfg) => {
      h.persisted.push({ name, cfg })
      onDisk = { type: "local", command: cfg.command, enabled: cfg.enabled }
    }
    const first = await ensure("s1")
    // INVERTED ON LIFT — same shape, same fix.
    expect(first.kind).toBe("entry-disabled")
    expect(h.persisted, "wrote our pinned enabled:true over a disable that landed during the probes").toHaveLength(0)
  })

  test("control: a disable that lands BEFORE the inspection is honoured on the same entry", async () => {
    const h = install([{ datamate: { status: "connected" } }], () => ({
      type: "local",
      command: ["datamate", "start-stdio"],
      enabled: false,
    }))
    expect((await ensure("s1")).kind).toBe("entry-disabled")
    expect(h.persisted).toHaveLength(0)
  })
})

describe("L3 (a)/(b) — edits between the two reads inside inspectEntry (no retry)", () => {
  test("(a) disable after the config read, client live → reused one turn, repaired next turn, no persist", async () => {
    let enabled = true
    const h = install([{ datamate: { status: "connected" } }], () => ({
      type: "local",
      command: ["datamate", "start-stdio", "--datamate", "42"],
      enabled,
    }))
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

  test("(b) re-enable after the config read → honour-disable on the stale half, config untouched, next turn repairs", async () => {
    let enabled = false
    const h = install(
      [{ datamate: { status: "connected" } }, { datamate: { status: "disabled" } }, { datamate: { status: "connected" } }],
      () => ({ type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled }),
    )
    const realStatus = syncInternals.mcp!.status
    syncInternals.mcp!.status = async () => {
      enabled = true
      return realStatus()
    }
    expect((await ensure("s1")).kind).toBe("entry-disabled")
    expect(h.persisted).toEqual([])
    expect(["reused", "attached"]).toContain((await ensure("s1")).kind)
  })

  test("(inverted round-12) IDE adds the entry after the config read → spawn persists over it, unreported", async () => {
    let onDisk: ExistingEntry | null = null
    const h = install([{}, { datamate: { status: "connected" } }], () => onDisk)
    const realStatus = syncInternals.mcp!.status
    syncInternals.mcp!.status = async () => {
      onDisk = { type: "local", command: ["datamate", "start-stdio"], enabled: true } // IDE sync lands here
      return realStatus()
    }
    const outcome = await ensure("s1")
    expect(outcome.kind).toBe("attached")
    expect((outcome as { replaced?: string }).replaced).toBeUndefined()
    expect(h.persisted).toHaveLength(1)
    expect(h.removes).toEqual([])
  })
})
