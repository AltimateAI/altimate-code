import z from "zod"
import { Tool } from "../../tool/tool"
import { AltimateApi } from "../api/client"
import { MCP } from "../../mcp"
import {
  addMcpToConfig,
  removeMcpFromConfig,
  listMcpInConfig,
  resolveConfigPath,
  findAllConfigPaths,
} from "../../mcp/config"
import { Instance } from "../../project/instance"
import { Global } from "../../global"
import { Log } from "@/altimate/util/log"
import { DATAMATE_KEY, readDatamateTransportFromIde } from "../datamate-transport"
// altimate_change - workspace mode owns the datamate key
import { managedWorkspaceLoaded } from "../workspace/engine-overlay"

const log = Log.create({ service: "datamate" })

/** Project root for config resolution — falls back to cwd when no git repo is detected. */
function projectRoot() {
  const wt = Instance.worktree
  return wt === "/" ? Instance.directory : wt
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

// Scans .vscode/mcp.json, .cursor/mcp.json, .github/copilot/mcp.json in projectRootDir
// so this works in Cursor, Copilot, and other IDEs that write their own MCP config file.
// Returns the exact command from the IDE config so altimate-code reuses the same process
// the extension already manages rather than spawning a second one.

export const DatamateManagerTool = Tool.define("datamate_manager", {
  description:
    "Manage Altimate Datamates — AI teammates with integrations (Snowflake, Jira, dbt, etc). " +
    "Operations: 'list' shows available datamates from the Altimate API, " +
    "'list-integrations' shows available integrations and their tools/capabilities, " +
    "'add' connects one as an MCP server and saves to config, " +
    "'create' creates a new datamate then connects it (use 'list-integrations' first to find integration IDs), " +
    "'edit' updates a datamate's config on the API, " +
    "'delete' permanently removes a datamate from the API, " +
    "'status' shows active datamate MCP servers in this session, " +
    "'remove' disconnects a datamate MCP server and removes it from config, " +
    "'list-config' shows all datamate entries saved in config files (project and global). " +
    "Config files: project config is at <project-root>/altimate-code.json, " +
    "global config is at ~/.config/altimate-code/altimate-code.json. " +
    "When a VS Code extension datamate entry exists (.vscode/mcp.json has 'datamate' key), " +
    "'add' always uses the server name 'datamate' — tools are then prefixed 'datamate_'. " +
    "In standalone mode, server names follow 'datamate-<name>' pattern. " +
    "Do NOT use glob/grep/read to find config files — use 'list-config' instead.",
  parameters: z.object({
    operation: z.enum(["list", "list-integrations", "add", "create", "edit", "delete", "status", "remove", "list-config"]),
    datamate_id: z.string().optional().describe("Datamate ID (required for 'add', 'edit', 'delete')"),
    name: z.string().optional().describe("Server name override for 'add', or name for 'create'/'edit'"),
    description: z.string().optional().describe("Description (for 'create'/'edit')"),
    integration_ids: z.array(z.string()).optional().describe("Integration IDs (for 'create'/'edit')"),
    memory_enabled: z.boolean().optional().describe("Enable memory (for 'create'/'edit')"),
    privacy: z.string().optional().describe("Privacy setting: 'private' or 'public' (for 'create'/'edit')"),
    scope: z
      .enum(["project", "global"])
      .optional()
      .describe(
        "Where to save/remove MCP config: 'project' (altimate-code.json in project root) or 'global' (~/.config/altimate-code/altimate-code.json). Ask the user which they prefer. Defaults to 'project'.",
      ),
    server_name: z
      .string()
      .optional()
      .describe("Server name to remove (for 'remove'). Use 'list-config' or 'status' to find names."),
  }),
  async execute(args): Promise<{ title: string; metadata: Record<string, unknown>; output: string }> {
    if (args.operation !== "status" && args.operation !== "list-config") {
      const configured = await AltimateApi.isConfigured()
      if (!configured) {
        return {
          title: "Datamate: not configured",
          metadata: {},
          output:
            "Altimate credentials not found at ~/.altimate/altimate.json.\n\nUse the /altimate-setup skill to configure your credentials.",
        }
      }
    }

    switch (args.operation) {
      case "list":
        return handleList()
      case "list-integrations":
        return handleListIntegrations()
      case "add":
        return handleAdd(args)
      case "create":
        return handleCreate(args)
      case "edit":
        return handleEdit(args)
      case "delete":
        return handleDelete(args)
      case "status":
        return handleStatus()
      case "remove":
        return handleRemove(args)
      case "list-config":
        return handleListConfig()
    }
  },
})

async function handleList() {
  try {
    const datamates = await AltimateApi.listDatamates()
    if (datamates.length === 0) {
      return {
        title: "Datamates: none found",
        metadata: { count: 0 },
        output: "No datamates found. Use operation 'create' to create one.",
      }
    }
    const lines = ["ID | Name | Description | Integrations | Privacy", "---|------|-------------|--------------|--------"]
    for (const d of datamates) {
      const integrations = d.integrations?.map((i: { id: string }) => i.id).join(", ") ?? "none"
      lines.push(`${d.id} | ${d.name} | ${d.description ?? "-"} | ${integrations} | ${d.privacy ?? "-"}`)
    }
    return {
      title: `Datamates: ${datamates.length} found`,
      metadata: { count: datamates.length },
      output: lines.join("\n"),
    }
  } catch (e) {
    return {
      title: "Datamates: ERROR",
      metadata: {},
      output: `Failed to list datamates: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

async function handleListIntegrations() {
  try {
    const catalog = await AltimateApi.listIntegrations()
    // altimate_change start — extension-type integrations are RPC into a live VS
    // Code host and cannot work from the CLI. Hide them from this surface (the
    // workspace UI still offers them) and say how many were hidden.
    const integrations = catalog.filter((i) => i.type !== "extension")
    const hidden = catalog.length - integrations.length
    const omitted =
      hidden > 0
        ? `${hidden} extension-type integration${hidden === 1 ? " was" : "s were"} omitted — they require a live VS Code bridge and are not available from the CLI.`
        : ""
    if (integrations.length === 0) {
      return {
        title: hidden > 0 ? `Integrations: none available on the CLI (${hidden} hidden)` : "Integrations: none found",
        metadata: { count: 0, hidden },
        output: omitted ? `No integrations available. ${omitted}` : "No integrations available.",
      }
    }
    // altimate_change end
    const lines = ["ID | Name | Tools", "---|------|------"]
    for (const i of integrations) {
      const tools = i.tools?.map((t) => t.key).join(", ") ?? "none"
      lines.push(`${i.id} | ${i.name} | ${tools}`)
    }
    // altimate_change start
    if (omitted) lines.push("", `(${omitted})`)
    // altimate_change end
    return {
      title: `Integrations: ${integrations.length} available`,
      metadata: { count: integrations.length, hidden },
      output: lines.join("\n"),
    }
  } catch (e) {
    return {
      title: "Integrations: ERROR",
      metadata: {},
      output: `Failed to list integrations: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

// DATAMATE_KEY is imported from altimate/datamate-transport.ts (shared constant).

async function handleAdd(args: { datamate_id?: string; name?: string; scope?: "project" | "global" }) {
  if (!args.datamate_id) {
    return {
      title: "Datamate add: FAILED",
      metadata: {},
      output: "Missing required parameter 'datamate_id'. Use 'list' first to see available datamates.",
    }
  }
  try {
    // readDatamateTransportFromIde returns the exact command from the IDE config so we
    // reuse the same process the extension already manages, not a second one.
    const transport = await readDatamateTransportFromIde(projectRoot())

    // altimate_change start — in workspace mode the shared `datamate` key is the
    // bound workspace's own engine, derived at config load. With an IDE transport
    // the add would go under that key; refuse and say why, before anything is
    // looked up — the refusal must not depend on the API being reachable.
    // Standalone `datamate-<name>` entries are a different key and stay the user's.
    const managed = transport !== null ? await managedWorkspaceLoaded() : null
    if (managed) {
      return {
        title: `Datamate add: '${DATAMATE_KEY}' is managed by workspace "${managed.name}"`,
        metadata: { serverName: DATAMATE_KEY, managedBy: managed.id, datamateId: args.datamate_id },
        output:
          `This project is linked to workspace "${managed.name}", whose integrations are served by the ` +
          `workspace's own engine under the '${DATAMATE_KEY}' MCP server. Adding datamate '${args.datamate_id}' ` +
          `there is not applied. Unlink the project, or run without ALTIMATE_WORKSPACE, to manage that entry by hand.`,
      }
    }
    // altimate_change end

    const datamate = await AltimateApi.getDatamate(args.datamate_id)

    if (transport !== null) {
      log.info("handleAdd: IDE transport detected, entering single-gateway mode", {
        serverName: DATAMATE_KEY,
        transportType: transport.type,
      })
    } else {
      log.info("handleAdd: no IDE transport found, using standalone cloud config")
    }

    // If an IDE MCP config has a "datamate" entry (written by VS Code, Cursor, etc.),
    // always use DATAMATE_KEY ("datamate") as the server name regardless
    // of which specific datamate the user selected. This prevents duplicate tool sets
    // — the extension's gateway already serves all datamate tools through a single
    // MCP connection.
    // In standalone/CLI mode (no IDE datamate entry), fall back to per-datamate naming
    // with cloud URL.
    const serverName = transport !== null
      ? DATAMATE_KEY
      : (args.name ?? `datamate-${slugify(datamate.name)}`)

    const creds = transport ? undefined : await AltimateApi.getCredentials()
    const mcpConfig =
      transport?.type === "remote"
        ? { type: "remote" as const, url: transport.url }
        : transport?.type === "local"
          // Use the exact command from the IDE config so we reuse the process the
          // extension manages rather than spawning a second one. The extension and
          // altimate-code would otherwise maintain two separate stdio child processes
          // connected to the same datamate binary, wasting resources.
          ? { type: "local" as const, command: transport.command }
          : AltimateApi.buildMcpConfig(creds!, args.datamate_id)

    const isGlobal = args.scope === "global"
    const configPath = await resolveConfigPath(isGlobal ? Global.Path.config : projectRoot(), isGlobal)

    if (transport !== null) {
      // IDE/extension mode: check if DATAMATE_KEY is already wired up
      const existingNames = await listMcpInConfig(configPath)
      const staleEntries = existingNames.filter(
        (n) => n !== DATAMATE_KEY && n.startsWith("datamate-"),
      )
      if (staleEntries.length > 0) {
        log.info("handleAdd: stale per-datamate entries detected alongside extension gateway", {
          staleEntries,
        })
      }

      if (existingNames.includes(DATAMATE_KEY)) {
        // Already in config — just ensure it is connected in this session
        const allStatus = await MCP.status()
        if (allStatus[DATAMATE_KEY]?.status === "connected") {
          log.info("handleAdd: already connected, skipping add", {
            serverName: DATAMATE_KEY,
          })
          const mcpTools = await MCP.tools()
          const toolCount = Object.keys(mcpTools).filter((k) =>
            k.startsWith(DATAMATE_KEY + "_"),
          ).length
          const staleNote =
            staleEntries.length > 0
              ? `\n\nNote: stale per-datamate entries found in config: ${staleEntries.join(", ")} — use operation 'remove' to clean them up.`
              : ""
          return {
            title: `Datamate '${datamate.name}': already connected via '${DATAMATE_KEY}'`,
            metadata: { serverName: DATAMATE_KEY, datamateId: args.datamate_id, toolCount },
            output: `Datamate tools are already available via the '${DATAMATE_KEY}' MCP server (${toolCount} tools active).${staleNote}`,
          }
        }
        // In config but not connected — reconnect via MCP.connect() so persistMcpEnabled
        // is called and the enabled:true state survives the next session restart.
        // Bug-fix: was previously MCP.add() which skips persistMcpEnabled, so a session
        // that had the server disabled would not re-enable it on the next restart.
        log.info("handleAdd: reconnecting existing datamate entry", {
          serverName: DATAMATE_KEY,
        })
        await MCP.connect(DATAMATE_KEY)
      } else {
        // Not in config yet — write to disk then connect
        log.info("handleAdd: adding new datamate entry", {
          serverName: DATAMATE_KEY,
          type: mcpConfig.type,
        })
        await addMcpToConfig(DATAMATE_KEY, { ...mcpConfig, enabled: true }, configPath)
        await MCP.add(DATAMATE_KEY, mcpConfig)
      }
    } else {
      // Standalone/CLI mode — original behaviour: per-datamate name + cloud URL
      log.info("handleAdd: standalone mode, adding per-datamate entry", {
        serverName,
        type: mcpConfig.type,
      })
      await addMcpToConfig(serverName, { ...mcpConfig, enabled: true }, configPath)
      await MCP.add(serverName, mcpConfig)
    }

    // Check connection status
    const allStatus = await MCP.status()
    const serverStatus = allStatus[serverName]
    const connected = serverStatus?.status === "connected"

    if (!connected) {
      return {
        title: `Datamate '${datamate.name}': saved (connection pending)`,
        metadata: { serverName, datamateId: args.datamate_id, configPath, status: serverStatus },
        output: `Saved datamate '${datamate.name}' (ID: ${args.datamate_id}) as MCP server '${serverName}' to ${configPath}.\n\nConnection status: ${serverStatus?.status ?? "unknown"}${serverStatus && "error" in serverStatus ? ` — ${serverStatus.error}` : ""}.\nIt will auto-connect on next session start.`,
      }
    }

    // Get tool count from the newly connected server
    const mcpTools = await MCP.tools()
    const toolCount = Object.keys(mcpTools).filter((k) =>
      k.startsWith(serverName.replace(/[^a-zA-Z0-9_-]/g, "_")),
    ).length

    return {
      title: `Datamate '${datamate.name}': connected as '${serverName}'`,
      metadata: { serverName, datamateId: args.datamate_id, toolCount, configPath },
      output: `Connected datamate '${datamate.name}' (ID: ${args.datamate_id}) as MCP server '${serverName}'.\n\n${toolCount} tools are now available. They will be usable in the next message.\n\nConfiguration saved to ${configPath} for future sessions.`,
    }
  } catch (e) {
    return {
      title: "Datamate add: ERROR",
      metadata: {},
      output: `Failed to add datamate: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

async function handleCreate(args: {
  name?: string
  description?: string
  integration_ids?: string[]
  memory_enabled?: boolean
  privacy?: string
  scope?: "project" | "global"
}) {
  if (!args.name) {
    return {
      title: "Datamate create: FAILED",
      metadata: {},
      output: "Missing required parameter 'name'.",
    }
  }
  try {
    // altimate_change start — with an IDE transport the add that follows would go
    // under the shared `datamate` key; in workspace mode that add is refused, so
    // refuse here before creating an API datamate nothing would connect to.
    if ((await readDatamateTransportFromIde(projectRoot())) !== null) {
      const managedKey = await managedWorkspaceLoaded()
      if (managedKey) {
        return {
          title: `Datamate create: '${DATAMATE_KEY}' is managed by workspace "${managedKey.name}"`,
          metadata: { serverName: DATAMATE_KEY, managedBy: managedKey.id },
          output:
            `This project is linked to workspace "${managedKey.name}", whose integrations are served by the ` +
            `workspace's own engine under the '${DATAMATE_KEY}' MCP server. Creating datamate '${args.name}' ` +
            `here would not connect it. Unlink the project, or run without ALTIMATE_WORKSPACE, first.`,
        }
      }
    }
    // altimate_change end
    const integrations = args.integration_ids
      ? await AltimateApi.resolveIntegrations(args.integration_ids)
      : undefined
    const created = await AltimateApi.createDatamate({
      name: args.name,
      description: args.description,
      integrations,
      memory_enabled: args.memory_enabled ?? true,
      privacy: args.privacy,
    })
    return handleAdd({ datamate_id: created.id, name: `datamate-${slugify(args.name)}`, scope: args.scope })
  } catch (e) {
    return {
      title: "Datamate create: ERROR",
      metadata: {},
      output: `Failed to create datamate: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

async function handleEdit(args: {
  datamate_id?: string
  name?: string
  description?: string
  integration_ids?: string[]
  memory_enabled?: boolean
  privacy?: string
}) {
  if (!args.datamate_id) {
    return {
      title: "Datamate edit: FAILED",
      metadata: {},
      output: "Missing required parameter 'datamate_id'. Use 'list' first to see available datamates.",
    }
  }
  try {
    const integrations = args.integration_ids
      ? await AltimateApi.resolveIntegrations(args.integration_ids)
      : undefined
    const updated = await AltimateApi.updateDatamate(args.datamate_id, {
      name: args.name,
      description: args.description,
      integrations,
      memory_enabled: args.memory_enabled,
      privacy: args.privacy,
    })
    return {
      title: `Datamate '${updated.name}': updated`,
      metadata: { datamateId: args.datamate_id },
      output: `Updated datamate '${updated.name}' (ID: ${args.datamate_id}).\n\nIf this datamate is connected as an MCP server, use 'remove' then 'add' to refresh the connection with the new config.`,
    }
  } catch (e) {
    return {
      title: "Datamate edit: ERROR",
      metadata: {},
      output: `Failed to edit datamate: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

async function handleDelete(args: { datamate_id?: string }) {
  if (!args.datamate_id) {
    return {
      title: "Datamate delete: FAILED",
      metadata: {},
      output: "Missing required parameter 'datamate_id'. Use 'list' first to see available datamates.",
    }
  }
  try {
    const datamate = await AltimateApi.getDatamate(args.datamate_id)
    await AltimateApi.deleteDatamate(args.datamate_id)

    // Disconnect the specific MCP server for this datamate (not all datamate- servers)
    const serverName = `datamate-${slugify(datamate.name)}`
    const allStatus = await MCP.status()
    const disconnected: string[] = []
    if (serverName in allStatus) {
      try {
        // altimate_change start — MCP.remove (was disconnect): the datamate is deleted, so fully
        // remove its MCP server from runtime state + publish ToolsChanged so the agent's tool list
        // refreshes. disconnect alone left a stale "disabled" entry and skipped the refresh.
        await MCP.remove(serverName)
        // altimate_change end
        disconnected.push(serverName)
      } catch {
        // Log but don't fail the delete operation
      }
    }

    // Remove from all config files
    const configPaths = await findAllConfigPaths(projectRoot(), Global.Path.config)
    const removedFrom: string[] = []
    for (const configPath of configPaths) {
      if (await removeMcpFromConfig(serverName, configPath)) {
        removedFrom.push(configPath)
      }
    }

    const parts = [`Deleted datamate '${datamate.name}' (ID: ${args.datamate_id}).`]
    if (disconnected.length > 0) {
      parts.push(`Disconnected servers: ${disconnected.join(", ")}.`)
    }
    if (removedFrom.length > 0) {
      parts.push(`Removed from config: ${removedFrom.join(", ")}.`)
    } else {
      parts.push("No config entries found to remove.")
    }

    return {
      title: `Datamate '${datamate.name}': deleted`,
      metadata: { datamateId: args.datamate_id, disconnected, removedFrom },
      output: parts.join("\n"),
    }
  } catch (e) {
    return {
      title: "Datamate delete: ERROR",
      metadata: {},
      output: `Failed to delete datamate: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

async function handleStatus() {
  try {
    const allStatus = await MCP.status()
    const datamateEntries = Object.entries(allStatus).filter(([name]) => name.startsWith("datamate-"))
    if (datamateEntries.length === 0) {
      return {
        title: "Datamate servers: none active",
        metadata: { count: 0 },
        output:
          "No datamate MCP servers active in this session.\n\nUse 'list' then 'add' to connect a datamate, or 'list-config' to see saved configs.",
      }
    }
    const lines = ["Server | Status", "-------|-------"]
    for (const [name, s] of datamateEntries) {
      lines.push(`${name} | ${s.status}`)
    }
    return {
      title: `Datamate servers: ${datamateEntries.length} active`,
      metadata: { count: datamateEntries.length },
      output: lines.join("\n"),
    }
  } catch (e) {
    return {
      title: "Datamate status: ERROR",
      metadata: {},
      output: `Failed to get status: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

async function handleRemove(args: { server_name?: string; scope?: "project" | "global" }) {
  if (!args.server_name) {
    return {
      title: "Datamate remove: FAILED",
      metadata: {},
      output:
        "Missing required parameter 'server_name'. Use 'status' to see active servers or 'list-config' to see saved configs.",
    }
  }
  try {
    // altimate_change start — the workspace-managed `datamate` key is not the
    // user's to remove either: it would stop the engine under a turn and delete
    // the entry that unlinking hands back. Standalone `datamate-<name>` entries
    // are unaffected.
    const managedKey = args.server_name === DATAMATE_KEY ? await managedWorkspaceLoaded() : null
    if (managedKey) {
      return {
        title: `Datamate remove: '${DATAMATE_KEY}' is managed by workspace "${managedKey.name}"`,
        metadata: { serverName: DATAMATE_KEY, managedBy: managedKey.id },
        output:
          `This project is linked to workspace "${managedKey.name}", whose integrations are served by the ` +
          `workspace's own engine under the '${DATAMATE_KEY}' MCP server. It is not removed. Unlink the project, ` +
          `or run without ALTIMATE_WORKSPACE, to manage that entry by hand.`,
      }
    }
    // altimate_change end
    // Fully remove from runtime state (disconnect + purge from MCP list)
    // altimate_change start — MCP.remove (was disconnect): delete the status entry + publish
    // ToolsChanged so the removed server's tools stop being offered without a restart.
    await MCP.remove(args.server_name).catch(() => {})
    // altimate_change end

    // Remove from config files — when no scope specified, try both to avoid orphaned entries
    const removed: string[] = []
    const scope = args.scope
    if (!scope || scope === "global") {
      const globalPath = await resolveConfigPath(Global.Path.config, true)
      if (await removeMcpFromConfig(args.server_name, globalPath)) {
        removed.push(globalPath)
      }
    }
    if (!scope || scope === "project") {
      const projectPath = await resolveConfigPath(projectRoot())
      if (await removeMcpFromConfig(args.server_name, projectPath)) {
        removed.push(projectPath)
      }
    }

    const configMsg =
      removed.length > 0
        ? `\n\nRemoved from config: ${removed.join(", ")}`
        : "\n\nNo config entries found to remove."

    return {
      title: `Datamate '${args.server_name}': removed`,
      metadata: { removedFromConfigs: removed },
      output: `Disconnected and removed MCP server '${args.server_name}'.${configMsg}`,
    }
  } catch (e) {
    return {
      title: "Datamate remove: ERROR",
      metadata: {},
      output: `Failed to remove: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

async function handleListConfig() {
  try {
    const configPaths = await findAllConfigPaths(projectRoot(), Global.Path.config)
    if (configPaths.length === 0) {
      return {
        title: "Datamate config: no config files found",
        metadata: {},
        output: `No config files found.\n\nProject config would be at: ${projectRoot()}/altimate-code.json\nGlobal config would be at: ${Global.Path.config}/altimate-code.json`,
      }
    }

    const lines: string[] = []
    let totalDatamates = 0

    for (const configPath of configPaths) {
      const mcpNames = await listMcpInConfig(configPath)
      const datamateNames = mcpNames.filter((name) => name.startsWith("datamate-"))
      const otherNames = mcpNames.filter((name) => !name.startsWith("datamate-"))

      lines.push(`**${configPath}**`)
      if (datamateNames.length > 0) {
        lines.push(`  Datamate servers: ${datamateNames.join(", ")}`)
        totalDatamates += datamateNames.length
      }
      if (otherNames.length > 0) {
        lines.push(`  Other MCP servers: ${otherNames.join(", ")}`)
      }
      if (mcpNames.length === 0) {
        lines.push("  No MCP entries")
      }
      lines.push("")
    }

    return {
      title: `Datamate config: ${totalDatamates} datamate(s) across ${configPaths.length} file(s)`,
      metadata: { configPaths, totalDatamates },
      output: lines.join("\n"),
    }
  } catch (e) {
    return {
      title: "Datamate config: ERROR",
      metadata: {},
      output: `Failed to read configs: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
