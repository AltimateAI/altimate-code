import z from "zod"
import { Tool } from "../../tool/tool"
import { discoverExternalMcp } from "../../mcp/discover"
import { resolveConfigPath, addMcpToConfig, findAllConfigPaths, listMcpInConfig } from "../../mcp/config"
import { Instance } from "../../project/instance"
import { Global } from "../../global"
import { MCP } from "../../mcp"

/**
 * Check which MCP server names are permanently configured on disk
 * (as opposed to ephemeral auto-discovered servers in memory).
 */
async function getPersistedMcpNames(): Promise<Set<string>> {
  const configPaths = await findAllConfigPaths(Instance.directory, Global.Path.config)
  const names = new Set<string>()
  for (const p of configPaths) {
    for (const name of await listMcpInConfig(p)) {
      names.add(name)
    }
  }
  return names
}

/** Redact server details for safe display — show type and name only, not commands/URLs */
function safeDetail(server: { type: string } & Record<string, any>): string {
  if (server.type === "remote") return "(remote)"
  if (server.type === "local") {
    // Show only the executable name, not args (which may contain credentials)
    if (Array.isArray(server.command) && server.command.length > 0) {
      return `(local: ${server.command[0]})`
    }
    if (typeof server.command === "string" && server.command.trim()) {
      return `(local: ${server.command.trim().split(/\s+/)[0]})`
    }
  }
  return `(${server.type})`
}

// discovered servers. ALTIMATE_EXTENSION_RPC is a Unix socket path that is
// unique to the current VS Code extension host process. Writing it to disk
// causes altimate-code on a future session (or a different VS Code window) to
// spawn datamate processes that connect to the wrong bridge or a dead socket.
// Stripping it forces runtime discovery via ~/.altimate/extension-rpc/ sidecars,
// which always resolves the correct live bridge by matching process.cwd() against
// each bridge's recorded workspaceFolders.
function stripSessionEnv(cfg: import("../../config/config").Config.Mcp): import("../../config/config").Config.Mcp {
  if (cfg.type !== "local" || !cfg.environment) return cfg
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { ALTIMATE_EXTENSION_RPC: _rpc, ...rest } = cfg.environment
  return { ...cfg, environment: Object.keys(rest).length > 0 ? rest : undefined }
}

export const McpDiscoverTool = Tool.define("mcp_discover", {
  description:
    "Discover MCP servers from external AI tool configs (VS Code, Cursor, Claude Code, Copilot, Gemini) and optionally add them to altimate-code config permanently.",
  parameters: z.object({
    action: z
      .enum(["list", "add"])
      .describe('"list" to show discovered servers, "add" to write them to config'),
    scope: z
      .enum(["project", "global"])
      .optional()
      .default("project")
      .describe('Where to write when action is "add". "project" = .altimate-code/altimate-code.json, "global" = ~/.config/opencode/'),
    servers: z
      .array(z.string())
      .optional()
      .describe('Server names to add. If omitted with action "add", adds all new servers.'),
  }),
  async execute(args, ctx) {
    const { servers: discovered } = await discoverExternalMcp(Instance.directory)
    const discoveredNames = Object.keys(discovered)

    if (discoveredNames.length === 0) {
      return {
        title: "MCP Discover: none found",
        metadata: { discovered: 0, new: 0, existing: 0, added: 0 },
        output:
          "No MCP servers found in external configs.\nChecked: .vscode/mcp.json, .cursor/mcp.json, .github/copilot/mcp.json, .mcp.json (project + home), .gemini/settings.json (project + home), ~/.claude.json",
      }
    }

    // Check what's actually persisted on disk, NOT the merged in-memory config
    const persistedNames = await getPersistedMcpNames()
    const newServers = discoveredNames.filter((n) => !persistedNames.has(n))
    const alreadyAdded = discoveredNames.filter((n) => persistedNames.has(n))

    // Build discovery report — redact details for security (no raw commands/URLs)
    const lines: string[] = []
    if (newServers.length > 0) {
      lines.push(`New servers (not yet in config):`)
      for (const name of newServers) {
        lines.push(`  - ${name} ${safeDetail(discovered[name])}`)
      }
    }
    if (alreadyAdded.length > 0) {
      lines.push(`\nAlready in config: ${alreadyAdded.join(", ")}`)
    }

    if (args.action === "list") {
      return {
        title: `MCP Discover: ${newServers.length} new, ${alreadyAdded.length} existing`,
        metadata: { discovered: discoveredNames.length, new: newServers.length, existing: alreadyAdded.length, added: 0 },
        output: lines.join("\n"),
      }
    }

    // action === "add"
    const toAdd = args.servers
      ? args.servers.filter((n) => newServers.includes(n))
      : newServers

    if (toAdd.length === 0) {
      return {
        title: "MCP Discover: nothing to add",
        metadata: { discovered: discoveredNames.length, new: newServers.length, existing: alreadyAdded.length, added: 0 },
        output: lines.join("\n") + "\n\nNo matching servers to add.",
      }
    }

    const useGlobal = args.scope === "global"
    const configPath = await resolveConfigPath(
      useGlobal ? Global.Path.config : Instance.directory,
      useGlobal,
    )

    for (const name of toAdd) {
      // strip the discovery-time  flag. Project-scoped discovery sets
      //  as a security default (no auto-connect until user approves).
      // When the user explicitly adds a server via this tool, it should be enabled.
      const { enabled: _discardEnabled, ...cfgToWrite } = stripSessionEnv(discovered[name]) as any
      await addMcpToConfig(name, { ...cfgToWrite, enabled: true, updatedAt: new Date().toISOString() } as import('../../config/config').Config.Mcp, configPath)
      // Connect immediately so /mcps reflects the server status in the current session
      // without requiring a restart.
      await MCP.connect(name)
    }

    lines.push(`\nAdded ${toAdd.length} server(s) to ${configPath}: ${toAdd.join(", ")}`)
    lines.push("These servers are already active in the current session via auto-discovery.")

    return {
      title: `MCP Discover: added ${toAdd.length} server(s)`,
      metadata: { discovered: discoveredNames.length, new: newServers.length, existing: alreadyAdded.length, added: toAdd.length },
      output: lines.join("\n"),
    }
  },
})
