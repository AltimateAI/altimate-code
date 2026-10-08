/**
 * Smaller default tool list, with a way to reach the rest.
 *
 * Every request carries the definitions of all built-in tools (about 20k tokens), and a session calls a
 * handful. This module decides, once per session and without a model, which of the data-engineering tools
 * are offered directly. The rest stay reachable through one fixed `tool_run` tool.
 *
 * Prompt-cache contract (the reason for this shape):
 *   - Tool definitions are the first block of the cached prompt prefix, ahead of the system prompt and the
 *     messages. Any change to them re-writes the cache for the whole conversation.
 *   - The offered list is a pure function of facts read once at session start (a dbt project, SQL files, a
 *     configured warehouse) and is remembered per session. It is identical on every step of the session,
 *     and identical across sessions that start from the same project state, so cross-session cache hits
 *     are kept for those.
 *   - A tool outside the list is never added to it. The model calls it through `tool_run`, whose
 *     definition does not change, so using it costs zero cache invalidations. (Adding the tool to the
 *     list at the next step would re-write the whole conversation once, at the cache-write price.)
 *   - A tool id this module does not know is always offered. A new tool therefore cannot disappear.
 */
import path from "path"
import { Filesystem } from "../util/filesystem"
import { SkillListing } from "./skill-listing"
import { Wildcard } from "../util/wildcard"
import type { Tool as AITool } from "ai"

export const TOOL_RUN = "tool_run"

/** Off until a live run shows no loss in task success; see the pull request. */
export const SMALLER_TOOL_LIST_DEFAULT = false

export function smallerToolListEnabled(configured: boolean | undefined): boolean {
  return SkillListing.switchEnabled("ALTIMATE_SMALLER_TOOL_LIST", configured, SMALLER_TOOL_LIST_DEFAULT)
}

export type Group =
  | "environment"
  | "warehouse_query"
  | "dbt"
  | "sql_quality"
  | "sql_compare"
  | "lineage"
  | "finops"
  | "access"
  | "governance"
  | "schema_utils"
  | "product_admin"
  | "memory"

/** Optional tools by group. A tool in no group is always offered. */
export const GROUPS: Record<Group, { label: string; tools: string[] }> = {
  environment: {
    label: "project and warehouse connections",
    tools: [
      "project_scan",
      "warehouse_list",
      "warehouse_test",
      "warehouse_add",
      "warehouse_install_driver",
      "warehouse_remove",
      "warehouse_discover",
    ],
  },
  warehouse_query: {
    label: "run SQL on a live warehouse, inspect and search its schema",
    tools: [
      "sql_execute",
      "sql_explain",
      "schema_inspect",
      "schema_index",
      "schema_search",
      "schema_cache_status",
      "sql_autocomplete",
      "data_diff",
    ],
  },
  dbt: {
    label: "dbt project analysis",
    tools: [
      "dbt_manifest",
      "dbt_unit_test_gen",
      "dbt_profiles",
      "dbt_lineage",
      "altimate_core_parse_dbt",
      "impact_analysis",
      "dbt_pr_review",
    ],
  },
  sql_quality: {
    label: "static SQL analysis, validation and fixing",
    tools: [
      "sql_analyze",
      "sql_optimize",
      "sql_format",
      "sql_fix",
      "sql_rewrite",
      "altimate_core_rewrite",
      "altimate_core_validate",
      "altimate_core_check",
      "altimate_core_fix",
      "altimate_core_semantics",
      "altimate_core_testgen",
      "altimate_core_correct",
      "altimate_core_grade",
      "altimate_core_complete",
      "altimate_core_extract_metadata",
    ],
  },
  sql_compare: {
    label: "compare or translate SQL and schemas",
    tools: [
      "sql_translate",
      "sql_diff",
      "schema_diff",
      "altimate_core_equivalence",
      "altimate_core_migration",
      "altimate_core_schema_diff",
      "altimate_core_compare",
    ],
  },
  lineage: {
    label: "column-level lineage",
    tools: ["lineage_check", "altimate_core_column_lineage", "altimate_core_track_lineage"],
  },
  finops: {
    label: "warehouse cost and usage",
    tools: [
      "finops_query_history",
      "finops_analyze_credits",
      "finops_expensive_queries",
      "finops_warehouse_advice",
      "finops_unused_resources",
    ],
  },
  access: {
    label: "warehouse roles and permissions",
    tools: ["finops_role_grants", "finops_role_hierarchy", "finops_user_roles"],
  },
  governance: {
    label: "PII detection, tags and policy",
    tools: [
      "schema_detect_pii",
      "schema_tags",
      "schema_tags_list",
      "altimate_core_classify_pii",
      "altimate_core_query_pii",
      "altimate_core_policy",
    ],
  },
  schema_utils: {
    label: "schema file utilities",
    tools: [
      "altimate_core_optimize_context",
      "altimate_core_prune_schema",
      "altimate_core_import_ddl",
      "altimate_core_export_ddl",
      "altimate_core_fingerprint",
      "altimate_core_introspection_sql",
      "altimate_core_resolve_term",
    ],
  },
  product_admin: {
    label: "product setup",
    tools: ["datamate_manager", "mcp_discover", "feedback_submit", "sample_setup"],
  },
  memory: {
    label: "saved memory notes",
    tools: [
      "altimate_memory_read",
      "altimate_memory_write",
      "altimate_memory_delete",
      "altimate_memory_audit",
      "altimate_memory_refresh",
      "altimate_memory_extract",
    ],
  },
}

/**
 * Optional tools that the default (builder) instructions direct the model to call by name. They are
 * offered whatever the project looks like, because the instructions would otherwise point at a tool that
 * is not in the list. A test keeps this in step with the instruction packs.
 */
export const NAMED_BY_PROMPT = [
  "sql_execute",
  "schema_inspect",
  "sql_analyze",
  "lineage_check",
  "warehouse_list",
  "warehouse_test",
  "dbt_lineage",
  "schema_search",
  "sql_fix",
  "altimate_core_validate",
  "altimate_core_fix",
  // named by the shipped setup and feedback commands
  "project_scan",
  "warehouse_add",
  "feedback_submit",
  "mcp_discover",
  // named by the workspace identity section of the system prompt
  "altimate_memory_read",
  "altimate_memory_write",
  // named by the skills catalogue in the default instructions
  "sql_optimize",
  "sql_explain",
  "dbt_unit_test_gen",
  "data_diff",
  "altimate_core_check",
  "altimate_core_grade",
  "altimate_core_equivalence",
]

export interface Facts {
  dbtProject: boolean
  sqlFiles: boolean
  warehouse: boolean
  /** The memory store already holds entries. */
  memory: boolean
}

const DBT_GROUPS: Group[] = ["environment", "dbt", "warehouse_query", "sql_quality", "lineage"]
const SQL_GROUPS: Group[] = ["sql_quality", "sql_compare", "lineage"]
const WAREHOUSE_GROUPS: Group[] = [
  "environment",
  "warehouse_query",
  "sql_quality",
  "sql_compare",
  "lineage",
  "finops",
  "access",
  "governance",
  "schema_utils",
]
const NO_FACT_GROUPS: Group[] = ["environment", "product_admin"]

export function groupsFor(facts: Facts): Set<Group> {
  const on = new Set<Group>()
  if (facts.memory) on.add("memory")
  if (facts.dbtProject) for (const g of DBT_GROUPS) on.add(g)
  if (facts.sqlFiles) for (const g of SQL_GROUPS) on.add(g)
  if (facts.warehouse) for (const g of WAREHOUSE_GROUPS) on.add(g)
  // No project signal: let the agent discover and set things up.
  if (!facts.dbtProject && !facts.sqlFiles && !facts.warehouse) for (const g of NO_FACT_GROUPS) on.add(g)
  return on
}

const GROUP_OF = new Map<string, Group>(
  (Object.entries(GROUPS) as [Group, { tools: string[] }][]).flatMap(([group, def]) =>
    def.tools.map((id) => [id, group] as const),
  ),
)
const NAMED = new Set(NAMED_BY_PROMPT)

/** Whether an agent's own instructions name the tool: then it is offered, whatever the project looks like. */
function namesTool(prompt: string, id: string): boolean {
  return prompt.length > 0 && new RegExp(`(^|[^A-Za-z0-9_])${id}($|[^A-Za-z0-9_])`).test(prompt)
}

/** Tool ids (of the native ones given) that are not offered directly under these groups. */
export function hiddenIds(nativeIds: Iterable<string>, on: ReadonlySet<Group>, agentPrompt = ""): string[] {
  const hidden: string[] = []
  for (const id of nativeIds) {
    const group = GROUP_OF.get(id)
    if (!group || on.has(group) || NAMED.has(id) || namesTool(agentPrompt, id)) continue
    hidden.push(id)
  }
  return hidden
}

/** Read the session-start facts. No model and no network; every check is a cheap local probe. */
export async function detectFacts(input: {
  directory: string
  /** The project boundary (the worktree): a dbt project above the session directory is found up to here. */
  root?: string
  /** The directory that holds the user-level `.altimate-code/connections.json`. */
  home: string
  memoryPresent: () => Promise<boolean>
}): Promise<Facts> {
  const dir = input.directory
  const [signals, above, memory, warehouse] = await Promise.all([
    scanProject(dir),
    dbtProjectAbove(dir, input.root),
    input.memoryPresent().catch(() => false),
    warehouseDeclared(dir, input.home),
  ])
  return { dbtProject: signals.dbtProject || above, sqlFiles: signals.sqlFiles, warehouse, memory }
}

/** A `dbt_project.yml` in a parent of the session directory, up to and including the project boundary. */
async function dbtProjectAbove(dir: string, root?: string): Promise<boolean> {
  if (!root) return false
  // Windows paths differ in case for the same folder.
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p)
  const boundary = fold(path.resolve(root))
  // No Git project: the worktree is the filesystem root, which is not a project boundary.
  if (boundary === path.dirname(boundary)) return false
  const inside = (candidate: string) => fold(candidate) === boundary || fold(candidate).startsWith(boundary + path.sep)
  let current = path.dirname(path.resolve(dir))
  while (inside(current) && current !== path.dirname(current)) {
    if (await Filesystem.exists(path.join(current, "dbt_project.yml"))) return true
    if (fold(current) === boundary) break
    current = path.dirname(current)
  }
  return false
}

const SKIP_DIRS = new Set(["node_modules", "dbt_packages", "target", "venv", "site-packages", "dist", "build"])
const MAX_DEPTH = 3
const MAX_DIRS = 400
const MAX_ENTRIES_PER_DIR = 500

/**
 * Look for a dbt project and SQL files in the project directory and up to three levels below it, so a
 * monorepo with dbt in a subfolder is recognised. Bounded (directories, entries per directory and depth), skips dot-directories and
 * dependency or build folders, and reads names only.
 */
async function scanProject(root: string): Promise<{ dbtProject: boolean; sqlFiles: boolean }> {
  const { readdir } = await import("fs/promises")
  let dbtProject = false
  let sqlFiles = false
  let dirs = 0
  let level = [root]
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
    const next: string[] = []
    for (const dir of level) {
      if (++dirs > MAX_DIRS) return { dbtProject, sqlFiles }
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      // Marker files are checked in every entry; the cap applies to the folders walked into, so a large
      // folder neither hides a marker next to it nor crowds out its siblings.
      const folders: string[] = []
      for (const entry of entries) {
        if (entry.isFile()) {
          if (entry.name === "dbt_project.yml") dbtProject = true
          else if (entry.name.toLowerCase().endsWith(".sql")) sqlFiles = true
        } else if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
          folders.push(entry.name)
        }
      }
      for (const name of folders.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_ENTRIES_PER_DIR)) {
        next.push(path.join(dir, name))
      }
      if (dbtProject && sqlFiles) return { dbtProject, sqlFiles }
    }
    level = next
  }
  return { dbtProject, sqlFiles }
}

/**
 * Whether any warehouse connection is declared for this project: the project's or the user's
 * connections file has an entry, or a connection environment variable is set. Read from the files
 * directly, not from the connection registry, which is process-wide and keeps the first project's
 * connections loaded for every later one.
 */
async function warehouseDeclared(dir: string, home: string): Promise<boolean> {
  // The same acceptance as the connection registry: a config object that has a `type`.
  const usable = (value: unknown) => !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("ALTIMATE_CODE_CONN_") || !value) continue
    try {
      if (usable(JSON.parse(value))) return true
    } catch {
      // not JSON: the registry ignores it too
    }
  }
  const { readFile } = await import("fs/promises")
  for (const file of [path.join(dir, ".altimate-code", "connections.json"), path.join(home, ".altimate-code", "connections.json")]) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf-8"))
      if (parsed && typeof parsed === "object" && Object.values(parsed).some(usable)) return true
    } catch {
      // absent or unreadable: not declared
    }
  }
  return false
}

/** Decided once per session in this process. The decision is the set of groups; it is not recomputed. */
const decided = new Map<string, Promise<ReadonlySet<Group>>>()

export function decide(sessionID: string, facts: () => Promise<Facts>): Promise<ReadonlySet<Group>> {
  // The promise is stored before it settles, so concurrent callers share one decision.
  const known = decided.get(sessionID)
  if (known) return known
  const pending = facts().then(groupsFor)
  decided.set(sessionID, pending)
  pending.catch(() => decided.delete(sessionID))
  return pending
}

/**
 * Whether the rules leave the generated router callable. A blanket `*` deny does not count against it
 * (the router carries only the targets that were checked one by one); a rule that names `tool_run`, or a
 * wildcard that reaches it more specifically (`tool_*`), does.
 */
export function routerAllowed(rules: readonly { permission: string; pattern: string; action: string }[]): boolean {
  // The last matching rule decides, as in `PermissionNext.disabled`. One exception: when that rule is the
  // catch-all `*` deny, a specific deny before it still counts, so a blanket deny cannot hide an explicit one.
  const matching = [...rules].reverse().filter((rule) => Wildcard.match(TOOL_RUN, rule.permission))
  const last = matching[0]
  if (!last) return true
  if (last.permission !== "*") return last.action !== "deny" || last.pattern !== "*"
  if (last.action !== "deny" || last.pattern !== "*") return true
  const specific = matching.find((rule) => rule.permission !== "*")
  return !specific || specific.action !== "deny" || specific.pattern !== "*"
}

/** Drop a session's decision when the session is deleted. A resumed session keeps its decision. */
export function forget(sessionID: string) {
  decided.delete(sessionID)
}

/** Test helper. */
export function reset(sessionID?: string) {
  if (sessionID) decided.delete(sessionID)
  else decided.clear()
}

/** The tools behind `tool_run` for a given `tool_run` object, so a mis-addressed call can be rerouted. */
const hiddenByRunTool = new WeakMap<object, Record<string, AITool>>()
export function attachHidden(runTool: object, hidden: Record<string, AITool>) {
  hiddenByRunTool.set(runTool, hidden)
}
export function hiddenFor(runTool: object | undefined): Record<string, AITool> | undefined {
  return runTool ? hiddenByRunTool.get(runTool) : undefined
}

/** One line per group: the group's purpose and the tool ids in it. Stable for a given set. */
export function renderIndex(hidden: readonly string[]): string {
  const set = new Set(hidden)
  const lines: string[] = []
  for (const def of Object.values(GROUPS)) {
    const ids = def.tools.filter((id) => set.has(id))
    if (ids.length > 0) lines.push(`- ${def.label}: ${ids.join(", ")}`)
  }
  return lines.join("\n")
}

export function runDescription(hidden: readonly string[]): string {
  return [
    "Run a tool that is not in your tool list. Pass its exact name and its own parameters as `arguments`.",
    "These tools are available this way (use tool_lookup with a name to see its parameters):",
    renderIndex(hidden),
    "A tool listed in your tool list is called directly, not through this tool.",
  ].join("\n")
}

export * as ToolSelection from "./tool-selection"
