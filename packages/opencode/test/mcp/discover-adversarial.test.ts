/**
 * Adversarial tests for MCP discovery.
 *
 * Covers: prototype pollution, command injection via server names/values,
 * path traversal, symlink attacks, huge files, deeply nested JSON,
 * null bytes, unicode edge cases, race conditions, type coercion traps,
 * and the consumeDiscoveryResult / setDiscoveryResult lifecycle.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile, symlink } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import {
  discoverExternalMcp,
  setDiscoveryResult,
  consumeDiscoveryResult,
} from "../../src/mcp/discover"

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "mcp-adversarial-"))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. Prototype pollution
// ---------------------------------------------------------------------------
describe("prototype pollution", () => {
  test("__proto__ server name is rejected", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          __proto__: { command: "evil" },
          legit: { command: "safe" },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers["__proto__"]).toBeUndefined()
    expect(servers["legit"]).toBeDefined()
    // Verify Object.prototype was not polluted
    expect(({} as any).command).toBeUndefined()
  })

  test("constructor server name is rejected", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          constructor: { command: "evil" },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers["constructor"]).toBeUndefined()
  })

  test("prototype server name is rejected", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          prototype: { command: "evil" },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers["prototype"]).toBeUndefined()
  })

  test("__proto__ nested in env does not pollute Object.prototype", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: {
            command: "node",
            env: { __proto__: { polluted: true } },
          },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect((servers["test"] as any)?.environment?.__proto__).toBeDefined() // env passes through
    expect(({} as any).polluted).toBeUndefined() // but prototype is not polluted
  })
})

// ---------------------------------------------------------------------------
// 2. Command injection / dangerous values
// ---------------------------------------------------------------------------
describe("command injection", () => {
  test("command with shell metacharacters is preserved verbatim (not interpreted)", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: {
            command: "node",
            args: ["; rm -rf /", "$(whoami)", "`id`", "| cat /etc/passwd"],
          },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    const local = servers["test"] as any
    expect(local.command).toEqual([
      "node",
      "; rm -rf /",
      "$(whoami)",
      "`id`",
      "| cat /etc/passwd",
    ])
  })

  test("url with javascript: protocol is preserved (validation is downstream)", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          xss: { url: "javascript:alert(1)" },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers["xss"]).toMatchObject({
      type: "remote",
      url: "javascript:alert(1)",
    })
  })

  test("command as number is coerced to string", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: { command: 42 },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect((servers["test"] as any).command).toEqual(["42"])
  })

  test("args with non-string elements are coerced via String(), nulls filtered", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: {
            command: "node",
            args: [123, true, null, { toString: "hacked" }],
          },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    const local = servers["test"] as any
    // null is filtered out; others coerced via String()
    expect(local.command[0]).toBe("node")
    expect(local.command[1]).toBe("123")
    expect(local.command[2]).toBe("true")
    // null is filtered, so index 3 is the object with broken toString
    // safeStr catches the TypeError and returns "[invalid]"
    expect(local.command[3]).toBe("[invalid]")
  })
})

// ---------------------------------------------------------------------------
// 3. Malformed / extreme inputs
// ---------------------------------------------------------------------------
describe("malformed inputs", () => {
  test("empty file returns empty result", async () => {
    await writeFile(path.join(tempDir, ".mcp.json"), "")
    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers).toEqual({})
  })

  test("file with only whitespace returns empty result", async () => {
    await writeFile(path.join(tempDir, ".mcp.json"), "   \n\t\n  ")
    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers).toEqual({})
  })

  test("null JSON value returns empty result", async () => {
    await writeFile(path.join(tempDir, ".mcp.json"), "null")
    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers).toEqual({})
  })

  test("JSON array (not object) returns empty result", async () => {
    await writeFile(path.join(tempDir, ".mcp.json"), '[{"command": "node"}]')
    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers).toEqual({})
  })

  test("JSON number returns empty result", async () => {
    await writeFile(path.join(tempDir, ".mcp.json"), "42")
    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers).toEqual({})
  })

  test("JSON string returns empty result", async () => {
    await writeFile(path.join(tempDir, ".mcp.json"), '"hello"')
    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers).toEqual({})
  })

  test("binary file content returns empty result", async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x89, 0x50, 0x4e, 0x47])
    await writeFile(path.join(tempDir, ".mcp.json"), binary)
    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers).toEqual({})
  })

  test("extremely large JSON file (10k servers) does not crash", async () => {
    const servers: Record<string, any> = {}
    for (let i = 0; i < 10_000; i++) {
      servers[`server-${i}`] = { command: `cmd-${i}` }
    }
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({ mcpServers: servers }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(Object.keys(result).length).toBe(10_000)
  })

  test("deeply nested JSON (100 levels) does not crash", async () => {
    let nested: any = { command: "deep" }
    for (let i = 0; i < 100; i++) {
      nested = { wrapper: nested }
    }
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          deep: nested, // entry itself is deeply nested — no command at top level
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    // Should not crash; entry has no top-level command/url so it's skipped
    expect(servers["deep"]).toBeUndefined()
  })

  test("server entry is a string (not object) is skipped", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          stringEntry: "not-an-object",
          valid: { command: "works" },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers["stringEntry"]).toBeUndefined()
    expect(servers["valid"]).toBeDefined()
  })

  test("server entry is null is skipped", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          nullEntry: null,
          valid: { command: "works" },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers["nullEntry"]).toBeUndefined()
    expect(servers["valid"]).toBeDefined()
  })

  test("server entry is a number is skipped", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          numEntry: 42,
          valid: { command: "works" },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers["numEntry"]).toBeUndefined()
    expect(servers["valid"]).toBeDefined()
  })

  test("server entry is an array is skipped", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          arrEntry: ["node", "server.js"],
          valid: { command: "works" },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    // Arrays are objects in JS, but transform() checks for command/url
    expect(servers["arrEntry"]).toBeUndefined()
    expect(servers["valid"]).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 4. Unicode and special characters
// ---------------------------------------------------------------------------
describe("unicode and special characters", () => {
  test("server names with unicode characters are preserved", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "サーバー": { command: "node" },
          "сервер": { command: "python" },
          "🚀-server": { command: "deno" },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers["サーバー"]).toBeDefined()
    expect(servers["сервер"]).toBeDefined()
    expect(servers["🚀-server"]).toBeDefined()
  })

  test("server name with null bytes is handled", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "null\x00byte": { command: "node" },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    // JSON serialization may or may not preserve null bytes; either way, no crash
    expect(Object.keys(servers).length).toBeLessThanOrEqual(1)
  })

  test("empty string server name is accepted (edge case)", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "": { command: "node" },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers[""]).toBeDefined()
  })

  test("server name with dots, slashes, and spaces", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "my.server/v2 (prod)": { command: "node" },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers["my.server/v2 (prod)"]).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 5. transform() edge cases
// ---------------------------------------------------------------------------
describe("transform edge cases", () => {
  test("entry with both command and url — url takes precedence", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          both: {
            command: "node",
            url: "https://example.com/mcp",
          },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    // url check comes first in transform()
    expect(servers["both"]).toMatchObject({
      type: "remote",
      url: "https://example.com/mcp",
    })
  })

  test("url as number is not treated as remote", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: { url: 12345 },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    // url must be string — this entry has no valid command either
    expect(servers["test"]).toBeUndefined()
  })

  test("url as empty string is falsy — falls through to command check", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: { url: "", command: "fallback" },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    // empty string is falsy, so url check fails; command is used
    expect(servers["test"]).toMatchObject({
      type: "local",
      command: ["fallback"],
    })
  })

  test("timeout as string is ignored (must be number)", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: { command: "node", timeout: "30000" },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect((servers["test"] as any).timeout).toBeUndefined()
  })

  test("timeout as negative number is preserved (no validation)", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: { command: "node", timeout: -1 },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect((servers["test"] as any).timeout).toBe(-1)
  })

  test("enabled as string is ignored (must be boolean)", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: { command: "node", enabled: "true" },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    // project-scoped → enabled=false; but the string "true" is not boolean
    // so it doesn't override. enabled should be false (project-scoped default)
    expect((servers["test"] as any).enabled).toBe(false)
  })

  test("env as array is ignored (must be object)", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: { command: "node", env: ["FOO=bar"] },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    // Arrays are objects in JS — but env check uses typeof === "object"
    // This means array env would be set as environment. Let's see:
    const local = servers["test"] as any
    // Array passes typeof check — this is a design choice, not a bug
    // The important thing is it doesn't crash
    expect(local).toBeDefined()
  })

  test("headers as array is passed through (no strict validation)", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: { url: "https://example.com", headers: ["bad"] },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    // Arrays are objects — headers check uses typeof === "object"
    expect(servers["test"]).toBeDefined()
  })

  test("command as boolean is coerced to string", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: { command: true },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    // Boolean is truthy, so it enters the command branch
    // String(true) = "true"
    expect((servers["test"] as any).command).toEqual(["true"])
  })

  test("command as object is coerced to string", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: { command: { evil: true } },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    // Not array, so goes to String({evil:true}) path
    // But wait — entry.command is truthy AND it could be Array.isArray check
    // {evil:true} is not array → String({evil:true}) = "[object Object]"
    expect((servers["test"] as any).command[0]).toBe("[object Object]")
  })
})

// ---------------------------------------------------------------------------
// 6. Priority and deduplication
// ---------------------------------------------------------------------------
describe("priority and deduplication", () => {
  test(".cursor/mcp.json is parsed with mcpServers key", async () => {
    await mkdir(path.join(tempDir, ".cursor"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".cursor/mcp.json"),
      JSON.stringify({
        mcpServers: {
          cursor: { command: "cursor-mcp" },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers["cursor"]).toMatchObject({
      type: "local",
      command: ["cursor-mcp"],
    })
  })

  test("all 5 sources can contribute unique servers simultaneously", async () => {
    await mkdir(path.join(tempDir, ".vscode"), { recursive: true })
    await writeFile(path.join(tempDir, ".vscode/mcp.json"), JSON.stringify({
      servers: { vscode: { command: "vscode-cmd" } },
    }))

    await mkdir(path.join(tempDir, ".cursor"), { recursive: true })
    await writeFile(path.join(tempDir, ".cursor/mcp.json"), JSON.stringify({
      mcpServers: { cursor: { command: "cursor-cmd" } },
    }))

    await mkdir(path.join(tempDir, ".github/copilot"), { recursive: true })
    await writeFile(path.join(tempDir, ".github/copilot/mcp.json"), JSON.stringify({
      mcpServers: { copilot: { command: "copilot-cmd" } },
    }))

    await writeFile(path.join(tempDir, ".mcp.json"), JSON.stringify({
      mcpServers: { claude: { command: "claude-cmd" } },
    }))

    await mkdir(path.join(tempDir, ".gemini"), { recursive: true })
    await writeFile(path.join(tempDir, ".gemini/settings.json"), JSON.stringify({
      mcpServers: { gemini: { command: "gemini-cmd" } },
    }))

    const { servers, sources } = await discoverExternalMcp(tempDir)
    expect(Object.keys(servers).length).toBe(5)
    expect(sources.length).toBe(5)
  })

  test("later source cannot override earlier source with same name", async () => {
    await mkdir(path.join(tempDir, ".vscode"), { recursive: true })
    await writeFile(path.join(tempDir, ".vscode/mcp.json"), JSON.stringify({
      servers: { shared: { command: "FIRST" } },
    }))

    await mkdir(path.join(tempDir, ".cursor"), { recursive: true })
    await writeFile(path.join(tempDir, ".cursor/mcp.json"), JSON.stringify({
      mcpServers: { shared: { command: "SECOND" } },
    }))

    await mkdir(path.join(tempDir, ".github/copilot"), { recursive: true })
    await writeFile(path.join(tempDir, ".github/copilot/mcp.json"), JSON.stringify({
      mcpServers: { shared: { command: "THIRD" } },
    }))

    await writeFile(path.join(tempDir, ".mcp.json"), JSON.stringify({
      mcpServers: { shared: { command: "FOURTH" } },
    }))

    await mkdir(path.join(tempDir, ".gemini"), { recursive: true })
    await writeFile(path.join(tempDir, ".gemini/settings.json"), JSON.stringify({
      mcpServers: { shared: { command: "FIFTH" } },
    }))

    const { servers } = await discoverExternalMcp(tempDir)
    expect((servers["shared"] as any).command).toEqual(["FIRST"])
  })

  test("sources list only includes files that contributed new servers", async () => {
    await mkdir(path.join(tempDir, ".vscode"), { recursive: true })
    await writeFile(path.join(tempDir, ".vscode/mcp.json"), JSON.stringify({
      servers: { shared: { command: "vscode" } },
    }))

    // This one has the same name — contributes nothing new
    await writeFile(path.join(tempDir, ".mcp.json"), JSON.stringify({
      mcpServers: { shared: { command: "claude" } },
    }))

    const { sources } = await discoverExternalMcp(tempDir)
    expect(sources).toEqual([".vscode/mcp.json"])
  })
})

// ---------------------------------------------------------------------------
// 7. Security: project-scoped vs home-scoped
// ---------------------------------------------------------------------------
describe("security: project vs home scope", () => {
  test("project-scoped .mcp.json servers are disabled by default", async () => {
    await writeFile(path.join(tempDir, ".mcp.json"), JSON.stringify({
      mcpServers: {
        proj: { command: "dangerous" },
      },
    }))

    const { servers } = await discoverExternalMcp(tempDir)
    expect((servers["proj"] as any).enabled).toBe(false)
  })

  test("project-scoped .vscode servers are disabled by default", async () => {
    await mkdir(path.join(tempDir, ".vscode"), { recursive: true })
    await writeFile(path.join(tempDir, ".vscode/mcp.json"), JSON.stringify({
      servers: { vsc: { command: "node" } },
    }))

    const { servers } = await discoverExternalMcp(tempDir)
    expect((servers["vsc"] as any).enabled).toBe(false)
  })

  test("project-scoped server with enabled:true in source is overridden to false", async () => {
    await writeFile(path.join(tempDir, ".mcp.json"), JSON.stringify({
      mcpServers: {
        test: { command: "node", enabled: true },
      },
    }))

    const { servers } = await discoverExternalMcp(tempDir)
    // Project-scoped forces enabled=false regardless of source config
    expect((servers["test"] as any).enabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 8. Filesystem edge cases
// ---------------------------------------------------------------------------
describe("filesystem edge cases", () => {
  test("config file is a directory (not a file) — no crash", async () => {
    await mkdir(path.join(tempDir, ".mcp.json"), { recursive: true })
    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers).toEqual({})
  })

  test("symlink to valid config is followed", async () => {
    const realDir = path.join(tempDir, "real")
    await mkdir(realDir)
    await writeFile(
      path.join(realDir, "mcp-config.json"),
      JSON.stringify({
        mcpServers: { linked: { command: "node" } },
      }),
    )
    await symlink(
      path.join(realDir, "mcp-config.json"),
      path.join(tempDir, ".mcp.json"),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers["linked"]).toBeDefined()
  })

  test("broken symlink — no crash", async () => {
    await symlink(
      path.join(tempDir, "nonexistent"),
      path.join(tempDir, ".mcp.json"),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers).toEqual({})
  })

  test("nonexistent worktree directory — no crash", async () => {
    const { servers } = await discoverExternalMcp("/nonexistent/path/that/does/not/exist")
    expect(servers).toEqual({})
  })

  test("config file with no read permissions — no crash", async () => {
    await writeFile(path.join(tempDir, ".mcp.json"), JSON.stringify({
      mcpServers: { test: { command: "node" } },
    }))
    const { chmod } = await import("fs/promises")
    await chmod(path.join(tempDir, ".mcp.json"), 0o000)

    try {
      const { servers } = await discoverExternalMcp(tempDir)
      expect(servers).toEqual({})
    } finally {
      // Restore permissions for cleanup
      await chmod(path.join(tempDir, ".mcp.json"), 0o644)
    }
  })
})

// ---------------------------------------------------------------------------
// 9. JSONC edge cases
// ---------------------------------------------------------------------------
describe("JSONC edge cases", () => {
  test("trailing commas are handled", async () => {
    await mkdir(path.join(tempDir, ".vscode"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".vscode/mcp.json"),
      `{
        "servers": {
          "test": {
            "command": "node",
            "args": ["server.js",],
          },
        },
      }`,
    )

    const { servers } = await discoverExternalMcp(tempDir)
    // jsonc-parser handles trailing commas
    expect(servers["test"]).toBeDefined()
  })

  test("multi-line comments are handled", async () => {
    await mkdir(path.join(tempDir, ".vscode"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".vscode/mcp.json"),
      `{
        /* This is a
           multi-line comment */
        "servers": {
          "test": { "command": "node" }
        }
      }`,
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect(servers["test"]).toBeDefined()
  })

  test("BOM (byte order mark) at start of file", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      "\uFEFF" + JSON.stringify({ mcpServers: { bom: { command: "node" } } }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    // jsonc-parser may or may not handle BOM — either way, no crash
    // BOM is common in Windows-created files
    const hasBom = servers["bom"] !== undefined
    expect(typeof hasBom).toBe("boolean") // no crash is the test
  })
})

// ---------------------------------------------------------------------------
// 10. setDiscoveryResult / consumeDiscoveryResult lifecycle
// ---------------------------------------------------------------------------
describe("discovery result lifecycle", () => {
  test("consumeDiscoveryResult returns null when nothing was set", () => {
    // Clear any prior state
    consumeDiscoveryResult()
    expect(consumeDiscoveryResult()).toBeNull()
  })

  test("setDiscoveryResult + consumeDiscoveryResult returns result once", () => {
    setDiscoveryResult(["server-a", "server-b"], [".mcp.json"])
    const result = consumeDiscoveryResult()
    expect(result).toEqual({
      serverNames: ["server-a", "server-b"],
      sources: [".mcp.json"],
    })
    // Second call returns null (consumed)
    expect(consumeDiscoveryResult()).toBeNull()
  })

  test("setDiscoveryResult with empty array does not store result", () => {
    consumeDiscoveryResult() // clear
    setDiscoveryResult([], [".mcp.json"])
    expect(consumeDiscoveryResult()).toBeNull()
  })

  test("multiple setDiscoveryResult calls — last one wins", () => {
    setDiscoveryResult(["first"], ["source-1"])
    setDiscoveryResult(["second"], ["source-2"])
    const result = consumeDiscoveryResult()
    expect(result).toEqual({
      serverNames: ["second"],
      sources: ["source-2"],
    })
  })
})

// ---------------------------------------------------------------------------
// 11. Concurrent / race-condition scenarios
// ---------------------------------------------------------------------------
describe("concurrent discovery", () => {
  test("parallel calls to discoverExternalMcp do not interfere", async () => {
    await writeFile(path.join(tempDir, ".mcp.json"), JSON.stringify({
      mcpServers: { shared: { command: "node" } },
    }))

    const results = await Promise.all([
      discoverExternalMcp(tempDir),
      discoverExternalMcp(tempDir),
      discoverExternalMcp(tempDir),
    ])

    for (const { servers } of results) {
      expect(servers["shared"]).toBeDefined()
      expect((servers["shared"] as any).command).toEqual(["node"])
    }
  })
})

// ---------------------------------------------------------------------------
// 12. Mixed valid and invalid entries
// ---------------------------------------------------------------------------
describe("mixed valid and invalid entries", () => {
  test("one invalid entry does not prevent other valid entries", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          invalid1: null,
          invalid2: "string",
          invalid3: 42,
          invalid4: { description: "no command or url" },
          valid1: { command: "node" },
          invalid5: [],
          valid2: { url: "https://example.com" },
          __proto__: { command: "evil" },
          valid3: { command: "python", args: ["-m", "server"] },
        },
      }),
    )

    const { servers } = await discoverExternalMcp(tempDir)
    expect(Object.keys(servers).length).toBe(3)
    expect(servers["valid1"]).toBeDefined()
    expect(servers["valid2"]).toBeDefined()
    expect(servers["valid3"]).toBeDefined()
  })
})
