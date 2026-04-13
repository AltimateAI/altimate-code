import os from "os"
import path from "path"
import { parse as parseJsonc } from "jsonc-parser"
import { Log } from "../util/log"
import { Filesystem } from "../util/filesystem"
import { ConfigPaths } from "../config/paths"
import type { Config } from "../config/config"

const log = Log.create({ service: "mcp.discover" })

// altimate_change start — per-field env-var resolution for discovered MCP configs
// Discovered configs (.vscode/mcp.json, .cursor/mcp.json, ~/.claude.json, etc.)
// are parsed with plain parseJsonc and thus never pass through ConfigPaths.substitute.
// Resolve ${VAR} / {env:VAR} patterns only on the env and headers fields so that
// scoping is narrow (we don't touch command args, URLs, or server names) and so
// that the launch site does NOT need a second resolution pass.
// See PR #666 review — double-interpolation regression fixed by doing this once,
// here, rather than twice.
function resolveServerEnvVars(
  obj: Record<string, unknown>,
  context: { server: string; source: string; field: "env" | "headers" },
): Record<string, string> {
  const out: Record<string, string> = {}
  const stats = ConfigPaths.newEnvSubstitutionStats()
  for (const [key, raw] of Object.entries(obj)) {
    if (typeof raw !== "string") continue
    out[key] = ConfigPaths.resolveEnvVarsInString(raw, stats)
  }
  if (stats.unresolvedNames.length > 0) {
    log.warn("unresolved env var references in MCP config — substituting empty string", {
      server: context.server,
      source: context.source,
      field: context.field,
      unresolved: stats.unresolvedNames.join(", "),
    })
  }
  return out
}
// altimate_change end

interface ExternalMcpSource {
  /** Relative path from base directory */
  file: string
  /** Key in the parsed JSON that holds the server map */
  key: string
  /** Where to search: "project", "home", or "both" */
  scope: "project" | "home" | "both"
}

/** Standard sources checked relative to project root and/or home directory */
const SOURCES: ExternalMcpSource[] = [
  // Project-only sources
  { file: ".vscode/mcp.json", key: "servers", scope: "project" },
  { file: ".cursor/mcp.json", key: "mcpServers", scope: "project" },
  { file: ".github/copilot/mcp.json", key: "mcpServers", scope: "project" },

  // Both project and home
  { file: ".mcp.json", key: "mcpServers", scope: "both" },
  { file: ".gemini/settings.json", key: "mcpServers", scope: "both" },
]

/**
 * Transform a single external MCP entry into our Config.Mcp shape.
 * Returns undefined if the entry is invalid (no command or url).
 * Preserves recognized fields: timeout, enabled.
 *
 * altimate_change — `context` is used to scope env-var resolution to the
 * `env` and `headers` fields and to tag warnings with the source + server name.
 */
function transform(
  entry: Record<string, any>,
  // altimate_change start — context for env-var resolution warnings
  context: { server: string; source: string },
  // altimate_change end
): Config.Mcp | undefined {
  // Remote server — handle both "url" and Claude Code's "type: http" format
  if (entry.url && typeof entry.url === "string") {
    const result: Record<string, any> = {
      type: "remote" as const,
      url: entry.url,
    }
    if (entry.headers && typeof entry.headers === "object") {
      // altimate_change start — resolve env vars in headers (e.g. Authorization: Bearer ${TOKEN})
      result.headers = resolveServerEnvVars(entry.headers as Record<string, unknown>, {
        ...context,
        field: "headers",
      })
      // altimate_change end
    }
    if (typeof entry.timeout === "number") result.timeout = entry.timeout
    if (typeof entry.enabled === "boolean") result.enabled = entry.enabled
    return result as Config.Mcp
  }

  // Local server
  if (entry.command) {
    const safeStr = (x: unknown): string => {
      if (typeof x === "string") return x
      try { return String(x) } catch { return "[invalid]" }
    }
    const cmd = Array.isArray(entry.command)
      ? entry.command.filter((x: unknown) => x != null).map(safeStr)
      : [safeStr(entry.command), ...(Array.isArray(entry.args) ? entry.args.filter((x: unknown) => x != null).map(safeStr) : [])]

    const result: Record<string, any> = {
      type: "local" as const,
      command: cmd,
    }
    if (entry.env && typeof entry.env === "object") {
      // altimate_change start — resolve env vars in environment block
      result.environment = resolveServerEnvVars(entry.env as Record<string, unknown>, {
        ...context,
        field: "env",
      })
      // altimate_change end
    }
    if (typeof entry.timeout === "number") result.timeout = entry.timeout
    if (typeof entry.enabled === "boolean") result.enabled = entry.enabled
    return result as Config.Mcp
  }

  return undefined
}

/**
 * Add servers from a parsed config into the result map.
 * First-source-wins: skips servers already in result.
 */
function addServersFromFile(
  servers: Record<string, any> | undefined,
  sourceLabel: string,
  result: Record<string, Config.Mcp>,
  contributingSources: string[],
  projectScoped = false,
) {
  if (!servers || typeof servers !== "object") return

  let added = 0
  for (const [name, entry] of Object.entries(servers)) {
    // Guard against prototype pollution from repo-controlled input
    if (name === "__proto__" || name === "constructor" || name === "prototype") continue
    if (Object.prototype.hasOwnProperty.call(result, name)) continue // first source wins
    if (!entry || typeof entry !== "object") continue

    const transformed = transform(entry as Record<string, any>, {
      server: name,
      source: sourceLabel,
    })
    if (transformed) {
      // Project-scoped servers are discovered but disabled by default for security.
      // User-owned home-directory configs are auto-enabled.
      if (projectScoped) {
        ;(transformed as any).enabled = false
      }
      result[name] = transformed
      added++
    }
  }

  if (added > 0) {
    contributingSources.push(sourceLabel)
  }
}

async function readJsonSafe(filePath: string): Promise<any | undefined> {
  let text: string
  try {
    text = await Filesystem.readText(filePath)
  } catch {
    return undefined
  }
  const errors: any[] = []
  const result = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    log.debug("failed to parse external MCP config", { file: filePath, errors: errors.length })
    return undefined
  }
  return result
}

/**
 * Discover MCP servers from Claude Code's global config (~/.claude.json).
 * Claude Code stores per-project MCP servers under projects[path].mcpServers.
 * Project-specific servers take precedence over global ones.
 */
async function discoverClaudeCode(
  worktree: string,
  result: Record<string, Config.Mcp>,
  contributingSources: string[],
) {
  const claudeJsonPath = path.join(os.homedir(), ".claude.json")
  const parsed = await readJsonSafe(claudeJsonPath)
  if (!parsed || typeof parsed !== "object") return

  // FIX: Project-specific FIRST, then global — project overrides global
  if (parsed.projects && typeof parsed.projects === "object") {
    const projectEntry = parsed.projects[worktree]
    if (projectEntry?.mcpServers && typeof projectEntry.mcpServers === "object") {
      addServersFromFile(
        projectEntry.mcpServers,
        `~/.claude.json (${path.basename(worktree)})`,
        result,
        contributingSources,
      )
    }
  }

  // Global-level mcpServers (lower priority — project-specific already added)
  if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
    addServersFromFile(parsed.mcpServers, "~/.claude.json (global)", result, contributingSources)
  }
}

/**
 * Discover MCP servers configured in external AI tool configs
 * (VS Code, GitHub Copilot, Claude Code, Gemini CLI).
 *
 * Security model: Project-scoped servers (.vscode/mcp.json, .mcp.json, etc.) are
 * discovered with enabled=false so they don't auto-connect. Users must explicitly
 * approve them via /discover-and-add-mcps. Home-directory configs (~/.claude.json,
 * ~/.gemini/settings.json) are auto-enabled since they're user-owned.
 *
 * Searches both the project directory and the home directory.
 * Returns servers and contributing source labels.
 * First-discovered-wins per server name across sources.
 */
export async function discoverExternalMcp(worktree: string): Promise<{
  servers: Record<string, Config.Mcp>
  sources: string[]
}> {
  log.info("Discovering MCP servers from external AI tool configs...")
  const result: Record<string, Config.Mcp> = Object.create(null)
  const contributingSources: string[] = []
  const homedir = os.homedir()

  // Scan standard sources in project and/or home directories
  for (const source of SOURCES) {
    const dirs: Array<{ dir: string; label: string }> = []
    if (source.scope === "project" || source.scope === "both") {
      dirs.push({ dir: worktree, label: source.file })
    }
    if ((source.scope === "home" || source.scope === "both") && worktree !== homedir) {
      dirs.push({ dir: homedir, label: `~/${source.file}` })
    }

    for (const { dir, label } of dirs) {
      const filePath = path.join(dir, source.file)
      const parsed = await readJsonSafe(filePath)
      if (!parsed || typeof parsed !== "object") continue

      const isProjectScoped = dir === worktree
      const servers = parsed[source.key]
      addServersFromFile(servers, label, result, contributingSources, isProjectScoped)
    }
  }

  // Claude Code has a unique config structure — handle separately
  await discoverClaudeCode(worktree, result, contributingSources)

  const serverNames = Object.keys(result)
  if (serverNames.length > 0) {
    log.info(`Discovered ${serverNames.length} MCP server(s) from ${contributingSources.join(", ")}: ${serverNames.join(", ")}`)
  } else {
    log.info("No external MCP configs found")
  }

  return { servers: result, sources: contributingSources }
}

/** Stored after config merge — only contains servers that were actually new. */
let _lastDiscovery: { serverNames: string[]; sources: string[] } | null = null

/** Called from config.ts after merge with only the names that were actually added. */
export function setDiscoveryResult(serverNames: string[], sources: string[]) {
  if (serverNames.length > 0) {
    _lastDiscovery = { serverNames, sources }
  }
}

/** Returns and clears the last discovery result (for one-time toast notification). */
export function consumeDiscoveryResult() {
  const result = _lastDiscovery
  _lastDiscovery = null
  return result
}
