import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

// altimate_change start — dual env var support: ALTIMATE_CLI_* (primary) + OPENCODE_* (fallback).
// Re-homed from packages/opencode/src/flag/flag.ts so the extracted TUI (packages/tui, which
// depends on core not opencode) can read the fork flags it uses.
function altTruthy(altKey: string, openKey: string) {
  return truthy(altKey) || truthy(openKey)
}
function numberEnv(key: string) {
  const value = process.env[key]
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
// altimate_change end

const copy = process.env["OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["OPENCODE_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("OPENCODE_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  OPENCODE_AUTO_HEAP_SNAPSHOT: truthy("OPENCODE_AUTO_HEAP_SNAPSHOT"),
  OPENCODE_GIT_BASH_PATH: process.env["OPENCODE_GIT_BASH_PATH"],
  OPENCODE_CONFIG: process.env["OPENCODE_CONFIG"],
  OPENCODE_CONFIG_CONTENT: process.env["OPENCODE_CONFIG_CONTENT"],
  OPENCODE_DISABLE_AUTOUPDATE: truthy("OPENCODE_DISABLE_AUTOUPDATE"),
  OPENCODE_ALWAYS_NOTIFY_UPDATE: truthy("OPENCODE_ALWAYS_NOTIFY_UPDATE"),
  OPENCODE_DISABLE_PRUNE: truthy("OPENCODE_DISABLE_PRUNE"),
  OPENCODE_DISABLE_TERMINAL_TITLE: truthy("OPENCODE_DISABLE_TERMINAL_TITLE"),
  OPENCODE_SHOW_TTFD: truthy("OPENCODE_SHOW_TTFD"),
  OPENCODE_DISABLE_AUTOCOMPACT: truthy("OPENCODE_DISABLE_AUTOCOMPACT"),
  OPENCODE_DISABLE_MODELS_FETCH: truthy("OPENCODE_DISABLE_MODELS_FETCH"),
  OPENCODE_DISABLE_MOUSE: truthy("OPENCODE_DISABLE_MOUSE"),
  OPENCODE_FAKE_VCS: process.env["OPENCODE_FAKE_VCS"],
  OPENCODE_SERVER_PASSWORD: process.env["OPENCODE_SERVER_PASSWORD"],
  OPENCODE_SERVER_USERNAME: process.env["OPENCODE_SERVER_USERNAME"],
  OPENCODE_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("OPENCODE_DISABLE_FFF"),

  // Experimental
  OPENCODE_EXPERIMENTAL_FILEWATCHER: Config.boolean("OPENCODE_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  OPENCODE_MODELS_URL: process.env["OPENCODE_MODELS_URL"],
  OPENCODE_MODELS_PATH: process.env["OPENCODE_MODELS_PATH"],
  OPENCODE_DB: process.env["OPENCODE_DB"],

  OPENCODE_WORKSPACE_ID: process.env["OPENCODE_WORKSPACE_ID"],
  // Unrelated to ALTIMATE_WORKSPACE (SaaS project-binding pilot) — this gates upstream's multi-instance/worktree control plane.
  OPENCODE_EXPERIMENTAL_WORKSPACES: enabledByExperimental("OPENCODE_EXPERIMENTAL_WORKSPACES"),

  // altimate_change start — pilot flag for the Workspaces feature (post-scan prompt +
  // altimate link subcommand). Read as a getter so tests and the runtime `--` middleware
  // can flip it between plugin activation and command execution.
  //
  // Opt-in only — deliberately does NOT inherit ``OPENCODE_EXPERIMENTAL`` (as
  // ``enabledByExperimental`` would). The pilot ships behind its own explicit
  // gate so users already opted into other experimental features don't get
  // this one turned on for them. (Kilo cycle 6.)
  // Unrelated to OPENCODE_EXPERIMENTAL_WORKSPACES (multi-instance control plane) — this gates the SaaS project-binding pilot.
  get ALTIMATE_WORKSPACE() {
    return truthy("ALTIMATE_WORKSPACE")
  },
  // altimate_change end

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get OPENCODE_DISABLE_PROJECT_CONFIG() {
    return truthy("OPENCODE_DISABLE_PROJECT_CONFIG")
  },
  get OPENCODE_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("OPENCODE_EXPERIMENTAL_REFERENCES")
  },
  get OPENCODE_TUI_CONFIG() {
    return process.env["OPENCODE_TUI_CONFIG"]
  },
  get OPENCODE_CONFIG_DIR() {
    return process.env["OPENCODE_CONFIG_DIR"]
  },
  get OPENCODE_PURE() {
    return truthy("OPENCODE_PURE")
  },
  get OPENCODE_PERMISSION() {
    return process.env["OPENCODE_PERMISSION"]
  },
  get OPENCODE_PLUGIN_META_FILE() {
    return process.env["OPENCODE_PLUGIN_META_FILE"]
  },
  get OPENCODE_CLIENT() {
    return process.env["OPENCODE_CLIENT"] ?? "cli"
  },
  // altimate_change start — fork flags used by the extracted TUI (packages/tui). Getters so the
  // runtime-set yolo flag (set by --yolo middleware after module load) evaluates at access time.
  get ALTIMATE_CALM_MODE() {
    return altTruthy("ALTIMATE_CALM_MODE", "OPENCODE_CALM_MODE")
  },
  get ALTIMATE_SMOOTH_STREAMING() {
    return this.ALTIMATE_CALM_MODE || altTruthy("ALTIMATE_SMOOTH_STREAMING", "OPENCODE_SMOOTH_STREAMING")
  },
  get ALTIMATE_LINE_STREAMING() {
    return this.ALTIMATE_CALM_MODE || altTruthy("ALTIMATE_LINE_STREAMING", "OPENCODE_LINE_STREAMING")
  },
  get ALTIMATE_CONTENT_MAX_WIDTH() {
    return (
      numberEnv("ALTIMATE_CONTENT_MAX_WIDTH") ??
      numberEnv("OPENCODE_CONTENT_MAX_WIDTH") ??
      (this.ALTIMATE_CALM_MODE ? 100 : undefined)
    )
  },
  get ALTIMATE_CLI_YOLO() {
    const alt = process.env["ALTIMATE_CLI_YOLO"]
    if (alt !== undefined) {
      const v = alt.toLowerCase()
      return v === "true" || v === "1"
    }
    const oc = process.env["OPENCODE_YOLO"]?.toLowerCase()
    return oc === "true" || oc === "1"
  },
  // altimate_change end
}
