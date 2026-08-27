// L3 confirmation-pass experiments against 8c78d98eb. Not part of the suite.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ensure, resetForTests, settledOutcome, syncInternals, type LocalMcpConfig } from "../../../src/altimate/workspace/engine-sync"
import type { CachedBinding } from "../../../src/altimate/workspace/state"
import type { ExistingEntry } from "../../../src/altimate/workspace/engine-sync"
import { Config } from "../../../src/config/config"
import { Filesystem } from "../../../src/util/filesystem"
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
  removes: string[]
  restores: Array<ExistingEntry | null>
  toasts: Array<{ title: string; message: string }>
  statusQueue: Array<Record<string, { status: string; error?: string } | undefined>>
  reads: Array<boolean | undefined>
  spawnedNow?: ExistingEntry
}

function install(statuses: H["statusQueue"], entry: () => ExistingEntry | null, opts: { realPersist?: boolean; spawned?: ExistingEntry } = {}): H {
  const h: H = { added: [], persisted: [], removes: [], restores: [], toasts: [], statusQueue: statuses, reads: [], spawnedNow: opts.spawned }
  syncInternals.resolveBinding = async () => binding
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
    h.toasts.push({ title: t.title, message: t.message })
  }
  syncInternals.toolsChanged = async () => {}
  syncInternals.persistRestore = async (_n, prev) => {
    h.restores.push(prev)
  }
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

const DISABLED_FILE = JSON.stringify({ mcp: { datamate: { type: "local", command: ["datamate", "start-stdio"], enabled: false } } }, null, 2)
const PINNED42 = { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: true } as ExistingEntry

describe("AG — real persist: the check is on the same text the write modifies", () => {
  let file: string
  let invalidateSpy: ReturnType<typeof spyOn>
  const originalReadText = Filesystem.readText
  beforeEach(async () => {
    file = path.join(mkdtempSync(path.join(tmpdir(), "l3r4-")), "altimate-code.json")
    await addMcpToConfig("datamate", { type: "local", command: ["datamate", "start-stdio"], enabled: true } as never, file)
    invalidateSpy = spyOn(Config, "invalidate").mockImplementation(async () => {})
  })
  afterEach(() => {
    invalidateSpy.mockRestore()
    Filesystem.readText = originalReadText
  })
  const diskEntry = async () => (await readMcpEntryFromDisk("datamate", file)) as ExistingEntry | undefined

  /** After the guard's intent read, config-file readText #1 is now addMcpToConfig's
   * ONLY read (persist has no separate check read any more). */
  function stage(where: "intent-read-end" | "before-write-read" | "after-write-read") {
    const h = install([{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }], () => null, { realPersist: true })
    syncInternals.projectConfigPath = async () => file
    let armed = false
    let landed = false
    let n = 0
    syncInternals.existingEntry = async () => {
      const e = (await diskEntry()) ?? null
      h.reads.push(e?.enabled)
      if (h.reads.length === 2) {
        if (where === "intent-read-end" && !landed) {
          landed = true
          writeFileSync(file, DISABLED_FILE)
        }
        armed = true
      }
      return e
    }
    syncInternals.projectEntry = async () => (await diskEntry()) ?? null
    Filesystem.readText = async (p: string) => {
      if (!armed || p !== file || landed) return originalReadText(p)
      n += 1
      if (n !== 1) return originalReadText(p)
      landed = true
      if (where === "before-write-read") {
        writeFileSync(file, DISABLED_FILE)
        return originalReadText(p)
      }
      const text = await originalReadText(p)
      writeFileSync(file, DISABLED_FILE)
      return text
    }
    return { h, reads: () => n }
  }

  test("W1: disable at the end of the guard's intent read → refused by the write's own read", async () => {
    const { h } = stage("intent-read-end")
    const out = await ensure("s1")
    expect(out.kind).toBe("entry-disabled")
    expect((await diskEntry())?.enabled).toBe(false)
    expect(h.added).toHaveLength(0)
    expect(h.toasts).toHaveLength(1)
  })

  test("W0/W2 (merged by construction): disable lands before the write's single read → refused", async () => {
    const { h, reads } = stage("before-write-read")
    const out = await ensure("s1")
    console.log("W0/W2:", JSON.stringify(out), "disk:", JSON.stringify(await diskEntry()), "config reads after guard:", reads())
    expect(out.kind).toBe("entry-disabled")
    expect((await diskEntry())?.enabled).toBe(false)
    expect(h.added).toHaveLength(0)
  })

  test("W3 (named residual): disable lands between the write's read and its write → still lost", async () => {
    const { h } = stage("after-write-read")
    const out = await ensure("s1")
    const after = await diskEntry()
    console.log("W3:", JSON.stringify(out), "disk:", JSON.stringify(after))
    expect(out.kind).toBe("attached")
    expect(after?.enabled).toBe(true)
    expect(after?.command).toEqual(["datamate", "start-stdio", "--datamate", "42"])
    expect(h.added).toHaveLength(1)
    expect(await ensure("s1")).toBe(out)
  })
})

describe("AH/AI — freshConfig throws at each read in turn (real existingEntry, no seam)", () => {
  function realReader(throwAt: (n: number) => boolean, onDisk: () => ExistingEntry | null) {
    const h = install([{}, { datamate: { status: "connected" } }], () => null)
    delete syncInternals.existingEntry
    let n = 0
    syncInternals.freshConfig = async () => {
      n += 1
      if (throwAt(n)) throw new Error(n === 1 || throwAt(1) ? "EIO" : `EIO#`)
      const e = onDisk()
      return { mcp: e ? { datamate: e } : {} }
    }
    return { h, calls: () => n }
  }

  test("read #1 (inspection) throws → connect-failed, 1 toast, no mutation", async () => {
    const { h } = realReader((n) => n === 1, () => null)
    const out = await ensure("s1")
    expect(out).toMatchObject({ kind: "connect-failed", error: "configuration unreadable: Error: EIO" })
    expect(h.toasts.map((t) => t.title)).toEqual(["Workspace engine not attached"])
    expect(h.persisted).toHaveLength(0)
    expect(h.added).toHaveLength(0)
  })

  test("read #2 (pre-install guard) throws → connect-failed, 1 toast, no mutation; same label as the inspection", async () => {
    const { h } = realReader((n) => n === 2, () => null)
    const out = await ensure("s1")
    expect(out).toMatchObject({ kind: "connect-failed", error: "configuration unreadable: intent could not be confirmed" })
    expect(h.toasts.map((t) => t.title)).toEqual(["Workspace engine not attached"])
    expect(h.persisted).toHaveLength(0)
    expect(h.added).toHaveLength(0)
  })

  test("read #3 (post-install guard) throws → install undone, connect-failed, 1 toast", async () => {
    const { h } = realReader((n) => n === 3, () => null)
    const out = await ensure("s1")
    expect(out).toMatchObject({ kind: "connect-failed" })
    expect(h.toasts.map((t) => t.title)).toEqual(["Workspace engine not attached"])
    expect(h.persisted).toHaveLength(1)
    expect(h.added).toHaveLength(1)
    expect(h.removes).toEqual(["datamate"])
    expect(h.restores).toEqual([null])
  })

  test("undo re-read (projectEntry #2) throws → FAILS CLOSED: no restore, one left-behind toast, superseded", async () => {
    let current: CachedBinding | null = binding
    const h = install([{}, { datamate: { status: "connected" } }], () => null)
    syncInternals.resolveBinding = async () => current
    let pe = 0
    syncInternals.projectEntry = async () => {
      pe += 1
      if (pe === 2) throw new Error("EIO undo re-read")
      return null
    }
    syncInternals.mcp!.tools = async () => ((current = { ...binding, datamateId: 99 } as CachedBinding), { datamate_dbt_build_model: 1 })
    const out = await ensure("s1")
    expect(out.kind).toBe("superseded")
    expect(pe).toBe(2)
    expect(h.restores).toEqual([])
    expect(h.removes).toEqual(["datamate"])
    expect(h.toasts.map((t) => t.title)).toEqual(["Workspace engine config left behind"])
  })

  test("memo validation read throws (transient) → not served, re-decided → reused; no toast", async () => {
    const { h } = realReader((n) => n === 4, () => (h.added.length ? PINNED42 : null))
    const first = await ensure("s1")
    expect(first.kind).toBe("attached")
    h.statusQueue = [{ datamate: { status: "connected" } }]
    const second = await ensure("s1")
    expect(second).not.toBe(first)
    expect(second.kind).toBe("reused")
    expect(h.toasts).toHaveLength(1)
  })

  test("PERSISTENT throw: three turns re-decide but announce ONCE (AL)", async () => {
    const { h, calls } = realReader(() => true, () => null)
    const a = await ensure("s1")
    const b = await ensure("s1")
    const c = await ensure("s1")
    console.log("AH persistent:", a.kind, b.kind, c.kind, "toasts:", h.toasts.length, "freshConfig calls:", calls())
    expect([a.kind, b.kind, c.kind]).toEqual(["connect-failed", "connect-failed", "connect-failed"])
    expect(h.toasts.length).toBe(1)
    expect(h.persisted).toHaveLength(0)
  })
})

describe("AJ — persistent probe failure in the check-version branch", () => {
  test("turn 1: detach + refuse once (engine-too-old), client not left registered; later turns re-decide silently (AL)", async () => {
    const h = install(
      [{ datamate: { status: "connected" } }, { datamate: { status: "disabled" } }, { datamate: { status: "connected" } }],
      () => PINNED42,
      { spawned: PINNED42 },
    )
    syncInternals.versionOf = async () => {
      throw new Error("EACCES")
    }
    const a = await ensure("s1")
    expect(a.kind).toBe("engine-too-old")
    expect(h.removes).toEqual(["datamate"])
    expect(h.spawnedNow).toBeUndefined()
    expect(h.toasts).toHaveLength(1)
    expect(settledOutcome("s1")?.kind).toBe("engine-too-old")

    // Turn 2: the outcome is REPAIRABLE, so the memo does not hold it — run() again.
    const b = await ensure("s1")
    const c = await ensure("s1")
    console.log("AJ:", b.kind, c.kind, "toasts:", h.toasts.length, "added:", h.added.length, "removes:", h.removes.length)
    expect(b).not.toBe(a)
    expect(h.toasts.length).toBe(1)
  })
})

describe("spawned cleared on onclose / disconnect — the next attach", () => {
  test("child exit (record cleared, status failed) → revived via add → reused", async () => {
    const h = install([{ datamate: { status: "failed", error: "Connection closed" } }, { datamate: { status: "connected" } }], () => PINNED42)
    const out = await ensure("s1")
    expect(out.kind).toBe("reused")
    expect(h.added).toHaveLength(1)
    expect(h.spawnedNow?.command).toEqual(PINNED42.command)
    expect(h.persisted).toHaveLength(0)
  })

  test("disconnect (record cleared, status disabled, config enabled:false) → entry-disabled; then /mcp enable-style re-add → reused", async () => {
    let enabled = true
    let status: { status: string } = { status: "connected" }
    const h = install([], () => ({ ...PINNED42, enabled }), { spawned: PINNED42 })
    syncInternals.mcp!.status = async () => ({ datamate: status })
    expect((await ensure("s1")).kind).toBe("reused")
    // MCP.disconnect: closeClient, delete spawned, status disabled, persist enabled:false
    enabled = false
    status = { status: "disabled" }
    h.spawnedNow = undefined
    const mid = await ensure("s1")
    expect(mid.kind).toBe("entry-disabled")
    expect(h.added).toHaveLength(0)
    // MCP.connect (prompt.ts /mcp enable): createAndStore → spawned set, status connected, persist enabled:true
    enabled = true
    status = { status: "connected" }
    h.spawnedNow = PINNED42
    const back = await ensure("s1")
    expect(back.kind).toBe("reused")
    expect(h.added).toHaveLength(0)
    expect(h.persisted).toHaveLength(0)
  })
})

describe("AL — dedupe edges", () => {
  test("same kind, changed detail (engine-too-old 0.5.9 → 0.6.0) speaks again", async () => {
    let v = "0.5.9"
    const h = install([{}], () => null)
    syncInternals.versionOf = async () => v
    expect((await ensure("s1")).kind).toBe("engine-too-old")
    expect((await ensure("s1")).kind).toBe("engine-too-old")
    v = "0.6.0"
    expect((await ensure("s1")).kind).toBe("engine-too-old")
    console.log("AL detail:", h.toasts.length, h.toasts.map((t) => t.message.slice(0, 40)))
    expect(h.toasts.length).toBe(2)
  })
  test("two sessions with the same verdict each hear it once", async () => {
    const h = install([{}], () => null)
    syncInternals.which = () => null
    await ensure("a"); await ensure("a"); await ensure("b"); await ensure("b")
    expect(h.toasts.length).toBe(2)
  })
  test("a reuse after a refusal clears the record: refusal → reused → same refusal speaks again", async () => {
    let onPath: string | null = null
    let status: { status: string } = { status: "disabled" }
    const h = install([], () => PINNED42, { spawned: undefined })
    syncInternals.which = () => onPath
    syncInternals.mcp!.status = async () => ({ datamate: status })
    expect((await ensure("s1")).kind).toBe("engine-missing") // ours+down → retry → revive? no: which null → refuse-unreachable → engine-missing
    onPath = "/usr/local/bin/datamate"; status = { status: "connected" }; h.spawnedNow = PINNED42
    expect((await ensure("s1")).kind).toBe("reused")
    onPath = null; status = { status: "disabled" }; h.spawnedNow = undefined
    expect((await ensure("s1")).kind).toBe("engine-missing")
    expect(h.toasts.filter((t) => t.title.includes("unavailable")).length).toBe(2)
  })
})

describe("RT/RU — the restore's own window: a disable landing between the undo's read and the restore's write (REAL persist + REAL persistRestore)", () => {
  let file: string
  let invalidateSpy: ReturnType<typeof spyOn>
  const originalReadText = Filesystem.readText
  beforeEach(() => {
    file = path.join(mkdtempSync(path.join(tmpdir(), "l3r4-restore-")), "altimate-code.json")
    invalidateSpy = spyOn(Config, "invalidate").mockImplementation(async () => {})
  })
  afterEach(() => {
    invalidateSpy.mockRestore()
    Filesystem.readText = originalReadText
  })
  const diskEntry = async () => (await readMcpEntryFromDisk("datamate", file)) as ExistingEntry | undefined

  function stageRestore(initial: ExistingEntry | null) {
    let current: CachedBinding | null = binding
    const statuses: H["statusQueue"] = initial ? [{ datamate: { status: "connected" } }, { datamate: { status: "connected" } }] : [{}, { datamate: { status: "connected" } }]
    const h = install(statuses, () => null, { realPersist: true })
    delete syncInternals.persistRestore // REAL restore
    syncInternals.projectConfigPath = async () => file
    syncInternals.resolveBinding = async () => current
    syncInternals.existingEntry = async () => {
      const e = (await diskEntry()) ?? null
      h.reads.push(e?.enabled)
      return e
    }
    let pe = 0
    let armed = false
    let landed = false
    syncInternals.projectEntry = async () => {
      pe += 1
      const e = (await diskEntry()) ?? null
      if (pe === 2) armed = true // the undo's own read has just completed
      return e
    }
    // binding moves during tools() → post-install guard → undo
    syncInternals.mcp!.tools = async () => ((current = { ...binding, datamateId: 99 } as CachedBinding), { datamate_dbt_build_model: 1 })
    Filesystem.readText = async (p: string) => {
      if (armed && !landed && p === file) {
        landed = true
        // the user disables OUR entry after the undo read it and before the restore writes
        const now = (await readMcpEntryFromDisk("datamate", file)) as ExistingEntry
        writeFileSync(file, JSON.stringify({ mcp: { datamate: { ...now, enabled: false } } }, null, 2))
      }
      return originalReadText(p)
    }
    return { h, landed: () => landed }
  }

  test("RT: previous entry existed → restore must NOT overwrite the disable with the enabled previous", async () => {
    await addMcpToConfig("datamate", { type: "local", command: ["datamate", "start-stdio"], enabled: true } as never, file)
    const { h, landed } = stageRestore({ type: "local", command: ["datamate", "start-stdio"], enabled: true })
    const out = await ensure("s1")
    const after = await diskEntry()
    console.log("RT:", JSON.stringify(out), "disk:", JSON.stringify(after), "landed:", landed(), "toasts:", h.toasts.map((t) => t.title))
    expect(landed()).toBe(true)
    expect(out.kind).toBe("superseded")
    expect(after?.enabled, "the restore wrote the enabled previous entry over the user's disable").toBe(false)
  })

  test("RU: no previous entry → restore must NOT delete the node the user just disabled", async () => {
    writeFileSync(file, "{}\n")
    const { h, landed } = stageRestore(null)
    const out = await ensure("s1")
    const after = await diskEntry()
    console.log("RU:", JSON.stringify(out), "disk:", JSON.stringify(after), "landed:", landed(), "toasts:", h.toasts.map((t) => t.title))
    expect(landed()).toBe(true)
    expect(out.kind).toBe("superseded")
    expect(after, "the restore deleted the node the user had just disabled").toBeDefined()
    expect(after?.enabled).toBe(false)
  })
})
