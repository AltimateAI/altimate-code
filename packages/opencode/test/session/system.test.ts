import { afterAll, beforeAll, describe, expect, spyOn } from "bun:test"
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
import * as SkillSelector from "../../src/altimate/skill-selector"
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

// These tests pin the full (unbounded) skill listing; the bounded format has its own tests in
// test/altimate/skill-listing.test.ts.
beforeAll(() => {
  process.env.ALTIMATE_BOUNDED_SKILL_LISTING = "0"
})
afterAll(() => {
  delete process.env.ALTIMATE_BOUNDED_SKILL_LISTING
})

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

  for (const disabledBy of ["config", "env"] as const) {
    it.instance(
      `learning kill switch from ${disabledBy} excludes managed candidates before selector limit`,
      () =>
        Effect.gen(function* () {
          const prompt = yield* SystemPrompt.Service
          const previous = process.env.ALTIMATE_LEARN
          const candidates: string[][] = []
          const selector = spyOn(SkillSelector, "selectSkillsWithLLM").mockImplementation(async (list) => {
            candidates.push(list.map((skill) => skill.name))
            return list.slice(0, 15)
          })
          try {
            process.env.ALTIMATE_LEARN = disabledBy === "env" ? "false" : ""
            const output = yield* prompt.skills(build)
            expect(candidates).toHaveLength(1)
            expect(candidates[0]).toContain("ordinary-rules")
            expect(candidates[0]?.some((name) => name.startsWith("published-lesson-"))).toBe(false)
            expect(output).toContain("<name>ordinary-rules</name>")
          } finally {
            selector.mockRestore()
            if (previous === undefined) delete process.env.ALTIMATE_LEARN
            else process.env.ALTIMATE_LEARN = previous
          }
        }),
      {
        config: {
          learn: { enabled: disabledBy !== "config" },
          experimental: { env_fingerprint_skill_selection: true },
        },
        init: (directory) =>
          Effect.promise(async () => {
            for (let i = 0; i < 16; i++) {
              const name = `published-lesson-${i}`
              await Bun.write(path.join(directory, ".opencode", "skill", name, "SKILL.md"),
                `---\nname: ${name}\ndescription: Learned guidance.\n---\n${HEADER}\nLearned rule.`)
            }
            await Bun.write(path.join(directory, ".opencode", "skill", "ordinary-rules", "SKILL.md"),
              "---\nname: ordinary-rules\ndescription: Ordinary guidance.\n---\nOrdinary guidance.")
          }),
      },
    )
  }

  // altimate_change start — refresh cached candidates when learning is re-enabled
  it.instance(
    "learning re-enable restores managed skills after a disabled selection was cached",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SystemPrompt.Service
        const previous = process.env.ALTIMATE_LEARN
        const select = SkillSelector.selectSkillsWithLLM
        const candidates: string[][] = []
        SkillSelector.resetSkillSelectorCache()
        const selector = spyOn(SkillSelector, "selectSkillsWithLLM").mockImplementation((list, fingerprint) =>
          select(list, fingerprint, {
            run: async (_prompt, names) => {
              candidates.push(names)
              return names.filter((name) => name === "ordinary-rules" || name === "published-lessons")
            },
          }),
        )
        try {
          process.env.ALTIMATE_LEARN = "false"
          const disabled = yield* prompt.skills(build)
          expect(disabled).toContain("<name>ordinary-rules</name>")
          expect(disabled).not.toContain("<name>published-lessons</name>")
          expect(yield* prompt.skills(build)).toBe(disabled)
          expect(candidates).toHaveLength(1)

          process.env.ALTIMATE_LEARN = "true"
          const enabled = yield* prompt.skills(build)
          expect(enabled).toContain("<name>published-lessons</name>")
          expect(enabled).toContain("Learned project guidance.")
          expect(candidates).toHaveLength(2)

          process.env.ALTIMATE_LEARN = "false"
          expect(yield* prompt.skills(build)).toBe(disabled)
        } finally {
          selector.mockRestore()
          SkillSelector.resetSkillSelectorCache()
          if (previous === undefined) delete process.env.ALTIMATE_LEARN
          else process.env.ALTIMATE_LEARN = previous
        }
      }),
    {
      config: { learn: { enabled: true }, experimental: { env_fingerprint_skill_selection: true } },
      init: (directory) =>
        Effect.promise(async () => {
          for (const [name, content] of [
            ["published-lessons", `${HEADER}\nLearned project guidance.`],
            ["ordinary-rules", "Ordinary project guidance."],
          ]) {
            await Bun.write(path.join(directory, ".opencode", "skill", name, "SKILL.md"),
              `---\nname: ${name}\ndescription: Project guidance.\nalwaysApply: true\n---\n${content}`)
          }
        }),
    },
  )
  // altimate_change end

  // altimate_change start — suppress managed exports only when the local lesson store replaces them
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
            await Bun.write(path.join(directory, ".altimate-code", "learn", "custom-lessons", "approved.json"), "[]")
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
          await Bun.write(path.join(directory, ".altimate-code", "learn", "published-lessons", "approved.json"), "[]")
        }),
    },
  )

  for (const autoLoad of ["alwaysApply", "applyPaths"] as const) {
    for (const disabledBy of ["config", "env"] as const) {
      it.instance(
        `learning kill switch from ${disabledBy} suppresses a received ${autoLoad} playbook without local lessons`,
        () =>
          Effect.gen(function* () {
            const prompt = yield* SystemPrompt.Service
            const previous = process.env.ALTIMATE_LEARN
            const output = yield* Effect.acquireUseRelease(
              Effect.sync(() => { process.env.ALTIMATE_LEARN = disabledBy === "env" ? "false" : "" }),
              () => prompt.skills(build),
              () => Effect.sync(() => {
                if (previous === undefined) delete process.env.ALTIMATE_LEARN
                else process.env.ALTIMATE_LEARN = previous
              }),
            )
            expect(output).toContain('<auto_loaded_skill name="ordinary-rules">')
            expect(output).not.toContain('<auto_loaded_skill name="published-lessons">')
            expect(output).not.toContain("<name>published-lessons</name>")
            expect(output).not.toContain("Use publishArtifact for workspace exports.")
          }),
        {
          config: { learn: { enabled: disabledBy !== "config" } },
          init: (directory) =>
            Effect.promise(async () => {
              const exported = serialize(withBullets(create({
                name: "published-lessons",
                ...(autoLoad === "applyPaths" ? { applyPaths: ["package.json"] } : {}),
              }), [{ id: "L-abcd", text: "Use publishArtifact for workspace exports.", helpful: 2, harmful: 0 }]))
              await Bun.write(path.join(directory, "package.json"), "{}")
              await Bun.write(path.join(directory, ".opencode", "skill", "published-lessons", "SKILL.md"), exported)
              await Bun.write(path.join(directory, ".opencode", "skill", "ordinary-rules", "SKILL.md"),
                "---\nname: ordinary-rules\ndescription: Ordinary guidance.\nalwaysApply: true\n---\nOrdinary guidance.")
            }),
        },
      )
    }
    for (const localStore of ["absent", "candidate-only", "different-name"] as const) {
      it.instance(
        `auto-loads a received ${autoLoad} playbook when the local approved store is ${localStore}`,
        () =>
          Effect.gen(function* () {
            const prompt = yield* SystemPrompt.Service
            const output = yield* prompt.skills(build)
            expect(output).toContain('<auto_loaded_skill name="published-lessons">')
            expect(output).toContain("Use publishArtifact for workspace exports.")
            const instance = yield* TestInstance
            expect(yield* Effect.promise(() =>
              Bun.file(path.join(instance.directory, ".altimate-code", "learn", "published-lessons", "approved.json")).exists(),
            )).toBe(false)
          }),
        {
          init: (directory) =>
            Effect.promise(async () => {
              const exported = serialize(
                withBullets(create({
                  name: "published-lessons",
                  ...(autoLoad === "applyPaths" ? { applyPaths: ["package.json"] } : {}),
                }), [
                  { id: "L-abcd", text: "Use publishArtifact for workspace exports.", helpful: 2, harmful: 0 },
                ]),
              )
              await Bun.write(path.join(directory, "package.json"), "{}")
              await Bun.write(path.join(directory, ".opencode", "skill", "published-lessons", "SKILL.md"), exported)
              if (localStore === "candidate-only")
                await Bun.write(path.join(directory, ".altimate-code", "learn", "published-lessons", "candidate.json"), "[]")
              if (localStore === "different-name")
                await Bun.write(path.join(directory, ".altimate-code", "learn", "other-lessons", "approved.json"), "[]")
            }),
        },
      )
    }
  }
  // altimate_change end
})
