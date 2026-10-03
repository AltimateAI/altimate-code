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
// altimate_change start — learn-managed skills are excluded from automatic injection
import { create, HEADER, serialize, withBullets } from "../../src/altimate/learn/playbook"
import { TestInstance } from "../fixture/fixture"
// altimate_change end

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

  // altimate_change start — the managed marker, rather than the skill's name, controls exclusion
  for (const autoLoad of ["alwaysApply: true", 'applyPaths: ["package.json"]']) {
    it.instance(
      `excludes custom learn-managed skills with ${autoLoad} while ordinary skills still auto-load`,
      () =>
        Effect.gen(function* () {
          const prompt = yield* SystemPrompt.Service
          const output = yield* prompt.skills(build)
          expect(output).toContain('<auto_loaded_skill name="team-playbook">')
          expect(output).toContain("Ordinary project guidance.")
          expect(output).not.toContain('<auto_loaded_skill name="custom-lessons">')
          expect(output).not.toContain("Stale learned rule.")
          const instance = yield* TestInstance
          const retained = yield* Effect.promise(() =>
            Bun.file(path.join(instance.directory, ".opencode", "skill", "custom-lessons", "SKILL.md")).text(),
          )
          expect(retained).toContain(HEADER)
        }),
      {
        init: (directory) =>
          Effect.promise(async () => {
            await Bun.write(path.join(directory, "package.json"), "{}")
            for (const [name, body] of [
              ["team-playbook", "Ordinary project guidance."],
              ["custom-lessons", `${HEADER}\nStale learned rule.`],
            ]) {
              await Bun.write(
                path.join(directory, ".opencode", "skill", name, "SKILL.md"),
                ["---", `name: ${name}`, "description: Project guidance.", autoLoad, "---", body].join("\n"),
              )
            }
          }),
      },
    )
  }

  it.instance(
    "excludes a published playbook export from local auto-loading",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SystemPrompt.Service
        const output = yield* prompt.skills(build)
        expect(output).toContain("<name>published-lessons</name>")
        expect(output).not.toContain('<auto_loaded_skill name="published-lessons">')
        expect(output).not.toContain("Use publishArtifact for workspace exports.")
      }),
    {
      init: (directory) =>
        Effect.promise(async () => {
          const exported = serialize(
            withBullets(create({ name: "published-lessons" }), [
              { id: "L-abcd", text: "Use publishArtifact for workspace exports.", helpful: 2, harmful: 0 },
            ]),
          )
          await Bun.write(path.join(directory, ".opencode", "skill", "published-lessons", "SKILL.md"), exported)
        }),
    },
  )
  // altimate_change end
})
