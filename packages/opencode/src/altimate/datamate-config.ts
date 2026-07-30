// Config-level reads for datamate MCP entries.
//
// Deliberately free of `MCP` and `Instance` imports so this module is safe to load from the TUI
// main thread as well as the server: the TUI runs the plugin host in-process while the server
// lives in a Worker (cli/cmd/tui.ts), so TUI-side code has no Effect/Instance runtime and must
// not pull one in. Live wiring (MCP.add/connect) lives in ./datamate-connect.ts, server-only.
import { Global } from "../global"
import { findAllConfigPaths, listMcpInConfig, readMcpEntryFromDisk } from "../mcp/config"
import { DATAMATE_KEY } from "./datamate-transport"

/** Standalone-mode MCP server names are `datamate-<slug>`; the shared gateway is DATAMATE_KEY. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

export type WiredDatamates = {
  /**
   * Datamate ids that are identifiable from config. Only the standalone/cloud transport records
   * one (as the `x-datamate-id` header), so this is empty in gateway mode.
   */
  ids: Set<string>
  /** Datamate MCP server names found in config, across project and global files. */
  serverNames: string[]
  /**
   * True when the shared `datamate` gateway server is wired. The gateway serves every datamate
   * through one connection, so no single datamate id can be recovered from it.
   */
  gateway: boolean
}

/** The `x-datamate-id` header AltimateApi.buildMcpConfig writes on the cloud transport. */
function datamateIdFromEntry(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined
  const headers = (entry as { headers?: unknown }).headers
  if (!headers || typeof headers !== "object") return undefined
  const id = (headers as Record<string, unknown>)["x-datamate-id"]
  return typeof id === "string" && id.length > 0 ? id : undefined
}

/**
 * Read which datamates are wired as MCP servers, from the project and global config files.
 *
 * Reads config only — it does not glob for IDE `mcp.json` files (readDatamateTransportFromIde
 * scans the whole worktree) and does not consult live MCP status, so it is cheap enough to call
 * on every dialog open.
 */
export async function readWiredDatamates(projectRootDir: string): Promise<WiredDatamates> {
  const ids = new Set<string>()
  const serverNames: string[] = []
  let gateway = false

  const configPaths = await findAllConfigPaths(projectRootDir, Global.Path.config)
  for (const configPath of configPaths) {
    for (const name of await listMcpInConfig(configPath)) {
      if (name !== DATAMATE_KEY && !name.startsWith("datamate-")) continue
      if (!serverNames.includes(name)) serverNames.push(name)
      if (name === DATAMATE_KEY) {
        gateway = true
        continue
      }
      const id = datamateIdFromEntry(await readMcpEntryFromDisk(name, configPath))
      if (id) ids.add(id)
    }
  }

  return { ids, serverNames, gateway }
}
