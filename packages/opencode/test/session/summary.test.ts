import { describe, test, expect } from "bun:test"

// Mirror the private unquoteGitPath implementation from src/session/summary.ts:14-68
// This function is not exported (private to SessionSummary namespace), so we
// copy it here for standalone testing. Keep in sync with the source.
function unquoteGitPath(input: string): string {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

describe("SessionSummary: unquoteGitPath", () => {
  test("returns unquoted path unchanged", () => {
    expect(unquoteGitPath("src/index.ts")).toBe("src/index.ts")
  })

  test("returns path with only opening quote unchanged", () => {
    expect(unquoteGitPath('"src/index.ts')).toBe('"src/index.ts')
  })

  test("strips simple quoted path with spaces", () => {
    expect(unquoteGitPath('"src/my file.ts"')).toBe("src/my file.ts")
  })

  test("decodes accented characters (UTF-8 octal)", () => {
    // é = U+00E9 = \303\251 in UTF-8 octal (git encoding)
    expect(unquoteGitPath('"caf\\303\\251.txt"')).toBe("café.txt")
  })

  test("decodes CJK characters (3-byte UTF-8 octal)", () => {
    // 日 = U+65E5 = \346\227\245, 本 = U+672C = \346\234\254
    expect(unquoteGitPath('"\\346\\227\\245\\346\\234\\254.txt"')).toBe("日本.txt")
  })

  test("handles escaped backslash", () => {
    expect(unquoteGitPath('"path\\\\to\\\\file.ts"')).toBe("path\\to\\file.ts")
  })

  test("handles escaped double quote", () => {
    expect(unquoteGitPath('"say \\"hello\\".txt"')).toBe('say "hello".txt')
  })

  test("handles newline and tab escapes", () => {
    expect(unquoteGitPath('"col1\\tcol2\\nrow"')).toBe("col1\tcol2\nrow")
  })

  test("handles trailing backslash in body", () => {
    // Body ends with a single backslash (no next char after it)
    expect(unquoteGitPath('"trailing\\"')).toBe("trailing\\")
  })

  test("handles mixed ASCII and octal escapes", () => {
    // résumé.pdf = r + \303\251 + sum + \303\251 + .pdf
    expect(unquoteGitPath('"r\\303\\251sum\\303\\251.pdf"')).toBe("résumé.pdf")
  })

  test("handles emoji (4-byte UTF-8 octal)", () => {
    // 🎉 = U+1F389 = \360\237\216\211 in UTF-8 octal
    expect(unquoteGitPath('"\\360\\237\\216\\211.txt"')).toBe("🎉.txt")
  })
})
