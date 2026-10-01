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
    const notSynced = Contents.render({ skills: null, integrations: null, memoryEnabled: null })
    expect(notSynced).toContain("not synced to this project yet")
    expect(notSynced).not.toContain("Integrations:")
    expect(notSynced).not.toContain("Workspace memory:")

    const none = Contents.render({ skills: [], integrations: [], memoryEnabled: false })
    expect(none).toContain("none — this workspace has no custom skills")
    expect(none).toContain("Integrations: none attached")
    expect(none).toContain("Workspace memory: off.")
  })

  test("a long list is capped with a count, and an oversize section drops descriptions before anything else", () => {
    const many = Array.from({ length: 55 }, (_, i) => ({ name: `skill-${String(i).padStart(2, "0")}`, description: "x".repeat(90) }))
    const full = Contents.render({ skills: many, integrations: [], memoryEnabled: true }, Number.POSITIVE_INFINITY)
    expect(full).toContain("Workspace skills (55):")
    expect(full).toContain("- …and 15 more")

    const capped = Contents.render({ skills: many, integrations: [], memoryEnabled: true })
    expect(capped.length).toBeLessThanOrEqual(Contents.MAX_CONTENTS_CHARS)
    expect(capped).toContain("- skill-00\n")
    expect(capped).toContain("answer from this section only")

    // Nothing partial: if even the bare list cannot fit, the section is omitted.
    expect(Contents.render({ skills: many, integrations: [], memoryEnabled: true }, 200)).toBe("")
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
    expect(await Contents.workspaceSummary(35)).toEqual({ integrations: ["github", "snowflake"], memoryEnabled: true })
    // Cached: no second request inside the TTL.
    await Contents.workspaceSummary(35)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()

    Contents.resetForTests()
    const failing = spyOn(AltimateApi, "getDatamate").mockRejectedValueOnce(new Error("offline"))
    expect(await Contents.workspaceSummary(36)).toEqual({ integrations: null, memoryEnabled: null })
    failing.mockRestore()
  })

  test("a slow service does not hold the step: the answer is 'not known' until it arrives", async () => {
    let release!: (v: any) => void
    const spy = spyOn(AltimateApi, "getDatamate").mockImplementation(
      () => new Promise((r) => (release = r)) as any,
    )
    const started = Date.now()
    expect(await Contents.workspaceSummary(37)).toEqual({ integrations: null, memoryEnabled: null })
    expect(Date.now() - started).toBeLessThan(2_000)
    release({ id: "37", name: "w", integrations: [{ id: "github" }], memory_enabled: false })
    await new Promise((r) => setTimeout(r, 10))
    expect(await Contents.workspaceSummary(37)).toEqual({ integrations: ["github"], memoryEnabled: false })
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
