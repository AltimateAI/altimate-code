// altimate_change - new file
//
// The Skills dialog's action picker must decide "built-in" the way the CLI
// does. It decided by prefix alone — `builtin:` or a non-absolute path — and
// on any postinstall'd machine the loader prefers the filesystem copy under
// `~/.altimate/builtin`, registered by ABSOLUTE path. So every shipped
// built-in was publishable from the TUI, and one published to a workspace
// syncs back as a managed skill that overrides the shipped one for every
// linked member, frozen at that version. (Ralph, review of #1313; Kilo and
// Codex found the same trace independently.)
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Global } from "../../../src/global"
import { skillSource } from "../../../src/cli/cmd/skill-helpers"
import { isBuiltinLocation, isGlobalLocation } from "../../../src/plugin/tui/altimate/skill-ops"
import { isManagedSkill } from "../../../src/altimate/workspace/skill-publish"

describe("the action picker's notion of built-in", () => {
  test("agrees with the CLI's for a filesystem-installed built-in", () => {
    const installed = path.join(Global.Path.home, ".altimate", "builtin", "x", "SKILL.md")
    // The three predicates Ralph traced: CLI true, TUI true, managed false.
    expect(skillSource(installed)).toBe("builtin")
    expect(isBuiltinLocation(installed)).toBe(true)
    expect(isManagedSkill("/some/project", path.dirname(installed))).toBe(false)
  })

  test("still treats the embedded and the non-absolute forms as built-in", () => {
    expect(isBuiltinLocation("builtin:x/SKILL.md")).toBe(true)
    expect(isBuiltinLocation("relative/x/SKILL.md")).toBe(true)
    expect(isBuiltinLocation(undefined)).toBe(true)
  })

  test("does not call a project skill built-in", () => {
    expect(isBuiltinLocation("/some/project/.opencode/skills/deploy/SKILL.md")).toBe(false)
  })

  test("a personal skill under the home directory is global, and not publishable", () => {
    for (const dir of [".claude", ".agents", ".altimate-code"]) {
      expect(isGlobalLocation(path.join(Global.Path.home, dir, "skills", "x", "SKILL.md"))).toBe(true)
    }
    expect(isGlobalLocation("/some/project/.opencode/skills/deploy/SKILL.md")).toBe(false)
  })
})

describe("skillSource contains by path segment, not by string prefix", () => {
  test("a sibling directory sharing a global dir's prefix is a project skill", () => {
    // `~/.claude/skills-archive/x` starts with the string `~/.claude/skills`
    // but is not inside it; a raw prefix check refused it as personal.
    const sibling = path.join(Global.Path.home, ".claude", "skills-archive", "x", "SKILL.md")
    expect(skillSource(sibling)).toBe("project")
    expect(isGlobalLocation(sibling)).toBe(false)
    const builtinSibling = path.join(Global.Path.home, ".altimate", "builtin-old", "x", "SKILL.md")
    expect(skillSource(builtinSibling)).toBe("project")
  })
})
