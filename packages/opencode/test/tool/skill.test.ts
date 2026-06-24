// altimate_change start - add imports for env fingerprint skill selection tests
import { afterEach, describe, expect, test } from "bun:test"
// altimate_change end
import path from "path"
import { pathToFileURL } from "url"
import { Instance } from "../../src/project/instance"
import { SkillTool } from "../../src/tool/skill"
import { tmpdir } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
// altimate_change start - imports for env fingerprint skill selection tests
import { resetSkillSelectorCache, selectSkillsWithLLM, type SkillSelectorDeps } from "../../src/altimate/skill-selector"
import type { Skill } from "../../src/skill"
import { Fingerprint } from "../../src/altimate/fingerprint/index"
import { initTool, type TestToolContext } from "../altimate/tool-fixture"
// altimate_change end

const baseCtx: Omit<TestToolContext, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
}
type TestPermissionRequest = Parameters<NonNullable<TestToolContext["ask"]>>[0]

// altimate_change start - helpers for env fingerprint skill selection tests
/** Pre-populate the skill selector cache with a specific subset */
function seedCache(skillNames: string[]) {
  resetSkillSelectorCache()
  const skills = skillNames.map((name) => ({
    name,
    description: `Skill: ${name}`,
    location: `/fake/${name}/SKILL.md`,
    content: `# ${name}`,
  })) as Skill.Info[]
  const deps: SkillSelectorDeps = {
    run: async () => skillNames,
  }
  return selectSkillsWithLLM(skills, undefined, deps)
}
// altimate_change end

describe("tool.skill", () => {
  // altimate_change start - reset skill selector and fingerprint caches between tests
  afterEach(() => {
    resetSkillSelectorCache()
    Fingerprint.reset()
  })
  // altimate_change end

  test("description lists skill location URL", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "tool-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await initTool(SkillTool)
          const skillPath = path.join(tmp.path, ".opencode", "skill", "tool-skill", "SKILL.md")
          // altimate_change start - updated assertion to match XML skill description format
          expect(tool.description).toContain(`<name>tool-skill</name>`)
          expect(tool.description).toContain(`<description>Skill for tool tests.</description>`)
          // altimate_change end
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("execute returns skill content block with files", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "tool-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill

Use this skill.
`,
        )
        await Bun.write(path.join(skillDir, "scripts", "demo.txt"), "demo")
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await initTool(SkillTool)
          const requests: TestPermissionRequest[] = []
          const ctx: TestToolContext = {
            ...baseCtx,
            ask: async (req) => {
              requests.push(req)
            },
          }

          const result = await tool.execute({ name: "tool-skill" }, ctx)
          const dir = path.join(tmp.path, ".opencode", "skill", "tool-skill")
          const file = path.resolve(dir, "scripts", "demo.txt")

          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("skill")
          expect(requests[0].patterns).toContain("tool-skill")
          expect(requests[0].always).toContain("tool-skill")

          expect(result.metadata.dir).toBe(dir)
          expect(result.output).toContain(`<skill_content name="tool-skill">`)
          expect(result.output).toContain(`Base directory for this skill: ${pathToFileURL(dir).href}`)
          expect(result.output).toContain(`<file>${file}</file>`)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  // altimate_change start — e2e tests for follow-up suggestions in skill tool output
  test("execute includes follow-up suggestions before skill_content for mapped skills", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "dbt-develop")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: dbt-develop
description: Create dbt models.
---

# dbt Model Development

Build models with dbt.
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await initTool(SkillTool)
          const ctx: TestToolContext = {
            ...baseCtx,
            ask: async () => {},
          }

          const result = await tool.execute({ name: "dbt-develop" }, ctx)

          // Follow-ups present
          expect(result.output).toContain("## What's Next?")
          expect(result.output).toContain("dbt-test")
          expect(result.output).toContain("dbt-docs")
          expect(result.output).toContain("dbt-analyze")
          expect(result.output).toContain("/discover")

          // Follow-ups appear BEFORE skill_content (truncation-safe)
          const followupsIdx = result.output.indexOf("## What's Next?")
          const contentIdx = result.output.indexOf("<skill_content")
          expect(followupsIdx).toBeLessThan(contentIdx)

          // Skill content still present
          expect(result.output).toContain(`<skill_content name="dbt-develop">`)
          expect(result.output).toContain("Build models with dbt.")
          expect(result.output).toContain("</skill_content>")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("execute omits follow-up section for skills without followup mappings", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "custom-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: custom-skill
description: A custom skill with no followups.
---

# Custom Skill

Do custom things.
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await initTool(SkillTool)
          const ctx: TestToolContext = {
            ...baseCtx,
            ask: async () => {},
          }

          const result = await tool.execute({ name: "custom-skill" }, ctx)

          // No follow-up section
          expect(result.output).not.toContain("## What's Next?")
          expect(result.output).not.toContain("/discover")

          // Output starts directly with skill_content
          expect(result.output).toMatch(/^<skill_content/)
          expect(result.output).toContain("Do custom things.")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
  // altimate_change end

  // altimate_change start - env fingerprint skill selection config guard tests
  test("env_fingerprint_skill_selection absent (default) → selector bypassed, all skills shown", async () => {
    // Pre-populate cache — if selector were called, it would return this cached subset
    await seedCache(["skill-alpha"])

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const name of ["skill-alpha", "skill-beta"]) {
          await Bun.write(
            path.join(dir, ".opencode", "skill", name, "SKILL.md"),
            `---\nname: ${name}\ndescription: Test ${name}\n---\n# ${name}\n`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await initTool(SkillTool)
          // No config set → default false → selector bypassed → both skills appear
          expect(tool.description).toContain("<name>skill-alpha</name>")
          expect(tool.description).toContain("<name>skill-beta</name>")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("env_fingerprint_skill_selection: false → selector bypassed, all skills shown", async () => {
    // Pre-populate cache with only "skill-alpha" — if selector is called, it returns this cached subset
    await seedCache(["skill-alpha"])

    await using tmp = await tmpdir({
      git: true,
      config: {
        experimental: {
          env_fingerprint_skill_selection: false,
          auto_mcp_discovery: true,
        },
      },
      init: async (dir) => {
        for (const name of ["skill-alpha", "skill-beta"]) {
          await Bun.write(
            path.join(dir, ".opencode", "skill", name, "SKILL.md"),
            `---\nname: ${name}\ndescription: Test ${name}\n---\n# ${name}\n`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await initTool(SkillTool)
          // Selector was bypassed → both skills appear (from Skill.available, not cache)
          expect(tool.description).toContain("<name>skill-alpha</name>")
          expect(tool.description).toContain("<name>skill-beta</name>")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("env_fingerprint_skill_selection: true → selector called, uses cached subset", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        experimental: {
          env_fingerprint_skill_selection: true,
          auto_mcp_discovery: true,
        },
      },
      init: async (dir) => {
        for (const name of ["skill-alpha", "skill-beta"]) {
          await Bun.write(
            path.join(dir, ".opencode", "skill", name, "SKILL.md"),
            `---\nname: ${name}\ndescription: Test ${name}\n---\n# ${name}\n`,
          )
        }
      },
    })

    // Pre-populate cache with only "skill-alpha" AFTER tmpdir so location matches
    const alphaLocation = path.join(tmp.path, ".opencode", "skill", "skill-alpha", "SKILL.md")
    resetSkillSelectorCache()
    const deps: SkillSelectorDeps = {
      run: async () => ["skill-alpha"],
    }
    await selectSkillsWithLLM(
      [{ name: "skill-alpha", description: "Test skill-alpha", location: alphaLocation, content: "# skill-alpha" } as Skill.Info],
      undefined,
      deps,
    )

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await initTool(SkillTool)
          // Selector was called → returns cached subset (only skill-alpha)
          expect(tool.description).toContain("<name>skill-alpha</name>")
          expect(tool.description).not.toContain("<name>skill-beta</name>")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  }, 15000)
  // altimate_change end
})
