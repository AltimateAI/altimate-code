import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  ROUTING_END,
  ROUTING_START,
  applyRoutingBlock,
  routingBlock,
  writeRoutingBlock,
} from "../../../src/altimate/tool-cli/claude-md"

describe("routing block", () => {
  test("block is delimited and names the commands", () => {
    const block = routingBlock()
    expect(block.startsWith(ROUTING_START)).toBe(true)
    expect(block.endsWith(ROUTING_END)).toBe(true)
    expect(block).toContain("altimate-code tool run")
    expect(block).toContain("altimate-code tool schema <tool>")
    expect(block).toContain("altimate-code tool context")
    expect(block).toContain("altimate-code run")
  })

  test("routes data work to the CLI and leaves other work to the normal tools", () => {
    const block = routingBlock()
    expect(block).toContain("altimate-code tool context")
    expect(block).toContain("altimate-code tool run <tool>")
    expect(block).not.toContain("MCP")
    expect(block).not.toContain("reading SQL by hand")
    expect(block).toContain("use the normal tools")
  })

  test("creates the block in an empty file", () => {
    expect(applyRoutingBlock("")).toBe(routingBlock() + "\n")
  })

  test("appends after existing content and leaves it untouched", () => {
    const existing = "# My project\n\nKeep tests fast.\n"
    const result = applyRoutingBlock(existing)
    expect(result.startsWith(existing + "\n")).toBe(true)
    expect(result.endsWith(routingBlock() + "\n")).toBe(true)
  })

  test("is idempotent", () => {
    const once = applyRoutingBlock("# Title\n")
    expect(applyRoutingBlock(once)).toBe(once)
  })

  test("replaces a stale block in place and preserves text on both sides", () => {
    const before = "# Title\n\nintro\n\n"
    const after = "\n\n## Later section\nmore\n"
    const stale = `${ROUTING_START}\nold guidance\n${ROUTING_END}`
    const result = applyRoutingBlock(before + stale + after)
    expect(result).toBe(before + routingBlock() + after)
    expect(result).not.toContain("old guidance")
  })

  test("an orphaned start marker does not swallow later content", () => {
    const content = `${ROUTING_START}\nunterminated\n\n## Mine\nkeep me\n`
    const once = applyRoutingBlock(content)
    expect(once).toContain("keep me")
    expect(once).toContain("unterminated")
    const twice = applyRoutingBlock(once)
    expect(twice).toBe(once)
  })

  test("writeRoutingBlock creates, then reports no change", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tool-cli-claude-md-"))
    try {
      expect(await writeRoutingBlock(dir)).toBe(true)
      const first = await readFile(path.join(dir, "CLAUDE.md"), "utf8")
      expect(first).toBe(routingBlock() + "\n")
      expect(await writeRoutingBlock(dir)).toBe(false)
      await writeFile(path.join(dir, "CLAUDE.md"), "# Mine\n" + first)
      expect(await writeRoutingBlock(dir)).toBe(false)
      expect(await readFile(path.join(dir, "CLAUDE.md"), "utf8")).toBe("# Mine\n" + first)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
