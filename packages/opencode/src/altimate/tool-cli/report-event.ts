// altimate_change - new file
//
// `tool report-event`: the Claude Code plugin records what a person did with its lineage report, as one
// usage-telemetry event. Only the action and the host session are sent: no model, column, file or project
// names. The plugin's page itself stays offline; this runs in the CLI, under its telemetry settings, so the
// usual opt-out turns it off.

export const REPORT_ACTIONS = ["summary_shown", "open_pressed", "command_run", "built", "build_failed", "no_browser"] as const
export type ReportAction = (typeof REPORT_ACTIONS)[number]

/** A Claude Code session id as the plugin passes it: `claude:` and the host's own id. */
const HOST_SESSION = /^claude:[A-Za-z0-9_-]{1,128}$/

export type ReportEvent = { type: "lineage_report"; timestamp: number; session_id: string; action: ReportAction }

/** The event for an action and a host session, or why there is none. */
export function reportEvent(action: unknown, session: unknown, now = Date.now()): ReportEvent | { error: string } {
  if (!REPORT_ACTIONS.includes(action as ReportAction)) return { error: `the action must be one of ${REPORT_ACTIONS.join(", ")}` }
  if (typeof session !== "string" || !HOST_SESSION.test(session)) return { error: "--session takes a Claude Code session id: claude:<id>" }
  return { type: "lineage_report", timestamp: now, session_id: session, action: action as ReportAction }
}
