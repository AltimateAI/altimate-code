import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { discoverExternalMcp } from "../../src/mcp/discover"

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "mcp-discover-"))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe("discoverExternalMcp", () => {
  test("parses .vscode/mcp.json with servers key", async () => {
    await mkdir(path.join(tempDir, ".vscode"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".vscode/mcp.json"),
      JSON.stringify({
        servers: {
          "my-server": {
            command: "node",
            args: ["server.js"],
            env: { API_KEY: "test" },
          },
        },
      }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result["my-server"]).toMatchObject({
      type: "local",
      command: ["node", "server.js"],
      environment: { API_KEY: "test" },
    })
  })

  test("parses .github/copilot/mcp.json with mcpServers key", async () => {
    await mkdir(path.join(tempDir, ".github/copilot"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".github/copilot/mcp.json"),
      JSON.stringify({
        mcpServers: {
          copilot: {
            command: "python",
            args: ["-m", "mcp_server"],
          },
        },
      }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result["copilot"]).toMatchObject({
      type: "local",
      command: ["python", "-m", "mcp_server"],
    })
  })

  test("parses .mcp.json (Claude Code) with mcpServers key", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          claude: {
            command: "npx",
            args: ["-y", "@anthropic/mcp-server"],
          },
        },
      }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result["claude"]).toMatchObject({
      type: "local",
      command: ["npx", "-y", "@anthropic/mcp-server"],
    })
  })

  test("parses .gemini/settings.json with mcpServers key", async () => {
    await mkdir(path.join(tempDir, ".gemini"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".gemini/settings.json"),
      JSON.stringify({
        mcpServers: {
          gemini: {
            command: "deno",
            args: ["run", "server.ts"],
            env: { PORT: "3000" },
          },
        },
      }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result["gemini"]).toMatchObject({
      type: "local",
      command: ["deno", "run", "server.ts"],
      environment: { PORT: "3000" },
    })
  })

  test("command + args → command array", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: { command: "node", args: ["a", "b", "c"] },
        },
      }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result["test"]).toMatchObject({
      type: "local",
      command: ["node", "a", "b", "c"],
    })
  })

  test("command only → single-element array", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          simple: { command: "my-mcp-server" },
        },
      }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result["simple"]).toMatchObject({
      type: "local",
      command: ["my-mcp-server"],
    })
  })

  test("command as array is handled", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          arrayed: { command: ["node", "server.js"] },
        },
      }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result["arrayed"]).toMatchObject({
      type: "local",
      command: ["node", "server.js"],
    })
  })

  test("remote: url → Config.McpRemote", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          remote: { url: "https://example.com/mcp" },
        },
      }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result["remote"]).toMatchObject({
      type: "remote",
      url: "https://example.com/mcp",
    })
  })

  test("remote: url with headers", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          remote: {
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer token" },
          },
        },
      }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result["remote"]).toMatchObject({
      type: "remote",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer token" },
    })
  })

  test("env → environment rename", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          test: {
            command: "node",
            args: ["server.js"],
            env: { FOO: "bar", BAZ: "qux" },
          },
        },
      }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result["test"]!.type).toBe("local")
    const local = result["test"] as { type: "local"; command: string[]; environment?: Record<string, string> }
    expect(local.environment).toEqual({ FOO: "bar", BAZ: "qux" })
  })

  test("missing files → returns empty object", async () => {
    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result).toEqual({})
  })

  test("malformed JSON → returns empty object", async () => {
    await writeFile(path.join(tempDir, ".mcp.json"), "{ invalid json !!!")

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result).toEqual({})
  })

  test("duplicate names: first source wins (.vscode > .github > .mcp.json > .gemini)", async () => {
    // Set up the same server name in multiple sources
    await mkdir(path.join(tempDir, ".vscode"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".vscode/mcp.json"),
      JSON.stringify({
        servers: {
          shared: { command: "vscode-version" },
        },
      }),
    )

    await mkdir(path.join(tempDir, ".github/copilot"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".github/copilot/mcp.json"),
      JSON.stringify({
        mcpServers: {
          shared: { command: "copilot-version" },
        },
      }),
    )

    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          shared: { command: "claude-version" },
        },
      }),
    )

    await mkdir(path.join(tempDir, ".gemini"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".gemini/settings.json"),
      JSON.stringify({
        mcpServers: {
          shared: { command: "gemini-version" },
        },
      }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    // .vscode is first in priority order
    expect(result["shared"]).toMatchObject({
      type: "local",
      command: ["vscode-version"],
    })
  })

  test("entries without command or url are skipped", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          invalid: { description: "no command or url" },
          valid: { command: "works" },
        },
      }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result["invalid"]).toBeUndefined()
    expect(result["valid"]).toBeDefined()
  })

  test("handles JSONC (comments in JSON)", async () => {
    await mkdir(path.join(tempDir, ".vscode"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".vscode/mcp.json"),
      `{
  // This is a comment
  "servers": {
    "commented": {
      "command": "node",
      "args": ["server.js"] // trailing comment
    }
  }
}`,
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result["commented"]).toMatchObject({
      type: "local",
      command: ["node", "server.js"],
    })
  })

  test("multiple sources contribute different servers", async () => {
    await mkdir(path.join(tempDir, ".vscode"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".vscode/mcp.json"),
      JSON.stringify({
        servers: {
          alpha: { command: "alpha-cmd" },
        },
      }),
    )

    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          beta: { command: "beta-cmd" },
        },
      }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result["alpha"]).toMatchObject({ type: "local", command: ["alpha-cmd"] })
    expect(result["beta"]).toMatchObject({ type: "local", command: ["beta-cmd"] })
  })

  test("wrong key in file is ignored", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        servers: {
          wrong: { command: "should-not-appear" },
        },
      }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result).toEqual({})
  })

  test("project-scoped servers are disabled by default for security", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "project-server": { command: "test-cmd" },
        },
      }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result["project-server"]).toBeDefined()
    expect((result["project-server"] as any).enabled).toBe(false)
  })
})
