// altimate_change - new file
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { AltimateApi } from "../../../src/altimate/api/client"
import * as Contents from "../../../src/altimate/workspace/contents"

afterEach(() => Contents.resetForTests())

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

  test("not synced, none, and unknown are three different answers", () => {
    const notSynced = Contents.render({ skills: null, integrations: null, memoryEnabled: null, knowledge: null })
    expect(notSynced).toContain("not synced to this project yet")
    expect(notSynced).not.toContain("Integrations:")
    expect(notSynced).not.toContain("Workspace memory:")

    const none = Contents.render({ skills: [], integrations: [], memoryEnabled: false, knowledge: null })
    expect(none).toContain("none — this workspace has no custom skills")
    expect(none).toContain("Integrations: none attached")
    expect(none).toContain("Workspace memory: off.")
  })

  test("a long list is capped with a count, and an oversize section drops descriptions before anything else", () => {
    const many = Array.from({ length: 55 }, (_, i) => ({ name: `skill-${String(i).padStart(2, "0")}`, description: "x".repeat(90) }))
    const full = Contents.render({ skills: many, integrations: [], memoryEnabled: true, knowledge: null }, Number.POSITIVE_INFINITY)
    expect(full).toContain("Workspace skills (55):")
    expect(full).toContain("- …and 15 more")

    const capped = Contents.render({ skills: many, integrations: [], memoryEnabled: true, knowledge: null })
    expect(capped.length).toBeLessThanOrEqual(Contents.MAX_CONTENTS_CHARS)
    expect(capped).toContain("- skill-00\n")
    expect(capped).toContain("answer from this section only")

    // Nothing partial: if even the bare list cannot fit, the section is omitted.
    expect(Contents.render({ skills: many, integrations: [], memoryEnabled: true, knowledge: null }, 200)).toBe("")
  })
})

describe("workspace summary cache", () => {
  test("integrations come back sorted, and a failure is 'not known', never 'none'", async () => {
    const spy = spyOn(AltimateApi, "getDatamate").mockResolvedValueOnce({
      id: "35",
      name: "w",
      integrations: [{ id: "snowflake" }, { id: "github" }],
      memory_enabled: true,
    } as any)
    expect(await Contents.workspaceSummary(35)).toEqual({ integrations: ["github", "snowflake"], memoryEnabled: true, knowledge: null })
    // Cached: no second request inside the TTL.
    await Contents.workspaceSummary(35)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()

    Contents.resetForTests()
    const failing = spyOn(AltimateApi, "getDatamate").mockRejectedValueOnce(new Error("offline"))
    expect(await Contents.workspaceSummary(36)).toEqual({ integrations: null, memoryEnabled: null, knowledge: null })
    failing.mockRestore()
  })

  test("a failed fetch is not cached: the next step asks again", async () => {
    const spy = spyOn(AltimateApi, "getDatamate")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ id: "38", name: "w", integrations: [{ id: "github" }], memory_enabled: true } as any)
    expect(await Contents.workspaceSummary(38)).toEqual({ integrations: null, memoryEnabled: null, knowledge: null })
    expect(await Contents.workspaceSummary(38)).toEqual({ integrations: ["github"], memoryEnabled: true, knowledge: null })
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })

  test("a slow service does not hold the step: the answer is 'not known' until it arrives", async () => {
    let release!: (v: any) => void
    const spy = spyOn(AltimateApi, "getDatamate").mockImplementation(
      () => new Promise((r) => (release = r)) as any,
    )
    const started = Date.now()
    expect(await Contents.workspaceSummary(37)).toEqual({ integrations: null, memoryEnabled: null, knowledge: null })
    expect(Date.now() - started).toBeLessThan(2_000)
    release({ id: "37", name: "w", integrations: [{ id: "github" }], memory_enabled: false })
    await new Promise((r) => setTimeout(r, 10))
    expect(await Contents.workspaceSummary(37)).toEqual({ integrations: ["github"], memoryEnabled: false, knowledge: null })
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})

describe("workspace knowledge", () => {
  afterEach(() => Contents.resetForTests())

  const base = { skills: [], integrations: [], memoryEnabled: true }

  test("off, all, selected and unknown read differently", () => {
    expect(Contents.render({ ...base, knowledge: { kind: "off" } })).toContain("Knowledge: none — the knowledge engine is off")
    expect(Contents.render({ ...base, knowledge: { kind: "all" } })).toContain("Knowledge: every document in the organization's knowledge hub")
    expect(Contents.render({ ...base, knowledge: { kind: "selected", count: 2, names: ["Metric definitions", "dbt style guide"] } })).toContain(
      "Knowledge documents (2): Metric definitions, dbt style guide.",
    )
    expect(Contents.render({ ...base, knowledge: { kind: "selected", count: 3, names: null } })).toContain(
      "Knowledge: 3 selected documents (their names could not be loaded).",
    )
    expect(Contents.render({ ...base, knowledge: null })).not.toContain("Knowledge")
  })

  test("a long document list is capped with a count", () => {
    const names = Array.from({ length: 25 }, (_, i) => `doc-${String(i).padStart(2, "0")}`)
    const text = Contents.render({ ...base, knowledge: { kind: "selected", count: 25, names } })
    expect(text).toContain("Knowledge documents (25): doc-00")
    expect(text).toContain("…and 5 more")
    expect(text).not.toContain("doc-24")
  })

  test("selected ids resolve to names of documents that still exist, sorted", async () => {
    const summary = spyOn(AltimateApi, "getDatamate").mockResolvedValueOnce({
      id: "40", name: "w", integrations: [], memory_enabled: true, knowledge_engine_enabled: true, knowledge_bases: [7, 3, 9],
    } as any)
    const docs = spyOn(AltimateApi, "listKnowledgeDocuments").mockResolvedValueOnce([
      { id: 3, name: "Zeta runbook", deleted: false },
      { id: 7, name: "Alpha metrics", deleted: false },
      { id: 9, name: "Removed doc", deleted: true },
      { id: 11, name: "Not selected", deleted: false },
    ])
    expect((await Contents.workspaceSummary(40)).knowledge).toEqual({ kind: "selected", count: 2, names: ["Alpha metrics", "Zeta runbook"] })
    summary.mockRestore()
    docs.mockRestore()
  })

  test("engine on with nothing selected is 'all'; engine off is 'off'; the document list is not fetched for either", async () => {
    const docs = spyOn(AltimateApi, "listKnowledgeDocuments")
    const summary = spyOn(AltimateApi, "getDatamate")
      .mockResolvedValueOnce({ id: "41", name: "w", knowledge_engine_enabled: true, knowledge_bases: [] } as any)
      .mockResolvedValueOnce({ id: "42", name: "w", knowledge_engine_enabled: false, knowledge_bases: [5] } as any)
    expect((await Contents.workspaceSummary(41)).knowledge).toEqual({ kind: "all" })
    expect((await Contents.workspaceSummary(42)).knowledge).toEqual({ kind: "off" })
    expect(docs).not.toHaveBeenCalled()
    summary.mockRestore()
    docs.mockRestore()
  })

  test("an unreadable document list keeps the count and says the names are unknown", async () => {
    const summary = spyOn(AltimateApi, "getDatamate").mockResolvedValueOnce({
      id: "43", name: "w", knowledge_engine_enabled: true, knowledge_bases: [1, 2],
    } as any)
    const docs = spyOn(AltimateApi, "listKnowledgeDocuments").mockRejectedValueOnce(new Error("offline"))
    expect((await Contents.workspaceSummary(43)).knowledge).toEqual({ kind: "selected", count: 2, names: null })
    summary.mockRestore()
    docs.mockRestore()
  })
})
