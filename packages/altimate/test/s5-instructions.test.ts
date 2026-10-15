import { expect, test } from "bun:test"
import { Plugin } from "@opencode/plugin"
import { mkdir, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { claudeInstructions } from "../src/instructions"
import { createFixture, createHost } from "./lib/host"

const scenarios: {
  name: string
  files: Record<string, string>
  directory: string
  expected: string[]
  absent: string[]
}[] = [
  {
    name: "S5.1. default Altimate injects project-root CLAUDE.md",
    files: { "CLAUDE.md": "root-claude-only" },
    directory: "",
    expected: ["root-claude-only"],
    absent: [],
  },
  {
    name: "S5.2. core AGENTS.md wins over CLAUDE.md without duplicate injection",
    files: { "AGENTS.md": "root-agents-wins", "CLAUDE.md": "root-claude-loses" },
    directory: "",
    expected: ["root-agents-wins"],
    absent: ["root-claude-loses"],
  },
  {
    name: "S5.3. nested CLAUDE.md precedes project-root CLAUDE.md",
    files: { "nested/CLAUDE.md": "nested-claude-first", "CLAUDE.md": "root-claude-second" },
    directory: "nested",
    expected: ["nested-claude-first", "root-claude-second"],
    absent: [],
  },
  {
    name: "S5.4. root AGENTS.md suppresses nested CLAUDE.md across the entire walk",
    files: { "AGENTS.md": "ancestor-agents-wins", "nested/CLAUDE.md": "nearest-claude-loses" },
    directory: "nested",
    expected: ["ancestor-agents-wins"],
    absent: ["nearest-claude-loses"],
  },
]

for (const scenario of scenarios) {
  test(
    scenario.name,
    async () => {
      await using fixture = await instructionFixture(scenario.files)
      const contexts: string[] = []
      await using host = await createHost({
        directory: fixture.path,
        sessionDirectory: join(fixture.path, "project", scenario.directory),
        project: true,
        plugins: [
          Plugin.define({
            id: "s5-context-observer",
            async setup(ctx) {
              await ctx.session.hook("context", (event) => {
                contexts.push(event.system.map((part) => part.text).join("\n\n"))
              })
            },
          }),
        ],
      })
      const session = await host.createSession()
      await host.run(session.id, [])
      expect(host.model.calls).toHaveLength(1)
      expect(contexts).toHaveLength(1)
      const system = systemPrompt(host)
      for (const marker of scenario.expected) {
        expect(system.split(marker)).toHaveLength(2)
        expect(contexts[0]).toContain(marker)
      }
      for (const marker of scenario.absent) expect(system).not.toContain(marker)
      if (scenario.expected.length === 2) {
        expect(system.indexOf(scenario.expected[0])).toBeLessThan(system.indexOf(scenario.expected[1]))
      }
      for (const [file, marker] of Object.entries(scenario.files)) {
        if (scenario.expected.includes(marker)) {
          expect(system).toContain(`Instructions from: ${join(fixture.path, "project", file)}\n${marker}`)
        }
      }
    },
    30_000,
  )
}

test("S5.5. global CLAUDE.md fallback precedes project CLAUDE.md", async () => {
  await using fixture = await instructionFixture({ "CLAUDE.md": "global-test-project" })
  await Bun.write(join(fixture.path, ".claude", "CLAUDE.md"), "global-claude-fallback")
  await using host = await createHost({
    directory: fixture.path,
    sessionDirectory: join(fixture.path, "project"),
    project: true,
    altimate: false,
    plugins: [claudeInstructions({ home: fixture.path, configDirectory: join(fixture.path, "config") })],
  })
  const session = await host.createSession()
  await host.run(session.id, [])
  const system = systemPrompt(host)
  expect(system.split("global-claude-fallback")).toHaveLength(2)
  expect(system.split("global-test-project")).toHaveLength(2)
  expect(system.indexOf("global-claude-fallback")).toBeLessThan(system.indexOf("global-test-project"))
}, 30_000)

test("S5.6. global config AGENTS.md suppresses home fallback but permits project CLAUDE.md", async () => {
  await using fixture = await instructionFixture({ "CLAUDE.md": "global-precedence-project" })
  await Bun.write(join(fixture.path, ".claude", "CLAUDE.md"), "global-claude-suppressed")
  await Bun.write(join(fixture.path, "config", "AGENTS.md"), "global-agents-selected")
  await using host = await createHost({
    directory: fixture.path,
    sessionDirectory: join(fixture.path, "project"),
    project: true,
    altimate: false,
    plugins: [claudeInstructions({ home: fixture.path, configDirectory: join(fixture.path, "config") })],
  })
  const session = await host.createSession()
  await host.run(session.id, [])
  const system = systemPrompt(host)
  expect(system.split("global-agents-selected")).toHaveLength(2)
  expect(system.split("global-precedence-project")).toHaveLength(2)
  expect(system).not.toContain("global-claude-suppressed")
  expect(system.indexOf("global-agents-selected")).toBeLessThan(system.indexOf("global-precedence-project"))
}, 30_000)

test("S5.7. disabling the home Claude prompt preserves project CLAUDE.md", async () => {
  await using fixture = await instructionFixture({ "CLAUDE.md": "project-survives-home-disable" })
  await Bun.write(join(fixture.path, ".claude", "CLAUDE.md"), "disabled-home-instructions")
  await using host = await createHost({
    directory: fixture.path,
    sessionDirectory: join(fixture.path, "project"),
    project: true,
    altimate: false,
    plugins: [
      claudeInstructions({
        home: fixture.path,
        configDirectory: join(fixture.path, "config"),
        disableClaudeCodePrompt: true,
      }),
    ],
  })
  const session = await host.createSession()
  await host.run(session.id, [])
  expect(systemPrompt(host)).toContain("project-survives-home-disable")
  expect(systemPrompt(host)).not.toContain("disabled-home-instructions")
}, 30_000)

test("S5.8. disabling project discovery preserves the global fallback", async () => {
  await using fixture = await instructionFixture({ "CLAUDE.md": "disabled-project-instructions" })
  await Bun.write(join(fixture.path, ".claude", "CLAUDE.md"), "home-survives-project-disable")
  await using host = await createHost({
    directory: fixture.path,
    sessionDirectory: join(fixture.path, "project"),
    project: false,
    altimate: false,
    plugins: [
      claudeInstructions({ home: fixture.path, configDirectory: join(fixture.path, "config"), project: false }),
    ],
  })
  const session = await host.createSession()
  await host.run(session.id, [])
  expect(systemPrompt(host)).toContain("home-survives-project-disable")
  expect(systemPrompt(host)).not.toContain("disabled-project-instructions")
}, 30_000)

test("S5.9. home fallback precedes core project AGENTS while project CLAUDE stays suppressed", async () => {
  await using fixture = await instructionFixture({
    "AGENTS.md": "independent-project-agents",
    "CLAUDE.md": "independent-project-claude-suppressed",
  })
  await Bun.write(join(fixture.path, ".claude", "CLAUDE.md"), "independent-global-claude")
  await using host = await createHost({
    directory: fixture.path,
    sessionDirectory: join(fixture.path, "project"),
    project: true,
    altimate: false,
    plugins: [claudeInstructions({ home: fixture.path, configDirectory: join(fixture.path, "config") })],
  })
  const session = await host.createSession()
  await host.run(session.id, [])
  const system = systemPrompt(host)
  expect(system.split("independent-global-claude")).toHaveLength(2)
  expect(system.split("independent-project-agents")).toHaveLength(2)
  expect(system).not.toContain("independent-project-claude-suppressed")
  expect(system.indexOf("independent-global-claude")).toBeLessThan(system.indexOf("independent-project-agents"))
}, 30_000)

test("S5.10. empty root AGENTS.md still suppresses nested CLAUDE.md", async () => {
  await using fixture = await instructionFixture({
    "AGENTS.md": "",
    "nested/CLAUDE.md": "claude-blocked-by-empty-agents",
  })
  await using host = await createHost({
    directory: fixture.path,
    sessionDirectory: join(fixture.path, "project", "nested"),
    project: true,
  })
  const session = await host.createSession()
  await host.run(session.id, [])
  expect(systemPrompt(host)).not.toContain("claude-blocked-by-empty-agents")
}, 30_000)

async function instructionFixture(files: Record<string, string>) {
  const fixture = await createFixture()
  await mkdir(join(fixture.path, "project", "nested"), { recursive: true })
  await mkdir(join(fixture.path, ".claude"), { recursive: true })
  await mkdir(join(fixture.path, "config"), { recursive: true })
  const git = Bun.spawn(["git", "init", "--quiet", join(fixture.path, "project")], {
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(await git.exited).toBe(0)
  await Promise.all(
    Object.entries(files).map(async ([file, content]) => {
      const target = join(fixture.path, "project", file)
      await mkdir(dirname(target), { recursive: true })
      await Bun.write(target, content)
    }),
  )
  return { ...fixture, path: await realpath(fixture.path) }
}

function systemPrompt(host: Awaited<ReturnType<typeof createHost>>) {
  expect(host.model.calls).toHaveLength(1)
  return host.model.calls[0].prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
}
