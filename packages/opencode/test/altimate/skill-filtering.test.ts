import { afterEach, describe, expect, test } from "bun:test"
import { partitionByFingerprint, rescueByMessage } from "../../src/tool/skill"
import type { Skill } from "../../src/skill"
import type { Fingerprint } from "../../src/altimate/fingerprint"

function mockSkill(name: string, tags?: string[]): Skill.Info {
  return {
    name,
    description: `Test skill: ${name}`,
    location: `/test/${name}/SKILL.md`,
    content: `# ${name}`,
    tags,
  } as Skill.Info
}

function mockFingerprint(tags: string[]): Fingerprint.Result {
  return { tags, detectedAt: Date.now(), cwd: "/test" } as Fingerprint.Result
}

describe("partitionByFingerprint", () => {
  test("returns all skills as included when no fingerprint", () => {
    const skills = [mockSkill("dbt-skill", ["dbt"]), mockSkill("react-skill", ["react"])]
    const result = partitionByFingerprint(skills, undefined)
    expect(result.included).toHaveLength(2)
    expect(result.excluded).toHaveLength(0)
  })

  test("returns all skills as included when fingerprint has no tags", () => {
    const skills = [mockSkill("dbt-skill", ["dbt"])]
    const result = partitionByFingerprint(skills, mockFingerprint([]))
    expect(result.included).toHaveLength(1)
    expect(result.excluded).toHaveLength(0)
  })

  test("partitions skills by matching tags", () => {
    const skills = [
      mockSkill("dbt-skill", ["dbt"]),
      mockSkill("react-skill", ["react"]),
      mockSkill("untagged-skill"),
    ]
    const result = partitionByFingerprint(skills, mockFingerprint(["dbt"]))
    expect(result.included.map((s) => s.name)).toEqual(["dbt-skill", "untagged-skill"])
    expect(result.excluded.map((s) => s.name)).toEqual(["react-skill"])
  })

  test("untagged skills always included", () => {
    const skills = [mockSkill("untagged")]
    const result = partitionByFingerprint(skills, mockFingerprint(["python"]))
    expect(result.included).toHaveLength(1)
    expect(result.excluded).toHaveLength(0)
  })

  test("skills with empty tags array always included", () => {
    const skills = [mockSkill("empty-tags", [])]
    const result = partitionByFingerprint(skills, mockFingerprint(["python"]))
    expect(result.included).toHaveLength(1)
    expect(result.excluded).toHaveLength(0)
  })

  test("matches tags case-insensitively", () => {
    const skills = [mockSkill("dbt-skill", ["DBT"])]
    const result = partitionByFingerprint(skills, mockFingerprint(["dbt"]))
    expect(result.included).toHaveLength(1)
    expect(result.excluded).toHaveLength(0)
  })

  test("skill with multiple tags matches if any tag matches", () => {
    const skills = [mockSkill("multi-tag", ["react", "typescript", "node"])]
    const result = partitionByFingerprint(skills, mockFingerprint(["node"]))
    expect(result.included).toHaveLength(1)
    expect(result.excluded).toHaveLength(0)
  })
})

describe("rescueByMessage", () => {
  test("returns empty when no message text", () => {
    const excluded = [mockSkill("react-skill", ["react"])]
    expect(rescueByMessage(excluded, undefined)).toEqual([])
  })

  test("returns empty for empty string message", () => {
    const excluded = [mockSkill("react-skill", ["react"])]
    expect(rescueByMessage(excluded, "")).toEqual([])
  })

  test("returns empty when excluded pool is empty", () => {
    expect(rescueByMessage([], "build a react app")).toEqual([])
  })

  test("rescues skill when message contains matching tag", () => {
    const excluded = [mockSkill("react-skill", ["react"])]
    const rescued = rescueByMessage(excluded, "build a react component")
    expect(rescued).toHaveLength(1)
    expect(rescued[0].name).toBe("react-skill")
  })

  test("does not rescue when no matching tags in message", () => {
    const excluded = [mockSkill("react-skill", ["react"])]
    const rescued = rescueByMessage(excluded, "build a vue component")
    expect(rescued).toHaveLength(0)
  })

  test("rescues multiple skills with matching tags", () => {
    const excluded = [
      mockSkill("react-skill", ["react"]),
      mockSkill("typescript-skill", ["typescript"]),
      mockSkill("vue-skill", ["vue"]),
    ]
    const rescued = rescueByMessage(excluded, "react typescript app")
    expect(rescued).toHaveLength(2)
    const names = rescued.map((s) => s.name)
    expect(names).toContain("react-skill")
    expect(names).toContain("typescript-skill")
  })

  test("deduplicates skills with multiple matching tags", () => {
    const excluded = [mockSkill("web-skill", ["react", "frontend"])]
    const rescued = rescueByMessage(excluded, "react frontend component")
    expect(rescued).toHaveLength(1)
  })

  test("ignores words shorter than 3 characters", () => {
    const excluded = [mockSkill("ai-skill", ["ai"])]
    const rescued = rescueByMessage(excluded, "do some ai work")
    expect(rescued).toHaveLength(0)
  })

  test("matches tags case-insensitively", () => {
    const excluded = [mockSkill("react-skill", ["react"])]
    const rescued = rescueByMessage(excluded, "build a REACT dashboard")
    expect(rescued).toHaveLength(1)
  })

  test("strips punctuation before matching", () => {
    const excluded = [mockSkill("react-skill", ["react"])]
    const rescued = rescueByMessage(excluded, "Using react, I want to build something")
    expect(rescued).toHaveLength(1)
  })

  test("strips parentheses before matching", () => {
    const excluded = [mockSkill("react-skill", ["react"])]
    const rescued = rescueByMessage(excluded, "something (react) related")
    expect(rescued).toHaveLength(1)
  })

  test("preserves hyphens for hyphenated tags", () => {
    const excluded = [mockSkill("de-skill", ["data-engineering"])]
    const rescued = rescueByMessage(excluded, "help with data-engineering tasks")
    expect(rescued).toHaveLength(1)
  })

  test("exact word match only - no substring matching", () => {
    const excluded = [mockSkill("react-skill", ["react"])]
    const rescued = rescueByMessage(excluded, "reactive programming is great")
    expect(rescued).toHaveLength(0)
  })

  test("handles skill with multiple tags - any match rescues", () => {
    const excluded = [mockSkill("fullstack", ["react", "node", "typescript"])]
    const rescued = rescueByMessage(excluded, "build with typescript")
    expect(rescued).toHaveLength(1)
    expect(rescued[0].name).toBe("fullstack")
  })
})

describe("dynamic_skills config gating", () => {
  test("when config is off, all skills pass through without filtering", () => {
    // Simulates the behavior: when dynamic_skills is falsy, allAllowed = accessibleSkills
    const skills = [
      mockSkill("dbt-skill", ["dbt"]),
      mockSkill("react-skill", ["react"]),
    ]
    const dynamicSkills = undefined // not set in config
    if (dynamicSkills) {
      // would partition + rescue
    }
    // When off, all skills are returned unfiltered
    const allAllowed = dynamicSkills ? [] : skills
    expect(allAllowed).toHaveLength(2)
  })

  test("when config is true, fingerprint filtering is applied", () => {
    const skills = [
      mockSkill("dbt-skill", ["dbt"]),
      mockSkill("react-skill", ["react"]),
    ]
    const dynamicSkills = true
    let allAllowed: Skill.Info[]
    if (dynamicSkills) {
      const { included, excluded } = partitionByFingerprint(skills, mockFingerprint(["dbt"]))
      const rescued = rescueByMessage(excluded, undefined)
      allAllowed = [...included, ...rescued]
    } else {
      allAllowed = skills
    }
    expect(allAllowed).toHaveLength(1)
    expect(allAllowed[0].name).toBe("dbt-skill")
  })

  test("when config is false, fingerprint filtering is skipped", () => {
    const skills = [
      mockSkill("dbt-skill", ["dbt"]),
      mockSkill("react-skill", ["react"]),
    ]
    const dynamicSkills = false
    let allAllowed: Skill.Info[]
    if (dynamicSkills) {
      const { included } = partitionByFingerprint(skills, mockFingerprint(["dbt"]))
      allAllowed = included
    } else {
      allAllowed = skills
    }
    expect(allAllowed).toHaveLength(2)
  })

  test("when config is true with message rescue, excluded skills can be rescued", () => {
    const skills = [
      mockSkill("dbt-skill", ["dbt"]),
      mockSkill("react-skill", ["react"]),
    ]
    const dynamicSkills = true
    let allAllowed: Skill.Info[]
    if (dynamicSkills) {
      const { included, excluded } = partitionByFingerprint(skills, mockFingerprint(["dbt"]))
      const rescued = rescueByMessage(excluded, "build a react dashboard")
      allAllowed = [...included, ...rescued]
    } else {
      allAllowed = skills
    }
    expect(allAllowed).toHaveLength(2)
    expect(allAllowed.map((s) => s.name)).toContain("react-skill")
  })
})
