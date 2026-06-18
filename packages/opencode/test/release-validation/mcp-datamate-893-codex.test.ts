import { describe, test, expect } from "bun:test"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { discoverExternalMcp } from "../../src/mcp/discover"
import { addMcpToConfig, readMcpEntryFromDisk } from "../../src/mcp/config"
import {
  readDatamateTransportFromIde,
  syncDatamateUrlFromVscodeMcp,
} from "../../src/altimate/datamate-transport"

const REPO_ROOT = path.join(import.meta.dir, "../../../..")

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2))
}

async function withIsolatedHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  await using home = await tmpdir()
  const oldHome = process.env.HOME
  const oldUserProfile = process.env.USERPROFILE
  process.env.HOME = home.path
  process.env.USERPROFILE = home.path
  try {
    return await fn(home.path)
  } finally {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    if (oldUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = oldUserProfile
  }
}

describe("PR #893 MCP discovery normalization", () => {
  test("recursive mcp.json discovery merges both VS Code servers and legacy mcpServers maps", async () => {
    await withIsolatedHome(async () => {
      await using project = await tmpdir()
      await writeJson(path.join(project.path, "tools/editor/mcp.json"), {
        servers: {
          vscodeRemote: {
            url: "https://mcp.example.com/sse",
            headers: { Authorization: "Bearer ${MCP_TOKEN}" },
          },
        },
        mcpServers: {
          cursorLocal: {
            command: "bunx",
            args: ["server", 7, false],
            env: { TOKEN: "${MCP_TOKEN}" },
          },
        },
      })

      process.env.MCP_TOKEN = "resolved-token"
      try {
        const { servers, sources } = await discoverExternalMcp(project.path)
        expect(sources).toContain("tools/editor/mcp.json")
        expect(servers.vscodeRemote).toEqual({
          type: "remote",
          url: "https://mcp.example.com/sse",
          headers: { Authorization: "Bearer resolved-token" },
          enabled: false,
        } as any)
        expect(servers.cursorLocal).toEqual({
          type: "local",
          command: ["bunx", "server", "7", "false"],
          environment: { TOKEN: "resolved-token" },
          enabled: false,
        } as any)
      } finally {
        delete process.env.MCP_TOKEN
      }
    })
  })

  test("recursive project scan ignores vendored mcp.json files before they can auto-connect", async () => {
    await withIsolatedHome(async () => {
      await using project = await tmpdir()
      await writeJson(path.join(project.path, "node_modules/malicious/mcp.json"), {
        servers: { vendored: { command: "do-not-run", args: ["--token", "secret"] } },
      })
      await writeJson(path.join(project.path, "dist/generated/mcp.json"), {
        mcpServers: { built: { command: "do-not-run-either" } },
      })
      await writeJson(path.join(project.path, ".vscode/mcp.json"), {
        servers: { authored: { command: "safe-dev-server" } },
      })

      const { servers, sources } = await discoverExternalMcp(project.path)
      expect(Object.keys(servers).sort()).toEqual(["authored"])
      expect(sources).toEqual([".vscode/mcp.json"])
    })
  })

  // BUG: normalizeMcpConfig rebuilds any MCP entry with command/url and drops updatedAt,
  // even though McpLocal/McpRemote schema accepts updatedAt for sync/reconnect detection.
  test.todo("Config normalization preserves updatedAt on local and remote MCP entries", () => {})
})

describe("PR #893 datamate IDE transport selection", () => {
  test("prefers remote datamate URL over command when both are present", async () => {
    await using project = await tmpdir()
    await writeJson(path.join(project.path, ".vscode/mcp.json"), {
      servers: {
        datamate: {
          url: "https://datamate.example.com/sse",
          command: "datamate",
          args: ["start-stdio"],
        },
      },
    })

    await expect(readDatamateTransportFromIde(project.path)).resolves.toEqual({
      type: "remote",
      url: "https://datamate.example.com/sse",
    })
  })

  test("returns local datamate command with exact IDE args", async () => {
    await using project = await tmpdir()
    await writeJson(path.join(project.path, ".cursor/mcp.json"), {
      mcpServers: {
        datamate: {
          command: "bunx",
          args: ["@altimate/datamate", "start-stdio", "--workspace", project.path],
        },
      },
    })

    await expect(readDatamateTransportFromIde(project.path)).resolves.toEqual({
      type: "local",
      command: ["bunx", "@altimate/datamate", "start-stdio", "--workspace", project.path],
    })
  })

  test("falls back to safe local datamate marker when IDE entry has no usable transport fields", async () => {
    await using project = await tmpdir()
    await writeJson(path.join(project.path, ".vscode/mcp.json"), {
      servers: { datamate: { type: "stdio", args: ["ignored-without-command"] } },
    })

    await expect(readDatamateTransportFromIde(project.path)).resolves.toEqual({
      type: "local",
      command: ["datamate", "start-stdio"],
    })
  })

  test("skips malformed mcp.json and uses the next valid datamate entry", async () => {
    await using project = await tmpdir()
    await mkdir(path.join(project.path, "a-bad"), { recursive: true })
    await writeFile(path.join(project.path, "a-bad/mcp.json"), "{ not json")
    await writeJson(path.join(project.path, "z-good/mcp.json"), {
      servers: { datamate: { url: "https://good.example.com/mcp" } },
    })

    await expect(readDatamateTransportFromIde(project.path)).resolves.toEqual({
      type: "remote",
      url: "https://good.example.com/mcp",
    })
  })

  test("ignores vendored datamate mcp.json entries during transport selection", async () => {
    await using project = await tmpdir()
    await writeJson(path.join(project.path, "node_modules/pkg/mcp.json"), {
      servers: { datamate: { url: "https://vendored.example.com/sse" } },
    })
    await writeJson(path.join(project.path, ".vscode/mcp.json"), {
      servers: { datamate: { command: "datamate", args: ["start-stdio"] } },
    })

    await expect(readDatamateTransportFromIde(project.path)).resolves.toEqual({
      type: "local",
      command: ["datamate", "start-stdio"],
    })
  })
})

describe("PR #893 datamate sync to altimate-code config", () => {
  test("syncs datamate stdio by updatedAt while preserving enabled/timeout and stripping session RPC env", async () => {
    await using project = await tmpdir()
    const configPath = path.join(project.path, ".altimate-code/altimate-code.json")
    await addMcpToConfig(
      "datamate",
      {
        type: "remote",
        url: "https://old.example.com/sse",
        enabled: false,
        timeout: 12345,
        updatedAt: "2026-06-17T09:00:00.000Z",
      } as any,
      configPath,
    )
    await writeJson(path.join(project.path, ".vscode/mcp.json"), {
      servers: {
        datamate: {
          type: "stdio",
          command: "datamate",
          args: ["start-stdio", "--port", "0"],
          env: {
            ALTIMATE_EXTENSION_RPC: "/tmp/extension-rpc-secret.sock",
            KEEP_ME: "yes",
          },
          updatedAt: "2026-06-17T10:00:00.000Z",
        },
      },
    })

    const updated = await syncDatamateUrlFromVscodeMcp(project.path)
    const entry = await readMcpEntryFromDisk("datamate", configPath)
    const raw = await readFile(configPath, "utf-8")

    expect(updated).toEqual(["datamate"])
    expect(entry).toEqual({
      type: "local",
      command: ["datamate", "start-stdio", "--port", "0"],
      environment: { KEEP_ME: "yes" },
      enabled: false,
      timeout: 12345,
      updatedAt: "2026-06-17T10:00:00.000Z",
    } as any)
    expect(raw).not.toContain("extension-rpc-secret")
    expect(raw).not.toContain("ALTIMATE_EXTENSION_RPC")
  })

  test("does not rewrite datamate when updatedAt already matches IDE config", async () => {
    await using project = await tmpdir()
    const configPath = path.join(project.path, ".altimate-code/altimate-code.json")
    await addMcpToConfig(
      "datamate",
      {
        type: "remote",
        url: "https://same.example.com/sse",
        enabled: true,
        updatedAt: "2026-06-17T10:00:00.000Z",
      } as any,
      configPath,
    )
    const before = await readFile(configPath, "utf-8")
    await writeJson(path.join(project.path, ".vscode/mcp.json"), {
      servers: {
        datamate: {
          url: "https://new-but-same-timestamp.example.com/sse",
          updatedAt: "2026-06-17T10:00:00.000Z",
        },
      },
    })

    await expect(syncDatamateUrlFromVscodeMcp(project.path)).resolves.toEqual([])
    await expect(readFile(configPath, "utf-8")).resolves.toBe(before)
  })

  test("updates non-datamate remote URLs from the same IDE file and preserves nested auth fields", async () => {
    await using project = await tmpdir()
    const configPath = path.join(project.path, ".altimate-code/altimate-code.json")
    await addMcpToConfig(
      "datamate",
      {
        type: "remote",
        url: "https://datamate.example.com/sse",
        updatedAt: "2026-06-17T10:00:00.000Z",
      } as any,
      configPath,
    )
    await addMcpToConfig(
      "analytics",
      {
        type: "remote",
        url: "https://old.example.com/mcp",
        headers: { Authorization: "Bearer keep-secret", "X-Tenant": "tenant-a" },
        oauth: { clientId: "client-1", scope: "read write" },
        timeout: 9000,
        enabled: false,
      } as any,
      configPath,
    )
    await writeJson(path.join(project.path, ".vscode/mcp.json"), {
      servers: {
        datamate: {
          url: "https://datamate.example.com/sse",
          updatedAt: "2026-06-17T10:00:00.000Z",
        },
        analytics: { url: "https://new.example.com/mcp" },
      },
    })

    const updated = await syncDatamateUrlFromVscodeMcp(project.path)
    const entry = (await readMcpEntryFromDisk("analytics", configPath)) as any

    expect(updated).toEqual(["analytics"])
    expect(entry.url).toBe("https://new.example.com/mcp")
    expect(entry.headers).toEqual({ Authorization: "Bearer keep-secret", "X-Tenant": "tenant-a" })
    expect(entry.oauth).toEqual({ clientId: "client-1", scope: "read write" })
    expect(entry.timeout).toBe(9000)
    expect(entry.enabled).toBe(false)
    expect(typeof entry.updatedAt).toBe("string")
  })

  test("missing altimate-code config is a no-op and does not create a config file", async () => {
    await using project = await tmpdir()
    const configPath = path.join(project.path, ".altimate-code/altimate-code.json")
    await writeJson(path.join(project.path, ".vscode/mcp.json"), {
      servers: {
        datamate: {
          url: "https://datamate.example.com/sse",
          updatedAt: "2026-06-17T10:00:00.000Z",
        },
      },
    })

    await expect(syncDatamateUrlFromVscodeMcp(project.path)).resolves.toEqual([])
    await expect(readFile(configPath, "utf-8")).rejects.toThrow()
  })
})

describe("PR #893 /mcps and installer static safety checks", () => {
  test("mcp_discover tool redacts discovered URLs, args, and session-only RPC env before persisting", async () => {
    const source = await readFile(
      path.join(REPO_ROOT, "packages/opencode/src/altimate/tools/mcp-discover.ts"),
      "utf-8",
    )

    expect(source).toContain("function safeDetail")
    expect(source).toContain('if (server.type === "remote") return "(remote)"')
    expect(source).toContain("server.command[0]")
    expect(source).toContain("ALTIMATE_EXTENSION_RPC")
    expect(source).toContain("stripSessionEnv(discovered[name])")
    expect(source).toContain("enabled: true")
    expect(source).not.toContain("server.url")
    expect(source).not.toContain("server.command.join")
  })

  test("enabled-state persistence reads all config paths and rewrites only the matching MCP entry", async () => {
    const source = await readFile(path.join(REPO_ROOT, "packages/opencode/src/mcp/index.ts"), "utf-8")

    expect(source).toContain("let persistChain: Promise<void> = Promise.resolve()")
    expect(source).toContain("findAllConfigPaths(Instance.directory, Global.Path.config)")
    expect(source).toContain("readMcpEntryFromDisk(name, p)")
    expect(source).toContain("{ ...entry, enabled }")
    expect(source).toContain("await persistMcpEnabled(name, true)")
    expect(source).toContain("await persistMcpEnabled(name, false)")
  })

  test("install.ps1 remains static-analysis friendly and does not use npm/node execution paths", async () => {
    const ps1 = await readFile(path.join(REPO_ROOT, "install.ps1"), "utf-8")

    expect(ps1).toContain("github.com/AltimateAI/altimate-code/releases")
    expect(ps1).toContain("Expand-Archive")
    expect(ps1).toContain("IsProcessorFeaturePresent(40)")
    expect(ps1).toContain("PROCESSOR_ARCHITEW6432")
    expect(ps1).not.toContain("npm install -g @altimateai")
    expect(ps1).not.toMatch(/\bnode\s+/i)
  })
})
