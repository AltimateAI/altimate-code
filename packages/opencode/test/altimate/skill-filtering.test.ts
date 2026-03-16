import { beforeEach, describe, expect, test } from "bun:test"
import { selectSkillsWithLLM, resetSkillSelectorCache, type SkillSelectorDeps } from "../../src/altimate/skill-selector"
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
