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
// Command.hints() — template hint extraction
// ---------------------------------------------------------------------------

describe("Command.hints()", () => {
  test("extracts and sorts placeholders", () => {
    const result = Command.hints("Use $10 then $2 and $1")
    expect(result).toEqual(["$1", "$2", "$10"])
  })

  test("extracts $ARGUMENTS placeholder", () => {
    const result = Command.hints("Run with $ARGUMENTS")
    expect(result).toEqual(["$ARGUMENTS"])
  })

  test("extracts both numbered and $ARGUMENTS", () => {
    const result = Command.hints("Use $1 and $ARGUMENTS")
    expect(result).toEqual(["$1", "$ARGUMENTS"])
  })

  test("deduplicates repeated numbered placeholders", () => {
    const result = Command.hints("$1 and $1 then $2")
    expect(result).toEqual(["$1", "$2"])
  })

  test("returns empty array for template with no placeholders", () => {
    const result = Command.hints("No placeholders here")
    expect(result).toEqual([])
  })

  test("includes $0 as a valid placeholder", () => {
    const result = Command.hints("$0 $1")
    expect(result).toEqual(["$0", "$1"])
  })
})

// ---------------------------------------------------------------------------
// discover-and-add-mcps builtin command (#409)
// ---------------------------------------------------------------------------

describe("discover-and-add-mcps builtin command", () => {
  test("is registered in Command.Default constants", () => {
    expect(Command.Default.DISCOVER_MCPS).toBe("discover-and-add-mcps")
  })

  test("is present in command list", async () => {
    await withInstance(async () => {
      const commands = await Command.list()
      const names = commands.map((c) => c.name)
      expect(names).toContain("discover-and-add-mcps")
    })
  })

  test("has correct metadata", async () => {
    await withInstance(async () => {
      const cmd = (await Command.get("discover-and-add-mcps"))!
      expect(cmd).toBeDefined()
      expect(cmd.name).toBe("discover-and-add-mcps")
      expect(cmd.source).toBe("command")
      expect(cmd.description).toContain("MCP")
    })
  })

  test("template references mcp_discover tool", async () => {
    await withInstance(async () => {
      const cmd = (await Command.get("discover-and-add-mcps"))!
      const template = await cmd.template
      expect(template).toContain("mcp_discover")
    })
  })

  test("is not a subtask", async () => {
    await withInstance(async () => {
      const cmd = (await Command.get("discover-and-add-mcps"))!
      expect(cmd.subtask).toBeUndefined()
    })
  })
})
