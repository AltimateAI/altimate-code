import { beforeEach, describe, expect, spyOn, test } from "bun:test"
import { selectSkillsWithLLM, resetSkillSelectorCache, type SkillSelectorDeps } from "../../src/altimate/skill-selector"
import { Provider } from "../../src/provider/provider"
import { LLM } from "../../src/session/llm"
import type { Skill } from "../../src/skill"
import type { Fingerprint } from "../../src/altimate/fingerprint"

function mockSkill(name: string, description?: string): Skill.Info {
  return {
    name,
    description: description ?? `Test skill: ${name}`,
    location: `/test/${name}/SKILL.md`,
    content: `# ${name}`,
  } as Skill.Info
}

function mockFingerprint(tags: string[]): Fingerprint.Result {
  return { tags, detectedAt: Date.now(), cwd: "/test" } as Fingerprint.Result
}

const ALL_SKILLS = [
  mockSkill("dbt-modeling", "Build and manage dbt models"),
  mockSkill("react-components", "Create React UI components"),
  mockSkill("python-testing", "Write Python unit tests"),
  mockSkill("kubernetes-deploy", "Deploy apps to Kubernetes"),
  mockSkill("sql-optimization", "Optimize SQL queries"),
]

/** Create deps that return selected skill names */
function makeDeps(selected: string[]): SkillSelectorDeps & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    run: async (_prompt, skillNames) => {
      calls.push(skillNames)
      return selected
    },
  }
}

/** Create deps that throw */
function makeDepsError(error: string): SkillSelectorDeps {
  return {
    run: async () => { throw new Error(error) },
  }
}

/** Create deps that never resolve (timeout test) */
function makeDepsHang(): SkillSelectorDeps {
  return {
    run: () => new Promise<never>(() => {}),
  }
}

describe("selectSkillsWithLLM", () => {
  // Reset cache before each test so tests are independent
  beforeEach(() => {
    resetSkillSelectorCache()
  })

  // --- Fallback cases: return all skills ---

  test("LLM error → returns all skills (graceful fallback)", async () => {
    const deps = makeDepsError("API key invalid")
    const result = await selectSkillsWithLLM(ALL_SKILLS, undefined, deps)
    expect(result).toHaveLength(ALL_SKILLS.length)
  })

  test("LLM returns zero skills → returns all skills", async () => {
    const deps = makeDeps([])
    const result = await selectSkillsWithLLM(ALL_SKILLS, mockFingerprint([]), deps)
    expect(result).toHaveLength(ALL_SKILLS.length)
  })

  test("LLM returns all non-existent names → returns all skills (fallback)", async () => {
    const deps = makeDeps(["fake-skill-1", "fake-skill-2"])
    const result = await selectSkillsWithLLM(ALL_SKILLS, mockFingerprint([]), deps)
    expect(result).toHaveLength(ALL_SKILLS.length)
  })

  // --- Successful selection ---

  test("LLM returns valid names → filters correctly", async () => {
    const deps = makeDeps(["dbt-modeling", "sql-optimization"])
    const result = await selectSkillsWithLLM(
      ALL_SKILLS,
      mockFingerprint(["dbt"]),
      deps,
    )
    expect(result).toHaveLength(2)
    expect(result.map((s) => s.name)).toEqual(["dbt-modeling", "sql-optimization"])
  })

  test("LLM returns non-existent names → ignored, returns only matching", async () => {
    const deps = makeDeps(["dbt-modeling", "nonexistent-skill"])
    const result = await selectSkillsWithLLM(
      ALL_SKILLS,
      mockFingerprint(["dbt"]),
      deps,
    )
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("dbt-modeling")
  })

  test("single skill selected → returns just that one", async () => {
    const deps = makeDeps(["python-testing"])
    const result = await selectSkillsWithLLM(
      ALL_SKILLS,
      mockFingerprint(["python"]),
      deps,
    )
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("python-testing")
  })

  // --- Limits ---

  test("max 15 skills cap enforced", async () => {
    const manySkills = Array.from({ length: 20 }, (_, i) => mockSkill(`skill-${i}`, `Skill ${i}`))
    const deps = makeDeps(manySkills.map((s) => s.name))
    const result = await selectSkillsWithLLM(manySkills, undefined, deps)
    expect(result.length).toBeLessThanOrEqual(15)
  })

  // --- Caching ---

  test("second call returns cached result without calling LLM", async () => {
    const deps = makeDeps(["dbt-modeling", "sql-optimization"])
    const first = await selectSkillsWithLLM(ALL_SKILLS, mockFingerprint(["dbt"]), deps)
    expect(deps.calls).toHaveLength(1)

    // Second call — LLM should NOT be called again
    const second = await selectSkillsWithLLM(ALL_SKILLS, mockFingerprint(["dbt"]), deps)
    expect(deps.calls).toHaveLength(1) // still 1 call
    expect(second).toEqual(first)
  })

  test("cached fallback result also avoids re-calling LLM", async () => {
    const deps = makeDepsError("API failure")
    const first = await selectSkillsWithLLM(ALL_SKILLS, undefined, deps)
    expect(first).toHaveLength(ALL_SKILLS.length) // fallback to all

    // Second call with working deps — should still return cached
    const workingDeps = makeDeps(["dbt-modeling"])
    const second = await selectSkillsWithLLM(ALL_SKILLS, undefined, workingDeps)
    expect(workingDeps.calls).toHaveLength(0) // never called
    expect(second).toHaveLength(ALL_SKILLS.length)
  })

  test("different cwd invalidates cache and re-calls LLM", async () => {
    const deps = makeDeps(["dbt-modeling"])
    await selectSkillsWithLLM(ALL_SKILLS, mockFingerprint(["dbt"]), deps)
    expect(deps.calls).toHaveLength(1)

    // Same cwd — cache hit
    await selectSkillsWithLLM(ALL_SKILLS, mockFingerprint(["dbt"]), deps)
    expect(deps.calls).toHaveLength(1)

    // Different cwd — cache miss, LLM called again
    const otherFingerprint = { tags: ["python"], detectedAt: Date.now(), cwd: "/other-project" } as Fingerprint.Result
    await selectSkillsWithLLM(ALL_SKILLS, otherFingerprint, deps)
    expect(deps.calls).toHaveLength(2)
  })

  test("resetSkillSelectorCache clears the cache", async () => {
    const deps1 = makeDeps(["dbt-modeling"])
    await selectSkillsWithLLM(ALL_SKILLS, mockFingerprint(["dbt"]), deps1)
    expect(deps1.calls).toHaveLength(1)

    resetSkillSelectorCache()

    const deps2 = makeDeps(["sql-optimization"])
    const result = await selectSkillsWithLLM(ALL_SKILLS, mockFingerprint(["sql"]), deps2)
    expect(deps2.calls).toHaveLength(1) // LLM called again after reset
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("sql-optimization")
  })

})

// altimate_change start — routing hint (Phase 0): skill-selector.ts's `runWithLLM` reuses the
// invoking session's own model instead of always resolving Provider.defaultModel() when that
// session model is Altimate-managed (altimate-free / altimate-backend). No `deps` here — that
// bypasses `runWithLLM` (and its model-resolution logic) entirely, which is what every other test
// in this file uses deliberately.
function fakeModel(providerID: string, modelID: string): any {
  return {
    id: modelID,
    providerID,
    name: modelID,
    api: { id: modelID, url: "", npm: "@ai-sdk/openai-compatible" },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: false,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 1000, output: 1000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-01-01",
  }
}

function stubLLMStream(text: string) {
  return spyOn(LLM, "stream").mockResolvedValue({
    // eslint-disable-next-line @typescript-eslint/require-yield
    fullStream: (async function* () {})(),
    text: Promise.resolve(text),
  } as any)
}

describe("skill-selector session-model reuse (routing hint Phase 0)", () => {
  beforeEach(() => {
    resetSkillSelectorCache()
  })

  test("reuses the session's model when it is Altimate-managed, skipping Provider.defaultModel()", async () => {
    const defaultModelSpy = spyOn(Provider, "defaultModel").mockResolvedValue({
      providerID: "opencode",
      modelID: "big-pickle",
    } as any)
    const getModelSpy = spyOn(Provider, "getModel").mockImplementation(
      async (providerID: any, modelID: any) => fakeModel(providerID, modelID) as any,
    )
    const streamSpy = stubLLMStream("dbt-modeling")

    try {
      await selectSkillsWithLLM(ALL_SKILLS, mockFingerprint(["dbt"]), undefined, {
        providerID: "altimate-backend",
        modelID: "altimate-default",
      })
      expect(getModelSpy).toHaveBeenCalledWith("altimate-backend", "altimate-default")
      expect(defaultModelSpy).not.toHaveBeenCalled()
    } finally {
      defaultModelSpy.mockRestore()
      getModelSpy.mockRestore()
      streamSpy.mockRestore()
    }
  })

  test("falls back to Provider.defaultModel() when the session model is not Altimate-managed", async () => {
    const defaultModelSpy = spyOn(Provider, "defaultModel").mockResolvedValue({
      providerID: "opencode",
      modelID: "big-pickle",
    } as any)
    const getModelSpy = spyOn(Provider, "getModel").mockImplementation(
      async (providerID: any, modelID: any) => fakeModel(providerID, modelID) as any,
    )
    const streamSpy = stubLLMStream("dbt-modeling")

    try {
      await selectSkillsWithLLM(ALL_SKILLS, mockFingerprint(["dbt"]), undefined, {
        providerID: "anthropic",
        modelID: "claude-x",
      })
      expect(defaultModelSpy).toHaveBeenCalled()
      expect(getModelSpy).toHaveBeenCalledWith("opencode", "big-pickle")
    } finally {
      defaultModelSpy.mockRestore()
      getModelSpy.mockRestore()
      streamSpy.mockRestore()
    }
  })

  test("falls back to Provider.defaultModel() when no session model is given", async () => {
    const defaultModelSpy = spyOn(Provider, "defaultModel").mockResolvedValue({
      providerID: "opencode",
      modelID: "big-pickle",
    } as any)
    const getModelSpy = spyOn(Provider, "getModel").mockImplementation(
      async (providerID: any, modelID: any) => fakeModel(providerID, modelID) as any,
    )
    const streamSpy = stubLLMStream("dbt-modeling")

    try {
      await selectSkillsWithLLM(ALL_SKILLS, mockFingerprint(["dbt"]))
      expect(defaultModelSpy).toHaveBeenCalled()
      expect(getModelSpy).toHaveBeenCalledWith("opencode", "big-pickle")
    } finally {
      defaultModelSpy.mockRestore()
      getModelSpy.mockRestore()
      streamSpy.mockRestore()
    }
  })
})
// altimate_change end
