import { describe, test, expect } from "bun:test"
import { Wildcard } from "../../src/util/wildcard"

test("match handles glob tokens", () => {
  expect(Wildcard.match("file1.txt", "file?.txt")).toBe(true)
  expect(Wildcard.match("file12.txt", "file?.txt")).toBe(false)
  expect(Wildcard.match("foo+bar", "foo+bar")).toBe(true)
})

test("match with trailing space+wildcard matches command with or without args", () => {
  // "ls *" should match "ls" (no args) and "ls -la" (with args)
  expect(Wildcard.match("ls", "ls *")).toBe(true)
  expect(Wildcard.match("ls -la", "ls *")).toBe(true)
  expect(Wildcard.match("ls foo bar", "ls *")).toBe(true)

  // "ls*" (no space) should NOT match "ls" alone — wait, it should because .* matches empty
  // but it WILL match "lstmeval" which is the dangerous case users should avoid
  expect(Wildcard.match("ls", "ls*")).toBe(true)
  expect(Wildcard.match("lstmeval", "ls*")).toBe(true)

  // "ls *" (with space) should NOT match "lstmeval"
  expect(Wildcard.match("lstmeval", "ls *")).toBe(false)

  // multi-word commands
  expect(Wildcard.match("git status", "git *")).toBe(true)
  expect(Wildcard.match("git", "git *")).toBe(true)
  expect(Wildcard.match("git commit -m foo", "git *")).toBe(true)
})

test("all picks the most specific pattern", () => {
  const rules = {
    "*": "deny",
    "git *": "ask",
    "git status": "allow",
  }
  expect(Wildcard.all("git status", rules)).toBe("allow")
  expect(Wildcard.all("git log", rules)).toBe("ask")
  expect(Wildcard.all("echo hi", rules)).toBe("deny")
})

test("allStructured matches command sequences", () => {
  const rules = {
    "git *": "ask",
    "git status*": "allow",
  }
  expect(Wildcard.allStructured({ head: "git", tail: ["status", "--short"] }, rules)).toBe("allow")
  expect(Wildcard.allStructured({ head: "npm", tail: ["run", "build", "--watch"] }, { "npm run *": "allow" })).toBe(
    "allow",
  )
  expect(Wildcard.allStructured({ head: "ls", tail: ["-la"] }, rules)).toBeUndefined()
})

test("allStructured prioritizes flag-specific patterns", () => {
  const rules = {
    "find *": "allow",
    "find * -delete*": "ask",
    "sort*": "allow",
    "sort -o *": "ask",
  }
  expect(Wildcard.allStructured({ head: "find", tail: ["src", "-delete"] }, rules)).toBe("ask")
  expect(Wildcard.allStructured({ head: "find", tail: ["src", "-print"] }, rules)).toBe("allow")
  expect(Wildcard.allStructured({ head: "sort", tail: ["-o", "out.txt"] }, rules)).toBe("ask")
  expect(Wildcard.allStructured({ head: "sort", tail: ["--reverse"] }, rules)).toBe("allow")
})

test("allStructured handles sed flags", () => {
  const rules = {
    "sed * -i*": "ask",
    "sed -n*": "allow",
  }
  expect(Wildcard.allStructured({ head: "sed", tail: ["-i", "file"] }, rules)).toBe("ask")
  expect(Wildcard.allStructured({ head: "sed", tail: ["-i.bak", "file"] }, rules)).toBe("ask")
  expect(Wildcard.allStructured({ head: "sed", tail: ["-n", "1p", "file"] }, rules)).toBe("allow")
  expect(Wildcard.allStructured({ head: "sed", tail: ["-i", "-n", "/./p", "myfile.txt"] }, rules)).toBe("ask")
})

test("match normalizes slashes for cross-platform globbing", () => {
  expect(Wildcard.match("C:\\Windows\\System32\\*", "C:/Windows/System32/*")).toBe(true)
  expect(Wildcard.match("C:/Windows/System32/drivers", "C:\\Windows\\System32\\*")).toBe(true)
})

test("match handles case-insensitivity on Windows", () => {
  if (process.platform === "win32") {
    expect(Wildcard.match("C:\\windows\\system32\\hosts", "C:/Windows/System32/*")).toBe(true)
    expect(Wildcard.match("c:/windows/system32/hosts", "C:\\Windows\\System32\\*")).toBe(true)
  } else {
    // Unix paths are case-sensitive
    expect(Wildcard.match("/users/test/file", "/Users/test/*")).toBe(false)
  }
})

// --- Edge cases found during test-discovery audit ---

describe("Wildcard.match — star crosses path separators", () => {
  test("star matches across directory boundaries unlike shell glob", () => {
    // Wildcard.match uses .* which crosses /, unlike shell globs where * stops at /
    // This is relied on by the permission system: "src/*" must match "src/deep/nested/file.ts"
    expect(Wildcard.match("src/deep/nested/file.ts", "src/*")).toBe(true)
    expect(Wildcard.match("src/a/b/c/d.ts", "src/*/d.ts")).toBe(true)
  })
})

describe("Wildcard.match — special regex characters", () => {
  test("dots in pattern are literal, not regex any-char", () => {
    expect(Wildcard.match("file.txt", "file.txt")).toBe(true)
    expect(Wildcard.match("filextxt", "file.txt")).toBe(false)
  })

  test("parentheses and pipes in pattern are literal", () => {
    expect(Wildcard.match("(a|b)", "(a|b)")).toBe(true)
    expect(Wildcard.match("a", "(a|b)")).toBe(false)
  })

  test("brackets in pattern are literal", () => {
    expect(Wildcard.match("[abc]", "[abc]")).toBe(true)
    expect(Wildcard.match("a", "[abc]")).toBe(false)
  })

  test("dollar and caret in pattern are literal", () => {
    expect(Wildcard.match("$HOME", "$HOME")).toBe(true)
    expect(Wildcard.match("^start", "^start")).toBe(true)
  })
})

describe("Wildcard.match — empty and boundary cases", () => {
  test("empty pattern matches only empty string", () => {
    expect(Wildcard.match("", "")).toBe(true)
    expect(Wildcard.match("something", "")).toBe(false)
  })
})

describe("Wildcard.allStructured — non-contiguous tail matching", () => {
  test("non-contiguous tail tokens match if in correct order", () => {
    // matchSequence scans non-contiguously: finds "push" then skips "extra" and finds "--force"
    const result = Wildcard.allStructured(
      { head: "git", tail: ["push", "extra", "--force"] },
      { "git push --force": "deny" },
    )
    expect(result).toBe("deny")
  })

  test("reversed tail tokens do not match when items exhausted", () => {
    // Pattern expects push then --force; tail has them reversed
    // "push" found at i=1, but no items remain after for "--force"
    const result = Wildcard.allStructured(
      { head: "git", tail: ["--force", "push"] },
      { "git push --force": "deny" },
    )
    expect(result).toBeUndefined()
  })
})
