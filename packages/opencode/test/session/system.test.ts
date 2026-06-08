import { describe, expect, test } from "bun:test"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import type { Provider } from "../../src/provider/provider"
import { tmpdir } from "../fixture/fixture"

function makeModel(overrides: { apiId: string; family?: string; providerID?: string }): Provider.Model {
  return {
    id: overrides.apiId as any,
    providerID: (overrides.providerID ?? "test") as Provider.Model["providerID"],
    api: { id: overrides.apiId, url: "", npm: "@ai-sdk/openai-compatible" },
    name: overrides.apiId,
    family: overrides.family,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, output: 0 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-01-01",
  } as Provider.Model
}

describe("session.system.provider routing", () => {
  // `codex_header.txt` (GPT-5 prompt) is the only base prompt with `## Editing
  // constraints` / `apply_patch`. The Claude-style fallback (`qwen.txt`) is the
  // only base prompt that begins with "Refuse to write code or explain code
  // that may be used maliciously".

  test("altimate-default routes to GPT-5 prompt via provider+family, not the Anthropic fallback", () => {
    const prompts = SystemPrompt.provider(
      makeModel({ apiId: "altimate-default", providerID: "altimate-backend", family: "openai" }),
    )
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatch(/## Editing constraints/)
    expect(prompts[0]).toMatch(/apply_patch/)
    expect(prompts[0]).not.toMatch(/Refuse to write code or explain code that may be used maliciously/)
  })

  test("altimate-backend anthropic-family routes to the same Claude prompt as direct anthropic", () => {
    const prompts = SystemPrompt.provider(
      makeModel({ apiId: "altimate-something", providerID: "altimate-backend", family: "anthropic" }),
    )
    const baselineAnthropic = SystemPrompt.provider(
      makeModel({ apiId: "claude-3-7-sonnet", providerID: "anthropic", family: "anthropic" }),
    )
    expect(prompts).toEqual(baselineAnthropic)
  })

  test("altimate-backend with unknown / missing family defaults to GPT-5 codex (gateway is openai-compatible)", () => {
    // Without this default the unknown-family branch would fall through to
    // PROMPT_ANTHROPIC_WITHOUT_TODO, recreating the GH #887 routing problem
    // the moment a new family value appears in config.
    for (const family of [undefined, "", "unknown-future-family"]) {
      const prompts = SystemPrompt.provider(
        makeModel({ apiId: "altimate-default", providerID: "altimate-backend", family }),
      )
      expect(prompts[0]).toMatch(/## Editing constraints/)
      expect(prompts[0]).not.toMatch(/Refuse to write code or explain code that may be used maliciously/)
    }
  })

  test("altimate-backend family lookup is case-insensitive", () => {
    const lower = SystemPrompt.provider(
      makeModel({ apiId: "altimate-default", providerID: "altimate-backend", family: "anthropic" }),
    )
    const upper = SystemPrompt.provider(
      makeModel({ apiId: "altimate-default", providerID: "altimate-backend", family: "Anthropic" }),
    )
    const mixed = SystemPrompt.provider(
      makeModel({ apiId: "altimate-default", providerID: "altimate-backend", family: "ANTHROPIC" }),
    )
    expect(upper).toEqual(lower)
    expect(mixed).toEqual(lower)
  })

  test("altimate-backend gemini-family routes to the same prompt as a direct gemini model", () => {
    // familyVendor maps the specific gateway family values (`gemini-pro`,
    // `gemini-flash`, …) to "gemini", so an altimate-backend Gemini model must
    // land on PROMPT_GEMINI — not fall through to the codex default. Guards the
    // #888 J1 class for the gemini branch specifically.
    const prompts = SystemPrompt.provider(
      makeModel({ apiId: "altimate-default", providerID: "altimate-backend", family: "gemini-pro" }),
    )
    const baselineGemini = SystemPrompt.provider(makeModel({ apiId: "gemini-2.0-flash", providerID: "google" }))
    expect(prompts).toEqual(baselineGemini)
    // And it must NOT be the codex default that an unknown family gets.
    const codexDefault = SystemPrompt.provider(
      makeModel({ apiId: "altimate-default", providerID: "altimate-backend", family: "unknown-future-family" }),
    )
    expect(prompts).not.toEqual(codexDefault)
  })

  test("non-altimate openai models still use the existing api.id matching", () => {
    const gpt5 = SystemPrompt.provider(makeModel({ apiId: "gpt-5", providerID: "openai" }))
    expect(gpt5[0]).toMatch(/## Editing constraints/)
    const gpt4 = SystemPrompt.provider(makeModel({ apiId: "gpt-4o", providerID: "openai" }))
    expect(gpt4[0]).not.toMatch(/## Editing constraints/)
  })
})

describe("session.system", () => {
  test("skills output is sorted by name and stable across calls", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const [name, description] of [
          ["zeta-skill", "Zeta skill."],
          ["alpha-skill", "Alpha skill."],
          ["middle-skill", "Middle skill."],
        ]) {
          const skillDir = path.join(dir, ".opencode", "skill", name)
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: ${name}
description: ${description}
---

# ${name}
`,
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
          const build = await Agent.get("build")
          const first = await SystemPrompt.skills(build!)
          const second = await SystemPrompt.skills(build!)

          expect(first).toBe(second)

          const alpha = first!.indexOf("<name>alpha-skill</name>")
          const middle = first!.indexOf("<name>middle-skill</name>")
          const zeta = first!.indexOf("<name>zeta-skill</name>")

          expect(alpha).toBeGreaterThan(-1)
          expect(middle).toBeGreaterThan(alpha)
          expect(zeta).toBeGreaterThan(middle)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})
