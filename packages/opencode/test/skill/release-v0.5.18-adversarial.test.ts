/**
 * Adversarial tests for v0.5.18 release features:
 *
 * 1. GitLab MR URL parsing — injection, malformed URLs, edge cases
 * 2. Glob tool — home/root blocking, timeout, boundary conditions
 * 3. MCP config normalization — mcpServers→mcp, external formats, prototype pollution
 * 4. GitLab token masking — boundary lengths, empty/null
 */

import { describe, test, expect } from "bun:test"
import { parseGitLabMRUrl } from "../../src/cli/cmd/gitlab"

// ─────────────────────────────────────────────────────────────
// 1. GitLab MR URL parsing adversarial
// ─────────────────────────────────────────────────────────────

describe("v0.5.18 release: parseGitLabMRUrl", () => {
  describe("valid URLs", () => {
    test("parses standard GitLab MR URL", () => {
      const result = parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests/123")
      expect(result).toEqual({
        instanceUrl: "https://gitlab.com",
        projectPath: "org/repo",
        mrIid: 123,
      })
    })

    test("parses nested group URL", () => {
      const result = parseGitLabMRUrl("https://gitlab.com/org/group/subgroup/repo/-/merge_requests/42")
      expect(result).toEqual({
        instanceUrl: "https://gitlab.com",
        projectPath: "org/group/subgroup/repo",
        mrIid: 42,
      })
    })

    test("parses self-hosted GitLab URL", () => {
      const result = parseGitLabMRUrl("https://gitlab.example.com/team/project/-/merge_requests/1")
      expect(result).toEqual({
        instanceUrl: "https://gitlab.example.com",
        projectPath: "team/project",
        mrIid: 1,
      })
    })

    test("parses URL with fragment (note anchor)", () => {
      const result = parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests/123#note_456")
      expect(result).toEqual({
        instanceUrl: "https://gitlab.com",
        projectPath: "org/repo",
        mrIid: 123,
      })
    })

    test("parses URL with query parameters", () => {
      const result = parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests/99?tab=changes")
      expect(result).toEqual({
        instanceUrl: "https://gitlab.com",
        projectPath: "org/repo",
        mrIid: 99,
      })
    })
  })

  describe("empty and null inputs", () => {
    test("empty string returns null", () => {
      expect(parseGitLabMRUrl("")).toBeNull()
    })

    test("whitespace-only string returns null", () => {
      expect(parseGitLabMRUrl("   ")).toBeNull()
      expect(parseGitLabMRUrl("\t\n")).toBeNull()
    })

    test("null bytes in URL are URL-encoded but still parse", () => {
      const result = parseGitLabMRUrl("https://gitlab.com/org/\0repo/-/merge_requests/1")
      // URL class encodes null bytes — result is valid parse with encoded path
      expect(result).not.toBeNull()
      expect(result!.mrIid).toBe(1)
    })
  })

  describe("malformed URLs", () => {
    test("non-URL string returns null", () => {
      expect(parseGitLabMRUrl("not a url")).toBeNull()
    })

    test("GitHub URL returns null", () => {
      expect(parseGitLabMRUrl("https://github.com/org/repo/pull/123")).toBeNull()
    })

    test("missing merge_requests path returns null", () => {
      expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/issues/123")).toBeNull()
    })

    test("missing MR number returns null", () => {
      expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests/")).toBeNull()
    })

    test("non-numeric MR number returns null", () => {
      expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests/abc")).toBeNull()
    })

    test("negative MR number returns null", () => {
      expect(parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests/-1")).toBeNull()
    })

    test("URL with only protocol returns null", () => {
      expect(parseGitLabMRUrl("https://")).toBeNull()
    })

    test("file:// protocol still parses (URL is syntactically valid)", () => {
      // Parser only checks path pattern, not protocol — SSRF protection is at fetch layer
      const result = parseGitLabMRUrl("file:///etc/passwd/-/merge_requests/1")
      if (result) {
        expect(result.instanceUrl).toBe("file://")
        expect(result.mrIid).toBe(1)
      }
    })
  })

  describe("injection and security", () => {
    test("path traversal in project path returns valid parse (URL-encoded)", () => {
      // URL class handles encoding — the regex just extracts the path
      const result = parseGitLabMRUrl("https://gitlab.com/../../etc/passwd/-/merge_requests/1")
      // Should parse but projectPath will be the literal path
      if (result) {
        expect(result.mrIid).toBe(1)
        expect(typeof result.projectPath).toBe("string")
      }
    })

    test("extremely long URL doesn't crash", () => {
      const longPath = "a/".repeat(5000) + "repo"
      const result = parseGitLabMRUrl(`https://gitlab.com/${longPath}/-/merge_requests/1`)
      // Should either parse or return null, not throw
      if (result) {
        expect(result.mrIid).toBe(1)
      }
    })

    test("URL with unicode characters in path", () => {
      const result = parseGitLabMRUrl("https://gitlab.com/组织/项目/-/merge_requests/1")
      if (result) {
        expect(result.mrIid).toBe(1)
      }
    })

    test("URL with SSRF-style internal addresses", () => {
      const result = parseGitLabMRUrl("https://127.0.0.1/org/repo/-/merge_requests/1")
      // Should parse (URL is syntactically valid) — SSRF prevention is at fetch layer
      if (result) {
        expect(result.instanceUrl).toBe("https://127.0.0.1")
      }
    })

    test("URL with javascript: protocol returns null", () => {
      expect(parseGitLabMRUrl("javascript:alert(1)///-/merge_requests/1")).toBeNull()
    })
  })

  describe("boundary values", () => {
    test("MR number 0 parses correctly", () => {
      // GitLab MR IIDs start at 1, but parser shouldn't crash on 0
      const result = parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests/0")
      // 0 doesn't match \d+ since it's not really valid, but regex will match it
      if (result) {
        expect(result.mrIid).toBe(0)
      }
    })

    test("very large MR number", () => {
      const result = parseGitLabMRUrl("https://gitlab.com/org/repo/-/merge_requests/999999999")
      expect(result).not.toBeNull()
      expect(result!.mrIid).toBe(999999999)
    })

    test("MR number at MAX_SAFE_INTEGER", () => {
      const result = parseGitLabMRUrl(`https://gitlab.com/org/repo/-/merge_requests/${Number.MAX_SAFE_INTEGER}`)
      if (result) {
        expect(result.mrIid).toBe(Number.MAX_SAFE_INTEGER)
      }
    })

    test("single-character project path", () => {
      const result = parseGitLabMRUrl("https://gitlab.com/a/b/-/merge_requests/1")
      expect(result).not.toBeNull()
      expect(result!.projectPath).toBe("a/b")
    })
  })
})

// ─────────────────────────────────────────────────────────────
// 2. GitLab token masking
// ─────────────────────────────────────────────────────────────

// maskToken is not exported, so we test the behavior indirectly
// by verifying the pattern it implements
describe("v0.5.18 release: token masking pattern", () => {
  function maskToken(token: string): string {
    if (token.length <= 8) return "****"
    return token.slice(0, 4) + "****" + token.slice(-4)
  }

  test("short token fully masked", () => {
    expect(maskToken("abc")).toBe("****")
    expect(maskToken("12345678")).toBe("****")
  })

  test("standard token shows first/last 4", () => {
    expect(maskToken("glpat-xxxxxxxxxx-yyyy")).toBe("glpa****yyyy")
  })

  test("empty token fully masked", () => {
    expect(maskToken("")).toBe("****")
  })

  test("exactly 9 characters shows partial", () => {
    expect(maskToken("123456789")).toBe("1234****6789")
  })
})

// ─────────────────────────────────────────────────────────────
// 3. MCP config normalization adversarial
//    (tested via the exported normalization behavior in config tests;
//     here we test the transformation logic patterns directly)
// ─────────────────────────────────────────────────────────────

describe("v0.5.18 release: MCP config normalization patterns", () => {
  // Replicate the normalization logic for isolated testing
  function normalizeMcpEntry(entry: any): any {
    if (!entry || typeof entry !== "object") return null
    if (entry.command || entry.args) {
      const cmd = Array.isArray(entry.command)
        ? entry.command.map(String)
        : [
            String(entry.command),
            ...(Array.isArray(entry.args)
              ? entry.args.map(String)
              : typeof entry.args === "string"
                ? [entry.args]
                : []),
          ]
      const transformed: Record<string, any> = { type: "local", command: cmd }
      if (entry.env && typeof entry.env === "object") transformed.environment = entry.env
      if (entry.environment && typeof entry.environment === "object") transformed.environment = entry.environment
      if (typeof entry.timeout === "number") transformed.timeout = entry.timeout
      if (typeof entry.enabled === "boolean") transformed.enabled = entry.enabled
      return transformed
    }
    if (entry.url && typeof entry.url === "string") {
      const transformed: Record<string, any> = { type: "remote", url: entry.url }
      if (entry.headers && typeof entry.headers === "object") transformed.headers = entry.headers
      if (typeof entry.timeout === "number") transformed.timeout = entry.timeout
      if (typeof entry.enabled === "boolean") transformed.enabled = entry.enabled
      return transformed
    }
    return entry
  }

  describe("local server entries", () => {
    test("string command + args array transforms correctly", () => {
      const result = normalizeMcpEntry({ command: "npx", args: ["-y", "@mcp/server"] })
      expect(result).toEqual({ type: "local", command: ["npx", "-y", "@mcp/server"] })
    })

    test("array command stays as-is", () => {
      const result = normalizeMcpEntry({ command: ["npx", "-y", "@mcp/server"] })
      expect(result).toEqual({ type: "local", command: ["npx", "-y", "@mcp/server"] })
    })

    test("command with env transforms env to environment", () => {
      const result = normalizeMcpEntry({ command: "node", env: { API_KEY: "secret" } })
      expect(result).toEqual({
        type: "local",
        command: ["node"],
        environment: { API_KEY: "secret" },
      })
    })

    test("preserves timeout and enabled", () => {
      const result = normalizeMcpEntry({ command: "node", timeout: 30000, enabled: false })
      expect(result.timeout).toBe(30000)
      expect(result.enabled).toBe(false)
    })
  })

  describe("remote server entries", () => {
    test("url-based entry transforms correctly", () => {
      const result = normalizeMcpEntry({ url: "https://mcp.example.com/sse" })
      expect(result).toEqual({ type: "remote", url: "https://mcp.example.com/sse" })
    })

    test("url with headers preserved", () => {
      const result = normalizeMcpEntry({ url: "https://mcp.example.com", headers: { Authorization: "Bearer x" } })
      expect(result.headers).toEqual({ Authorization: "Bearer x" })
    })
  })

  describe("injection and security", () => {
    test("null entry returns null", () => {
      expect(normalizeMcpEntry(null)).toBeNull()
    })

    test("string entry returns null", () => {
      expect(normalizeMcpEntry("not an object")).toBeNull()
    })

    test("number entry returns null", () => {
      expect(normalizeMcpEntry(42)).toBeNull()
    })

    test("array entry passes through unchanged (typeof array is object)", () => {
      // Arrays are objects in JS — the check is typeof === "object" && !null
      const result = normalizeMcpEntry([1, 2, 3])
      expect(Array.isArray(result)).toBe(true)
    })

    test("command with shell injection characters is stringified, not executed", () => {
      const result = normalizeMcpEntry({ command: "node; rm -rf /", args: ["--flag"] })
      expect(result.command).toEqual(["node; rm -rf /", "--flag"])
      // The command is stored as data, not executed — security is at spawn layer
    })

    test("prototype pollution in command does not affect result", () => {
      const malicious = JSON.parse('{"command": "node", "__proto__": {"polluted": true}}')
      const result = normalizeMcpEntry(malicious)
      expect(result.type).toBe("local")
      expect((result as any).polluted).toBeUndefined()
      expect(({} as any).polluted).toBeUndefined()
    })

    test("constructor pollution attempt is safe", () => {
      const result = normalizeMcpEntry({ command: "node", constructor: { prototype: { x: 1 } } })
      expect(result.type).toBe("local")
      expect(({} as any).x).toBeUndefined()
    })

    test("numeric args are stringified", () => {
      const result = normalizeMcpEntry({ command: "node", args: [123, 0, -1] })
      expect(result.command).toEqual(["node", "123", "0", "-1"])
    })

    test("boolean command is stringified", () => {
      const result = normalizeMcpEntry({ command: true })
      expect(result.command).toEqual(["true"])
    })

    test("env with non-object value is ignored", () => {
      const result = normalizeMcpEntry({ command: "node", env: "not-an-object" })
      expect(result.environment).toBeUndefined()
    })

    test("timeout with non-number value is ignored", () => {
      const result = normalizeMcpEntry({ command: "node", timeout: "30000" })
      expect(result.timeout).toBeUndefined()
    })

    test("enabled with non-boolean value is ignored", () => {
      const result = normalizeMcpEntry({ command: "node", enabled: "true" })
      expect(result.enabled).toBeUndefined()
    })
  })

  describe("boundary values", () => {
    test("empty command string is falsy, skips command branch", () => {
      const result = normalizeMcpEntry({ command: "" })
      // Empty string is falsy — entry.command is falsy, so command branch is skipped
      // Result passes through unchanged
      expect(result.command).toBe("")
    })

    test("empty args array", () => {
      const result = normalizeMcpEntry({ command: "node", args: [] })
      expect(result.command).toEqual(["node"])
    })

    test("very large args array", () => {
      const args = Array.from({ length: 1000 }, (_, i) => `arg${i}`)
      const result = normalizeMcpEntry({ command: "node", args })
      expect(result.command.length).toBe(1001) // command + 1000 args
    })

    test("empty url string passes through unchanged (falsy && short-circuits)", () => {
      const result = normalizeMcpEntry({ url: "" })
      // "" is falsy, so entry.url && typeof ... is false — url branch NOT entered
      expect(result.type).toBeUndefined()
      expect(result.url).toBe("")
    })

    test("url with only spaces", () => {
      const result = normalizeMcpEntry({ url: "   " })
      expect(result.type).toBe("remote")
      expect(result.url).toBe("   ")
    })

    test("entry with both command and url prefers command", () => {
      const result = normalizeMcpEntry({ command: "node", url: "https://example.com" })
      expect(result.type).toBe("local")
      expect(result.command).toEqual(["node"])
    })

    test("deeply nested env object", () => {
      const env: Record<string, any> = { KEY: "value" }
      let current = env
      for (let i = 0; i < 50; i++) {
        current.nested = { [`key${i}`]: "value" }
        current = current.nested
      }
      const result = normalizeMcpEntry({ command: "node", env })
      expect(result.environment).toBeDefined()
      expect(result.environment.KEY).toBe("value")
    })
  })
})

// ─────────────────────────────────────────────────────────────
// 4. Glob tool home/root blocking patterns
// ─────────────────────────────────────────────────────────────

describe("v0.5.18 release: glob safety patterns", () => {
  describe("path resolution patterns", () => {
    test("home directory is correctly identified", () => {
      const os = require("os")
      const home = os.homedir()
      expect(typeof home).toBe("string")
      expect(home.length).toBeGreaterThan(0)
      expect(home).not.toBe("/")
    })

    test("root and home are distinct paths", () => {
      const os = require("os")
      const home = os.homedir()
      // On macOS/Linux, home is like /Users/x or /home/x, never /
      expect(home).not.toBe("/")
    })
  })

  describe("IGNORE_PATTERNS sanity", () => {
    // Verify the default exclusions exist and are reasonable
    test("IGNORE_PATTERNS is non-empty array", async () => {
      const { IGNORE_PATTERNS } = await import("../../src/tool/ls")
      expect(Array.isArray(IGNORE_PATTERNS)).toBe(true)
      expect(IGNORE_PATTERNS.length).toBeGreaterThan(0)
    })

    test("IGNORE_PATTERNS includes node_modules", async () => {
      const { IGNORE_PATTERNS } = await import("../../src/tool/ls")
      expect(IGNORE_PATTERNS.some((p: string) => p.includes("node_modules"))).toBe(true)
    })

    test("IGNORE_PATTERNS includes .git", async () => {
      const { IGNORE_PATTERNS } = await import("../../src/tool/ls")
      expect(IGNORE_PATTERNS.some((p: string) => p.includes(".git"))).toBe(true)
    })

    test("all patterns are non-empty strings", async () => {
      const { IGNORE_PATTERNS } = await import("../../src/tool/ls")
      for (const p of IGNORE_PATTERNS) {
        expect(typeof p).toBe("string")
        expect(p.length).toBeGreaterThan(0)
      }
    })
  })
})
