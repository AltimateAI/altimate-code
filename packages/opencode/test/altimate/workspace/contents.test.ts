// altimate_change - new file
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { AltimateApi } from "../../../src/altimate/api/client"
import * as Contents from "../../../src/altimate/workspace/contents"

const ACCOUNT_A = { altimateUrl: "https://api.example.com", altimateInstanceName: "acme", altimateApiKey: "key-a" }
const ACCOUNT_B = { altimateUrl: "https://api.example.com", altimateInstanceName: "globex", altimateApiKey: "key-b" }

let creds: typeof ACCOUNT_A | null
beforeEach(() => {
  creds = ACCOUNT_A
  spyOn(AltimateApi, "getCredentials").mockImplementation(async () => {
    if (!creds) throw new Error("not configured")
    return creds as any
  })
})

// Every spy is restored even when an assertion fails, so no test leaks a mocked API.
afterEach(() => {
  mock.restore()
  Contents.resetForTests()
})

const summary = (over: Record<string, unknown> = {}) => ({ id: "35", name: "w", ...over }) as any

describe("workspace contents section", () => {
  test("lists the workspace's own skills, sorted, and tells the model to keep built-ins separate", () => {
    const text = Contents.render({
      skills: [
        { name: "revenue-metrics", description: "How revenue is defined" },
        { name: "dbt-style", description: "" },
      ],
      integrations: ["github", "snowflake"],
      memoryEnabled: true,
      knowledge: null,
    })
    expect(text).toContain("Workspace skills (2):")
    expect(text).toContain("- revenue-metrics — How revenue is defined")
    expect(text).toContain("- dbt-style")
    expect(text).toContain("Integrations: github, snowflake.")
    expect(text).toContain("Workspace memory: on")
    expect(text).toContain("answer from this section only")
    expect(text).toContain("built-in")
    expect(text).toContain("not instructions")
  })

  test("not synced, unread, none and unknown are different answers", () => {
    const notSynced = Contents.render({ skills: null, integrations: null, memoryEnabled: null, knowledge: null })
    expect(notSynced).toContain("not synced to this project yet")
    expect(notSynced).not.toContain("Integrations:")
    expect(notSynced).not.toContain("Workspace memory:")

    const unread = Contents.render({ skills: "unknown", integrations: null, memoryEnabled: null, knowledge: null })
    expect(unread).toContain("could not be read just now")
    expect(unread).not.toContain("not synced")

    const none = Contents.render({ skills: [], integrations: [], memoryEnabled: false, knowledge: null })
    expect(none).toContain("none — this workspace has no custom skills")
    expect(none).toContain("Integrations: none attached")
    expect(none).toContain("Workspace memory: off.")
  })

  test("over the cap it drops descriptions, then lists only the count; the rest of the block stays", () => {
    const many = Array.from({ length: 55 }, (_, i) => ({ name: `skill-${String(i).padStart(2, "0")}`, description: "x".repeat(90) }))
    const contents = { skills: many, integrations: ["github"], memoryEnabled: true, knowledge: { kind: "all" as const } }

    const full = Contents.render(contents, Number.POSITIVE_INFINITY)
    expect(full).toContain("Workspace skills (55):")
    expect(full).toContain("- …and 15 more")

    const names = Contents.render(contents)
    expect(names.length).toBeLessThanOrEqual(Contents.MAX_CONTENTS_CHARS)
    expect(names).toContain("- skill-00\n")
    expect(names).not.toContain("xxxx")

    const counted = Contents.render(contents, 900)
    expect(counted.length).toBeLessThanOrEqual(900)
    expect(counted).toContain("Workspace skills: 55 (too many to list here")
    expect(counted).toContain("Integrations: github.")
    expect(counted).toContain("Knowledge: every document")
    expect(counted).toContain("answer from this section only")
  })

  test("knowledge: off, all, selected, unknown names, and unchecked ids read differently", () => {
    const base = { skills: [], integrations: [], memoryEnabled: true }
    expect(Contents.render({ ...base, knowledge: { kind: "off" } })).toContain("Knowledge: none — the knowledge engine is off")
    expect(Contents.render({ ...base, knowledge: { kind: "all" } })).toContain("Knowledge: every document in the organization's knowledge hub")
    const sel = (selected: number, names: string[] | null, unchecked = 0) => ({ kind: "selected" as const, selected, names, unchecked })
    expect(Contents.render({ ...base, knowledge: sel(2, ["Metric definitions", "dbt style guide"]) })).toContain(
      "Knowledge documents (2): Metric definitions, dbt style guide.",
    )
    expect(Contents.render({ ...base, knowledge: sel(3, null) })).toContain(
      "Knowledge: 3 selected documents (their names could not be loaded).",
    )
    // Ids past the lookup cap are never claimed to exist: the count is only what was verified.
    const capped = Contents.render({ ...base, knowledge: sel(25, ["a", "b"], 5) })
    expect(capped).toContain("Knowledge documents (2): a, b; 5 more selected, not checked.")
    expect(capped).not.toContain("(25)")
    expect(Contents.render({ ...base, knowledge: sel(2, []) })).toContain("no longer exist")
    expect(Contents.render({ ...base, knowledge: sel(23, [], 3) })).toContain("3 more selected, not checked")
    expect(Contents.render({ ...base, knowledge: sel(25, null, 5) })).toContain(
      "Knowledge: 25 selected documents (their names could not be loaded; 5 of them are past the lookup limit and were not checked).",
    )
    expect(Contents.render({ ...base, knowledge: null })).not.toContain("Knowledge")
  })
})

describe("workspace summary", () => {
  test("integrations come back sorted and are cached; a failure is 'not known', never 'none'", async () => {
    const spy = spyOn(AltimateApi, "getDatamate").mockResolvedValueOnce(
      summary({ integrations: [{ id: "snowflake" }, { id: "github" }], memory_enabled: true }),
    )
    expect(await Contents.workspaceSummary(35)).toEqual({ integrations: ["github", "snowflake"], memoryEnabled: true, knowledge: null })
    await Contents.workspaceSummary(35)
    expect(spy).toHaveBeenCalledTimes(1)

    spy.mockRejectedValueOnce(new Error("offline"))
    expect(await Contents.workspaceSummary(36)).toEqual({ integrations: null, memoryEnabled: null, knowledge: null })
  })

  test("fields the response left out stay unknown; only an explicit empty selection means every document", async () => {
    spyOn(AltimateApi, "getDatamate")
      .mockResolvedValueOnce(summary({ knowledge_engine_enabled: true }))
      .mockResolvedValueOnce(summary({ knowledge_engine_enabled: true, knowledge_bases: null, integrations: null }))
      .mockResolvedValueOnce(summary({ knowledge_engine_enabled: true, knowledge_bases: [], integrations: [] }))
    expect(await Contents.workspaceSummary(40)).toEqual({ integrations: null, memoryEnabled: null, knowledge: null })
    expect(await Contents.workspaceSummary(41)).toEqual({ integrations: null, memoryEnabled: null, knowledge: null })
    expect(await Contents.workspaceSummary(42)).toEqual({ integrations: [], memoryEnabled: null, knowledge: { kind: "all" } })
  })

  test("another account's workspace with the same id is never answered from the cache", async () => {
    const spy = spyOn(AltimateApi, "getDatamate")
      .mockResolvedValueOnce(summary({ integrations: [{ id: "github" }] }))
      .mockResolvedValueOnce(summary({ integrations: [{ id: "snowflake" }] }))
    expect((await Contents.workspaceSummary(35)).integrations).toEqual(["github"])
    creds = ACCOUNT_B
    expect((await Contents.workspaceSummary(35)).integrations).toEqual(["snowflake"])
    creds = ACCOUNT_A
    expect((await Contents.workspaceSummary(35)).integrations).toEqual(["github"])
    expect(spy).toHaveBeenCalledTimes(2)
  })

  test("a fetch uses the account it is cached under, even if the account changes mid-fetch", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const spy = spyOn(AltimateApi, "getDatamate").mockImplementation(async (_id: string, c?: any) => {
      await gate
      return summary({ knowledge_engine_enabled: true, knowledge_bases: [7], integrations: [{ id: c?.altimateInstanceName ?? "unpinned" }] })
    })
    const doc = spyOn(AltimateApi, "getKnowledgeDocument").mockImplementation(async (id: number, c?: any) => ({
      id,
      name: `doc of ${c?.altimateInstanceName ?? "unpinned"}`,
      deleted: false,
    }))
    const first = Contents.workspaceSummary(35)
    await new Promise((r) => setTimeout(r, 5))
    creds = ACCOUNT_B // switched while A's request is in flight
    release()
    await first
    await new Promise((r) => setTimeout(r, 5))
    creds = ACCOUNT_A
    const a = await Contents.workspaceSummary(35)
    expect(a.integrations).toEqual(["acme"])
    expect(a.knowledge).toEqual({ kind: "selected", selected: 1, names: ["doc of acme"], unchecked: 0 })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(doc.mock.calls[0][1]).toEqual(ACCOUNT_A as any)
  })

  test("without a usable credential nothing is fetched and everything is unknown", async () => {
    creds = null
    const spy = spyOn(AltimateApi, "getDatamate")
    expect(await Contents.workspaceSummary(35)).toEqual({ integrations: null, memoryEnabled: null, knowledge: null })
    expect(spy).not.toHaveBeenCalled()
  })

  test("selected documents are fetched by id; missing and deleted ones are left out, at most 20 fetched", async () => {
    const ids = Array.from({ length: 23 }, (_, i) => i + 1)
    spyOn(AltimateApi, "getDatamate").mockResolvedValueOnce(summary({ knowledge_engine_enabled: true, knowledge_bases: ids }))
    const doc = spyOn(AltimateApi, "getKnowledgeDocument").mockImplementation(async (id: number) => {
      if (id === 2) return null // 404
      return { id, name: `Doc ${String(21 - id).padStart(2, "0")}`, deleted: id === 3 }
    })
    const k = (await Contents.workspaceSummary(43)).knowledge
    expect(doc).toHaveBeenCalledTimes(20)
    if (k?.kind !== "selected") throw new Error(`expected a selection, got ${JSON.stringify(k)}`)
    // 20 fetched, 2 gone, 3 not checked beyond the cap.
    expect(k.names).toHaveLength(18)
    expect(k.names?.[0]).toBe("Doc 01")
    expect(k.selected).toBe(23)
    expect(k.unchecked).toBe(3)
  })

  test("an unreadable document is 'names unknown' and is retried next step, not cached", async () => {
    const summarySpy = spyOn(AltimateApi, "getDatamate").mockResolvedValue(
      summary({ knowledge_engine_enabled: true, knowledge_bases: [1, 2], integrations: [] }),
    )
    spyOn(AltimateApi, "getKnowledgeDocument")
      .mockRejectedValueOnce(new Error("unrecognised"))
      .mockResolvedValue({ id: 1, name: "Doc", deleted: false })
    expect((await Contents.workspaceSummary(44)).knowledge).toEqual({ kind: "selected", selected: 2, names: null, unchecked: 0 })
    expect((await Contents.workspaceSummary(44)).knowledge).toEqual({ kind: "selected", selected: 2, names: ["Doc", "Doc"], unchecked: 0 })
    expect(summarySpy).toHaveBeenCalledTimes(2)
  })

  test("a failed fetch is not cached: the next step asks again", async () => {
    const spy = spyOn(AltimateApi, "getDatamate")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(summary({ integrations: [{ id: "github" }], memory_enabled: true }))
    expect(await Contents.workspaceSummary(38)).toEqual({ integrations: null, memoryEnabled: null, knowledge: null })
    expect(await Contents.workspaceSummary(38)).toEqual({ integrations: ["github"], memoryEnabled: true, knowledge: null })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  test("a slow service does not hold the step past its wait; the answer arrives on a later step", async () => {
    let release!: (v: any) => void
    const spy = spyOn(AltimateApi, "getDatamate").mockImplementation(() => new Promise((r) => (release = r)) as any)
    const started = Date.now()
    expect(await Contents.workspaceSummary(37)).toEqual({ integrations: null, memoryEnabled: null, knowledge: null })
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(250)
    expect(waited).toBeLessThan(600)
    release(summary({ integrations: [{ id: "github" }], memory_enabled: false }))
    await new Promise((r) => setTimeout(r, 10))
    expect(await Contents.workspaceSummary(37)).toEqual({ integrations: ["github"], memoryEnabled: false, knowledge: null })
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe("workspace skills", () => {
  test("a workspace the last sync found empty is 'none', not 'not synced'", async () => {
    Contents.setSnapshotForTests({ workspaceId: async () => null, knownEmpty: async () => true })
    expect(await Contents.workspaceSkills("/project", 35)).toEqual([])
    Contents.setSnapshotForTests({ workspaceId: async () => null, knownEmpty: async () => false })
    expect(await Contents.workspaceSkills("/project", 35)).toBeNull()
  })

  test("a snapshot swapped in during the read is 'unknown', never paired with the validated id", async () => {
    let generation = 1
    Contents.setSnapshotForTests({
      root: () => "/nonexistent-root",
      generation: async () => generation++, // a different snapshot on every look
      workspaceId: async () => 35,
    })
    expect(await Contents.workspaceSkills("/project", 35)).toBe("unknown")
  })

  test("a foreign snapshot is 'not synced', not 'none', even with a stale empty record", async () => {
    Contents.setSnapshotForTests({ workspaceId: async () => 99, knownEmpty: async () => true })
    expect(await Contents.workspaceSkills("/project", 35)).toBeNull()
  })

  test("an in-place SKILL.md edit is picked up without a new snapshot", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-contents-"))
    try {
      fs.mkdirSync(path.join(root, "s1"))
      const file = path.join(root, "s1", "SKILL.md")
      fs.writeFileSync(file, "---\nname: alpha\ndescription: one\n---\nbody\n")
      Contents.setSnapshotForTests({ root: () => root, workspaceId: async () => 35 })
      expect(await Contents.workspaceSkills("/project", 35)).toEqual([{ name: "alpha", description: "one" }])
      // Same size, so only the file's own stamp changes; the root's does not.
      fs.writeFileSync(file, "---\nname: alpha\ndescription: two\n---\nbody\n")
      const later = new Date(Date.now() + 5_000)
      fs.utimesSync(file, later, later)
      expect(await Contents.workspaceSkills("/project", 35)).toEqual([{ name: "alpha", description: "two" }])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("a slow snapshot read does not hold the step: skills are 'unknown' that step", async () => {
    Contents.setSnapshotForTests({ workspaceId: () => new Promise(() => {}) })
    spyOn(AltimateApi, "getDatamate").mockResolvedValue(summary({ integrations: [] }))
    const started = Date.now()
    const text = await Contents.section("/project", 35)
    expect(Date.now() - started).toBeLessThan(600)
    expect(text).toContain("Workspace skills: could not be read just now")
  })
})
// altimate_change end
