import { describe, test, expect } from "bun:test"
import { Patch } from "../../src/patch"
import * as fs from "fs/promises"
import * as path from "path"
import { tmpdir } from "../fixture/fixture"

/**
 * Tests for Patch.deriveNewContentsFromChunks — the core function that applies
 * update chunks to file content using seekSequence's multi-pass matching.
 *
 * seekSequence tries 4 comparison strategies in order:
 *   1. Exact match
 *   2. Trailing whitespace trimmed (rstrip)
 *   3. Both-end whitespace trimmed (trim)
 *   4. Unicode-normalized + trimmed
 *
 * These tests verify that real-world patch application succeeds even when the
 * LLM-generated patch text has minor whitespace or Unicode differences from
 * the actual file content — a common source of "Failed to find expected lines"
 * errors for users.
 */

describe("Patch.deriveNewContentsFromChunks — seekSequence matching", () => {
  test("exact match: replaces old_lines with new_lines", async () => {
    await using tmp = await tmpdir()
    const filePath = path.join(tmp.path, "exact.txt")
    const content = "line1\nline2\nline3\n"
    await fs.writeFile(filePath, content)

    const result = Patch.deriveNewContentsFromChunks(filePath, [
      {
        old_lines: ["line2"],
        new_lines: ["REPLACED"],
      },
    ])

    expect(result.content).toBe("line1\nREPLACED\nline3\n")
    expect(result.unified_diff).toContain("-line2")
    expect(result.unified_diff).toContain("+REPLACED")
  })

  test("rstrip pass: matches despite trailing whitespace differences", async () => {
    await using tmp = await tmpdir()
    const filePath = path.join(tmp.path, "rstrip.txt")
    const content = "line1\nline2   \nline3\n"
    await fs.writeFile(filePath, content)

    const result = Patch.deriveNewContentsFromChunks(filePath, [
      {
        old_lines: ["line2"],
        new_lines: ["REPLACED"],
      },
    ])

    expect(result.content).toContain("REPLACED")
  })

  test("trim pass: matches despite leading whitespace differences", async () => {
    await using tmp = await tmpdir()
    const filePath = path.join(tmp.path, "trim.txt")
    const content = "  function foo() {\n    return 1\n  }\n"
    await fs.writeFile(filePath, content)

    const result = Patch.deriveNewContentsFromChunks(filePath, [
      {
        old_lines: ["return 1"],
        new_lines: ["return 42"],
      },
    ])

    expect(result.content).toContain("return 42")
  })

  test("unicode pass: matches smart quotes to ASCII quotes", async () => {
    await using tmp = await tmpdir()
    const filePath = path.join(tmp.path, "unicode.txt")
    const content = 'const msg = \u201CHello World\u201D\n'
    await fs.writeFile(filePath, content)

    const result = Patch.deriveNewContentsFromChunks(filePath, [
      {
        old_lines: ['const msg = "Hello World"'],
        new_lines: ['const msg = "Goodbye World"'],
      },
    ])

    expect(result.content).toContain("Goodbye World")
  })

  test("unicode pass: matches em-dash to hyphen", async () => {
    await using tmp = await tmpdir()
    const filePath = path.join(tmp.path, "emdash.txt")
    const content = "value \u2014 description\n"
    await fs.writeFile(filePath, content)

    const result = Patch.deriveNewContentsFromChunks(filePath, [
      {
        old_lines: ["value - description"],
        new_lines: ["value - updated"],
      },
    ])

    expect(result.content).toContain("updated")
  })

  test("is_end_of_file: anchors match to end of file", async () => {
    await using tmp = await tmpdir()
    const filePath = path.join(tmp.path, "eof.txt")
    const content = "line1\nline2\nline3\nline2\n"
    await fs.writeFile(filePath, content)

    const result = Patch.deriveNewContentsFromChunks(filePath, [
      {
        old_lines: ["line2"],
        new_lines: ["LAST"],
        is_end_of_file: true,
      },
    ])

    expect(result.content).toBe("line1\nline2\nline3\nLAST\n")
  })

  test("change_context: seeks to context line before matching old_lines", async () => {
    await using tmp = await tmpdir()
    const filePath = path.join(tmp.path, "context.txt")
    const content = "function foo() {\n  return 1\n}\nfunction bar() {\n  return 1\n}\n"
    await fs.writeFile(filePath, content)

    const result = Patch.deriveNewContentsFromChunks(filePath, [
      {
        old_lines: ["  return 1"],
        new_lines: ["  return 99"],
        change_context: "function bar() {",
      },
    ])

    expect(result.content).toContain("function foo() {\n  return 1")
    expect(result.content).toContain("function bar() {\n  return 99")
  })

  test("throws when old_lines cannot be found", async () => {
    await using tmp = await tmpdir()
    const filePath = path.join(tmp.path, "missing.txt")
    await fs.writeFile(filePath, "hello\nworld\n")

    expect(() =>
      Patch.deriveNewContentsFromChunks(filePath, [
        {
          old_lines: ["nonexistent line"],
          new_lines: ["replacement"],
        },
      ]),
    ).toThrow("Failed to find expected lines")
  })

  test("throws when file does not exist", async () => {
    await using tmp = await tmpdir()
    expect(() =>
      Patch.deriveNewContentsFromChunks(path.join(tmp.path, "nonexistent-file.txt"), [
        {
          old_lines: ["x"],
          new_lines: ["y"],
        },
      ]),
    ).toThrow("Failed to read file")
  })

  test("multiple chunks applied in sequence", async () => {
    await using tmp = await tmpdir()
    const filePath = path.join(tmp.path, "multi.txt")
    const content = "alpha\nbeta\ngamma\ndelta\n"
    await fs.writeFile(filePath, content)

    const result = Patch.deriveNewContentsFromChunks(filePath, [
      {
        old_lines: ["beta"],
        new_lines: ["BETA"],
      },
      {
        old_lines: ["delta"],
        new_lines: ["DELTA"],
      },
    ])

    expect(result.content).toBe("alpha\nBETA\ngamma\nDELTA\n")
  })

  test("pure addition chunk (empty old_lines) appends content", async () => {
    await using tmp = await tmpdir()
    const filePath = path.join(tmp.path, "append.txt")
    await fs.writeFile(filePath, "existing\n")

    const result = Patch.deriveNewContentsFromChunks(filePath, [
      {
        old_lines: [],
        new_lines: ["new_line"],
      },
    ])

    expect(result.content).toContain("existing")
    expect(result.content).toContain("new_line")
  })
})

describe("Patch.parsePatch — stripHeredoc handling", () => {
  test("parses patch wrapped in heredoc with cat <<'EOF'", () => {
    const input = `cat <<'EOF'
*** Begin Patch
*** Add File: hello.txt
+Hello
*** End Patch
EOF`

    const result = Patch.parsePatch(input)
    expect(result.hunks).toHaveLength(1)
    expect(result.hunks[0].type).toBe("add")
  })

  test("parses patch wrapped in heredoc with <<HEREDOC", () => {
    const input = `<<HEREDOC
*** Begin Patch
*** Delete File: old.txt
*** End Patch
HEREDOC`

    const result = Patch.parsePatch(input)
    expect(result.hunks).toHaveLength(1)
    expect(result.hunks[0].type).toBe("delete")
  })

  test("parses unwrapped patch text unchanged", () => {
    const input = `*** Begin Patch
*** Add File: test.txt
+content
*** End Patch`

    const result = Patch.parsePatch(input)
    expect(result.hunks).toHaveLength(1)
  })
})
