import { describe, test, expect } from "bun:test"
import { Command } from "../../src/command/index"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withInstance(fn: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({ directory: tmp.path, fn })
}

// ---------------------------------------------------------------------------
// Tests: Default commands are always available and correctly configured
// ---------------------------------------------------------------------------

describe("Command module", () => {
  describe("default commands", () => {
    test("init, discover, review are always present", async () => {
      await withInstance(async () => {
        const commands = await Command.list()
        const names = commands.map((c) => c.name)
        expect(names).toContain("init")
        expect(names).toContain("discover")
        expect(names).toContain("review")
      })
    })

    test("discover command has correct metadata", async () => {
      await withInstance(async () => {
        const cmd = await Command.get("discover")
        expect(cmd).toBeDefined()
        expect(cmd.name).toBe("discover")
        expect(cmd.source).toBe("command")
        expect(cmd.description).toBe("scan data stack and set up connections")
      })
    })

    test("discover template references project_scan tool", async () => {
      await withInstance(async () => {
        const cmd = await Command.get("discover")
        const template = await cmd.template
        expect(template).toContain("project_scan")
      })
    })

    test("discover template has $ARGUMENTS placeholder", async () => {
      await withInstance(async () => {
        const cmd = await Command.get("discover")
        expect(cmd.hints).toContain("$ARGUMENTS")
      })
    })

    test("init command has correct metadata", async () => {
      await withInstance(async () => {
        const cmd = await Command.get("init")
        expect(cmd).toBeDefined()
        expect(cmd.name).toBe("init")
        expect(cmd.source).toBe("command")
        expect(cmd.description).toBe("create/update AGENTS.md")
      })
    })

    test("review command has subtask flag", async () => {
      await withInstance(async () => {
        const cmd = await Command.get("review")
        expect(cmd).toBeDefined()
        expect(cmd.name).toBe("review")
        expect(cmd.subtask).toBe(true)
        expect(cmd.source).toBe("command")
      })
    })

    test("all default commands have source 'command'", async () => {
      await withInstance(async () => {
        const commands = await Command.list()
        const defaults = commands.filter((c) => ["init", "discover", "review"].includes(c.name))
        expect(defaults.length).toBe(3)
        for (const cmd of defaults) {
          expect(cmd.source).toBe("command")
        }
      })
    })

    test("Command.get returns undefined for non-existent commands", async () => {
      await withInstance(async () => {
        const cmd = await Command.get("nonexistent-command-12345")
        expect(cmd).toBeUndefined()
      })
    })
  })

  describe("user-defined commands from config", () => {
    test("config commands are loaded alongside defaults", async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          command: {
            "my-custom": {
              description: "Custom command",
              template: "Do something custom with $1",
            },
          },
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const commands = await Command.list()
          const names = commands.map((c) => c.name)
          // Defaults still present
          expect(names).toContain("init")
          expect(names).toContain("discover")
          expect(names).toContain("review")
          // Custom command also present
          expect(names).toContain("my-custom")
          const custom = await Command.get("my-custom")
          expect(custom.source).toBe("command")
          expect(custom.description).toBe("Custom command")
        },
      })
    })
  })
})

// ---------------------------------------------------------------------------
// Tests: Resilient loading pattern (isolated from module mocks)
//
// These tests verify the try/catch pattern used in command/index.ts to ensure
// MCP and Skill failures don't prevent default commands from being served.
// ---------------------------------------------------------------------------

describe("Command loading resilience pattern", () => {
  // NOTE: These tests duplicate the loading logic from command/index.ts rather than
  // mocking the real MCP/Skill modules. This avoids complex module mocking but means
  // loadCommands() below could drift from the real implementation. If the loading
  // pattern in command/index.ts changes, these tests should be updated to match.
  async function loadCommands(opts: {
    mcpPrompts: () => Promise<Record<string, any>>
    skillAll: () => Promise<Array<{ name: string; description: string; content: string }>>
  }) {
    const result: Record<string, { name: string; source: string; description?: string }> = {
      init: { name: "init", source: "command", description: "create/update AGENTS.md" },
      discover: { name: "discover", source: "command", description: "scan data stack" },
      review: { name: "review", source: "command", description: "review changes" },
    }

    // This matches the pattern in command/index.ts
    try {
      for (const [name, prompt] of Object.entries(await opts.mcpPrompts())) {
        result[name] = { name, source: "mcp", description: (prompt as any).description }
      }
    } catch {
      // MCP prompt loading failed — continue with default commands
    }

    try {
      for (const skill of await opts.skillAll()) {
        if (result[skill.name]) continue
        result[skill.name] = { name: skill.name, source: "skill", description: skill.description }
      }
    } catch {
      // Skill loading failed — continue with default commands
    }

    return Object.values(result)
  }

  test("all plugins healthy — defaults + plugins present", async () => {
    const commands = await loadCommands({
      mcpPrompts: async () => ({ "mcp-cmd": { description: "MCP prompt" } }),
      skillAll: async () => [{ name: "my-skill", description: "A skill", content: "" }],
    })
    const names = commands.map((c) => c.name)
    expect(names).toContain("init")
    expect(names).toContain("discover")
    expect(names).toContain("review")
    expect(names).toContain("mcp-cmd")
    expect(names).toContain("my-skill")
  })

  test("MCP throws — defaults + skills still present", async () => {
    const commands = await loadCommands({
      mcpPrompts: async () => {
        throw new Error("MCP server unavailable")
      },
      skillAll: async () => [{ name: "my-skill", description: "A skill", content: "" }],
    })
    const names = commands.map((c) => c.name)
    expect(names).toContain("init")
    expect(names).toContain("discover")
    expect(names).toContain("review")
    expect(names).toContain("my-skill")
    expect(commands.filter((c) => c.source === "mcp").length).toBe(0)
  })

  test("Skills throws — defaults + MCP still present", async () => {
    const commands = await loadCommands({
      mcpPrompts: async () => ({ "mcp-cmd": { description: "MCP prompt" } }),
      skillAll: async () => {
        throw new Error("Skill discovery failed")
      },
    })
    const names = commands.map((c) => c.name)
    expect(names).toContain("init")
    expect(names).toContain("discover")
    expect(names).toContain("review")
    expect(names).toContain("mcp-cmd")
    expect(commands.filter((c) => c.source === "skill").length).toBe(0)
  })

  test("BOTH throw — only defaults present", async () => {
    const commands = await loadCommands({
      mcpPrompts: async () => {
        throw new Error("MCP server unavailable")
      },
      skillAll: async () => {
        throw new Error("Skill discovery failed")
      },
    })
    const names = commands.map((c) => c.name)
    expect(names).toContain("init")
    expect(names).toContain("discover")
    expect(names).toContain("review")
    expect(commands.length).toBe(3)
  })

  test("skill with same name as default is skipped", async () => {
    const commands = await loadCommands({
      mcpPrompts: async () => ({}),
      skillAll: async () => [{ name: "discover", description: "Rogue skill", content: "" }],
    })
    const discover = commands.find((c) => c.name === "discover")!
    expect(discover.source).toBe("command")
    expect(discover.description).toBe("scan data stack")
  })

  test("MCP command can overwrite default (same name)", async () => {
    const commands = await loadCommands({
      mcpPrompts: async () => ({ discover: { description: "MCP discover" } }),
      skillAll: async () => [],
    })
    const discover = commands.find((c) => c.name === "discover")!
    // MCP overwrites default because it's applied after defaults
    expect(discover.source).toBe("mcp")
  })
})
