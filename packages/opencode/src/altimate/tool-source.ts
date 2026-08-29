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
 * `session/prompt.ts` resolveTools and `session/tools.ts` SessionTools.resolve),
 * so each has its own classifier — but both loops stamp via the shared
 * `stampRegistryToolSource` / `describeMcpTool` helpers below so they can't drift.
 * The native `skill` tool is a further special case: it loads skills of varying
 * origin, so its badge is classified per-call from the loaded skill's origin (see
 * `skillToolSource`) rather than from the tool id.
 */
export type ToolSource = "builtin" | "altimate" | "mcp"

/**
 * Where a registry tool comes from, declared at registration time so we don't
 * have to infer ownership from the tool id:
 *  - "native"   — a native opencode tool (read/glob/bash/...)
 *  - "altimate" — an Altimate-shipped tool registered directly in the registry
 *  - "external" — a user-authored custom tool or a third-party plugin tool
 *
 * Only "external" strictly needs to be declared: without it, the id-based
 * fallback in `registryToolSource` treats every non-native id as Altimate, which
 * over-claims ownership of custom/plugin tools (see `fromPlugin` in
 * `tool/registry.ts`). Native and Altimate tools may omit it and rely on the id
 * fallback.
 */
export type RegistryToolOrigin = "native" | "altimate" | "external"

/**
 * Native opencode tool ids. This set is small and stable; every other tool in
 * the registry is Altimate-provided, so new Altimate tools classify correctly
 * with no per-tool maintenance here.
 */
const NATIVE_TOOL_IDS = new Set<string>([
  "invalid",
  "question",
  "terminal",
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

/** MCP client names that are Altimate-owned (Datamates as an MCP server). */
const ALTIMATE_MCP_PREFIXES = ["datamate"]

/**
 * Classify a registry tool (never an MCP tool) as builtin vs Altimate. Prefers
 * the origin declared at registration; only falls back to the id when a tool
 * doesn't declare one (native + Altimate tools registered directly). "external"
 * (user custom / third-party plugin) maps to the neutral "builtin" badge so the
 * Altimate mark never over-claims tools we don't own.
 */
export function registryToolSource(id: string, origin?: RegistryToolOrigin): ToolSource {
  switch (origin) {
    case "external":
      return "builtin"
    case "altimate":
      return "altimate"
    case "native":
      return "builtin"
  }
  return NATIVE_TOOL_IDS.has(id) ? "builtin" : "altimate"
}

/**
 * Classify an MCP tool by its original (pre-sanitize) client name: Altimate
 * (Datamates) vs third-party. Classifying from the real client name — rather than
 * re-parsing the flattened `<client>_<tool>` key — avoids mislabeling a
 * third-party server whose name sanitizes into a `datamate…`-prefixed key (e.g.
 * client `datamate.ai` → key `datamate_ai_query`, whose first segment is
 * `datamate`). Accepts the exact name, its plural (`datamates`), and a
 * `datamate-…` prefixed client.
 */
export function mcpToolSource(clientName: string): ToolSource {
  const client = clientName.toLowerCase()
  return ALTIMATE_MCP_PREFIXES.some((p) => client === p || client === `${p}s` || client.startsWith(`${p}-`))
    ? "altimate"
    : "mcp"
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

/** Mirror of `sanitize()` in `mcp/catalog.ts` — MCP keys are built from sanitized names. */
const sanitizeMcpName = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

/**
 * Best-effort readable title for an MCP tool call, from its `<client>_<tool>`
 * key — e.g. "datamates_jira_get_issue" → "Jira Get Issue". Strips the client
 * segment and Title-Cases the rest. When the original client name is known the
 * segment is stripped by its exact sanitized length (robust to client names that
 * themselves contain underscores, e.g. `datamate.ai` → `datamate_ai`); otherwise
 * it falls back to splitting on the first `_`. (Richer per-call titles are the
 * MCP server's job; this is the fallback so MCP rows aren't a bare snake_case id.)
 */
export function humanizeMcpTitle(key: string, clientName?: string): string {
  const prefix = clientName ? `${sanitizeMcpName(clientName)}_` : ""
  const withoutClient =
    prefix && key.startsWith(prefix)
      ? key.slice(prefix.length)
      : key.includes("_")
        ? key.slice(key.indexOf("_") + 1)
        : key
  const words = (withoutClient || key).split(/[_-]+/).filter(Boolean)
  if (words.length === 0) return key
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
}

/**
 * A resolved registry tool, as seen by the two tool resolvers (`prompt.ts`
 * resolveTools and `session/tools.ts` SessionTools.resolve).
 */
interface RegistryToolLike {
  id: string
  registrySource?: RegistryToolOrigin
}

/**
 * Stamp the authoritative `source` badge onto a registry tool's output metadata.
 * Shared by both tool resolvers so their per-call stamping cannot drift. The
 * native `skill` tool is classified per-call from the loaded skill's origin
 * (`state.metadata.skillOrigin`); every other tool from its declared/inferred
 * origin.
 */
export function stampRegistryToolSource<T extends { metadata?: Record<string, any> }>(
  output: T,
  item: RegistryToolLike,
): T & { metadata: Record<string, any> & { source: ToolSource } } {
  const metadata = output.metadata ?? {}
  const source =
    item.id === "skill" ? skillToolSource(metadata.skillOrigin) : registryToolSource(item.id, item.registrySource)
  return { ...output, metadata: { ...metadata, source } }
}

/**
 * Authoritative `source` badge + readable `title` for an MCP tool call, derived
 * from the original client name and the flattened key. Shared by both tool
 * resolvers so MCP stamping cannot drift.
 */
export function describeMcpTool(key: string, clientName: string): { source: ToolSource; title: string } {
  return { source: mcpToolSource(clientName), title: humanizeMcpTitle(key, clientName) }
}
