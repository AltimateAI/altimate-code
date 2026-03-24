import { describe, test, expect } from "bun:test"
import { Skill } from "../../src/skill/skill"

function skill(overrides: Partial<Skill.Info> = {}): Skill.Info {
  return {
    name: overrides.name ?? "test-skill",
    description: overrides.description ?? "A test skill",
    location: overrides.location ?? "/home/user/skills/test-skill/SKILL.md",
    content: overrides.content ?? "# Test\nDo the thing.",
  }
}

describe("Skill.fmt: skill list formatting", () => {
  test("returns 'No skills' message for empty list", () => {
    expect(Skill.fmt([], { verbose: false })).toBe("No skills are currently available.")
    expect(Skill.fmt([], { verbose: true })).toBe("No skills are currently available.")
  })

  test("verbose mode returns XML with skill tags", () => {
    const skills = [
      skill({ name: "analyze", description: "Analyze code", location: "/path/to/analyze/SKILL.md" }),
      skill({ name: "deploy", description: "Deploy app", location: "/path/to/deploy/SKILL.md" }),
    ]
    const output = Skill.fmt(skills, { verbose: true })
    expect(output).toContain("<available_skills>")
    expect(output).toContain("</available_skills>")
    expect(output).toContain("<name>analyze</name>")
    expect(output).toContain("<description>Analyze code</description>")
    expect(output).toContain("<name>deploy</name>")
    expect(output).toContain("<description>Deploy app</description>")
    // File paths get converted to file:// URLs
    expect(output).toContain("file:///path/to/analyze/SKILL.md")
  })

  test("non-verbose returns markdown with bullet points", () => {
    const skills = [
      skill({ name: "lint", description: "Lint the code" }),
      skill({ name: "format", description: "Format files" }),
    ]
    const output = Skill.fmt(skills, { verbose: false })
    expect(output).toContain("## Available Skills")
    expect(output).toContain("- **lint**: Lint the code")
    expect(output).toContain("- **format**: Format files")
  })

  test("verbose mode preserves builtin: protocol without file:// conversion", () => {
    const skills = [
      skill({ name: "builtin-skill", description: "Built in", location: "builtin:my-skill/SKILL.md" }),
    ]
    const output = Skill.fmt(skills, { verbose: true })
    expect(output).toContain("<location>builtin:my-skill/SKILL.md</location>")
    // Should NOT contain file:// for builtin: paths
    expect(output).not.toContain("file://")
  })
})
