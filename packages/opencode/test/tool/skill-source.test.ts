import { afterEach, describe, test, expect } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { SkillTool, classifySkillSource } from "../../src/tool/skill"
import { skillToolSource } from "../../src/altimate/tool-source"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"

const ctx = {
  sessionID: SessionID.make("ses_test-skill-source"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("classifySkillSource", () => {
  test("Altimate-shipped locations → builtin", () => {
    expect(classifySkillSource("builtin:data-viz/SKILL.md")).toBe("builtin")
    expect(classifySkillSource("/home/x/.altimate/builtin/dbt-analyze/SKILL.md")).toBe("builtin")
    expect(classifySkillSource("/app/node_modules/@altimateai/pkg/skills/x/SKILL.md")).toBe("builtin")
    // Windows-style separators must still match the Altimate-builtin marker.
    expect(classifySkillSource("C:\\Users\\x\\.altimate\\builtin\\dbt-analyze\\SKILL.md")).toBe("builtin")
  })

  test("skills under the user's home (but not Altimate builtin) → global", () => {
    expect(classifySkillSource(path.join(os.homedir(), ".claude", "skills", "mine", "SKILL.md"))).toBe("global")
  })

  test("skills elsewhere (project checkout) → project", () => {
    expect(classifySkillSource("/work/repo/.claude/skills/local/SKILL.md")).toBe("project")
  })
})

describe("skill tool stamps origin that drives the source badge", () => {
  afterEach(async () => {
    await Instance.disposeAll()
  })

  test("a real project skill load reports origin=project → neutral (builtin) badge", async () => {
    await using tmp = await tmpdir()
    // Lay down a project-level skill the way Claude Code / opencode discover them.
    const skillDir = path.join(tmp.path, ".claude", "skills", "e2e-probe")
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      ["---", "name: e2e-probe", "description: probe skill for source-badge test", "---", "", "Probe body."].join("\n"),
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skill = await SkillTool.init()
        const result = await skill.execute({ name: "e2e-probe" }, ctx)

        // The tool now carries the loaded skill's origin on its metadata...
        expect(result.metadata.skillOrigin).toBe("project")
        // ...and the badge policy maps a user/project skill to the neutral badge.
        expect(skillToolSource(result.metadata.skillOrigin)).toBe("builtin")
        // The humanized title path is unaffected.
        expect(result.title).toBe("Loaded skill: e2e-probe")
      },
    })
  })

  test("a real Altimate-shipped (~/.altimate/builtin) skill load → origin=builtin → altimate badge", async () => {
    await using tmp = await tmpdir()
    // Seed an Altimate-shipped skill in an isolated home's builtin dir, mirroring
    // how postinstall lays bundled skills under ~/.altimate/builtin/.
    const prevHome = process.env["OPENCODE_TEST_HOME"]
    const home = path.join(tmp.path, "home")
    const builtinSkillDir = path.join(home, ".altimate", "builtin", "e2e-builtin-probe")
    await fs.mkdir(builtinSkillDir, { recursive: true })
    await fs.writeFile(
      path.join(builtinSkillDir, "SKILL.md"),
      ["---", "name: e2e-builtin-probe", "description: bundled probe skill", "---", "", "Bundled body."].join("\n"),
    )
    process.env["OPENCODE_TEST_HOME"] = home
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const skill = await SkillTool.init()
          const result = await skill.execute({ name: "e2e-builtin-probe" }, ctx)

          // A bundled skill is classified as builtin origin...
          expect(result.metadata.skillOrigin).toBe("builtin")
          // ...which the badge policy promotes to the Altimate mark.
          expect(skillToolSource(result.metadata.skillOrigin)).toBe("altimate")
        },
      })
    } finally {
      if (prevHome === undefined) delete process.env["OPENCODE_TEST_HOME"]
      else process.env["OPENCODE_TEST_HOME"] = prevHome
    }
  })
})
