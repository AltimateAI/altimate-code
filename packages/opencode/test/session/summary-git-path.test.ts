import { describe, test, expect } from "bun:test"
import { SessionSummary } from "../../src/session/summary"
import { Instance } from "../../src/project/instance"
import { Storage } from "../../src/storage/storage"
import { Log } from "../../src/util/log"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"

/**
 * Tests for the unquoteGitPath function used in SessionSummary.diff().
 *
 * Git quotes file paths containing non-ASCII bytes using C-style escaping with
 * octal sequences (e.g., \303\251 for UTF-8 "é"). This function decodes those
 * paths back to their original Unicode representation. Without correct decoding,
 * session diffs show garbled filenames for non-ASCII files (CJK, accented, emoji).
 *
 * We test indirectly via SessionSummary.diff() which applies unquoteGitPath to
 * stored FileDiff entries.
 */

Log.init({ print: false })

// Helper: write fake diffs to Storage for a session, then read them back via diff()
async function roundtrip(files: string[]): Promise<string[]> {
  const sessionID = Identifier.ascending("session") as any
  const diffs = files.map((file) => ({
    file,
    before: "",
    after: "",
    additions: 1,
    deletions: 0,
    status: "added" as const,
  }))

  await Storage.write(["session_diff", sessionID], diffs)
  const result = await SessionSummary.diff({ sessionID })
  return result.map((d) => d.file)
}

describe("SessionSummary.diff: unquoteGitPath decoding", () => {
  test("plain ASCII paths pass through unchanged", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const files = await roundtrip([
          "src/index.ts",
          "README.md",
          "packages/opencode/test/file.test.ts",
        ])
        expect(files).toEqual([
          "src/index.ts",
          "README.md",
          "packages/opencode/test/file.test.ts",
        ])
      },
    })
  })

  test("git-quoted path with octal-encoded UTF-8 (2-byte: é = \\303\\251)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Git quotes "café.txt" as "caf\\303\\251.txt"
        const files = await roundtrip(['"caf\\303\\251.txt"'])
        expect(files).toEqual(["café.txt"])
      },
    })
  })

  test("git-quoted path with 3-byte UTF-8 octal (CJK character 中 = \\344\\270\\255)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Git quotes "中文.txt" as "\\344\\270\\255\\346\\226\\207.txt"
        const files = await roundtrip(['"\\344\\270\\255\\346\\226\\207.txt"'])
        expect(files).toEqual(["中文.txt"])
      },
    })
  })

  test("git-quoted path with standard escape sequences (\\n, \\t, \\\\, \\\")", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const files = await roundtrip([
          '"path\\\\with\\\\backslashes"',
          '"file\\twith\\ttabs"',
          '"line\\nbreak"',
        ])
        expect(files).toEqual([
          "path\\with\\backslashes",
          "file\twith\ttabs",
          "line\nbreak",
        ])
      },
    })
  })

  test("mixed octal and plain ASCII in one path", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // "docs/résumé.md" → git quotes accented chars only
        // é = \303\251 in UTF-8
        const files = await roundtrip(['"docs/r\\303\\251sum\\303\\251.md"'])
        expect(files).toEqual(["docs/résumé.md"])
      },
    })
  })

  test("unquoted path (no surrounding double quotes) passes through unchanged", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // If git doesn't quote the path, it should pass through as-is
        const files = await roundtrip(["normal/path.ts", "another-file.js"])
        expect(files).toEqual(["normal/path.ts", "another-file.js"])
      },
    })
  })

  test("path with embedded double quote (\\\")", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const files = await roundtrip(['"file\\"name.txt"'])
        expect(files).toEqual(['file"name.txt'])
      },
    })
  })

  test("empty string passes through unchanged", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const files = await roundtrip([""])
        expect(files).toEqual([""])
      },
    })
  })

  test("Japanese filename with 3-byte UTF-8 sequences (テスト = \\343\\203\\206\\343\\202\\271\\343\\203\\210)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // テ = E3 83 86 = \343\203\206
        // ス = E3 82 B9 = \343\202\271
        // ト = E3 83 88 = \343\203\210
        const files = await roundtrip(['"\\343\\203\\206\\343\\202\\271\\343\\203\\210.sql"'])
        expect(files).toEqual(["テスト.sql"])
      },
    })
  })

  test("multiple files: some quoted, some not", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const files = await roundtrip([
          "plain.ts",
          '"caf\\303\\251.txt"',
          "normal/path.js",
          '"\\344\\270\\255.md"',
        ])
        expect(files).toEqual([
          "plain.ts",
          "café.txt",
          "normal/path.js",
          "中.md",
        ])
      },
    })
  })
})
