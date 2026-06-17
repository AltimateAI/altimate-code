import { readFile } from "fs/promises"
import path from "path"
import { parseTree, findNodeAtLocation, getNodeValue } from "jsonc-parser"
import { resolveConfigPath, addMcpToConfig, readMcpEntryFromDisk } from "../mcp/config"
import { Filesystem } from "../util/filesystem"
import { Glob } from "../util/glob"
import { Log } from "../util/log"
import type { Config } from "../config/config"

const log = Log.create({ service: "datamate-transport" })

export const DATAMATE_KEY = "datamate"

/**
 * Top-level keys that MCP config files use to map server name → entry.
 * VS Code 1.99+ uses "servers"; older VS Code and Cursor use "mcpServers".
 * We try both so the scan works regardless of which IDE wrote the file.
 */
const MCP_SERVERS_KEYS = ["servers", "mcpServers"] as const


export type DatamateTransport =
  | { type: "remote"; url: string }
  | { type: "local"; command: string[] }

/**
 * Parse a single mcp.json file and return the servers map, trying each of the
 * known top-level key names in order.
 */
function extractServersMap(
  parsed: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  for (const key of MCP_SERVERS_KEYS) {
    const candidate = parsed[key]
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as Record<string, Record<string, unknown>>
    }
  }
  return {}
}

/**
 * Find all mcp.json files under projectRootDir (excluding noise directories)
 * and return the paths sorted for deterministic ordering.
 */
async function findAllMcpJsonFiles(projectRootDir: string): Promise<string[]> {
  try {
    const paths = await Glob.scan("**/mcp.json", {
      cwd: projectRootDir,
      absolute: true,
      dot: true,
      // Exclude build/dependency/output trees. command + args from a discovered
      // mcp.json are passed to StdioClientTransport, so keep the scan to source the
      // user actually authors and out of vendored/generated directories.
      ignore: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
        "**/.pnpm/**",
        "**/target/**",
        "**/.next/**",
        "**/out/**",
        "**/vendor/**",
        "**/coverage/**",
        "**/.venv/**",
        "**/.turbo/**",
      ],
    })
    return paths.sort()
  } catch {
    log.warn("findAllMcpJsonFiles: glob scan failed", { cwd: projectRootDir })
    return []
  }
}

/**
 * Scan all mcp.json files under projectRootDir and return the transport type
 * for the first "datamate" server entry found.
 *
 * Returns null if no mcp.json contains a "datamate" entry — the caller should
 * fall back to the cloud config.
 *
 * Reuses the exact command from the IDE config so altimate-code spawns the
 * same process the extension already started, rather than a second one.
 */
export async function readDatamateTransportFromIde(
  projectRootDir: string,
): Promise<DatamateTransport | null> {
  const mcpJsonPaths = await findAllMcpJsonFiles(projectRootDir)

  for (const mcpJsonPath of mcpJsonPaths) {
    const relPath = path.relative(projectRootDir, mcpJsonPath)
    try {
      const text = await readFile(mcpJsonPath, "utf-8")
      const parsed = JSON.parse(text) as Record<string, unknown>
      const serversMap = extractServersMap(parsed)
      const entry = serversMap[DATAMATE_KEY]
      if (!entry) continue

      log.info("readDatamateTransportFromIde: found entry", {
        source: relPath,
        type: entry["type"] ?? "(no type)",
      })

      if (typeof entry["url"] === "string") {
        return { type: "remote", url: entry["url"] }
      }

      // stdio entry — reuse the exact command + args the extension registered
      const cmd = typeof entry["command"] === "string" ? entry["command"] : undefined
      const args = Array.isArray(entry["args"]) ? (entry["args"] as string[]) : []
      if (cmd) {
        return { type: "local", command: [cmd, ...args] }
      }

      // Entry exists but has no usable command — treat as local marker
      return { type: "local", command: [DATAMATE_KEY, "start-stdio"] }
    } catch {
      log.warn("readDatamateTransportFromIde: failed to parse", { source: relPath })
    }
  }

  log.info("readDatamateTransportFromIde: no IDE entry found, falling back to cloud config")
  return null
}

/**
 * Sync the "datamate" entry (and other remote MCP entries) from the first
 * mcp.json that contains a "datamate" key to altimate-code.json.
 *
 * Uses `updatedAt` as the change signal for the datamate entry (covers both
 * stdio and HTTP transport), and URL comparison for all other remote entries.
 *
 * Fire-and-forget friendly: errors are logged but never thrown.
 * Returns the list of MCP server names whose config was updated on disk.
 */
export async function syncDatamateUrlFromVscodeMcp(cwd: string): Promise<string[]> {
  const updated: string[] = []
  try {
    log.info("syncDatamateUrlFromVscodeMcp: start", { cwd })

    // Find the first mcp.json that contains a "datamate" entry.
    const mcpJsonPaths = await findAllMcpJsonFiles(cwd)
    let mcpJsonPath: string | undefined
    let serversMap: Record<string, Record<string, unknown>> = {}

    for (const candidate of mcpJsonPaths) {
      try {
        const text = await readFile(candidate, "utf-8")
        const parsed = JSON.parse(text) as Record<string, unknown>
        const map = extractServersMap(parsed)
        if (map[DATAMATE_KEY]) {
          mcpJsonPath = candidate
          serversMap = map
          break
        }
      } catch {
        // Unparseable — skip
      }
    }

    if (!mcpJsonPath) {
      log.info("syncDatamateUrlFromVscodeMcp: no mcp.json with datamate entry found, skipping sync")
      return updated
    }

    log.info("syncDatamateUrlFromVscodeMcp: using config", {
      source: path.relative(cwd, mcpJsonPath),
    })

    // ── "datamate" entry: sync by updatedAt (works for stdio + HTTP) ────────
    const datamateVscode = serversMap[DATAMATE_KEY]
    const vscodeUpdatedAt =
      datamateVscode && typeof datamateVscode["updatedAt"] === "string"
        ? (datamateVscode["updatedAt"] as string)
        : undefined

    if (datamateVscode && vscodeUpdatedAt) {
      const configPath = await resolveConfigPath(cwd)
      if (await Filesystem.exists(configPath)) {
        const configText = await Filesystem.readText(configPath)
        const existingTree = parseTree(configText)
        const existingNode = existingTree
          ? findNodeAtLocation(existingTree, ["mcp", DATAMATE_KEY])
          : undefined

        if (existingNode) {
          // getNodeValue reconstructs the full entry (a manual children walk reading
          // `prop.children[1].value` drops array/object fields — jsonc-parser only
          // populates `Node.value` for primitives).
          const existingEntry =
            existingNode.type === "object"
              ? (getNodeValue(existingNode) as Record<string, unknown>)
              : {}
          const existingUpdatedAt =
            typeof existingEntry["updatedAt"] === "string" ? existingEntry["updatedAt"] : undefined

          if (vscodeUpdatedAt === existingUpdatedAt) {
            log.info("syncDatamateUrlFromVscodeMcp: datamate entry already up to date", {
              updatedAt: vscodeUpdatedAt,
            })
          } else {
            // Preserve fields the IDE doesn't manage (enabled, timeout, oauth, …) by
            // carrying forward everything except the transport-identity fields, which
            // we re-derive below. IDE config uses "stdio"/"http"/"streamable-http"/"sse";
            // altimate-code.json uses "local"/"remote".
            const TRANSPORT_FIELDS = new Set([
              "type",
              "command",
              "args",
              "environment",
              "url",
              "updatedAt",
            ])
            const preserved: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(existingEntry)) {
              if (!TRANSPORT_FIELDS.has(k)) preserved[k] = v
            }

            let newEntry: Record<string, unknown>
            if ("command" in datamateVscode) {
              const env = datamateVscode["env"] as Record<string, string> | undefined
              const { ALTIMATE_EXTENSION_RPC: _rpc, ...restEnv } = env ?? {}
              const cmd =
                typeof datamateVscode["command"] === "string"
                  ? (datamateVscode["command"] as string)
                  : DATAMATE_KEY
              newEntry = {
                ...preserved,
                type: "local",
                command: [cmd, ...((datamateVscode["args"] as string[]) ?? [])],
                ...(Object.keys(restEnv).length > 0 ? { environment: restEnv } : {}),
                updatedAt: vscodeUpdatedAt,
              }
            } else {
              // http / streamable-http / sse → remote
              newEntry = {
                ...preserved,
                type: "remote",
                url: datamateVscode["url"] as string,
                updatedAt: vscodeUpdatedAt,
              }
            }

            await addMcpToConfig(
              DATAMATE_KEY,
              newEntry as Parameters<typeof addMcpToConfig>[1],
              configPath,
            )
            log.info("syncDatamateUrlFromVscodeMcp: datamate entry synced", {
              type: datamateVscode["type"],
              updatedAt: vscodeUpdatedAt,
            })
            updated.push(DATAMATE_KEY)
          }
        }
      }
    }

    // ── All other remote MCP entries: existing URL-comparison logic ──────────
    const httpEntries: Array<{ key: string; url: string }> = []
    for (const [key, entry] of Object.entries(serversMap)) {
      if (key === DATAMATE_KEY) continue
      if (typeof entry["url"] === "string") {
        httpEntries.push({ key, url: entry["url"] })
      }
    }

    if (httpEntries.length > 0) {
      const configPath = await resolveConfigPath(cwd)
      if (await Filesystem.exists(configPath)) {
        const configText = await Filesystem.readText(configPath)
        const tree = parseTree(configText)
        const mcpNode = tree ? findNodeAtLocation(tree, ["mcp"]) : undefined

        if (tree && mcpNode && mcpNode.type === "object" && mcpNode.children) {
          const remoteMcpEntries: Array<{ name: string; url: string }> = []
          for (const child of mcpNode.children) {
            if (child.type !== "property" || !child.children) continue
            const nameNode = child.children[0]
            const valueNode = child.children[1]
            if (!nameNode || !valueNode || valueNode.type !== "object" || !valueNode.children) continue
            const typeNode = findNodeAtLocation(valueNode, ["type"])
            const urlNode = findNodeAtLocation(valueNode, ["url"])
            if (typeNode?.value === "remote" && typeof urlNode?.value === "string") {
              remoteMcpEntries.push({ name: nameNode.value as string, url: urlNode.value })
            }
          }

          for (const remote of remoteMcpEntries) {
            const match = httpEntries.find((e) => e.key === remote.name)
            if (match && match.url !== remote.url) {
              const entryNode = findNodeAtLocation(tree, ["mcp", remote.name])
              if (!entryNode || entryNode.type !== "object") continue
              // getNodeValue preserves headers/oauth/timeout; a children walk reading
              // `prop.children[1].value` would strip them (object/array nodes).
              const entry = getNodeValue(entryNode) as Record<string, unknown>
              entry["url"] = match.url
              entry["updatedAt"] = new Date().toISOString()
              await addMcpToConfig(
                remote.name,
                entry as Parameters<typeof addMcpToConfig>[1],
                configPath,
              )
              log.info("syncDatamateUrlFromVscodeMcp: remote entry updated", {
                name: remote.name,
                oldUrl: remote.url,
                newUrl: match.url,
              })
              updated.push(remote.name)
            }
          }
        }
      }
    }

    if (updated.length === 0) log.info("syncDatamateUrlFromVscodeMcp: no changes detected")
  } catch (err) {
    log.warn("syncDatamateUrlFromVscodeMcp: failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return updated
}

