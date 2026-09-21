// altimate_change - new file
//
// The FinOps tools run their SQL through connections configured on this machine —
// `~/.altimate-code/connections.json`, the project's, `ALTIMATE_CODE_CONN_*` — and
// nothing else. A project bound to a workspace whose warehouse credentials live in the
// workspace has none of those, so every `finops_*` call fails, and the workspace's own
// cost skills steer the model to exactly these tools first. A bare `FAILED` there sends
// the model through four failures before it thinks of the engine tool that works.
//
// This is the reason and the way out, appended to every FinOps failure when the
// session's bound workspace serves a type the tool supports. It is advice, not a
// redirect: the FinOps SQL is not routed through the engine (that is the option the
// issue prefers and a larger change — the engine's result shape is not a contract the
// native handlers can parse), so the model is told which engine tool to run the same
// usage-table query through instead.
import * as Precedence from "../workspace/precedence"
import { workspaceLabel } from "../workspace/workspace-name"

/** The FinOps operations, named as the wrapper knows them. */
export type FinopsOperation =
  | "query_history"
  | "analyze_credits"
  | "expensive_queries"
  | "warehouse_advice"
  | "unused_resources"
  | "role_grants"
  | "role_hierarchy"
  | "user_roles"

/** Where each operation's data lives, per served type — the tables the native
 * handler itself reads (`native/finops/*.ts`), so the model writes the query the
 * tool would have run. Keyed by canonical local driver type, the key
 * `servedInventory` reports; an operation/type pair with no entry gets the tool
 * name alone rather than a table that holds something else. BigQuery's
 * INFORMATION_SCHEMA views are only reachable region-qualified (`bq-utils.ts`), and
 * the snapshot does not carry the integration's region, so the placeholder is
 * spelled out rather than a bare name that would fail again. */
const SOURCE: Readonly<Record<FinopsOperation, Readonly<Record<string, string>>>> = {
  query_history: {
    snowflake: "`SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY`",
    bigquery: "`region-<location>.INFORMATION_SCHEMA.JOBS`",
    databricks: "`system.query.history`",
    postgres: "`pg_stat_statements`",
  },
  analyze_credits: {
    snowflake: "`SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY` and `QUERY_HISTORY`",
    bigquery: "`region-<location>.INFORMATION_SCHEMA.JOBS`",
    databricks: "`system.billing.usage` and `system.query.history`",
  },
  expensive_queries: {
    snowflake: "`SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY`",
    bigquery: "`region-<location>.INFORMATION_SCHEMA.JOBS`",
    databricks: "`system.query.history`",
  },
  warehouse_advice: {
    snowflake: "`SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY` and `QUERY_HISTORY`, plus `SHOW WAREHOUSES`",
    bigquery: "`region-<location>.INFORMATION_SCHEMA.JOBS` and `JOBS_TIMELINE`",
    databricks: "`system.compute.warehouse_events` and `system.query.history`",
  },
  unused_resources: {
    snowflake: "`SNOWFLAKE.ACCOUNT_USAGE.TABLE_STORAGE_METRICS`, `ACCESS_HISTORY`, `WAREHOUSES` and `QUERY_HISTORY`",
    bigquery: "`region-<location>.INFORMATION_SCHEMA.TABLE_STORAGE`",
    databricks: "`system.information_schema.tables`",
  },
  role_grants: {
    snowflake: "`SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES`",
    bigquery: "`region-<location>.INFORMATION_SCHEMA.OBJECT_PRIVILEGES`",
    databricks: "`system.information_schema.table_privileges`",
  },
  role_hierarchy: { snowflake: "`SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES` (granted_on = 'ROLE')" },
  user_roles: { snowflake: "`SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_USERS`" },
}

export interface WorkspaceFallback {
  workspaceName: string
  /** The bound workspace's numeric id, the stable half of its identity. */
  workspaceId?: string
  /** Canonical local driver type the workspace serves, e.g. `snowflake`. */
  type: string
  /** The engine execute tool the model should call, e.g.
   * `datamate_snowflake_execute_database_query`. */
  modelKey: string
}

/** What the failure path learns about the workspace, in one read. */
export type FallbackLookup =
  | { state: "current"; fallbacks: WorkspaceFallback[] }
  | { state: "relinked" | "unreadable" }

/**
 * The workspace-served execute tools for the types a FinOps operation supports, if the
 * session is bound to a workspace that serves any. Reads the session's precedence
 * snapshot only — the same reachability-filtered projection the awareness section
 * uses, so this never names a tool the caller's agent cannot call — and re-validates
 * the snapshot once, as `check()` does before a redirect: a note naming a workspace
 * the project has since left would send the model to that workspace's engine.
 */
export async function workspaceFallbacks(sessionID: string, supportedTypes: readonly string[]): Promise<FallbackLookup> {
  const precedence = Precedence.forSession(sessionID)
  if (!precedence?.enabled) return { state: "current", fallbacks: [] }
  const fallbacks = Precedence.servedInventory(precedence).flatMap(({ type, served }) => {
    if (!supportedTypes.includes(type)) return []
    const execute = served.find((row) => row.capability === "sql_execute")
    return execute
      ? [{ workspaceName: precedence.workspaceName, workspaceId: precedence.workspaceId, type, modelKey: execute.modelKey }]
      : []
  })
  if (fallbacks.length === 0) return { state: "current", fallbacks }
  const state = await Precedence.snapshotState(precedence)
  return state === "current" ? { state, fallbacks } : { state }
}

/** The sentence appended to a FinOps failure, or nothing when the workspace serves
 * none of the operation's types — then the local error stands on its own. */
export function workspaceFallbackNote(operation: FinopsOperation, fallbacks: WorkspaceFallback[]): string | undefined {
  if (fallbacks.length === 0) return undefined
  // The canonical identity rendering: the name is customer-authored and is quoted
  // safely, and the id — the stable half — rides along.
  const label = workspaceLabel(fallbacks[0].workspaceName, fallbacks[0].workspaceId)
  const routes = fallbacks
    .map(({ type, modelKey }) => {
      const source = SOURCE[operation][type]
      return source ? `for ${type}, query ${source} with \`${modelKey}\`` : `for ${type}, use \`${modelKey}\``
    })
    .join("; ")
  // The snapshot does not carry a BigQuery integration's location, and the engine
  // runs what it is given: the placeholder has to be explained, not left to be sent.
  const region = fallbacks.some((f) => f.type === "bigquery" && SOURCE[operation].bigquery)
    ? " Replace `<location>` with the BigQuery connection's location (for example `region-us`, `region-eu`); " +
      "if it is unknown, ask the engine for the connection's details first — the view is not reachable unqualified."
    : ""
  return (
    `This tool only uses warehouse connections configured on this machine, and workspace ${label} ` +
    `serves ${fallbacks.map((f) => f.type).join(", ")} through its integration engine instead. ` +
    `Run the same analysis through the workspace: ${routes}.${region}`
  )
}

/** Why the fallback could not be decided, when that is uncertainty rather than a
 * choice. Deliberate disablement (unbound, pilot off, `--integrations=local`, nothing
 * materialised) says nothing: that is the plain local failure. Uncertainty must say so
 * (the precedence module's first claim), so the failure is marked `undetermined` and
 * says the workspace could not be consulted — mirroring `check()`'s own cases. */
function undeterminedNote(sessionID: string, lookup: FallbackLookup): string | undefined {
  if (lookup.state === "unreadable") {
    return "The workspace link could not be read while this call ran, so whether the workspace serves this connection type is unknown."
  }
  if (lookup.state === "relinked") {
    return "The workspace binding changed while this call ran, so the previous routing decision no longer applies."
  }
  const precedence = Precedence.forSession(sessionID)
  // No snapshot at all is the same unknown `check()` reports: a caller that never
  // resolved tools, or an entry evicted between resolution and this call.
  if (!precedence) {
    return "No routing decision was available for this call, so whether the linked workspace serves this connection type is unknown."
  }
  const reason = precedence.disabledReason
  if (reason === "unattributed" || reason === "binding-unreadable" || reason === "derive-failed") {
    return (
      "Whether the linked workspace serves this connection type could not be determined this turn " +
      "(no routing decision was available), so no workspace alternative is offered here."
    )
  }
  return undefined
}

/**
 * Attach the workspace note to a failed FinOps result. The failure text is kept — the
 * local reason may still be the one to fix — and the engine tool is stamped on the
 * metadata so telemetry can tell a failure the model could route around from a dead
 * end.
 */
export async function withWorkspaceFallback<T extends { metadata: Record<string, unknown>; output: string }>(
  sessionID: string,
  operation: FinopsOperation,
  supportedTypes: readonly string[],
  result: T,
): Promise<T> {
  const lookup = await workspaceFallbacks(sessionID, supportedTypes)
  const note = lookup.state === "current" ? workspaceFallbackNote(operation, lookup.fallbacks) : undefined
  if (note && lookup.state === "current") {
    return {
      ...result,
      metadata: { ...result.metadata, workspace_fallback: lookup.fallbacks.map((f) => f.modelKey) },
      output: `${result.output}\n\n${note}`,
    }
  }
  const undetermined = undeterminedNote(sessionID, lookup)
  if (!undetermined) return result
  return {
    ...result,
    metadata: { ...result.metadata, precedence: "undetermined" },
    output: `${result.output}\n\n${undetermined}`,
  }
}
