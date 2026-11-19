// altimate_change - new file
//
// `tool report-event`: the Claude Code plugin records usage as one usage-telemetry event each: what a
// person did with its lineage report, a session start (plugin and altimate-code versions, OS, the
// plugin's anonymous install id), or a feature used (which panel, command or gate, and its outcome).
// Each event is built from an allow-list of fields, each checked against a fixed pattern or list, so no
// model, column, file or project name, SQL or session text can ride along. This runs in the CLI, under
// its telemetry settings, so the usual opt-out turns it off.

import { InstallationVersion } from "@opencode-ai/core/installation/version"

export const REPORT_ACTIONS = ["summary_shown", "open_pressed", "command_run", "built", "build_failed", "no_browser"] as const
export type ReportAction = (typeof REPORT_ACTIONS)[number]

/** The plugin's own usage actions. */
export const PLUGIN_ACTIONS = ["plugin_session_start", "plugin_feature_used"] as const
export type PluginAction = (typeof PLUGIN_ACTIONS)[number]

/** The plugin's panels and commands, and its two gates. */
export const PLUGIN_FEATURES = [
  "lineage",
  "dbt_show",
  "profile_ctes",
  "scan_cost",
  "comments",
  "sql_graph",
  "health",
  "runs",
  "to_model",
  "cost_gate",
  "health_push_gate",
] as const
export type PluginFeature = (typeof PLUGIN_FEATURES)[number]

/** A panel opened or could not open; a gate held a command or let it through. */
export const PLUGIN_OUTCOMES = ["opened", "failed", "held", "allowed"] as const
export type PluginOutcome = (typeof PLUGIN_OUTCOMES)[number]

/** The OS as Claude Code names it. */
export const PLUGIN_OS = ["macos", "linux", "windows", "wsl", "unknown"] as const
export type PluginOs = (typeof PLUGIN_OS)[number]

/** A Claude Code session id as the plugin passes it: `claude:` and the host's own id. */
const HOST_SESSION = /^claude:[A-Za-z0-9_-]{1,128}$/
/** A SemVer 2.0 version (prerelease and build metadata included), up to 64 characters, or `unknown` when the plugin could not read its own. */
const NUMBER = "(?:0|[1-9]\\d{0,5})"
const PRERELEASE_PART = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)"
const PLUGIN_VERSION = new RegExp(
  `^(?:${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?|unknown)$`,
)
const MAX_VERSION = 64
/** The plugin's install id: a random (version 4) UUID it made on first run, lowercase. */
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type ReportEvent = { type: "lineage_report"; timestamp: number; session_id: string; action: ReportAction }
export type PluginSessionStartEvent = {
  type: "plugin_session_start"
  timestamp: number
  session_id: string
  plugin_version: string
  altimate_code_version: string
  os: PluginOs
  install_id: string
}
export type PluginFeatureUsedEvent = {
  type: "plugin_feature_used"
  timestamp: number
  session_id: string
  plugin_version: string
  install_id: string
  feature: PluginFeature
  outcome: PluginOutcome
}
export type UsageEvent = ReportEvent | PluginSessionStartEvent | PluginFeatureUsedEvent

/** The fields the plugin's actions take, as the command line gives them; a field the action does not take is refused. */
export type PluginFields = { pluginVersion?: unknown; installId?: unknown; os?: unknown; feature?: unknown; outcome?: unknown }

const ACTIONS: readonly string[] = [...REPORT_ACTIONS, ...PLUGIN_ACTIONS]
/** The fields each kind of action takes; any other one given is refused. */
const TAKES: Record<"lineage" | PluginAction, readonly (keyof PluginFields)[]> = {
  lineage: [],
  plugin_session_start: ["pluginVersion", "installId", "os"],
  plugin_feature_used: ["pluginVersion", "installId", "feature", "outcome"],
}
const FLAG: Record<keyof PluginFields, string> = {
  pluginVersion: "--plugin-version",
  installId: "--install-id",
  os: "--os",
  feature: "--feature",
  outcome: "--outcome",
}
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => list.includes(value as T)

/** The event for an action and a host session (and, for the plugin's actions, its fields), or why there is none. */
export function reportEvent(
  action: unknown,
  session: unknown,
  now = Date.now(),
  fields: PluginFields = {},
  cliVersion: string = InstallationVersion,
): UsageEvent | { error: string } {
  if (!oneOf(ACTIONS, action)) return { error: `the action must be one of ${ACTIONS.join(", ")}` }
  if (typeof session !== "string" || !HOST_SESSION.test(session)) return { error: "--session takes a Claude Code session id: claude:<id>" }
  const takes = TAKES[oneOf(PLUGIN_ACTIONS, action) ? action : "lineage"]
  const extra = (Object.keys(FLAG) as (keyof PluginFields)[]).filter((key) => fields[key] !== undefined && !takes.includes(key))
  if (extra.length > 0) return { error: `${action} does not take ${extra.map((key) => FLAG[key]).join(", ")}` }
  if (oneOf(REPORT_ACTIONS, action)) return { type: "lineage_report", timestamp: now, session_id: session, action }

  if (typeof fields.pluginVersion !== "string" || fields.pluginVersion.length > MAX_VERSION || !PLUGIN_VERSION.test(fields.pluginVersion))
    return { error: "--plugin-version takes the plugin's version: a semver, or unknown" }
  if (typeof fields.installId !== "string" || !INSTALL_ID.test(fields.installId)) return { error: "--install-id takes a lowercase random (version 4) UUID" }
  const common = { timestamp: now, session_id: session, plugin_version: fields.pluginVersion, install_id: fields.installId }
  if (action === "plugin_session_start") {
    if (!oneOf(PLUGIN_OS, fields.os)) return { error: `--os must be one of ${PLUGIN_OS.join(", ")}` }
    return { type: "plugin_session_start", ...common, altimate_code_version: cliVersion, os: fields.os }
  }
  if (!oneOf(PLUGIN_FEATURES, fields.feature)) return { error: `--feature must be one of ${PLUGIN_FEATURES.join(", ")}` }
  if (!oneOf(PLUGIN_OUTCOMES, fields.outcome)) return { error: `--outcome must be one of ${PLUGIN_OUTCOMES.join(", ")}` }
  return { type: "plugin_feature_used", ...common, feature: fields.feature, outcome: fields.outcome }
}
