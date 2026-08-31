import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises"
import os, { tmpdir } from "os"
import path from "path"
import { discoverExternalMcp, unresolvedEnvVars } from "../../src/mcp/discover"

let tempDir: string
let homeDir: string
let homedirSpy: ReturnType<typeof spyOn> | undefined

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "mcp-discover-"))
  // Isolate the home dir to an empty temp dir. discoverExternalMcp also reads the home-scoped
  // global config (~/.claude.json etc.); without isolation these hermetic "returns empty" cases
  // pick up the developer's real MCP servers and fail off-CI. (bun's os.homedir() caches $HOME at
  // startup, so it must be spied rather than set via process.env.)
  homeDir = await mkdtemp(path.join(tmpdir(), "mcp-discover-home-"))
  homedirSpy = spyOn(os, "homedir").mockImplementation(() => homeDir)
})

afterEach(async () => {
  homedirSpy?.mockRestore()
  await rm(tempDir, { recursive: true, force: true })
  await rm(homeDir, { recursive: true, force: true })
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

  // altimate_change start — discovery must preserve bearer-auth fields
  // (headersCommand / oauth) the same way config.ts `normalizeMcpConfig` does,
  // or auto-discovered servers silently connect with no auth. See #791 / #792.
  test("remote: headersCommand and oauth are preserved", async () => {
    await writeFile(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          fabric: {
            url: "https://api.fabric.microsoft.com/v1/mcp/core",
            headersCommand: {
              Authorization: ["az", "account", "get-access-token"],
            },
          },
          "no-oauth": {
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer token" },
            oauth: false,
          },
        },
      }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result["fabric"]).toMatchObject({
      type: "remote",
      url: "https://api.fabric.microsoft.com/v1/mcp/core",
      headersCommand: { Authorization: ["az", "account", "get-access-token"] },
    })
    expect(result["no-oauth"]).toMatchObject({
      type: "remote",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer token" },
      oauth: false,
    })
  })

  test("remote: foreign oauth/headersCommand dialects are dropped, server kept", async () => {
    // Discovered configs are foreign files: shapes our schema rejects (e.g.
    // Gemini CLI's `oauth: { enabled: true }`) must be dropped, not passed
    // through — `mcp-discover add` persists entries to opencode.json without
    // re-validation, and an invalid shape there fails every config load.
    await mkdir(path.join(tempDir, ".gemini"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".gemini/settings.json"),
      JSON.stringify({
        mcpServers: {
          "gemini-oauth": {
            url: "https://example.com/mcp",
            oauth: { enabled: true },
          },
          "bool-oauth": {
            url: "https://example.com/mcp",
            oauth: true,
          },
          "bad-headers-command": {
            url: "https://example.com/mcp",
            headersCommand: { Authorization: "not-an-argv-array" },
          },
          "valid-oauth": {
            url: "https://example.com/mcp",
            oauth: { clientId: "client-xyz" },
          },
        },
      }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result["gemini-oauth"]).toMatchObject({ type: "remote", url: "https://example.com/mcp" })
    expect(result["gemini-oauth"]).not.toHaveProperty("oauth")
    expect(result["bool-oauth"]).not.toHaveProperty("oauth")
    expect(result["bad-headers-command"]).toMatchObject({ type: "remote", url: "https://example.com/mcp" })
    expect(result["bad-headers-command"]).not.toHaveProperty("headersCommand")
    expect(result["valid-oauth"]).toMatchObject({ oauth: { clientId: "client-xyz" } })
  })
  // altimate_change end

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

  // NOTE: env-var interpolation in discover only applies to `env` and `headers`
  // fields (see resolveServerEnvVars in discover.ts), NOT to `command` args.
  // Tests for command-level interpolation were removed as invalid.

  // altimate_change start — the `**/mcp.json` scan is now pruned during traversal
  // instead of filtered afterwards. Pin that the exclusion still holds and that
  // real project files are still discovered.
  test("mcp.json inside dependency and build trees is not discovered", async () => {
    await mkdir(path.join(tempDir, "node_modules/some-pkg/.vscode"), { recursive: true })
    await writeFile(
      path.join(tempDir, "node_modules/some-pkg/.vscode/mcp.json"),
      JSON.stringify({ servers: { vendored: { command: "should-not-appear" } } }),
    )
    await mkdir(path.join(tempDir, "dist"), { recursive: true })
    await writeFile(
      path.join(tempDir, "dist/mcp.json"),
      JSON.stringify({ servers: { built: { command: "should-not-appear" } } }),
    )
    await mkdir(path.join(tempDir, ".vscode"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".vscode/mcp.json"),
      JSON.stringify({ servers: { real: { command: "real-cmd" } } }),
    )

    const { servers: result } = await discoverExternalMcp(tempDir)
    expect(result["vendored"]).toBeUndefined()
    expect(result["built"]).toBeUndefined()
    expect(result["real"]).toMatchObject({ type: "local", command: ["real-cmd"] })
  })
  // altimate_change end
})

// altimate_change start — upstream_fix (#701): the record must not outlive the problem.
describe("unresolvedEnvVars staleness", () => {
  const VAR = "ALTIMATE_TEST_UNRESOLVED_VAR"

  async function writeServer() {
    await mkdir(path.join(tempDir, ".vscode"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".vscode/mcp.json"),
      JSON.stringify({
        servers: { stale: { command: "node", env: { TOKEN: `{env:${VAR}}` } } },
      }),
    )
  }

  // Save and restore rather than blindly deleting: these mutate process-wide state, and a
  // parallel `bun test` run must not observe a variable this file removed or left behind.
  let previous: string | undefined
  beforeEach(() => {
    previous = process.env[VAR]
    delete process.env[VAR]
  })
  afterEach(() => {
    if (previous === undefined) delete process.env[VAR]
    else process.env[VAR] = previous
  })

  test("clears a variable that has since been set", async () => {
    await writeServer()

    await discoverExternalMcp(tempDir)
    expect(unresolvedEnvVars("stale")).toContain(VAR)

    // The user sets the variable and discovery runs again (config reload / mcp_discover).
    process.env[VAR] = "now-set"
    await discoverExternalMcp(tempDir)
    // Previously this still returned [VAR]: the record only ever unioned, and the recording
    // site sits inside an `unresolvedNames.length > 0` guard, so a clean run never cleared it.
    // `/mcps` kept telling the user to set a variable that already resolved.
    expect(unresolvedEnvVars("stale")).toEqual([])
  })

  test("still reports it while it is genuinely unset", async () => {
    await writeServer()
    await discoverExternalMcp(tempDir)
    await discoverExternalMcp(tempDir)
    // The reset must not swallow a real, still-unresolved variable across runs.
    expect(unresolvedEnvVars("stale")).toContain(VAR)
  })
})
// altimate_change end
