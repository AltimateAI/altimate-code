import os from "os"
import path from "path"
import { parse as parseJsonc } from "jsonc-parser"
import { Log } from "../util/log"
import { Filesystem } from "../util/filesystem"
import { Glob } from "../util/glob"
import { ConfigPaths } from "../config/paths"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"

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
    // altimate_change start — upstream_fix: remember it for the user, not just the log (#701).
    // An unresolved `${SNOWFLAKE_PASSWORD}` becomes "" and the server launches with a blank
    // credential, failing later with something that names neither the variable nor the config
    // file. The log line already had the answer; nobody reads it. Recorded here so `/mcps` can
    // say so. Mirrors the `setDiscoveryResult` handoff below.
    const seen = _unresolvedEnv.get(context.server) ?? new Set<string>()
    for (const name of stats.unresolvedNames) seen.add(name)
    _unresolvedEnv.set(context.server, seen)
    // altimate_change end
  }
  return out
}
// altimate_change end

// altimate_change start — upstream_fix: unresolved-variable record for the user surface (#701).
/** Server name -> variable names that resolved to "" during discovery. */
const _unresolvedEnv = new Map<string, Set<string>>()

/**
 * Variable names that silently became "" for `server`, from the most recent discovery.
 *
 * The record is cleared at the start of every `discoverExternalMcp` run and then unioned
 * within that run, because one server is resolved twice — once for `headers` and once for
 * `environment`. Without the reset the map only ever grew: a server whose `{env:VAR}` had
 * since been fixed kept its old entry (the recording site below is inside an
 * `unresolvedNames.length > 0` guard, so a clean run never touched it), and `/mcps` went on
 * telling the user to set a variable that already resolved.
 *
 * Only the latest run's servers are present, so a daemon that discovers for a second project
 * replaces the first project's entries rather than mixing the two under a shared server name.
 */
export function unresolvedEnvVars(server: string): string[] {
  return [...(_unresolvedEnv.get(server) ?? [])].sort()
}

/** Drop the previous run's records. Called once per `discoverExternalMcp`. */
function resetUnresolvedEnv() {
  _unresolvedEnv.clear()
}
// altimate_change end

// altimate_change start — upstream_fix (#878): report drift instead of silently skipping.
// Discovery is first-source-wins, so a server already present in altimate-code.json is skipped
// outright and a changed `.vscode/mcp.json` (a new ALTIMATE_EXTENSION_RPC port, a moved command)
// is never mentioned. Overwriting the user's own config would be worse than the silence, so the
// differing field names are recorded and a user surface reports them; the user decides.
const _drift = new Map<string, { source: string; fields: string[] }>()

/**
 * Fields whose difference is expected and not worth reporting.
 *
 * `updatedAt` is the datamate sync change-signal: `normalizeMcpConfig` preserves it on the
 * configured entry and discovery never produces one, so every comparison saw a value against
 * `undefined` and reported drift on every `mcp list` for any datamate-synced server.
 */
const DRIFT_IGNORED = new Set(["enabled", "updatedAt"])

/** Key order must not read as a difference — `{a,b}` and `{b,a}` are the same config. */
function stableStringify(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]"
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k]))
      .join(",") +
    "}"
  )
}

const isPlainObject = (v: any): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v)

/**
 * Field names that differ between a discovered server and the one already configured.
 * Nested `environment`/`headers` differences are reported per key (`environment.FOO`) so the
 * message names the thing to fix rather than just "environment".
 */
export function driftFields(discovered: Record<string, any>, configured: Record<string, any>): string[] {
  const fields: string[] = []
  for (const key of new Set([...Object.keys(discovered), ...Object.keys(configured)])) {
    if (DRIFT_IGNORED.has(key)) continue
    const a = discovered[key]
    const b = configured[key]
    // Nested when EITHER side has the block: requiring both meant a server that gained or lost
    // an `environment` wholesale reported the bare word "environment" and lost the key names,
    // which is the one thing this function exists to provide.
    if ((key === "environment" || key === "headers") && (isPlainObject(a) || isPlainObject(b))) {
      const left = isPlainObject(a) ? a : {}
      const right = isPlainObject(b) ? b : {}
      const inner = new Set([...Object.keys(left), ...Object.keys(right)])
      // An empty block against a missing one has no key to name, so report it at the top level
      // rather than saying nothing at all.
      if (inner.size === 0) {
        if (stableStringify(a) !== stableStringify(b)) fields.push(key)
        continue
      }
      for (const name of inner) if (left[name] !== right[name]) fields.push(`${key}.${name}`)
      continue
    }
    if (stableStringify(a) !== stableStringify(b)) fields.push(key)
  }
  return fields.sort()
}

/** Record that `server` is configured differently from what discovery found in `source`. */
export function setConfigDrift(server: string, source: string, fields: string[]) {
  if (fields.length > 0) _drift.set(server, { source, fields })
  else _drift.delete(server)
}

/** Servers whose configured definition differs from the discovered one. */
export function configDrift(): { server: string; source: string; fields: string[] }[] {
  return [..._drift.entries()]
    .map(([server, info]) => ({ server, ...info }))
    .sort((a, b) => a.server.localeCompare(b.server))
}

/** Server name -> the file that actually defined it, for drift attribution. */
const _discoveredSource = new Map<string, string>()

/** The config file a discovered server came from, or undefined if it was not discovered. */
export function discoveredSource(server: string): string | undefined {
  return _discoveredSource.get(server)
}

/** Test seam — drift accumulates at module level. */
export function resetConfigDrift() {
  _drift.clear()
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

/**
 * Config files whose basename is NOT "mcp.json" — the `**​/mcp.json` glob scan
 * in `discoverExternalMcp` does not match these, so they are still checked by
 * exact relative path. (`.vscode/mcp.json`, `.cursor/mcp.json`,
 * `.github/copilot/mcp.json` and any other tool's `mcp.json` are covered by the
 * glob scan and intentionally omitted here.)
 */
const SOURCES: ExternalMcpSource[] = [
  // Both project and home
  { file: ".mcp.json", key: "mcpServers", scope: "both" },
  { file: ".gemini/settings.json", key: "mcpServers", scope: "both" },
]

/**
 * Transform a single external MCP entry into our ConfigMCPV1.Info shape.
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
): ConfigMCPV1.Info | undefined {
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
    // altimate_change start — preserve bearer-auth fields so a discovered
    // server's `headersCommand` / `oauth` isn't dropped before reaching the
    // runtime, silently connecting with no auth. Unlike config.ts
    // `normalizeMcpConfig` (which passes malformed shapes through so the user's
    // own file fails `Info.safeParse` with an actionable error), discovery
    // ingests FOREIGN config files: only shapes our McpRemote schema accepts
    // are preserved, and foreign dialects (e.g. Gemini CLI's
    // `oauth: { enabled: true }`) are dropped as before. Discovered entries are
    // merged into the runtime config after validation and can be persisted to
    // opencode.json via `mcp-discover add`, so an unvalidated pass-through
    // would poison the config file and fail every subsequent load.
    // Validators mirror the McpRemote schema: `headersCommand` is a record of
    // non-empty string argv arrays; `oauth` is `false` or a strict object of
    // optional string fields clientId/clientSecret/scope. (Schemas can't be
    // imported as values here — config.ts dynamically imports this module, and
    // the Config import above is type-only to avoid a static cycle.)
    // See #791 / #792.
    const headersCommand = entry.headersCommand
    if (headersCommand !== undefined) {
      const valid =
        headersCommand !== null &&
        typeof headersCommand === "object" &&
        !Array.isArray(headersCommand) &&
        Object.values(headersCommand).every(
          (argv) => Array.isArray(argv) && argv.length > 0 && argv.every((part: unknown) => typeof part === "string"),
        )
      if (valid) result.headersCommand = headersCommand
      else log.debug("dropping unrecognized headersCommand from discovered server", context)
    }
    const oauth = entry.oauth
    if (oauth !== undefined) {
      const oauthStringFields = ["clientId", "clientSecret", "scope"]
      const valid =
        oauth === false ||
        (oauth !== null &&
          typeof oauth === "object" &&
          !Array.isArray(oauth) &&
          Object.entries(oauth).every(([k, v]) => oauthStringFields.includes(k) && typeof v === "string"))
      if (valid) result.oauth = oauth
      else log.debug("dropping unrecognized oauth config from discovered server", context)
    }
    // altimate_change end
    if (typeof entry.timeout === "number") result.timeout = entry.timeout
    if (typeof entry.enabled === "boolean") result.enabled = entry.enabled
    return result as ConfigMCPV1.Info
  }

  // Local server
  if (entry.command) {
    const safeStr = (x: unknown): string => {
      if (typeof x === "string") return x
      try {
        return String(x)
      } catch {
        return "[invalid]"
      }
    }
    const cmd = Array.isArray(entry.command)
      ? entry.command.filter((x: unknown) => x != null).map(safeStr)
      : [
          safeStr(entry.command),
          ...(Array.isArray(entry.args) ? entry.args.filter((x: unknown) => x != null).map(safeStr) : []),
        ]

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
    return result as ConfigMCPV1.Info
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
  result: Record<string, ConfigMCPV1.Info>,
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
      // altimate_change start — upstream_fix (#878): attribute drift to the file that defined
      // this server, not to every file that contributed something to the run.
      _discoveredSource.set(name, sourceLabel)
      // altimate_change end
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
  result: Record<string, ConfigMCPV1.Info>,
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
 * Merge the server maps from every recognized top-level key in a parsed config.
 * VS Code 1.99+ uses "servers"; older VS Code, Cursor, and Copilot use
 * "mcpServers". A single file normally uses one or the other, but we merge both
 * so the scan is IDE-agnostic regardless of which key the writer chose.
 */
function mergeServerKeys(parsed: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const key of ["servers", "mcpServers"]) {
    const candidate = parsed[key]
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      Object.assign(out, candidate)
    }
  }
  return out
}

/**
 * Discover MCP servers configured in external AI tool configs
 * (VS Code, Cursor, GitHub Copilot, Claude Code, Gemini CLI).
 *
 * Security model: Project-scoped servers (.vscode/mcp.json, .mcp.json, etc.) are
 * discovered with enabled=false so they don't auto-connect. Users must explicitly
 * approve them via /discover-and-add-mcps. Home-directory configs (~/.claude.json,
 * ~/.gemini/settings.json) are auto-enabled since they're user-owned.
 *
 * `projectDir` is the project root (the opened workspace folder) — NOT the git
 * worktree, which resolves to "/" for non-git projects and would scan the whole
 * filesystem / miss the project's configs entirely.
 *
 * Recursively scans every `mcp.json` under `projectDir` (IDE-agnostic) plus the
 * non-"mcp.json" config files in the project and home directories.
 * Returns servers and contributing source labels.
 * First-discovered-wins per server name across sources.
 */
export async function discoverExternalMcp(projectDir: string): Promise<{
  servers: Record<string, ConfigMCPV1.Info>
  sources: string[]
}> {
  log.info("Discovering MCP servers from external AI tool configs...")
  // Start from a clean slate so a variable fixed since the last run stops being reported.
  resetUnresolvedEnv()
  // Same for drift: a server removed from the external config, or a reload that resolved the
  // difference, otherwise left a stale entry and `mcp status` reported a mismatch that no
  // longer existed. The setConfigDrift calls after this run repopulate it.
  resetConfigDrift()
  _discoveredSource.clear()
  const result: Record<string, ConfigMCPV1.Info> = Object.create(null)
  const contributingSources: string[] = []
  const homedir = os.homedir()

  // Recursively scan every mcp.json under the project root — covers
  // .vscode/mcp.json (VS Code), .cursor/mcp.json (Cursor),
  // .github/copilot/mcp.json (Copilot), and any other tool's mcp.json.
  // Ordered by IDE precedence first, then alphabetically, so first-source-wins
  // dedup is deterministic and keeps the historical .vscode > .cursor > copilot order
  // (a plain alphabetical sort would let .cursor override .vscode).
  const IDE_PRECEDENCE = [".vscode/mcp.json", ".cursor/mcp.json", ".github/copilot/mcp.json"]
  const toRel = (abs: string) => path.relative(projectDir, abs).split(path.sep).join("/")
  let mcpJsonFiles: string[] = []
  try {
    // altimate_change start — prune dependency/build trees during traversal.
    // Filtering results after an unrestricted `**/mcp.json` walk still reads
    // every directory in the project: on a monorepo with node_modules present
    // that costs ~6 CPU-seconds per invocation, spread across the whole runtime
    // I/O thread pool. The post-filter stays as defence in depth.
    const IGNORE_GLOBS = [...Glob.DEFAULT_IGNORE]
    const scanned = (
      await Glob.scan("**/mcp.json", {
        cwd: projectDir,
        absolute: true,
        dot: true,
        ignore: IGNORE_GLOBS,
      })
    ).filter((abs) => {
      const rel = toRel(abs)
      return !IGNORE_GLOBS.some((pattern) => Glob.match(pattern, rel))
    })
    // altimate_change end
    const rank = (abs: string) => {
      const i = IDE_PRECEDENCE.indexOf(toRel(abs))
      return i === -1 ? IDE_PRECEDENCE.length : i
    }
    mcpJsonFiles = scanned.sort((a, b) => {
      const ra = rank(a)
      const rb = rank(b)
      if (ra !== rb) return ra - rb
      const relA = toRel(a)
      const relB = toRel(b)
      return relA < relB ? -1 : relA > relB ? 1 : 0
    })
  } catch {
    log.warn("mcp.json glob scan failed", { cwd: projectDir })
  }
  for (const file of mcpJsonFiles) {
    const parsed = await readJsonSafe(file)
    if (!parsed || typeof parsed !== "object") continue
    const label = toRel(file) || path.basename(file)
    addServersFromFile(mergeServerKeys(parsed), label, result, contributingSources, true)
  }

  // Non-"mcp.json" config files (not matched by the glob above), in project and/or home.
  for (const source of SOURCES) {
    const dirs: Array<{ dir: string; label: string }> = []
    if (source.scope === "project" || source.scope === "both") {
      dirs.push({ dir: projectDir, label: source.file })
    }
    if ((source.scope === "home" || source.scope === "both") && projectDir !== homedir) {
      dirs.push({ dir: homedir, label: `~/${source.file}` })
    }

    for (const { dir, label } of dirs) {
      const filePath = path.join(dir, source.file)
      const parsed = await readJsonSafe(filePath)
      if (!parsed || typeof parsed !== "object") continue

      const isProjectScoped = dir === projectDir
      const servers = parsed[source.key]
      addServersFromFile(servers, label, result, contributingSources, isProjectScoped)
    }
  }

  // Claude Code has a unique config structure — handle separately
  await discoverClaudeCode(projectDir, result, contributingSources)

  const serverNames = Object.keys(result)
  if (serverNames.length > 0) {
    log.info(
      `Discovered ${serverNames.length} MCP server(s) from ${contributingSources.join(", ")}: ${serverNames.join(", ")}`,
    )
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
