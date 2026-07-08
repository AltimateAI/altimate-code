import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ConfigPaths } from "../../../src/config/paths"
import { discoverExternalMcp } from "../../../src/mcp/discover"
import { McpCatalog } from "../../../src/mcp/catalog"

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..", "..")
const opencodeRoot = path.join(repoRoot, "packages", "opencode")
const srcDir = path.join(opencodeRoot, "src")

async function readSrc(...rel: string[]) {
  return fs.readFile(path.join(srcDir, ...rel), "utf-8")
}

async function withTempDiscovery<T>(fn: (project: string, home: string) => Promise<T>) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "upi-mcp-project-"))
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "upi-mcp-home-"))
  const realHomedir = os.homedir
  const envSnapshot = { ...process.env }
  ;(os as any).homedir = () => home
  try {
    return await fn(project, home)
  } finally {
    ;(os as any).homedir = realHomedir
    process.env = envSnapshot
    await fs.rm(project, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  }
}

describe("UPI-22 and UPI-24 config env grammar and external MCP discovery", () => {
  test("resolveEnvVarsInString resolves env/default/legacy refs exactly once and preserves escapes", () => {
    const previous = process.env.UPI_TOKEN
    process.env.UPI_TOKEN = "secret-${NESTED}"
    try {
      const stats = ConfigPaths.newEnvSubstitutionStats()
      const result = ConfigPaths.resolveEnvVarsInString(
        "a=${UPI_TOKEN} b=${UPI_MISSING:-fallback} c={env:UPI_TOKEN} d=$${UPI_TOKEN} e=${UPI_MISSING}",
        stats,
      )

      expect(result).toBe("a=secret-${NESTED} b=fallback c=secret-${NESTED} d=${UPI_TOKEN} e=")
      expect(stats.dollarRefs).toBe(3)
      expect(stats.dollarDefaulted).toBe(1)
      expect(stats.dollarEscaped).toBe(1)
      expect(stats.legacyBraceRefs).toBe(1)
      expect(stats.unresolvedNames).toEqual(["UPI_MISSING"])
    } finally {
      if (previous === undefined) delete process.env.UPI_TOKEN
      else process.env.UPI_TOKEN = previous
    }
  })

  test("project-scoped discovered local servers default disabled and do not resolve command args", async () => {
    await withTempDiscovery(async (project) => {
      process.env.MCP_TOKEN = "secret"
      await fs.mkdir(path.join(project, ".vscode"), { recursive: true })
      await fs.writeFile(
        path.join(project, ".vscode", "mcp.json"),
        JSON.stringify({
          servers: {
            datamate: {
              command: "npx",
              args: ["${MCP_TOKEN}", null, 123],
              env: {
                TOKEN: "${MCP_TOKEN}",
                DEFAULTED: "${MISSING_TOKEN:-fallback}",
                ESCAPED: "$${MCP_TOKEN}",
              },
              enabled: true,
            },
          },
        }),
      )

      const result = await discoverExternalMcp(project)
      expect(result.servers.datamate).toEqual({
        type: "local",
        command: ["npx", "${MCP_TOKEN}", "123"],
        environment: { TOKEN: "secret", DEFAULTED: "fallback", ESCAPED: "${MCP_TOKEN}" },
        enabled: false,
      })
    })
  })

  test("IDE precedence is stable, first source wins, and prototype-polluting names are ignored", async () => {
    await withTempDiscovery(async (project) => {
      await fs.mkdir(path.join(project, ".vscode"), { recursive: true })
      await fs.mkdir(path.join(project, ".cursor"), { recursive: true })
      await fs.writeFile(
        path.join(project, ".vscode", "mcp.json"),
        JSON.stringify({ servers: { dupe: { command: "vscode" }, __proto__: { command: "pollute" } } }),
      )
      await fs.writeFile(
        path.join(project, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { dupe: { command: "cursor" }, constructor: { command: "pollute" } } }),
      )

      const result = await discoverExternalMcp(project)
      expect(result.sources.slice(0, 2)).toEqual([".vscode/mcp.json"])
      expect(result.servers.dupe).toMatchObject({ type: "local", command: ["vscode"], enabled: false })
      expect(Object.keys(result.servers)).toEqual(["dupe"])
      expect(({} as any).pollute).toBeUndefined()
    })
  })

  test("remote MCP headers resolve env refs while project-scoped remotes stay disabled", async () => {
    await withTempDiscovery(async (project) => {
      process.env.MCP_TOKEN = "secret"
      await fs.mkdir(path.join(project, ".cursor"), { recursive: true })
      await fs.writeFile(
        path.join(project, ".cursor", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            remote: {
              url: "https://example.com/mcp",
              headers: { Authorization: "Bearer ${MCP_TOKEN}" },
              timeout: 5000,
            },
          },
        }),
      )

      const result = await discoverExternalMcp(project)
      expect(result.servers.remote).toEqual({
        type: "remote",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer secret" },
        timeout: 5000,
        enabled: false,
      })
    })
  })

  test("recursive MCP discovery ignores dependency and build output directories", async () => {
    await withTempDiscovery(async (project) => {
      await fs.mkdir(path.join(project, "node_modules", "pkg"), { recursive: true })
      await fs.mkdir(path.join(project, "build", "generated"), { recursive: true })
      await fs.mkdir(path.join(project, "tools"), { recursive: true })
      await fs.writeFile(
        path.join(project, "node_modules", "pkg", "mcp.json"),
        JSON.stringify({ servers: { bad_node_modules: { command: "bad" } } }),
      )
      await fs.writeFile(
        path.join(project, "build", "generated", "mcp.json"),
        JSON.stringify({ servers: { bad_build: { command: "bad" } } }),
      )
      await fs.writeFile(
        path.join(project, "tools", "mcp.json"),
        JSON.stringify({ servers: { good: { command: "ok" } } }),
      )

      const result = await discoverExternalMcp(project)
      expect(Object.keys(result.servers)).toEqual(["good"])
    })
  })
})

describe("UPI-25 through UPI-27 MCP persistence, names, pagination, and resource safety", () => {
  test("MCP tool names sanitize deterministically for unsafe client/tool names", () => {
    expect(McpCatalog.sanitize("client.name/one")).toBe("client_name_one")
    expect(McpCatalog.sanitize("mcp__already-safe")).toBe("mcp__already-safe")
    expect(McpCatalog.sanitize(" spaced name ")).toBe("_spaced_name_")
  })

  test("MCP pagination rejects duplicate cursors instead of looping forever", async () => {
    let calls = 0
    await expect(
      McpCatalog.paginate(
        async () => {
          calls++
          return { nextCursor: "same", items: [calls] }
        },
        (result) => result.items,
      ),
    ).rejects.toThrow(/duplicate cursor: same/)
    expect(calls).toBe(2)
  })

  test("config load normalizes mcpServers to mcp and preserves updatedAt without forcing update writes", async () => {
    const source = await readSrc("config", "config.ts")
    const normalizeBody = source.slice(source.indexOf("function normalizeMcpConfig"), source.indexOf("function normalizeLoadedConfig"))

    expect(normalizeBody).toContain('if ("mcpServers" in result)')
    expect(normalizeBody).toContain("delete result.mcpServers")
    expect(normalizeBody).toContain("transformed.updatedAt = entry.updatedAt")
    expect(source).toContain("This prevents disk mutation when configs are written back via updateGlobal().")
  })

  test("MCP enabled-state writes are serialized and Datamate reload bypasses stale Config singleton", async () => {
    const mcpSource = await readSrc("mcp", "index.ts")
    const serverSource = await readSrc("server", "server.ts")

    expect(mcpSource).toContain("let persistChain: Promise<void> = Promise.resolve()")
    expect(mcpSource).toContain("persistChain.then(() =>")
    expect(mcpSource).toContain("persistChain = run.catch(() => {})")
    expect(serverSource).toContain("Bypass Config.get() (stale singleton) by reading the file directly.")
    expect(serverSource).toContain("const freshEntry = await readMcpEntryFromDisk(name, configPath)")
    expect(serverSource).toContain("await MCP.add(name, freshEntry)")
  })
})
