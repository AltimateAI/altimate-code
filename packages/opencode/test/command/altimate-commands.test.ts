import { describe, test, expect } from "bun:test"
import { Command } from "../../src/command/index"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

async function withInstance(fn: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({ directory: tmp.path, fn })
}

describe("Altimate builtin commands", () => {
  test("all altimate-specific commands are registered", async () => {
    await withInstance(async () => {
      const commands = await Command.list()
      const names = commands.map((c) => c.name)
      // These are the altimate_change commands that must ship with the package.
      // Regression guard: commit 528af75 fixed discover-and-add-mcps not shipping.
      expect(names).toContain("configure-claude")
      expect(names).toContain("configure-codex")
      expect(names).toContain("discover-and-add-mcps")
      expect(names).toContain("feedback")
    })
  })

  test("Command.Default includes all altimate constants", () => {
    expect(Command.Default.CONFIGURE_CLAUDE).toBe("configure-claude")
    expect(Command.Default.CONFIGURE_CODEX).toBe("configure-codex")
    expect(Command.Default.DISCOVER_MCPS).toBe("discover-and-add-mcps")
    expect(Command.Default.FEEDBACK).toBe("feedback")
  })

  test("discover-and-add-mcps has correct metadata and template", async () => {
    await withInstance(async () => {
      const cmd = await Command.get("discover-and-add-mcps")
      expect(cmd).toBeDefined()
      expect(cmd.name).toBe("discover-and-add-mcps")
      expect(cmd.source).toBe("command")
      expect(cmd.description).toBe("discover MCP servers from external AI tool configs and add them")
      const template = await cmd.template
      expect(template).toContain("mcp_discover")
      expect(cmd.hints).toContain("$ARGUMENTS")
    })
  })

  test("configure-claude has correct metadata", async () => {
    await withInstance(async () => {
      const cmd = await Command.get("configure-claude")
      expect(cmd).toBeDefined()
      expect(cmd.name).toBe("configure-claude")
      expect(cmd.source).toBe("command")
      expect(cmd.description).toBe("configure /altimate command in Claude Code")
    })
  })

  test("configure-codex has correct metadata", async () => {
    await withInstance(async () => {
      const cmd = await Command.get("configure-codex")
      expect(cmd).toBeDefined()
      expect(cmd.name).toBe("configure-codex")
      expect(cmd.source).toBe("command")
      expect(cmd.description).toBe("configure altimate skill in Codex CLI")
    })
  })
})
