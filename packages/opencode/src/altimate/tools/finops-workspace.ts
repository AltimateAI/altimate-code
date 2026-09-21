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

/** Where each served type keeps the usage data the FinOps tools read, so the model
 * can write the query the tool would have run. Keyed by canonical local driver type,
 * the key `servedInventory` reports. */
const USAGE_SOURCE: Readonly<Record<string, string>> = {
  snowflake:
    "the `SNOWFLAKE.ACCOUNT_USAGE` views (`QUERY_HISTORY`, `WAREHOUSE_METERING_HISTORY`, " +
    "`WAREHOUSE_LOAD_HISTORY`, `GRANTS_TO_ROLES`, `GRANTS_TO_USERS`)",
  bigquery: "`INFORMATION_SCHEMA.JOBS_BY_PROJECT`",
  databricks: "`system.query.history` and `system.billing.usage`",
  postgres: "`pg_stat_statements`",
}

export interface WorkspaceFallback {
  workspaceName: string
  /** Canonical local driver type the workspace serves, e.g. `snowflake`. */
  type: string
  /** The engine execute tool the model should call, e.g.
   * `datamate_snowflake_execute_database_query`. */
  modelKey: string
}

/**
 * The workspace-served execute tools for the types a FinOps operation supports, if
 * the session is bound to a workspace that serves any. Reads the session's precedence
 * snapshot only — the same reachability-filtered projection the awareness section
 * uses, so this never names a tool the caller's agent cannot call.
 */
export function workspaceFallbacks(sessionID: string, supportedTypes: readonly string[]): WorkspaceFallback[] {
  const precedence = Precedence.forSession(sessionID)
  if (!precedence?.enabled) return []
  return Precedence.servedInventory(precedence).flatMap(({ type, served }) => {
    if (!supportedTypes.includes(type)) return []
    const execute = served.find((row) => row.capability === "sql_execute")
    return execute ? [{ workspaceName: precedence.workspaceName, type, modelKey: execute.modelKey }] : []
  })
}

/** The sentence appended to a FinOps failure, or nothing when the workspace serves
 * none of the operation's types — then the local error stands on its own. */
export function workspaceFallbackNote(fallbacks: WorkspaceFallback[]): string | undefined {
  if (fallbacks.length === 0) return undefined
  const name = fallbacks[0].workspaceName
  const routes = fallbacks
    .map(({ type, modelKey }) => {
      const source = USAGE_SOURCE[type]
      return source ? `for ${type}, query ${source} with \`${modelKey}\`` : `for ${type}, use \`${modelKey}\``
    })
    .join("; ")
  return (
    `This tool only uses warehouse connections configured on this machine, and workspace "${name}" ` +
    `serves ${fallbacks.map((f) => f.type).join(", ")} through its integration engine instead. ` +
    `Run the same analysis through the workspace: ${routes}.`
  )
}

/**
 * Attach the workspace note to a failed FinOps result. The failure text is kept — the
 * local reason may still be the one to fix — and the engine tool is stamped on the
 * metadata so telemetry can tell a failure the model could route around from a dead
 * end.
 */
export function withWorkspaceFallback<T extends { metadata: Record<string, unknown>; output: string }>(
  sessionID: string,
  supportedTypes: readonly string[],
  result: T,
): T {
  const fallbacks = workspaceFallbacks(sessionID, supportedTypes)
  const note = workspaceFallbackNote(fallbacks)
  if (!note) return result
  return {
    ...result,
    metadata: { ...result.metadata, workspace_fallback: fallbacks.map((f) => f.modelKey) },
    output: `${result.output}\n\n${note}`,
  }
}
