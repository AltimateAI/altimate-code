import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import { MCP } from "../../src/mcp"
import { testEffect } from "../lib/effect"
import { withLegacyInstanceRunner } from "./legacy-instance"
import fs from "node:fs/promises"
import path from "node:path"

const skills = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/skills/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/skills/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/skills/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/skills/manual-skill/SKILL.md",
    content: "# manual-skill",
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

const it = withLegacyInstanceRunner(testEffect(SystemPrompt.defaultLayer))

// altimate_change start — mocked-layer runner for tests that don't need a real
// on-disk instance (Meta prompt selection, MCP instructions formatting). The
// skills test above uses withLegacyInstanceRunner + real SKILL.md fixtures;
// these use Layer.mock so they don't need a live MCP connection.
const itMocked = testEffect(
  LayerNode.compile(SystemPrompt.node, [
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        instructions: () =>
          Effect.succeed([
            {
              name: "guide-server",
              instructions: "Use lookup before mutate.",
              tools: [],
            },
            {
              name: "tool-server",
              instructions: "Prefer search before update.",
              tools: ["tool-server_search", "tool-server_update"],
            },
          ]),
      }),
    ],
    [
      Skill.node,
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ],
  ]),
)
// altimate_change end

describe("session.system", () => {
  test("selects the Meta prompt for Muse Spark model IDs", () => {
    expect(SystemPrompt.provider({ api: { id: "meta/muse-spark-preview" } } as Provider.Model)[0]).toContain(
      "Meta Muse Spark",
    )
  })

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

  itMocked.effect("MCP output includes connected server instructions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          '  <server name="tool-server">',
          "    Prefer search before update.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  itMocked.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )
})
