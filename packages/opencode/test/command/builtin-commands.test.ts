import { describe, test, expect } from "bun:test"
import { Command } from "../../src/command/index"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

async function withInstance(fn: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({ directory: tmp.path, fn })
}

describe("altimate builtin commands", () => {
  describe("discover-and-add-mcps", () => {
    test("is registered as a default command", async () => {
      await withInstance(async () => {
        const cmd = (await Command.get("discover-and-add-mcps"))!
        expect(cmd).toBeDefined()
        expect(cmd.name).toBe("discover-and-add-mcps")
        expect(cmd.source).toBe("command")
      })
    })

    test("has correct description", async () => {
      await withInstance(async () => {
        const cmd = (await Command.get("discover-and-add-mcps"))!
        expect(cmd.description).toBe("discover MCP servers from external AI tool configs and add them")
      })
    })

    test("template references MCP discovery workflow", async () => {
      await withInstance(async () => {
        const cmd = (await Command.get("discover-and-add-mcps"))!
        const template = await cmd.template
        expect(typeof template).toBe("string")
        expect(template.length).toBeGreaterThan(0)
        // The template should reference MCP-related concepts
        expect(template.toLowerCase()).toContain("mcp")
      })
    })

    test("is present in Command.Default constants", () => {
      expect(Command.Default.DISCOVER_MCPS).toBe("discover-and-add-mcps")
    })
  })

  describe("configure-claude", () => {
    test("is registered as a default command", async () => {
      await withInstance(async () => {
        const cmd = (await Command.get("configure-claude"))!
        expect(cmd).toBeDefined()
        expect(cmd.name).toBe("configure-claude")
        expect(cmd.source).toBe("command")
      })
    })

    test("has correct description", async () => {
      await withInstance(async () => {
        const cmd = (await Command.get("configure-claude"))!
        expect(cmd.description).toBe("configure /altimate command in Claude Code")
      })
    })

    test("is present in Command.Default constants", () => {
      expect(Command.Default.CONFIGURE_CLAUDE).toBe("configure-claude")
    })
  })

  describe("configure-codex", () => {
    test("is registered as a default command", async () => {
      await withInstance(async () => {
        const cmd = (await Command.get("configure-codex"))!
        expect(cmd).toBeDefined()
        expect(cmd.name).toBe("configure-codex")
        expect(cmd.source).toBe("command")
      })
    })

    test("has correct description", async () => {
      await withInstance(async () => {
        const cmd = (await Command.get("configure-codex"))!
        expect(cmd.description).toBe("configure altimate skill in Codex CLI")
      })
    })

    test("is present in Command.Default constants", () => {
      expect(Command.Default.CONFIGURE_CODEX).toBe("configure-codex")
    })
  })
})

describe("Command.hints()", () => {
  test("extracts numbered placeholders in order", () => {
    expect(Command.hints("Do $1 then $2")).toEqual(["$1", "$2"])
  })

  test("extracts $ARGUMENTS", () => {
    expect(Command.hints("Run with $ARGUMENTS")).toEqual(["$ARGUMENTS"])
  })

  test("extracts both numbered and $ARGUMENTS", () => {
    expect(Command.hints("Do $1 with $ARGUMENTS")).toEqual(["$1", "$ARGUMENTS"])
  })

  test("deduplicates repeated placeholders", () => {
    expect(Command.hints("$1 and $1 again")).toEqual(["$1"])
  })

  test("returns empty array for no placeholders", () => {
    expect(Command.hints("plain text")).toEqual([])
  })

  test("sorts numbered placeholders numerically", () => {
    expect(Command.hints("$3 then $1 then $2")).toEqual(["$1", "$2", "$3"])
  })
})
