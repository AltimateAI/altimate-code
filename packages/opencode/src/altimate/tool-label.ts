/**
 * Produces a readable, dbt-aware title for a tool call — e.g. "Reading customers
 * model" instead of a bare file path — so any client (chat webview, TUI, ...) can
 * render a descriptive label straight from the tool part's `state.title`.
 *
 * This is the source of truth for tool-call labels: it runs inside the tool
 * execute() wrapper (see `tool/tool.ts`) and rewrites the title every tool
 * returns. Only file-acting tools (whose native title is a bare path) are
 * rewritten; every other tool keeps the rich title it already emits.
 *
 * dbt naming ("model"/"seed"/...) is applied only when the path sits under the
 * matching directory, so it degrades to the plain filename off-dbt.
 */

/** File-acting tools whose native title is a bare path → gerund verb. */
const FILE_TOOL_VERBS: Record<string, string> = {
  read: "Reading",
  write: "Writing",
  edit: "Editing",
  multiedit: "Editing",
  glob: "Searching",
  grep: "Searching",
  list: "Listing",
}

/** dbt directory → singular noun used in the label. */
const DBT_DIR_KIND: Record<string, string> = {
  models: "model",
  seeds: "seed",
  macros: "macro",
  snapshots: "snapshot",
  tests: "test",
  analyses: "analysis",
  analysis: "analysis",
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

/**
 * Turn a file path into a friendly target:
 *  - under a known dbt dir → "<name> <kind>" with the sql/yaml/csv extension stripped
 *  - otherwise → the basename, extension kept (e.g. "dbt_project.yml", "index.ts")
 */
function friendlyTarget(rawPath: string): string {
  const segments = rawPath.replace(/\\/g, "/").replace(/^\.\//, "").split("/").filter(Boolean)
  const base = segments[segments.length - 1] ?? rawPath
  for (const segment of segments.slice(0, -1)) {
    const kind = DBT_DIR_KIND[segment.toLowerCase()]
    if (kind) {
      const name = base.replace(/\.(sql|ya?ml|csv)$/i, "")
      return `${name} ${kind}`
    }
  }
  return base
}

/** Extract the display target for a given file tool from its input args. */
function fileTarget(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool === "glob" || tool === "grep") {
    return asString(input["pattern"])
  }
  if (tool === "list") {
    const path = asString(input["path"])
    return path ? friendlyTarget(path) : undefined
  }
  // read / write / edit / multiedit
  const filePath = asString(input["filePath"]) ?? asString(input["path"])
  return filePath ? friendlyTarget(filePath) : undefined
}

/**
 * @param tool     the tool id (e.g. "read", "sql_analyze")
 * @param input    the tool's input args
 * @param rawTitle the title the tool itself returned (a bare path for file tools,
 *                 already human-readable for everything else)
 * @returns a humanized label for file tools, otherwise the tool's own title.
 */
export function describeToolCall(tool: string, input: unknown, rawTitle?: string): string | undefined {
  const fallback = asString(rawTitle)
  const verb = FILE_TOOL_VERBS[tool]
  if (verb && input && typeof input === "object") {
    const target = fileTarget(tool, input as Record<string, unknown>)
    if (target) return `${verb} ${target}`
  }
  // Non-file / rich-title tools: keep the title the tool already emitted.
  return fallback
}
