// altimate_change start — fork-local Log shim
// Upstream removed packages/opencode/src/util/log.ts (the imperative
// `Log.create({service})` / `Log.Default` model) during the v1.4.0 -> v1.17.9
// migration to Effect `Logging`. Our altimate observability/telemetry/memory code
// uses the old imperative API. This shim reproduces that surface over stderr so we
// stay decoupled from upstream's Effect-based logging churn. Repoint old
// `@/util/log` imports to `@/altimate/util/log`.
export namespace Log {
  export type Level = "DEBUG" | "INFO" | "WARN" | "ERROR"

  const levelPriority: Record<Level, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  }

  let level: Level = ((): Level => {
    const env = (process.env["ALTIMATE_LOG_LEVEL"] ?? process.env["OPENCODE_LOG_LEVEL"] ?? "").toUpperCase()
    return env === "DEBUG" || env === "INFO" || env === "WARN" || env === "ERROR" ? (env as Level) : "INFO"
  })()

  export function setLevel(input: Level): void {
    level = input
  }

  function shouldLog(input: Level): boolean {
    return printEnabled() && levelPriority[input] >= levelPriority[level]
  }

  // Whether log lines are written to stderr. Default is OFF (quiet) and is read LAZILY from
  // OPENCODE_PRINT_LOGS at emit time. This is deliberate: the TUI runs the server in-process
  // (cli/tui/worker.ts -> Server.Default().fetch), so an always-on stderr writer floods and
  // corrupts the TUI. The CLI's `--print-logs` middleware sets OPENCODE_PRINT_LOGS=1
  // (index.ts) AFTER this module is imported, so we must read it lazily, not at module load.
  //
  // Reading the env directly (instead of an `init()` the entrypoints must remember to call)
  // keeps this self-correcting: every v1.x upstream merge that rewrites the entrypoints has
  // dropped the old `Log.init({ print })` calls, which is exactly what re-flooded the TUI.
  // With a lazy env default there is nothing for a merge to drop. `init()` still exists for
  // tests and can force a value via the override below.
  function printEnabled(): boolean {
    const env = process.env["ALTIMATE_PRINT_LOGS"] ?? process.env["OPENCODE_PRINT_LOGS"]
    return env === "1" || env === "true"
  }
  export interface InitOptions {
    print: boolean
    dev?: boolean
    level?: Level
  }
  export function init(options: InitOptions): void {
    if (options.level) level = options.level
    // Force printing on/off through the same env var the lazy reader checks — one source of
    // truth, so there is no separate in-memory flag to get out of sync, and tests reset cleanly
    // by clearing the env. (Only tests call init(); production relies on the lazy env default.)
    process.env["OPENCODE_PRINT_LOGS"] = options.print ? "1" : "0"
  }

  export type Logger = {
    debug(message?: any, extra?: Record<string, any>): void
    info(message?: any, extra?: Record<string, any>): void
    warn(message?: any, extra?: Record<string, any>): void
    error(message?: any, extra?: Record<string, any>): void
    tag(key: string, value: string): Logger
    clone(): Logger
    time(
      message: string,
      extra?: Record<string, any>,
    ): {
      stop(): void
      [Symbol.dispose](): void
    }
  }

  function render(value: any): string {
    if (typeof value === "string") return value
    // Errors don't JSON.stringify usefully (message/stack are non-enumerable) —
    // surface them like the upstream util/log.ts did.
    if (value instanceof Error) {
      const cause = (value as { cause?: unknown }).cause
      return value.stack || `${value.name}: ${value.message}` + (cause ? ` (cause: ${render(cause)})` : "")
    }
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  function emit(service: string, tags: Record<string, string>, lvl: Level, message?: any, extra?: Record<string, any>) {
    if (!shouldLog(lvl)) return
    const parts: string[] = [new Date().toISOString(), `[${lvl}]`, `service=${service}`]
    for (const [k, v] of Object.entries(tags)) parts.push(`${k}=${v}`)
    if (message !== undefined) parts.push(render(message))
    if (extra) for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${render(v)}`)
    try {
      process.stderr.write(parts.join(" ") + "\n")
    } catch {
      // logging must never throw
    }
  }

  export interface Options {
    service: string
    [key: string]: any
  }

  export function create(options: Options): Logger {
    const service = options.service ?? "default"
    const tags: Record<string, string> = {}
    const self: Logger = {
      debug: (message, extra) => emit(service, tags, "DEBUG", message, extra),
      info: (message, extra) => emit(service, tags, "INFO", message, extra),
      warn: (message, extra) => emit(service, tags, "WARN", message, extra),
      error: (message, extra) => emit(service, tags, "ERROR", message, extra),
      tag: (key, value) => {
        tags[key] = value
        return self
      },
      clone: () => {
        const next = create({ service })
        for (const [k, v] of Object.entries(tags)) next.tag(k, v)
        return next
      },
      time: (message, extra) => {
        const start = Date.now()
        emit(service, tags, "INFO", message, extra)
        const stop = () => emit(service, tags, "INFO", `${message} (done)`, { ...extra, duration: Date.now() - start })
        return { stop, [Symbol.dispose]: stop }
      },
    }
    return self
  }

  export const Default = create({ service: "default" })
}
// altimate_change end
