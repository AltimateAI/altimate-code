// Wiring a datamate up as a live MCP server.
//
// Extracted from the `datamate_manager` tool's 'add' operation so the tool and the /datamates
// picker share one implementation. Server-only: it touches Instance and the live MCP registry, so
// it must not be imported from TUI-side plugin code (see ./datamate-config.ts for the reads that
// are safe there). The picker reaches this through POST /altimate/datamate/connect.
import { AltimateApi } from "./api/client"
import { MCP } from "../mcp"
import { addMcpToConfig, listMcpInConfig, resolveConfigPath } from "../mcp/config"
import { Instance } from "../project/instance"
import { Global } from "../global"
import { Log } from "@/altimate/util/log"
import { DATAMATE_KEY, readDatamateTransportFromIde } from "./datamate-transport"
import { slugify } from "./datamate-config"

const log = Log.create({ service: "datamate" })

/** Project root for config resolution — falls back to cwd when no git repo is detected. */
export function projectRoot() {
  const wt = Instance.worktree
  return wt === "/" ? Instance.directory : wt
}

type McpServerStatus = Awaited<ReturnType<typeof MCP.status>>[string]

export type DatamateConnectResult = {
  /**
   * `already-connected` — the server was in config and live, nothing changed.
   * `connected` — wired and the connection came up.
   * `pending` — written to config but the connection has not come up yet.
   */
  status: "already-connected" | "connected" | "pending"
  datamateId: string
  datamateName: string
  /** MCP server name the datamate is wired under — DATAMATE_KEY in gateway mode. */
  serverName: string
  /** True when an IDE/extension datamate entry supplied the transport. */
  gateway: boolean
  /** Tools the server exposes; 0 unless the connection is up. */
  toolCount: number
  /** Config file the entry lives in. */
  configPath: string
  /** Live MCP status, carried for the `pending` case so callers can explain the stall. */
  mcpStatus?: McpServerStatus
  /** Per-datamate entries left over alongside the gateway — worth cleaning up. */
  staleEntries: string[]
}

/**
 * Wire a datamate as an MCP server: resolve its transport, persist the config entry, and connect.
 *
 * When an IDE MCP config has a "datamate" entry (written by VS Code, Cursor, etc.) the server name
 * is always DATAMATE_KEY regardless of which datamate was chosen — the extension's gateway already
 * serves every datamate's tools over one connection, and a per-datamate entry would duplicate the
 * whole tool set. `name` is honored only in standalone mode.
 *
 * Throws on any API/config failure; callers format the error for their surface.
 */
export async function connectDatamate(input: {
  datamateId: string
  name?: string
  scope?: "project" | "global"
}): Promise<DatamateConnectResult> {
  const datamate = await AltimateApi.getDatamate(input.datamateId)
  // readDatamateTransportFromIde returns the exact command from the IDE config so we
  // reuse the same process the extension already manages, not a second one.
  const transport = await readDatamateTransportFromIde(projectRoot())

  if (transport !== null) {
    log.info("connectDatamate: IDE transport detected, entering single-gateway mode", {
      serverName: DATAMATE_KEY,
      transportType: transport.type,
    })
  } else {
    log.info("connectDatamate: no IDE transport found, using standalone cloud config")
  }

  const serverName = transport !== null ? DATAMATE_KEY : (input.name ?? `datamate-${slugify(datamate.name)}`)

  const creds = transport ? undefined : await AltimateApi.getCredentials()
  const mcpConfig =
    transport?.type === "remote"
      ? { type: "remote" as const, url: transport.url }
      : transport?.type === "local"
        ? // Use the exact command from the IDE config so we reuse the process the
          // extension manages rather than spawning a second one. The extension and
          // altimate-code would otherwise maintain two separate stdio child processes
          // connected to the same datamate binary, wasting resources.
          { type: "local" as const, command: transport.command }
        : AltimateApi.buildMcpConfig(creds!, input.datamateId)

  const isGlobal = input.scope === "global"
  const configPath = await resolveConfigPath(isGlobal ? Global.Path.config : projectRoot(), isGlobal)

  const base = {
    datamateId: input.datamateId,
    datamateName: datamate.name,
    serverName,
    gateway: transport !== null,
    configPath,
  }

  let staleEntries: string[] = []

  if (transport !== null) {
    const existingNames = await listMcpInConfig(configPath)
    staleEntries = existingNames.filter((n) => n !== DATAMATE_KEY && n.startsWith("datamate-"))
    if (staleEntries.length > 0) {
      log.info("connectDatamate: stale per-datamate entries detected alongside extension gateway", {
        staleEntries,
      })
    }

    if (existingNames.includes(DATAMATE_KEY)) {
      const allStatus = await MCP.status()
      if (allStatus[DATAMATE_KEY]?.status === "connected") {
        log.info("connectDatamate: already connected, skipping add", { serverName: DATAMATE_KEY })
        return {
          ...base,
          status: "already-connected",
          toolCount: await countTools(DATAMATE_KEY + "_"),
          staleEntries,
        }
      }
      // In config but not connected — reconnect via MCP.connect() so persistMcpEnabled
      // is called and the enabled:true state survives the next session restart.
      // MCP.add() skips persistMcpEnabled, so a session that had the server disabled
      // would not re-enable it on the next restart.
      log.info("connectDatamate: reconnecting existing datamate entry", { serverName: DATAMATE_KEY })
      await MCP.connect(DATAMATE_KEY)
    } else {
      log.info("connectDatamate: adding new datamate entry", { serverName: DATAMATE_KEY, type: mcpConfig.type })
      await addMcpToConfig(DATAMATE_KEY, { ...mcpConfig, enabled: true }, configPath)
      await MCP.add(DATAMATE_KEY, mcpConfig)
    }
  } else {
    log.info("connectDatamate: standalone mode, adding per-datamate entry", {
      serverName,
      type: mcpConfig.type,
    })
    await addMcpToConfig(serverName, { ...mcpConfig, enabled: true }, configPath)
    await MCP.add(serverName, mcpConfig)
  }

  const allStatus = await MCP.status()
  const mcpStatus = allStatus[serverName]
  if (mcpStatus?.status !== "connected") {
    return { ...base, status: "pending", toolCount: 0, mcpStatus, staleEntries }
  }

  return {
    ...base,
    status: "connected",
    toolCount: await countTools(serverName.replace(/[^a-zA-Z0-9_-]/g, "_")),
    staleEntries,
  }
}

async function countTools(prefix: string): Promise<number> {
  const mcpTools = await MCP.tools()
  return Object.keys(mcpTools).filter((k) => k.startsWith(prefix)).length
}
