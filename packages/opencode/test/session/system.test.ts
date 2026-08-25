import { describe, expect } from "bun:test"
import { Effect } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Permission } from "../../src/permission"
import { SystemPrompt } from "../../src/session/system"
import { testEffect } from "../lib/effect"
import { withLegacyInstanceRunner } from "./legacy-instance"
import fs from "node:fs/promises"
import path from "node:path"

const skills = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
  },
  {
    name: "manual-skill",
  },
  // `sort-a` / `sort_a` order differently under locale collation than by codepoint: ICU gives
  // underscore first, codepoint gives hyphen first (0x2D < 0x5F). Reverting the comparator to
  // `localeCompare` flips these two and fails the assertion below.
  {
    name: "sort-a",
    description: "Hyphen variant.",
  },
  {
    name: "sort_a",
    description: "Underscore variant.",
  },
]

const writeSkillFixtures = (directory: string) =>
  Effect.promise(async () => {
    for (const skill of skills) {
      const dir = path.join(directory, ".opencode", "skill", skill.name)
      await fs.mkdir(dir, { recursive: true })
      await Bun.write(
        path.join(dir, "SKILL.md"),
        [
          "---",
          `name: ${skill.name}`,
          skill.description ? `description: ${skill.description}` : undefined,
          "---",
          "",
          `# ${skill.name}`,
          "",
        ]
          .filter((line) => line !== undefined)
          .join("\n"),
      )
    }
  })

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = withLegacyInstanceRunner(testEffect(SystemPrompt.layer))

describe("session.system", () => {
  it.instance(
    "skills output is sorted by name and stable across calls",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SystemPrompt.Service
        const first = yield* prompt.skills(build)
        const second = yield* prompt.skills(build)
        const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

        expect(first).toBe(second)

        const alpha = output.indexOf("<name>alpha-skill</name>")
        const middle = output.indexOf("<name>middle-skill</name>")
        const zeta = output.indexOf("<name>zeta-skill</name>")

        expect(alpha).toBeGreaterThan(-1)
        expect(middle).toBeGreaterThan(alpha)
        expect(zeta).toBeGreaterThan(middle)
        expect(output).not.toContain("manual-skill")
      }),
    { init: writeSkillFixtures },
  )

  it.instance(
    "skills are ordered by codepoint, not by the runtime's locale",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SystemPrompt.Service
        const output =
          (yield* prompt.skills(build)) ??
          (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

        // The skills block sits near the head of the system prompt, and exact-prefix caches
        // stop at the first differing byte. An order that depends on LANG or ICU data means
        // two machines emit different bytes here and share no prefix at all.
        const hyphen = output.indexOf("<name>sort-a</name>")
        const underscore = output.indexOf("<name>sort_a</name>")

        expect(hyphen).toBeGreaterThan(-1)
        expect(underscore).toBeGreaterThan(-1)
        expect(hyphen).toBeLessThan(underscore)
        expect("sort-a".localeCompare("sort_a")).toBeGreaterThan(0)
      }),
    { init: writeSkillFixtures },
  )
})
