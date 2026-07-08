/**
 * Authoritative classification of a tool call's origin, stamped onto the tool
 * part's `state.metadata.source` so clients (chat webview, ...) render the right
 * badge without re-deriving it from tool-name prefixes.
 *
 *  - "builtin"  — native opencode tools (read/glob/bash/...)
 *  - "altimate" — Altimate-provided tools (sql_*, schema_*, finops_*, ...) AND
 *                 tools from the Datamates MCP server (Altimate-owned, just
 *                 delivered over MCP)
 *  - "mcp"      — third-party MCP tools
 *
 * Registry tools and MCP tools are resolved in separate loops (see
 * `session/prompt.ts` resolveTools), so each has its own classifier. The native
 * `skill` tool is a further special case: it loads skills of varying origin, so
 * its badge is classified per-call from the loaded skill's origin (see
 * `skillToolSource`) rather than from the tool id.
 */
export type ToolSource = "builtin" | "altimate" | "mcp"

/**
 * Native opencode tool ids. This set is small and stable; every other tool in
 * the registry is Altimate-provided, so new Altimate tools classify correctly
 * with no per-tool maintenance here.
 */
const NATIVE_TOOL_IDS = new Set<string>([
  "invalid",
  "question",
  "bash",
  "batch",
  "read",
  "glob",
  "grep",
  "list",
  "edit",
  "write",
  "multiedit",
  "task",
  "webfetch",
  "todowrite",
  "todoread",
  "websearch",
  "codesearch",
  "skill",
  "apply_patch",
  "lsp",
  "plan_exit",
  "plan_enter",
  "StructuredOutput",
])

/** MCP client-name prefixes that are Altimate-owned (Datamates as an MCP server). */
const ALTIMATE_MCP_PREFIXES = ["datamate"]

/** Classify a registry tool (never an MCP tool) as builtin vs Altimate. */
export function registryToolSource(id: string): ToolSource {
  return NATIVE_TOOL_IDS.has(id) ? "builtin" : "altimate"
}

/** Classify an MCP tool by its `<client>_<tool>` key: Altimate (Datamates) vs third-party. */
export function mcpToolSource(key: string): ToolSource {
  const lower = key.toLowerCase()
  return ALTIMATE_MCP_PREFIXES.some((p) => lower.startsWith(p)) ? "altimate" : "mcp"
}

/**
 * Classify a skill-load (the native `skill` tool) by the loaded skill's origin,
 * which the skill tool reports on its metadata (see `tool/skill.ts`). Altimate
 * ships its skills bundled with the CLI ("builtin" origin) — those wear the
 * Altimate mark. User-authored global/project skills stay neutral so the badge
 * doesn't over-claim third-party or personal skills. Origin arrives as `unknown`
 * (client metadata), so anything other than "builtin" is treated as neutral.
 */
export function skillToolSource(origin: unknown): ToolSource {
  return origin === "builtin" ? "altimate" : "builtin"
}

/**
 * Best-effort readable title for an MCP tool call, from its `<client>_<tool>`
 * key — e.g. "datamates_jira_get_issue" → "Jira Get Issue". Strips the leading
 * client segment and Title-Cases the rest. (Richer per-call titles are the MCP
 * server's job; this is the fallback so MCP rows aren't a bare snake_case id.)
 */
export function humanizeMcpTitle(key: string): string {
  const withoutClient = key.includes("_") ? key.slice(key.indexOf("_") + 1) : key
  const words = (withoutClient || key).split(/[_-]+/).filter(Boolean)
  if (words.length === 0) return key
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
}
