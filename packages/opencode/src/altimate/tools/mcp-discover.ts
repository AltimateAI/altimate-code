import z from "zod"
import { Tool } from "../../tool/tool"
import { discoverExternalMcp } from "../../mcp/discover"
import { resolveConfigPath, addMcpToConfig, findAllConfigPaths, listMcpInConfig } from "../../mcp/config"
import { Instance } from "../../project/instance"
import { Global } from "../../global"

/**
 * Check which MCP server names are permanently configured on disk
 * (as opposed to ephemeral auto-discovered servers in memory).
 */
async function getPersistedMcpNames(): Promise<Set<string>> {
  const configPaths = await findAllConfigPaths(Instance.worktree, Global.Path.config)
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
  if (server.type === "local" && Array.isArray(server.command) && server.command.length > 0) {
    // Show only the executable name, not args (which may contain credentials)
    return `(local: ${server.command[0]})`
  }
  return `(${server.type})`
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
    const { servers: discovered } = await discoverExternalMcp(Instance.worktree)
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
      useGlobal ? Global.Path.config : Instance.worktree,
      useGlobal,
    )

    for (const name of toAdd) {
      await addMcpToConfig(name, discovered[name], configPath)
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
