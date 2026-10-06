// altimate_change start — debug report: pure analysis and rendering (no I/O), so every rule is testable
/**
 * Builds the `altimate debug bundle` report from facts gathered by `collect.ts`.
 * Everything here is a pure function of its input. The report is meant to be read
 * by the user before they send it, so it leads with plain-language findings and
 * keeps raw evidence below them.
 */

export interface RedactContext {
  home?: string
  username?: string
  hostname?: string
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** Any `scheme://` URL, not only http: `snowflake://`, `jdbc:postgresql://` and the like carry passwords in queries. */
const URL_QUERY = /([a-z][a-z0-9+.-]*:\/\/[^\s"'?#]+)\?[^\s"']*/gi
/** `scheme://user:secret@host`: the secret goes, the user name is handled with the rest. */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+):[^\s@/"']+@/gi
/**
 * A key that ENDS in a secret word (`client_secret`, `PGPASSWORD`, `aws_secret_access_key`, `accessToken`), followed
 * by `=` or `:`, then a quoted value in full or a bare value up to a separator. The key may itself be quoted (JSON).
 */
const SECRET_KV =
  /([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|passphrase|authorization|credentials?))(["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"',;&}]+)/gi
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g
const PEM = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Removes secrets, emails, URL queries, and the user's home folder and name from any text. */
export function redact(text: string, ctx: RedactContext = {}): string {
  let out = text.replace(PEM, "<private key>")
  out = out.replace(BEARER, "$1 <redacted>")
  out = out.replace(URL_USERINFO, "$1:<redacted>@")
  out = out.replace(SECRET_KV, "$1$2<redacted>")
  out = out.replace(URL_QUERY, "$1?<query removed>")
  out = out.replace(EMAIL, "<email>")
  if (ctx.home && ctx.home.length > 3) {
    for (const form of new Set([ctx.home, ctx.home.replace(/\\/g, "\\\\"), ctx.home.replace(/\\/g, "/")])) {
      out = out.replace(new RegExp(escapeRegExp(form), "gi"), "~")
    }
  }
  if (ctx.hostname && ctx.hostname.length > 2) {
    // Often the owner's real name ("Janes-MacBook-Pro.local"). The short form too: terminals and `STY` drop the domain.
    const short = ctx.hostname.split(".")[0]
    for (const form of new Set([ctx.hostname, ...(short.length > 3 ? [short] : [])])) {
      out = out.replace(new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(form)}(?![A-Za-z0-9-])`, "gi"), "<host>")
    }
  }
  if (ctx.username && ctx.username.length > 2) {
    // Where a user name appears as a name, not as an ordinary word: after a path separator, a dash (folder names
    // derived from paths, "-Users-<name>-project"), "=", ":" or "@", or as "~name". A user called "code" or "dev"
    // must not turn the report's own prose into "<user>".
    out = out.replace(new RegExp(`(?<=[/\\\\=:@~-])${escapeRegExp(ctx.username)}(?![A-Za-z0-9])`, "gi"), "<user>")
  }
  return out
}

// ---------------------------------------------------------------------------
// Log analysis
// ---------------------------------------------------------------------------

export interface LogLine {
  timestamp: string
  level: string
  run: string
  message: string
  fields: Record<string, string>
  raw: string
}

const LINE = /^timestamp=(\S+) level=(\S+)(?: run=(\S+))? (.*)$/

/** `key=value` and `key="quoted value"` pairs from the rest of a log line. */
function parseFields(rest: string): Record<string, string> {
  const fields: Record<string, string> = {}
  const re = /([A-Za-z_][\w.-]*)=("((?:[^"\\]|\\.)*)"|\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(rest))) fields[m[1]] = m[3] !== undefined ? m[3] : m[2]
  return fields
}

export function parseLog(text: string): LogLine[] {
  const out: LogLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw)
    if (!m) continue
    const fields = parseFields(m[4])
    out.push({ timestamp: m[1], level: m[2], run: m[3] ?? "", message: fields.message ?? "", fields, raw })
  }
  return out
}

/** Collapses variable parts (numbers, ids, quoted paths) so repeats of one problem count as one. */
export function messageTemplate(line: LogLine): string {
  const base = line.message || line.raw.slice(0, 120)
  const extra = ["key", "service", "category", "phase"].map((k) => (line.fields[k] ? `${k}=${line.fields[k]}` : "")).filter(Boolean)
  return [base, ...extra].join(" ").replace(/\b[0-9a-f]{8,}\b/gi, "#").replace(/\d+/g, "#").slice(0, 160)
}

export interface LogFindings {
  lines: number
  firstAt?: string
  lastAt?: string
  starts: number
  /** Starts per day, newest last. */
  startsByDay: Array<{ day: string; starts: number }>
  problems: Array<{ level: string; template: string; count: number; lastAt: string }>
  mcpFailures: Array<{ server: string; count: number; lastError: string }>
  connectFailures: Array<{ category: string; count: number; lastAt: string }>
  signIns: { waiting: number; completed: number; failed: number }
  stalls: Array<{ at: string; thread: string; blockedMs: number }>
  snapshotFailures: number
  /**
   * Runs whose last debug trace shows a tool still running. `pid` comes from the run's start line; `alive` is filled
   * in by the collector: true means that process is still running (another open window), so the tool may simply
   * still be working; false means it ended mid-tool; undefined means it could not be checked.
   */
  endedMidTool: Array<{ run: string; at: string; tools: string; pid?: number; alive?: boolean }>
  debugTracing: boolean
  /** Project loads in log lines with no run id (older logs): they cannot be tied to a process, so they are shown on
   * their own rather than counted as app starts. */
  unattributedLoads: number
  /** A start line said debug mode was on, whether or not any tool call followed. */
  debugOn: boolean
}

export function analyzeLog(lines: LogLine[]): LogFindings {
  const problems = new Map<string, { level: string; template: string; count: number; lastAt: string }>()
  const mcp = new Map<string, { count: number; lastError: string }>()
  const connect = new Map<string, { count: number; lastAt: string }>()
  const startsByDay = new Map<string, number>()
  const stalls: LogFindings["stalls"] = []
  const signIns = { waiting: 0, completed: 0, failed: 0 }
  const inFlight = new Map<string, Map<string, string>>() // run -> callID -> tool
  const lastAtByRun = new Map<string, string>()
  const pidByRun = new Map<string, number>()
  let snapshotFailures = 0
  let debugTracing = false
  let debugOn = false
  let unattributedLoads = 0
  /** Each run's first timestamp, and what kind of start it shows: a start line (main or worker thread), or only
   * project loads (logs written before start lines existed). A process counts once however many projects it loads. */
  const runFirstAt = new Map<string, string>()
  const runStart = new Map<string, "main" | "worker" | "loads-only">()

  for (const l of lines) {
    if (l.run) lastAtByRun.set(l.run, l.timestamp)
    if (l.run && !runFirstAt.has(l.run)) runFirstAt.set(l.run, l.timestamp)
    if (l.message === "altimate-code started") {
      if (l.run && Number(l.fields.pid) > 0) pidByRun.set(l.run, Number(l.fields.pid))
      if (l.fields.debug === "true") debugOn = true
      if (l.run) runStart.set(l.run, l.fields.thread === "worker" ? "worker" : "main")
    }
    if (l.message === "creating instance") {
      // A load with no run id cannot be tied to a process (one process may load several projects).
      if (!l.run) unattributedLoads++
      else if (!runStart.has(l.run)) runStart.set(l.run, "loads-only")
    }
    if (l.level === "WARN" || l.level === "ERROR") {
      const t = messageTemplate(l)
      const k = `${l.level} ${t}`
      const p = problems.get(k) ?? { level: l.level, template: t, count: 0, lastAt: l.timestamp }
      p.count++
      p.lastAt = l.timestamp
      problems.set(k, p)
    }
    if (l.message === "server unavailable" && l.fields.key) {
      const e = mcp.get(l.fields.key) ?? { count: 0, lastError: "" }
      e.count++
      e.lastError = l.fields.error ?? l.fields.status ?? ""
      mcp.set(l.fields.key, e)
    }
    if (l.message === "connect failed") {
      const cat = l.fields.category ?? "other"
      const e = connect.get(cat) ?? { count: 0, lastAt: l.timestamp }
      e.count++
      e.lastAt = l.timestamp
      connect.set(cat, e)
    }
    if (l.message === "browser sign-in") {
      const phase = l.fields.phase as keyof typeof signIns
      if (phase in signIns) signIns[phase]++
    }
    if (l.message === "event loop stall") {
      stalls.push({ at: l.timestamp, thread: l.fields.thread ?? "?", blockedMs: Number(l.fields.blocked_ms) || 0 })
    }
    if (l.message === "failed to add snapshot files" || l.message === "cleanup failed") snapshotFailures++
    if (l.message === "tool start" && l.fields.call) {
      debugTracing = true
      const runMap = inFlight.get(l.run) ?? new Map<string, string>()
      runMap.set(l.fields.call, l.fields.tool ?? "?")
      inFlight.set(l.run, runMap)
    }
    if (l.message === "tool end" && l.fields.call) inFlight.get(l.run)?.delete(l.fields.call)
  }

  for (const [run, kind] of runStart) {
    if (kind === "worker") continue // the TUI's worker belongs to a process already counted by its main thread
    const day = (runFirstAt.get(run) ?? "").slice(0, 10)
    if (day) startsByDay.set(day, (startsByDay.get(day) ?? 0) + 1)
  }

  const endedMidTool: LogFindings["endedMidTool"] = []
  for (const [run, calls] of inFlight) {
    if (calls.size === 0) continue
    endedMidTool.push({ run, at: lastAtByRun.get(run) ?? "", tools: [...new Set(calls.values())].join(", "), pid: pidByRun.get(run) })
  }

  return {
    lines: lines.length,
    firstAt: lines[0]?.timestamp,
    lastAt: lines[lines.length - 1]?.timestamp,
    starts: [...startsByDay.values()].reduce((a, b) => a + b, 0),
    startsByDay: [...startsByDay.entries()].sort().map(([day, n]) => ({ day, starts: n })),
    problems: [...problems.values()].sort((a, b) => b.count - a.count),
    mcpFailures: [...mcp.entries()].map(([server, v]) => ({ server, ...v })).sort((a, b) => b.count - a.count),
    connectFailures: [...connect.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.count - a.count),
    signIns,
    stalls,
    snapshotFailures,
    endedMidTool,
    debugTracing,
    debugOn,
    unattributedLoads,
  }
}

/** Marks each run that left a tool unfinished with whether its process is still running. Without a pid (a log from
 * before start lines carried one) it stays unknown, and the report says "unconfirmed". */
export function withLiveness(log: LogFindings, alive: (pid: number) => boolean): LogFindings {
  return { ...log, endedMidTool: log.endedMidTool.map((e) => (e.pid ? { ...e, alive: alive(e.pid) } : e)) }
}

// ---------------------------------------------------------------------------
// Facts and findings
// ---------------------------------------------------------------------------

export interface ConnectionFact {
  name: string
  type: string
  auth: string
  /** Field names present in the saved config (never values). */
  fields: string[]
  /** For password-style auth: whether a password is available after loading saved credentials. */
  passwordAvailable?: boolean
}

export interface NetworkCheck {
  target: string
  host: string
  ok: boolean
  detail: string
  ms?: number
}

export interface Facts {
  generatedAt: string
  version: string
  installMethod?: string
  os: string
  arch: string
  runtime: string
  terminal: Record<string, string>
  proxy: Record<string, string>
  envFlags: string[]
  debugMode: boolean
  /** `checked: false` when it was not determined (with `--no-network`, telemetry is not started). */
  telemetry: { enabled: boolean; reason?: string; checked?: boolean }
  account: { configured: boolean; instance?: string; apiHost?: string }
  connections: ConnectionFact[]
  /** undefined when no configuration file could be read. */
  mcpServers?: Array<{ name: string; type: string; enabled: boolean }>
  network: NetworkCheck[]
  logPath?: string
  log?: LogFindings
  logTail: string[]
}

export interface Finding {
  severity: "problem" | "warning" | "info"
  title: string
  detail: string
}

const PASSWORD_AUTHS = new Set(["password", "username_password_mfa"])
/** File-backed engines need no sign-in, and BigQuery with no key file uses Application Default Credentials, so
 * "unknown" is not a problem for them. */
const NO_SIGN_IN_TYPES = new Set(["duckdb", "sqlite", "bigquery"])

/** Whether a connection's sign-in could be missing: password-style, or no method detected at all. */
export function needsPassword(c: Pick<ConnectionFact, "auth" | "type">): boolean {
  return PASSWORD_AUTHS.has(c.auth) || (c.auth === "unknown" && !NO_SIGN_IN_TYPES.has(c.type))
}

export function detectProblems(f: Facts): Finding[] {
  const out: Finding[] = []
  const log = f.log

  for (const c of f.connections) {
    if (needsPassword(c) && c.passwordAvailable === false) {
      out.push({
        severity: "problem",
        title: `Connection '${c.name}' has no password or other sign-in details`,
        detail:
          c.auth === "unknown"
            ? 'No password, key, token or single sign-on setting is saved for it, so every connection attempt will fail ("A password must be specified"). This happens when a password could not be saved to the system credential store. Re-add the connection, or switch it to key-pair authentication.'
            : "It uses password sign-in, but no password was found in the saved connection or the system credential store, so every connection attempt will fail. Re-add the connection, or switch it to key-pair authentication.",
      })
    }
  }

  const ended = log?.endedMidTool.filter((e) => e.alive === false) ?? []
  if (ended.length) {
    const last = ended[ended.length - 1]
    out.push({
      severity: "problem",
      title: `Altimate Code ended while a tool was still running (${ended.length} time${ended.length === 1 ? "" : "s"})`,
      detail: `Most recently at ${last.at}, during: ${last.tools}. The process stopped without finishing the tool, which is also when terminal input can be left in mouse-reporting mode.`,
    })
  }
  const unconfirmed = log?.endedMidTool.filter((e) => e.alive === undefined) ?? []
  if (unconfirmed.length) {
    const last = unconfirmed[unconfirmed.length - 1]
    out.push({
      severity: "warning",
      title: `A tool call never finished in the log (${unconfirmed.length} run${unconfirmed.length === 1 ? "" : "s"}), unconfirmed`,
      detail: `Most recently at ${last.at}, during: ${last.tools}. Whether that process ended could not be checked, so it may still have been running elsewhere.`,
    })
  }

  const sso = log?.connectFailures.find((c) => c.category === "sso_not_completed")
  if (sso || (log && log.signIns.waiting > log.signIns.completed)) {
    out.push({
      severity: "problem",
      title: "Browser sign-ins to the warehouse were not completed",
      detail: `${log?.signIns.waiting ?? 0} sign-in${log?.signIns.waiting === 1 ? " was" : "s were"} requested and ${log?.signIns.completed ?? 0} completed. Check that a sign-in page opens in the browser when connecting; if it never does, key-pair authentication avoids the browser step.`,
    })
  }

  for (const c of log?.connectFailures ?? []) {
    if (c.category === "sso_not_completed") continue
    out.push({
      severity: c.count >= 3 ? "problem" : "warning",
      title: `Warehouse connections failed: ${c.category} (${c.count}×)`,
      detail: `Last at ${c.lastAt}. See "Log: repeated warnings and errors" below for the messages.`,
    })
  }

  for (const n of f.network.filter((n) => !n.ok)) {
    out.push({
      severity: "problem",
      title: `Cannot reach ${n.target}`,
      detail: `${n.host}: ${n.detail}. ${Object.keys(f.proxy).length ? "A proxy is configured; check it allows this host." : "No proxy is configured; if the network requires one, set HTTPS_PROXY."}`,
    })
  }

  if (f.telemetry.checked !== false && !f.telemetry.enabled) {
    out.push({
      severity: "info",
      title: "Telemetry is off",
      detail: `${f.telemetry.reason ?? "Disabled"}. Usage diagnostics from this machine do not reach Altimate, so this report is the main source of information.`,
    })
  }

  // Without the configured list (unreadable config), the log's failures are still reported.
  for (const m of f.mcpServers?.length !== 0 ? (log?.mcpFailures ?? []) : []) {
    if (m.count < 3) continue
    out.push({
      severity: "warning",
      title: `MCP server '${m.server}' keeps failing to start (${m.count}×)`,
      detail: `Last error: ${m.lastError || "unknown"}. Its tools are unavailable; fix or remove it in the MCP configuration.`,
    })
  }

  const longStalls = (log?.stalls ?? []).filter((s) => s.blockedMs >= 30_000)
  if (longStalls.length) {
    out.push({
      severity: "warning",
      title: `The app was unresponsive for 30 s or more ${longStalls.length} time${longStalls.length === 1 ? "" : "s"}`,
      detail: `Longest: ${Math.round(Math.max(...longStalls.map((s) => s.blockedMs)) / 1000)} s. A stall reported at the same moment by two threads is usually the computer sleeping, not the app.`,
    })
  }

  if ((log?.snapshotFailures ?? 0) >= 20) {
    out.push({
      severity: "warning",
      title: `Undo snapshots are failing (${log!.snapshotFailures}×)`,
      detail: "Altimate Code could not snapshot some project files (often open Office lock files or nested folders), so undoing agent edits may not work in this project.",
    })
  }

  if (log && !log.debugTracing && log.debugOn) {
    out.push({
      severity: "info",
      title: "Debug mode was on, but no tool calls were traced",
      detail: "Debug mode was on, but the agent made no tool calls in this log, so there is nothing to trace yet. Reproduce the problem with debug mode on, then run this command again.",
    })
  } else if (!log?.debugTracing) {
    out.push({
      severity: "info",
      title: "Debug mode was not on",
      detail: "Turn it on (set ALTIMATE_DEBUG=1 before starting Altimate Code), reproduce the problem, then run this command again; the report will then show what each tool was doing.",
    })
  }

  const order = { problem: 0, warning: 1, info: 2 }
  return out.sort((a, b) => order[a.severity] - order[b.severity])
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function table(header: string[], rows: string[][]): string {
  if (!rows.length) return "_None._\n"
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ].join("\n") + "\n"
}

export function renderReport(f: Facts, findings: Finding[]): string {
  const icon = { problem: "PROBLEM", warning: "WARNING", info: "INFO" }
  const parts: string[] = []
  parts.push(`# Altimate Code debug report\n`)
  parts.push(
    `Generated ${f.generatedAt} by Altimate Code ${f.version}. Passwords, keys, tokens, email addresses, URL parameters and your home folder and user name have been removed. Please read it before sending.\n`,
  )

  parts.push(`## Findings\n`)
  if (!findings.length) parts.push("No problems detected.\n")
  for (const x of findings) parts.push(`- **${icon[x.severity]}: ${x.title}.** ${x.detail}`)
  parts.push("")

  parts.push(`## Environment\n`)
  parts.push(
    table(
      ["Item", "Value"],
      [
        ["Version", f.version],
        ["Install method", f.installMethod ?? "unknown"],
        ["OS", `${f.os} (${f.arch})`],
        ["Runtime", f.runtime],
        ["Debug traces in the log", f.log?.debugTracing ? "yes" : f.log?.debugOn ? "no (debug mode on, no tool calls)" : "no (debug mode was off)"],
        [
          "Telemetry",
          f.telemetry.checked === false
            ? `not checked${f.telemetry.reason ? ` (${f.telemetry.reason})` : ""}`
            : f.telemetry.enabled
              ? "on"
              : `off${f.telemetry.reason ? ` (${f.telemetry.reason})` : ""}`,
        ],
        ["Altimate account", f.account.configured ? `${f.account.instance ?? "?"} @ ${f.account.apiHost ?? "?"}` : "not configured"],
        ...Object.entries(f.terminal).map(([k, v]) => [`Terminal: ${k}`, v]),
        ...Object.entries(f.proxy).map(([k, v]) => [`Proxy: ${k}`, v]),
        ["Settings in the environment", f.envFlags.join(", ") || "none"],
      ],
    ),
  )

  parts.push(`## Warehouse connections\n`)
  parts.push(
    table(
      ["Name", "Type", "Sign-in", "Password available", "Fields set"],
      f.connections.map((c) => [
        c.name,
        c.type,
        c.auth,
        c.passwordAvailable === undefined ? "n/a" : c.passwordAvailable ? "yes" : "NO",
        c.fields.join(", "),
      ]),
    ),
  )

  parts.push(`## Network\n`)
  parts.push(table(["Target", "Host", "Result", "Time"], f.network.map((n) => [n.target, n.host, n.ok ? `ok (${n.detail})` : `FAILED: ${n.detail}`, n.ms !== undefined ? `${n.ms} ms` : ""])))

  parts.push(`## MCP servers\n`)
  if (f.mcpServers) parts.push(table(["Name", "Type", "Enabled"], f.mcpServers.map((m) => [m.name, m.type, m.enabled ? "yes" : "no"])))
  else parts.push("No configuration file could be read, so MCP servers are not listed.\n")

  const log = f.log
  parts.push(`## Log summary\n`)
  if (!log) parts.push(`No log file found${f.logPath ? ` at ${f.logPath}` : ""}.\n`)
  else {
    parts.push(
      `${log.lines} lines from ${log.firstAt ?? "?"} to ${log.lastAt ?? "?"}; ${log.starts} app starts` +
        (log.unattributedLoads ? ` (plus ${log.unattributedLoads} project loads in older lines that cannot be tied to a process)` : "") +
        `. Browser sign-ins: ${log.signIns.waiting} requested, ${log.signIns.completed} completed, ${log.signIns.failed} failed.\n`,
    )
    parts.push(`### Runs that ended while a tool was running\n`)
    parts.push(
      table(
        ["Run", "Last activity", "Tools not finished", "Process"],
        log.endedMidTool.map((e) => [e.run, e.at, e.tools, e.alive === undefined ? "unknown" : e.alive ? "still running (or its pid was reused)" : "ended"]),
      ),
    )
    parts.push(`### Warehouse connection failures\n`)
    parts.push(table(["Category", "Count", "Last"], log.connectFailures.map((c) => [c.category, String(c.count), c.lastAt])))
    parts.push(`### MCP servers that failed to start\n`)
    parts.push(table(["Server", "Count", "Last error"], log.mcpFailures.map((m) => [m.server, String(m.count), m.lastError])))
    parts.push(`### App starts per day (last 14 days)\n`)
    parts.push(table(["Day", "Starts"], log.startsByDay.slice(-14).map((d) => [d.day, String(d.starts)])))
    parts.push(`### Stalls of 5 s or more\n`)
    parts.push(table(["When", "Thread", "Blocked"], log.stalls.filter((s) => s.blockedMs >= 5000).slice(-30).map((s) => [s.at, s.thread, `${Math.round(s.blockedMs / 1000)} s`])))
    parts.push(`### Log: repeated warnings and errors\n`)
    parts.push(table(["Level", "Count", "Last", "Message"], log.problems.slice(0, 40).map((p) => [p.level, String(p.count), p.lastAt, p.template])))
  }

  parts.push(`## Recent log lines\n`)
  parts.push("```\n" + (f.logTail.join("\n") || "(empty)") + "\n```\n")
  return parts.join("\n")
}
// altimate_change end
