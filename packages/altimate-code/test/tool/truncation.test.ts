import { describe, test, expect } from "bun:test"
import { Truncate } from "../../src/tool/truncation"
import { Identifier } from "../../src/id/id"
import { Filesystem } from "../../src/util/filesystem"
import path from "path"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")

describe("Truncate", () => {
  describe("output", () => {
    test("truncates large json file by bytes", async () => {
      const content = await Filesystem.readText(path.join(FIXTURES_DIR, "models-api.json"))
      const result = await Truncate.output(content)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("truncated...")
      if (result.truncated) expect(result.outputPath).toBeDefined()
    })

    test("returns content unchanged when under limits", async () => {
      const content = "line1\nline2\nline3"
      const result = await Truncate.output(content)

      expect(result.truncated).toBe(false)
      expect(result.content).toBe(content)
    })

    test("truncates by line count", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const result = await Truncate.output(lines, { maxLines: 10 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("...90 lines truncated...")
    })

    test("truncates by byte count", async () => {
      const content = "a".repeat(1000)
      const result = await Truncate.output(content, { maxBytes: 100 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("truncated...")
    })

    test("truncates from head by default", async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
      const result = await Truncate.output(lines, { maxLines: 3 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("line0")
      expect(result.content).toContain("line1")
      expect(result.content).toContain("line2")
      expect(result.content).not.toContain("line9")
    })

    test("truncates from tail when direction is tail", async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
      const result = await Truncate.output(lines, { maxLines: 3, direction: "tail" })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("line7")
      expect(result.content).toContain("line8")
      expect(result.content).toContain("line9")
      expect(result.content).not.toContain("line0")
    })

    test("uses default MAX_LINES and MAX_BYTES", () => {
      expect(Truncate.MAX_LINES).toBe(2000)
      expect(Truncate.MAX_BYTES).toBe(50 * 1024)
    })

    test("large single-line file truncates with byte message", async () => {
      const content = await Filesystem.readText(path.join(FIXTURES_DIR, "models-api.json"))
      const result = await Truncate.output(content)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("bytes truncated...")
      expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(Truncate.MAX_BYTES)
    })

    test("writes full output to file when truncated", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const result = await Truncate.output(lines, { maxLines: 10 })

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("The tool call succeeded but the output was truncated")
      expect(result.content).toContain("Grep")
      if (!result.truncated) throw new Error("expected truncated")
      expect(result.outputPath).toBeDefined()
      expect(result.outputPath).toContain("tool_")

      const written = await Filesystem.readText(result.outputPath!)
      expect(written).toBe(lines)
    })

    test("suggests Task tool when agent has task permission", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const agent = { permission: [{ permission: "task", pattern: "*", action: "allow" as const }] }
      const result = await Truncate.output(lines, { maxLines: 10 }, agent as any)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("Grep")
      expect(result.content).toContain("Task tool")
    })

    test("omits Task tool hint when agent lacks task permission", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      const agent = { permission: [{ permission: "task", pattern: "*", action: "deny" as const }] }
      const result = await Truncate.output(lines, { maxLines: 10 }, agent as any)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("Grep")
      expect(result.content).not.toContain("Task tool")
    })

    test("does not write file when not truncated", async () => {
      const content = "short content"
      const result = await Truncate.output(content)

      expect(result.truncated).toBe(false)
      if (result.truncated) throw new Error("expected not truncated")
      expect("outputPath" in result).toBe(false)
    })
  })

  describe("cleanup", () => {
    const DAY_MS = 24 * 60 * 60 * 1000
    const RETENTION_MS = 7 * DAY_MS

    test("identifier timestamps maintain correct ordering for cleanup", () => {
      const now = Date.now()
      const oldId = Identifier.create("tool", false, now - 10 * DAY_MS)
      const recentId = Identifier.create("tool", false, now - 3 * DAY_MS)
      const cutoffId = Identifier.create("tool", false, now - RETENTION_MS)

      const oldTs = Identifier.timestamp(oldId)
      const recentTs = Identifier.timestamp(recentId)
      const cutoff = Identifier.timestamp(cutoffId)

      expect(oldTs).toBeLessThan(cutoff)
      expect(recentTs).toBeGreaterThanOrEqual(cutoff)
    })

    test("cleanup logic correctly filters old vs recent entries", () => {
      const now = Date.now()
      const oldId = Identifier.create("tool", false, now - 10 * DAY_MS)
      const recentId = Identifier.create("tool", false, now - 3 * DAY_MS)
      const cutoff = Identifier.timestamp(Identifier.create("tool", false, now - RETENTION_MS))

      // Simulate the cleanup filtering logic from Truncate.cleanup()
      const entries = [oldId, recentId, "not_a_tool_file.txt"]
      const deleted: string[] = []
      const kept: string[] = []

      for (const entry of entries) {
        if (!entry.startsWith("tool_")) {
          kept.push(entry)
          continue
        }
        if (Identifier.timestamp(entry) >= cutoff) {
          kept.push(entry)
          continue
        }
        deleted.push(entry)
      }

      expect(deleted).toContain(oldId)
      expect(deleted).not.toContain(recentId)
      expect(kept).toContain(recentId)
      expect(kept).not.toContain(oldId)
      expect(kept).toContain("not_a_tool_file.txt")
    })
  })
})
