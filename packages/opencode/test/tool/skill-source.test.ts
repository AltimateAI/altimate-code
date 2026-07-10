import { describe, test, expect } from "bun:test"
import path from "path"
import os from "os"
import { classifySkillSource } from "../../src/tool/skill"
import { skillToolSource } from "../../src/altimate/tool-source"

// The end-to-end "load a skill through the tool and read metadata.skillOrigin"
// path is exercised by the serve E2E. These unit tests pin the pure decision
// logic that drives the source badge: classifySkillSource (location → origin)
// and skillToolSource (origin → badge).

describe("classifySkillSource", () => {
  test("Altimate-shipped locations → builtin", () => {
    expect(classifySkillSource("builtin:data-viz/SKILL.md")).toBe("builtin")
    expect(classifySkillSource("/home/x/.altimate/builtin/dbt-analyze/SKILL.md")).toBe("builtin")
    expect(classifySkillSource("/app/node_modules/@altimateai/pkg/skills/x/SKILL.md")).toBe("builtin")
    // Windows-style separators must still match the Altimate-builtin marker.
    expect(classifySkillSource("C:\\Users\\x\\.altimate\\builtin\\dbt-analyze\\SKILL.md")).toBe("builtin")
  })

  test("a third-party skill under some other node_modules is NOT tagged Altimate", () => {
    expect(classifySkillSource("/work/repo/node_modules/some-other-pkg/skills/x/SKILL.md")).toBe("project")
  })

  test("skills under the user's home (but not Altimate builtin) → global", () => {
    expect(classifySkillSource(path.join(os.homedir(), ".claude", "skills", "mine", "SKILL.md"))).toBe("global")
  })

  test("skills elsewhere (project checkout) → project", () => {
    expect(classifySkillSource("/work/repo/.claude/skills/local/SKILL.md")).toBe("project")
  })
})

describe("skill origin → source badge (skillToolSource ∘ classifySkillSource)", () => {
  test("an Altimate-shipped skill wears the Altimate mark", () => {
    expect(skillToolSource(classifySkillSource("/home/x/.altimate/builtin/pii-audit/SKILL.md"))).toBe("altimate")
    expect(skillToolSource(classifySkillSource("builtin:data-viz/SKILL.md"))).toBe("altimate")
  })

  test("a project / user-authored skill stays neutral", () => {
    expect(skillToolSource(classifySkillSource("/work/repo/.claude/skills/jaffle-glossary/SKILL.md"))).toBe("builtin")
    expect(skillToolSource(classifySkillSource(path.join(os.homedir(), ".claude", "skills", "mine", "SKILL.md")))).toBe(
      "builtin",
    )
  })
})
