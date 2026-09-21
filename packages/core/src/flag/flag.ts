import { Config, Option } from "effect"

// altimate_change start — every OPENCODE_* variable is documented under its ALTIMATE_CLI_*
// name (docs/docs/usage/cli.md), so the documented spelling is read first and the OPENCODE_
// one is the fallback. This is the one definition of that rule: the opencode `Flag`
// namespace and the Effect `Config`-backed services (`effect/config-service.ts`) import it,
// so every read path — this object, that namespace, `RuntimeFlags` — agrees. #1329 was one
// flag that missed the dual read; a cross-check found the table mostly in that state.
// An empty documented value counts as unset: `ALTIMATE_CLI_CONFIG=""` must not hide a real
// `OPENCODE_CONFIG`.
export function documentedAlias(key: string): string | undefined {
  return key.startsWith("OPENCODE_") ? "ALTIMATE_CLI_" + key.slice("OPENCODE_".length) : undefined
}

/** The variable as the environment has it now, documented name first. For the few sites
 * that must read at call time rather than through the import-time constants below. */
export function env(key: string): string | undefined {
  const alias = documentedAlias(key)
  const documented = alias !== undefined ? process.env[alias] : undefined
  return documented !== undefined && documented !== "" ? documented : process.env[key]
}

export function truthy(key: string) {
  const value = env(key)?.toLowerCase()
  return value === "true" || value === "1"
}

/** An Effect `Config` boolean with the same documented-name-first rule, for the flags
 * that are resolved through the ambient ConfigProvider rather than `process.env`. The
 * documented value is read as a string and judged by `truthy`'s rule, so a set-but-invalid
 * documented value is `false` — not a fallback to the OPENCODE_ one, which `Config.orElse`
 * (and `Config.option`) would silently do, since both swallow parse failures. */
function bool(key: string) {
  const alias = documentedAlias(key)
  const fallback = Config.boolean(key).pipe(Config.withDefault(false))
  if (alias === undefined) return fallback
  return Config.all({ documented: Config.string(alias).pipe(Config.option), fallback }).pipe(
    Config.map(({ documented, fallback }) => {
      const value = Option.getOrUndefined(documented)
      if (value === undefined || value === "") return fallback
      const lower = value.toLowerCase()
      return lower === "true" || lower === "1"
    }),
  )
}
// altimate_change end

// altimate_change start — dual env var support: ALTIMATE_CLI_* (primary) + OPENCODE_* (fallback).
// Re-homed from packages/opencode/src/flag/flag.ts so the extracted TUI (packages/tui, which
// depends on core not opencode) can read the fork flags it uses. A set documented value wins
// outright — a documented `false` is not overridden by a fallback `true`.
function altTruthy(altKey: string, openKey: string) {
  const documented = process.env[altKey]
  return documented !== undefined && documented !== "" ? truthy(altKey) : truthy(openKey)
}
function numberEnv(key: string) {
  const value = env(key)
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
// altimate_change end

// altimate_change start — documented ALTIMATE_CLI_ name read first (see `env`)
const copy = env("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
const fff = env("OPENCODE_DISABLE_FFF")
// altimate_change end

function enabledByExperimental(key: string) {
  // altimate_change start — documented ALTIMATE_CLI_ name read first (see `env`)
  return env(key) === undefined ? truthy("OPENCODE_EXPERIMENTAL") : truthy(key)
  // altimate_change end
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  OPENCODE_AUTO_HEAP_SNAPSHOT: truthy("OPENCODE_AUTO_HEAP_SNAPSHOT"),
  // altimate_change start — documented ALTIMATE_CLI_ name read first (see `env`)
  OPENCODE_GIT_BASH_PATH: env("OPENCODE_GIT_BASH_PATH"),
  OPENCODE_CONFIG: env("OPENCODE_CONFIG"),
  OPENCODE_CONFIG_CONTENT: env("OPENCODE_CONFIG_CONTENT"),
  // altimate_change end
  OPENCODE_DISABLE_AUTOUPDATE: truthy("OPENCODE_DISABLE_AUTOUPDATE"),
  OPENCODE_ALWAYS_NOTIFY_UPDATE: truthy("OPENCODE_ALWAYS_NOTIFY_UPDATE"),
  OPENCODE_DISABLE_PRUNE: truthy("OPENCODE_DISABLE_PRUNE"),
  OPENCODE_DISABLE_TERMINAL_TITLE: truthy("OPENCODE_DISABLE_TERMINAL_TITLE"),
  OPENCODE_SHOW_TTFD: truthy("OPENCODE_SHOW_TTFD"),
  OPENCODE_DISABLE_AUTOCOMPACT: truthy("OPENCODE_DISABLE_AUTOCOMPACT"),
  OPENCODE_DISABLE_MODELS_FETCH: truthy("OPENCODE_DISABLE_MODELS_FETCH"),
  OPENCODE_DISABLE_MOUSE: truthy("OPENCODE_DISABLE_MOUSE"),
  // altimate_change start — documented ALTIMATE_CLI_ name read first (see `env`)
  OPENCODE_FAKE_VCS: env("OPENCODE_FAKE_VCS"),
  OPENCODE_SERVER_PASSWORD: env("OPENCODE_SERVER_PASSWORD"),
  OPENCODE_SERVER_USERNAME: env("OPENCODE_SERVER_USERNAME"),
  // altimate_change end
  OPENCODE_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("OPENCODE_DISABLE_FFF"),

  // Experimental
  // altimate_change start — documented ALTIMATE_CLI_ name read first (see `bool`)
  OPENCODE_EXPERIMENTAL_FILEWATCHER: bool("OPENCODE_EXPERIMENTAL_FILEWATCHER"),
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: bool("OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER"),
  // altimate_change end
  OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  // altimate_change start — documented ALTIMATE_CLI_ name read first (see `env`)
  OPENCODE_MODELS_URL: env("OPENCODE_MODELS_URL"),
  OPENCODE_MODELS_PATH: env("OPENCODE_MODELS_PATH"),
  OPENCODE_DB: env("OPENCODE_DB"),
  // altimate_change end

  // altimate_change start — documented ALTIMATE_CLI_ name read first (see `env`)
  OPENCODE_WORKSPACE_ID: env("OPENCODE_WORKSPACE_ID"),
  // altimate_change end
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
  /**
   * Workspace precedence escape hatch, set by `--integrations=local`. When on, the
   * native warehouse tools serve every local connection themselves and nothing is
   * redirected to the bound workspace's integration engine, for the whole session.
   */
  get ALTIMATE_INTEGRATIONS_LOCAL() {
    return process.env["ALTIMATE_INTEGRATIONS"]?.toLowerCase() === "local"
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
  // altimate_change start — documented ALTIMATE_CLI_ name read first (see `env`)
  get OPENCODE_TUI_CONFIG() {
    return env("OPENCODE_TUI_CONFIG")
  },
  get OPENCODE_CONFIG_DIR() {
    return env("OPENCODE_CONFIG_DIR")
  },
  // altimate_change end
  get OPENCODE_PURE() {
    return truthy("OPENCODE_PURE")
  },
  // altimate_change start — documented ALTIMATE_CLI_ name read first (see `env`)
  get OPENCODE_PERMISSION() {
    return env("OPENCODE_PERMISSION")
  },
  get OPENCODE_PLUGIN_META_FILE() {
    return env("OPENCODE_PLUGIN_META_FILE")
  },
  get OPENCODE_CLIENT() {
    return env("OPENCODE_CLIENT") ?? "cli"
  },
  // altimate_change end
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
    // Empty counts as unset, as everywhere else in this file.
    const alt = process.env["ALTIMATE_CLI_YOLO"]
    if (alt !== undefined && alt !== "") {
      const v = alt.toLowerCase()
      return v === "true" || v === "1"
    }
    const oc = env("OPENCODE_YOLO")?.toLowerCase()
    return oc === "true" || oc === "1"
  },
  // altimate_change end
}
