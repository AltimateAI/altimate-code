import { readFile } from "fs/promises"
import path from "path"
import { parseTree, findNodeAtLocation, getNodeValue } from "jsonc-parser"
import { resolveConfigPath, addMcpToConfig, readMcpEntryFromDisk, findProjectConfigPaths, findGlobalConfigPaths } from "../mcp/config"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Glob } from "@opencode-ai/core/util/glob"
import { Log } from "@/altimate/util/log"
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
  | { type: "remote"; url: string; updatedAt?: string; source: string }
  | { type: "local"; command: string[]; environment?: Record<string, string>; updatedAt?: string; source: string }

/**
 * Provenance stamp on entries altimate-code derived from an IDE mcp.json.
 * `managedBy` marks the entry as ours; `sourceMcpJson` binds it to the exact
 * file it came from. The boot-time heal only rewrites a GLOBAL entry that
 * carries a matching stamp — a hand-added or legacy global entry is never
 * silently replaced from a project-local file.
 */
export const DATAMATE_PROVENANCE = "altimate-ide"

/**
 * The only mcp.json locations the extension writes (`.${ide}/mcp.json`, ide ∈
 * vscode|cursor). Anything else in a checkout is not an extension-authored
 * entry and must not become a transport source.
 */
const IDE_MCP_JSON_PATTERNS = ["**/.vscode/mcp.json", "**/.cursor/mcp.json"]

/**
 * Env keys carried from an IDE entry into the spawn. ELECTRON_RUN_AS_NODE is
 * the one the fix exists for: on desktop editors the entry's command is the
 * editor's Electron binary, and without the flag the spawn boots the editor
 * GUI — which opens datamate-cli.js as a document — instead of running it.
 * Nothing else is taken: the carried env is spread over altimate-code's own
 * process env at spawn, so a denylist would let a repo-local file override
 * NODE_OPTIONS/LD_PRELOAD/PATH for the child.
 */
const SPAWN_ENV_ALLOWLIST: ReadonlySet<string> = new Set(["ELECTRON_RUN_AS_NODE"])

function extractSpawnEnvironment(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!SPAWN_ENV_ALLOWLIST.has(key)) continue
    if (typeof value === "string") env[key] = value
  }
  return Object.keys(env).length > 0 ? env : undefined
}

/**
 * Validate an IDE mcp.json `datamate` entry into a transport, or null when it
 * is not one: missing, a blanked {} tombstone (the extension blanks the entry
 * in non-active-IDE files), or incomplete (no usable `url` for remote, no
 * usable `command` for stdio). Incomplete entries must not win source
 * selection — an entry like `{type:"stdio", updatedAt:…}` would otherwise be
 * persisted as `{type:"remote"}` with no url and break config loading.
 */
export function parseIdeTransport(entry: unknown, source: string): DatamateTransport | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null
  const e = entry as Record<string, unknown>
  if (Object.keys(e).length === 0) return null
  const updatedAt = typeof e["updatedAt"] === "string" && e["updatedAt"] ? { updatedAt: e["updatedAt"] } : {}
  if (typeof e["url"] === "string" && e["url"].length > 0) {
    return { type: "remote", url: e["url"], ...updatedAt, source }
  }
  if (typeof e["command"] === "string" && e["command"].length > 0) {
    const args = Array.isArray(e["args"]) ? e["args"].filter((a): a is string => typeof a === "string") : []
    const environment = extractSpawnEnvironment(e["env"])
    return {
      type: "local",
      command: [e["command"], ...args],
      ...(environment ? { environment } : {}),
      ...updatedAt,
      source,
    }
  }
  return null
}

/**
 * Root directory the boot-time heal should scan from: the containing git
 * project root when there is one, else the directory itself. Boot-time callers
 * (TUI worker, `run`) fire the sync before an Instance exists, so they cannot
 * use `Instance.worktree` — but MCP config is scoped to the project root, and
 * a session launched from a subdirectory would otherwise scan the subtree and
 * miss both the IDE config and the persisted entry it needs to repair.
 */
export async function resolveDatamateSyncRoot(directory: string): Promise<string> {
  try {
    // Bounded at the home directory: an unbounded walk reaches `/`, and a home
    // under dotfiles management would otherwise become the "project" — its
    // whole tree scanned for a datamate entry from any unrelated project.
    // `stop` is inclusive, so a `.git` AT home still matches and is rejected.
    // `.git` may be a file (worktrees, submodules); the nearest one wins,
    // matching how Project.fromDirectory derives the sandbox.
    const home = Global.Path.home
    const matches = Filesystem.up({ targets: [".git"], start: directory, stop: home })
    const dotgit = await matches.next().then((x) => x.value)
    await matches.return()
    if (dotgit) {
      const root = path.dirname(dotgit)
      if (root !== home) return root
    }
  } catch {
    // fall through to the directory itself
  }
  return directory
}

/**
 * Entry fields re-derived from the IDE transport on every sync/refresh — as
 * opposed to user-managed fields (enabled, timeout, oauth, …), which are
 * carried forward from the existing entry. Shared with `datamate_manager add`'s
 * refresh path so the two never disagree on what counts as transport identity.
 */
export const TRANSPORT_IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "command",
  "args",
  "environment",
  "url",
  "updatedAt",
  "managedBy",
  "sourceMcpJson",
])

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
    const paths: string[] = []
    for (const pattern of IDE_MCP_JSON_PATTERNS) {
      paths.push(...(await Glob.scan(pattern, { cwd: projectRootDir, absolute: true, dot: true })))
    }
    // Exclude build/dependency/output trees. command + args from a discovered
    // mcp.json are passed to StdioClientTransport, so keep the scan to source the
    // user actually authors and out of vendored/generated directories. The new core
    // Glob.Options dropped the `ignore` field, so filter the results instead.
    const ignoredDirs = [
      "node_modules",
      ".git",
      "dist",
      "build",
      ".pnpm",
      "target",
      ".next",
      "out",
      "vendor",
      "coverage",
      ".venv",
      ".turbo",
    ]
    return paths.filter((p) => !ignoredDirs.some((dir) => p.includes(`/${dir}/`))).sort()
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
  for (const mcpJsonPath of await findAllMcpJsonFiles(projectRootDir)) {
    const relPath = path.relative(projectRootDir, mcpJsonPath)
    try {
      const parsed = JSON.parse(await readFile(mcpJsonPath, "utf-8")) as Record<string, unknown>
      const transport = parseIdeTransport(extractServersMap(parsed)[DATAMATE_KEY], mcpJsonPath)
      if (!transport) continue
      log.info("readDatamateTransportFromIde: found entry", { source: relPath, type: transport.type })
      return transport
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
export async function syncDatamateUrlFromVscodeMcp(
  launchDir: string,
  // Overridable for tests only — the real global config dir is a static xdg path.
  globalConfigDir: string = Global.Path.config,
): Promise<string[]> {
  const updated: string[] = []
  try {
    // IDE discovery is scoped to the project root; the config heal walks from
    // the launch directory up to that root, mirroring the loader (a nested
    // package's own opencode.json is loaded and overrides the root entry, so
    // it must be healed too — Codex review on this PR).
    const root = await resolveDatamateSyncRoot(launchDir)
    const cwd = root
    log.info("syncDatamateUrlFromVscodeMcp: start", { launchDir, root })

    // First VALID datamate transport among the extension-written mcp.json files.
    let transport: DatamateTransport | undefined
    let serversMap: Record<string, Record<string, unknown>> = {}
    for (const candidate of await findAllMcpJsonFiles(root)) {
      try {
        const map = extractServersMap(JSON.parse(await readFile(candidate, "utf-8")) as Record<string, unknown>)
        const parsed = parseIdeTransport(map[DATAMATE_KEY], candidate)
        if (parsed) {
          transport = parsed
          serversMap = map
          break
        }
      } catch {
        // Unparseable — skip
      }
    }

    if (!transport) {
      log.info("syncDatamateUrlFromVscodeMcp: no mcp.json with a valid datamate entry found, skipping sync")
      return updated
    }
    log.info("syncDatamateUrlFromVscodeMcp: using config", { source: path.relative(root, transport.source) })

    // ── "datamate" entry: sync by updatedAt (works for stdio + HTTP) ────────
    const vscodeUpdatedAt = transport.updatedAt
    if (vscodeUpdatedAt) {
      const ideTransport = transport
      const healEntryInFile = async (configPath: string, scope: "project" | "global"): Promise<boolean> => {
        const configText = await Filesystem.readText(configPath)
        const existingTree = parseTree(configText)
        const existingNode = existingTree ? findNodeAtLocation(existingTree, ["mcp", DATAMATE_KEY]) : undefined
        if (!existingNode) return false

        // getNodeValue reconstructs the full entry (a manual children walk reading
        // `prop.children[1].value` drops array/object fields — jsonc-parser only
        // populates `Node.value` for primitives).
        const existingEntry =
          existingNode.type === "object" ? (getNodeValue(existingNode) as Record<string, unknown>) : {}

        // A GLOBAL entry outlives the project, so it is rewritten only when it
        // carries our provenance stamp bound to THIS mcp.json. Hand-added or
        // legacy global entries stay untouched; `datamate_manager add` is the
        // explicit path that (re)stamps them.
        if (scope === "global") {
          const managed =
            existingEntry["managedBy"] === DATAMATE_PROVENANCE && existingEntry["sourceMcpJson"] === ideTransport.source
          if (!managed) {
            log.info("syncDatamateUrlFromVscodeMcp: global datamate entry not managed from this IDE file, leaving it", {
              configPath,
            })
            return false
          }
        }

        const existingUpdatedAt =
          typeof existingEntry["updatedAt"] === "string" ? existingEntry["updatedAt"] : undefined
        if (vscodeUpdatedAt === existingUpdatedAt) {
          log.info("syncDatamateUrlFromVscodeMcp: datamate entry already up to date", { configPath, updatedAt: vscodeUpdatedAt })
          return false
        }

        // Preserve fields the IDE doesn't manage (enabled, timeout, oauth, …) by
        // carrying forward everything except the transport-identity fields, which
        // we re-derive below. IDE config uses "stdio"/"http"/"streamable-http"/"sse";
        // altimate-code.json uses "local"/"remote".
        const preserved: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(existingEntry)) {
          if (!TRANSPORT_IDENTITY_FIELDS.has(k)) preserved[k] = v
        }
        const newEntry: Record<string, unknown> = {
          ...preserved,
          ...(ideTransport.type === "local"
            ? {
                type: "local",
                command: ideTransport.command,
                ...(ideTransport.environment ? { environment: ideTransport.environment } : {}),
              }
            : { type: "remote", url: ideTransport.url }),
          updatedAt: vscodeUpdatedAt,
          managedBy: DATAMATE_PROVENANCE,
          sourceMcpJson: ideTransport.source,
        }

        await addMcpToConfig(DATAMATE_KEY, newEntry as Parameters<typeof addMcpToConfig>[1], configPath)
        log.info("syncDatamateUrlFromVscodeMcp: datamate entry synced", { configPath, type: ideTransport.type, updatedAt: vscodeUpdatedAt })
        return true
      }

      // Project-scope candidates: every directory from the launch dir up to the
      // root (inclusive), each with its .altimate-code/.opencode subdirs.
      const candidates: Array<{ path: string; scope: "project" | "global" }> = []
      const seen = new Set<string>()
      let dir = path.resolve(launchDir)
      const rootResolved = path.resolve(root)
      while (true) {
        for (const p of await findProjectConfigPaths(dir)) {
          if (!seen.has(p)) { seen.add(p); candidates.push({ path: p, scope: "project" }) }
        }
        if (dir === rootResolved || !dir.startsWith(rootResolved)) break
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
      for (const p of await findGlobalConfigPaths(globalConfigDir)) {
        if (!seen.has(p)) { seen.add(p); candidates.push({ path: p, scope: "global" }) }
      }

      let datamateHealed = false
      for (const { path: configPath, scope } of candidates) {
        // Per-file isolation: one malformed config (addMcpToConfig refuses to
        // rewrite unparseable files by throwing) must not abort the heal for the
        // remaining files.
        try {
          if (await healEntryInFile(configPath, scope)) datamateHealed = true
        } catch (err) {
          log.warn("syncDatamateUrlFromVscodeMcp: skipping unhealable config file", {
            configPath,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (datamateHealed) updated.push(DATAMATE_KEY)
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

