import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { Flag } from "../../flag/flag"
import { bootstrap } from "../bootstrap"
import { EOL } from "os"
import { Filesystem } from "../../util/filesystem"
import { createOpencodeClient, type Message, type OpencodeClient, type ToolPart } from "@opencode-ai/sdk/v2"
import { Server } from "../../server/server"
import { Provider } from "../../provider/provider"
import { Agent } from "../../agent/agent"
import { PermissionNext } from "../../permission/next"
import { Tool } from "../../tool/tool"
import { GlobTool } from "../../tool/glob"
import { GrepTool } from "../../tool/grep"
import { ListTool } from "../../tool/ls"
import { ReadTool } from "../../tool/read"
import { WebFetchTool } from "../../tool/webfetch"
import { EditTool } from "../../tool/edit"
import { WriteTool } from "../../tool/write"
import { CodeSearchTool } from "../../tool/codesearch"
import { WebSearchTool } from "../../tool/websearch"
import { TaskTool } from "../../tool/task"
import { SkillTool } from "../../tool/skill"
import { BashTool } from "../../tool/bash"
import { TodoWriteTool } from "../../tool/todo"
import { Locale } from "../../util/locale"
import { Tracer, FileExporter, HttpExporter, type TraceExporter } from "../../altimate/observability/tracing"
// altimate_change start — run accounting helpers (fork-only module)
import { RunAccounting } from "./run-accounting"
// altimate_change start — stable message id for idempotent prompt retries
import { MessageID } from "../../session/schema"
// altimate_change end
// altimate_change end
// altimate_change start — run implies run mode (fork-only module)
import { applyRunModeDefault } from "./run/run-mode"
// altimate_change end
// altimate_change start — run-mode-only idle-done fallback (fork-only modules).
// Detection lives in idle-done.ts; the confirm-DONE challenge text and the DONE
// token contract live in session/termination.ts; delivery goes through the nudge
// arbiter (at most one system-authored directive block per injected turn).
import { IdleDone } from "./idle-done"
import { NudgeArbiter } from "../../session/nudge"
import { SessionTermination } from "../../session/termination"
// altimate_change end
// altimate_change start — upstream_fix: type-only import for the tracing-config cast (see tracer setup below)
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
// altimate_change end

// When a tool's parameters can't be statically inferred (legacy fork tools whose
// param schema erases to `unknown`), fall back to a string-keyed record so the
// display helpers can still read fields like `input.name`/`input.command`.
type ToolInput<T> = unknown extends Tool.InferParameters<T> ? Record<string, unknown> : Tool.InferParameters<T>

type ToolProps<T = Tool.Info> = {
  input: ToolInput<T>
  metadata: Tool.InferMetadata<T>
  part: ToolPart
}

function props<T = Tool.Info>(part: ToolPart): ToolProps<T> {
  const state = part.state
  return {
    input: state.input as ToolInput<T>,
    metadata: ("metadata" in state ? state.metadata : {}) as Tool.InferMetadata<T>,
    part,
  }
}

type Inline = {
  icon: string
  title: string
  description?: string
}

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

function fallback(part: ToolPart) {
  const state = part.state
  const input = "input" in state ? state.input : undefined
  const title =
    ("title" in state && state.title ? state.title : undefined) ||
    (input && typeof input === "object" && Object.keys(input).length > 0 ? JSON.stringify(input) : "Unknown")
  inline({
    icon: "⚙",
    title: `${part.tool} ${title}`,
  })
}

function glob(info: ToolProps<typeof GlobTool>) {
  const root = info.input.path ?? ""
  const title = `Glob "${info.input.pattern}"`
  const suffix = root ? `in ${normalizePath(root)}` : ""
  const num = info.metadata.count
  const description =
    num === undefined ? suffix : `${suffix}${suffix ? " · " : ""}${num} ${num === 1 ? "match" : "matches"}`
  inline({
    icon: "✱",
    title,
    ...(description && { description }),
  })
}

function grep(info: ToolProps<typeof GrepTool>) {
  const root = info.input.path ?? ""
  const title = `Grep "${info.input.pattern}"`
  const suffix = root ? `in ${normalizePath(root)}` : ""
  const num = info.metadata.matches
  const description =
    num === undefined ? suffix : `${suffix}${suffix ? " · " : ""}${num} ${num === 1 ? "match" : "matches"}`
  inline({
    icon: "✱",
    title,
    ...(description && { description }),
  })
}

function list(info: ToolProps<typeof ListTool>) {
  const dir = info.input.path ? normalizePath(info.input.path) : ""
  inline({
    icon: "→",
    title: dir ? `List ${dir}` : "List",
  })
}

function read(info: ToolProps<typeof ReadTool>) {
  const file = normalizePath(info.input.filePath)
  const pairs = Object.entries(info.input).filter(([key, value]) => {
    if (key === "filePath") return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  const description = pairs.length ? `[${pairs.map(([key, value]) => `${key}=${value}`).join(", ")}]` : undefined
  inline({
    icon: "→",
    title: `Read ${file}`,
    ...(description && { description }),
  })
}

function write(info: ToolProps<typeof WriteTool>) {
  block(
    {
      icon: "←",
      title: `Write ${normalizePath(info.input.filePath)}`,
    },
    info.part.state.status === "completed" ? info.part.state.output : undefined,
  )
}

function webfetch(info: ToolProps<typeof WebFetchTool>) {
  inline({
    icon: "%",
    title: `WebFetch ${info.input.url}`,
  })
}

function edit(info: ToolProps<typeof EditTool>) {
  const title = normalizePath(info.input.filePath)
  const diff = info.metadata.diff
  block(
    {
      icon: "←",
      title: `Edit ${title}`,
    },
    diff,
  )
}

function codesearch(info: ToolProps<typeof CodeSearchTool>) {
  inline({
    icon: "◇",
    title: `Exa Code Search "${info.input.query}"`,
  })
}

function websearch(info: ToolProps<typeof WebSearchTool>) {
  inline({
    icon: "◈",
    title: `Exa Web Search "${info.input.query}"`,
  })
}

function task(info: ToolProps<typeof TaskTool>) {
  const input = info.part.state.input
  const status = info.part.state.status
  const subagent =
    typeof input.subagent_type === "string" && input.subagent_type.trim().length > 0 ? input.subagent_type : "unknown"
  const agent = Locale.titlecase(subagent)
  const desc =
    typeof input.description === "string" && input.description.trim().length > 0 ? input.description : undefined
  const icon = status === "error" ? "✗" : status === "running" ? "•" : "✓"
  const name = desc ?? `${agent} Task`
  inline({
    icon,
    title: name,
    description: desc ? `${agent} Agent` : undefined,
  })
}

function skill(info: ToolProps<typeof SkillTool>) {
  inline({
    icon: "→",
    title: `Skill "${info.input.name}"`,
  })
}

function bash(info: ToolProps<typeof BashTool>) {
  const output = info.part.state.status === "completed" ? info.part.state.output?.trim() : undefined
  block(
    {
      icon: "$",
      title: `${info.input.command}`,
    },
    output,
  )
}

function todo(info: ToolProps<typeof TodoWriteTool>) {
  block(
    {
      icon: "#",
      title: "Todos",
    },
    info.input.todos.map((item) => `${item.status === "completed" ? "[x]" : "[ ]"} ${item.content}`).join("\n"),
  )
}

function splitSqlStatements(sql: string): string[] {
  const stmts: string[] = []
  const current: string[] = []
  let inStr = false
  let strChar = ""
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (!inStr && (ch === "'" || ch === '"' || ch === "`")) {
      inStr = true
      strChar = ch
      current.push(ch)
    } else if (inStr && ch === strChar) {
      inStr = false
      current.push(ch)
    } else if (!inStr && ch === ";") {
      const s = current.join("").trim()
      if (s) stmts.push(s)
      current.length = 0
    } else {
      current.push(ch)
    }
  }
  const last = current.join("").trim()
  if (last) stmts.push(last)
  return stmts.length ? stmts : [sql]
}

function normalizePath(input?: string) {
  if (!input) return ""
  if (path.isAbsolute(input)) return path.relative(process.cwd(), input) || "."
  return input
}

export const RunCommand = cmd({
  command: "run [message..]",
  describe: "run altimate with a message",
  builder: (yargs: Argv) => {
    return (
      yargs
        .positional("message", {
          describe: "message to send",
          type: "string",
          array: true,
          default: [],
        })
        .option("command", {
          describe: "the command to run, use message for args",
          type: "string",
        })
        .option("continue", {
          alias: ["c"],
          describe: "continue the last session",
          type: "boolean",
        })
        .option("session", {
          alias: ["s"],
          describe: "session id to continue",
          type: "string",
        })
        .option("fork", {
          describe: "fork the session before continuing (requires --continue or --session)",
          type: "boolean",
        })
        .option("share", {
          type: "boolean",
          describe: "share the session",
        })
        .option("model", {
          type: "string",
          alias: ["m"],
          describe: "model to use in the format of provider/model",
        })
        .option("agent", {
          type: "string",
          describe: "agent to use",
        })
        .option("format", {
          type: "string",
          choices: ["default", "json"],
          default: "default",
          describe: "format: default (formatted) or json (raw JSON events)",
        })
        .option("file", {
          alias: ["f"],
          type: "string",
          array: true,
          describe: "file(s) to attach to message",
        })
        .option("title", {
          type: "string",
          describe: "title for the session (uses truncated prompt if no value provided)",
        })
        .option("attach", {
          type: "string",
          describe: "attach to a running altimate server (e.g., http://localhost:4096)",
        })
        .option("password", {
          alias: ["p"],
          type: "string",
          describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
        })
        .option("dir", {
          type: "string",
          describe: "directory to run in, path on remote server if attaching",
        })
        .option("port", {
          type: "number",
          describe: "port for the local server (defaults to random port if no value provided)",
        })
        .option("variant", {
          type: "string",
          describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
        })
        .option("thinking", {
          type: "boolean",
          describe: "show thinking blocks",
          default: false,
        })
        .option("output", {
          alias: ["o"],
          type: "string",
          describe: "write final assistant response to file (.md or .txt)",
        })
        .option("audience", {
          type: "string",
          choices: ["executive", "technical"] as const,
          describe: "output calibration: executive (no SQL/jargon, business framing) or technical (default)",
        })
        .option("query", {
          alias: ["q"],
          type: "number",
          describe: "when using --file with a SQL file, analyze only the Nth statement (1-indexed)",
        })
        .option("trace", {
          type: "boolean",
          describe: "enable session tracing (default: true, disable with --no-trace)",
          default: true,
        })
        // altimate_change start — budget limits for CI/enterprise governance
        .option("max-turns", {
          type: "number",
          describe: "maximum number of assistant turns before aborting the session",
        })
        // altimate_change end
        // altimate_change start — backport upstream PR #21266 (dropped during v1.4.0 merge)
        .option("dangerously-skip-permissions", {
          type: "boolean",
          describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
          default: false,
        })
    )
    // altimate_change end
  },
  handler: async (args) => {
    // altimate_change start — validate --max-turns before anything runs. yargs
    // coerces a non-numeric value to NaN, which is falsy and SILENTLY disabled
    // the budget; a negative value is truthy and aborted the session on its
    // very first step with a nonsense message. Both are configuration errors a
    // benchmark harness must hear about immediately, not discover afterwards.
    if (args.maxTurns !== undefined && !RunAccounting.isValidMaxTurns(args.maxTurns)) {
      UI.error(`--max-turns must be a positive integer (got ${String(args.maxTurns)})`)
      process.exit(1)
    }
    // altimate_change end
    // altimate_change start — `run` is the only entrypoint without an answer
    // channel for the question tool: no TUI is mounted and the in-process
    // Server.Default() shim below does not bind a port, so a connected IDE
    // or web client cannot POST /question/:requestID/reply. Without this
    // flag, Question.ask() awaits a Deferred forever and the parent
    // supervisor TaskStops the subprocess — looking exactly like a hang.
    // Server commands (serve/web/acp/workspace-serve) intentionally leave
    // this unset so their HTTP reply path stays live.
    //
    // Skipped when --attach is set: the agent runs on the remote server, so
    // the local env var would be a no-op and would only pollute the local
    // process env for other tools that may consult it.
    //
    // Child processes spawned by the bash tool would inherit this flag and
    // misbehave if they themselves are server-mode entrypoints; bash.ts
    // strips ALTIMATE_NON_INTERACTIVE from mergedEnv to prevent that leak.
    //
    // Users can opt out by exporting ALTIMATE_NON_INTERACTIVE=0 before
    // launching `run`. A blank/whitespace value is treated as unset — otherwise
    // a stray `export ALTIMATE_NON_INTERACTIVE=` would silently reintroduce the
    // exact headless hang this block exists to prevent.
    if (!args.attach && !process.env["ALTIMATE_NON_INTERACTIVE"]?.trim()) {
      process.env["ALTIMATE_NON_INTERACTIVE"] = "1"
    }
    // altimate_change end
    // altimate_change start — mark this process as run mode so
    // run-mode-only mechanisms (DONE-termination gate, starvation-breaker
    // directives, doom-loop escalation ladder) arm in the in-process session.
    // Explicit ALTIMATE_RUN_MODE=0 opts out; --attach skips entirely (the agent
    // runs on the remote, possibly interactive, server). See run/run-mode.ts.
    applyRunModeDefault(process.env, {
      attach: Boolean(args.attach),
      resumed: Boolean(args.continue || args.session),
    })
    // altimate_change end

    let message = [...args.message, ...(args["--"] || [])]
      .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
      .join(" ")

    const directory = (() => {
      if (!args.dir) return undefined
      if (args.attach) return args.dir
      try {
        process.chdir(args.dir)
        return process.cwd()
      } catch {
        UI.error("Failed to change directory to " + args.dir)
        process.exit(1)
      }
    })()

    const files: { type: "file"; url: string; filename: string; mime: string }[] = []
    if (args.file) {
      const list = Array.isArray(args.file) ? args.file : [args.file]

      for (const filePath of list) {
        const resolvedPath = path.resolve(process.cwd(), filePath)
        if (!(await Filesystem.exists(resolvedPath))) {
          UI.error(`File not found: ${filePath}`)
          process.exit(1)
        }

        const mime = (await Filesystem.isDir(resolvedPath)) ? "application/x-directory" : "text/plain"

        files.push({
          type: "file",
          url: pathToFileURL(resolvedPath).href,
          filename: path.basename(resolvedPath),
          mime,
        })
      }
    }

    // --query N: extract the Nth SQL statement from attached file(s) as a text part
    if (args.query !== undefined && args.file) {
      const fileList = Array.isArray(args.file) ? args.file : [args.file]
      const extractedParts: string[] = []
      for (const filePath of fileList) {
        const resolvedPath = path.resolve(process.cwd(), filePath)
        const content = await Bun.file(resolvedPath).text()
        const stmts = splitSqlStatements(content)
        const n = args.query
        if (n < 1 || n > stmts.length) {
          UI.error(
            `--query ${n} is out of range (${path.basename(filePath)} has ${stmts.length} statement${stmts.length === 1 ? "" : "s"})`,
          )
          process.exit(1)
        }
        extractedParts.push(
          `[${path.basename(filePath)}, statement ${n} of ${stmts.length}]\n\`\`\`sql\n${stmts[n - 1].trim()}\n\`\`\``,
        )
      }
      // Replace file attachments with extracted statement as inline text
      files.length = 0
      message = [extractedParts.join("\n\n"), message].filter(Boolean).join("\n\n")
    }

    // altimate_change start — null-safe stdin read. process.stdin can be
    // undefined in embedded/child runtimes (dev-punia review, PR #937).
    // Earlier revision used `!process.stdin?.isTTY`, which turned the crash
    // into a stall: undefined stdin satisfied the guard and we then awaited
    // Bun.stdin.text() on a stream that would never EOF. Skip the read
    // entirely when there is no stdin to read from.
    if (process.stdin && !process.stdin.isTTY) message += "\n" + (await Bun.stdin.text())
    // altimate_change end

    if (message.trim().length === 0 && !args.command) {
      UI.error("You must provide a message or a command")
      process.exit(1)
    }

    if (args.fork && !args.continue && !args.session) {
      UI.error("--fork requires --continue or --session")
      process.exit(1)
    }

    const rules: PermissionNext.Ruleset = [
      {
        permission: "question",
        action: "deny",
        pattern: "*",
      },
      {
        permission: "plan_enter",
        action: "deny",
        pattern: "*",
      },
      {
        permission: "plan_exit",
        action: "deny",
        pattern: "*",
      },
    ]

    function title() {
      if (args.title === undefined) return
      if (args.title !== "") return args.title
      return message.slice(0, 50) + (message.length > 50 ? "..." : "")
    }

    async function session(sdk: OpencodeClient) {
      const baseID = args.continue ? (await sdk.session.list()).data?.find((s) => !s.parentID)?.id : args.session

      if (baseID && args.fork) {
        const forked = await sdk.session.fork({ sessionID: baseID })
        return forked.data?.id
      }

      if (baseID) return baseID

      const name = title()
      const result = await sdk.session.create({ title: name, permission: rules })
      return result.data?.id
    }

    async function share(sdk: OpencodeClient, sessionID: string) {
      const cfg = await sdk.config.get()
      if (!cfg.data) return
      if (cfg.data.share !== "auto" && !Flag.OPENCODE_AUTO_SHARE && !args.share) return
      const res = await sdk.session.share({ sessionID }).catch((error) => {
        if (error instanceof Error && error.message.includes("disabled")) {
          UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + error.message)
        }
        return { error }
      })
      if (!res.error && "data" in res && res.data?.share?.url) {
        UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + res.data.share.url)
      }
    }

    const EXECUTIVE_DIRECTIVE = `## Output Calibration — Executive Mode
You are speaking to a non-technical business executive. Follow these rules strictly:
- NEVER show SQL queries, column names in backticks, or code blocks
- NEVER use engineering jargon (Cartesian product, referential integrity, column pruning, NULL, schema, index, CTE, predicate)
- Translate ALL technical findings to business impact: revenue, cost, risk, time, compliance exposure
- Lead with the business implication, then briefly explain the cause in plain English if needed
- Format output for a slide deck or email: short paragraphs, simple tables with business-friendly headers
- "Query Duration" not "total_elapsed_time" — "Data Processed" not "bytes_scanned" — "Monthly Cost" not "credits_used * 3.00"`

    async function execute(sdk: OpencodeClient) {
      const outputParts: string[] = []
      // altimate_change start — validate explicit models before starting the session event loop.
      // Otherwise an invalid model can fail before an idle event is emitted, leaving non-interactive
      // `run` waiting until the process-level timeout kills it.
      if (args.model) {
        const parsed = Provider.parseModel(args.model)
        const providers = (await sdk.provider.list()).data?.all ?? []
        const provider = providers.find((item) => item.id === parsed.providerID)
        if (!provider?.models?.[parsed.modelID]) {
          throw new Provider.ModelNotFoundError({
            providerID: parsed.providerID,
            modelID: parsed.modelID,
            suggestions: provider ? Object.keys(provider.models).slice(0, 5) : [],
          })
        }
      }
      // altimate_change end

      function tool(part: ToolPart) {
        try {
          if (part.tool === "bash") return bash(props<typeof BashTool>(part))
          if (part.tool === "glob") return glob(props<typeof GlobTool>(part))
          if (part.tool === "grep") return grep(props<typeof GrepTool>(part))
          if (part.tool === "list") return list(props<typeof ListTool>(part))
          if (part.tool === "read") return read(props<typeof ReadTool>(part))
          if (part.tool === "write") return write(props<typeof WriteTool>(part))
          if (part.tool === "webfetch") return webfetch(props<typeof WebFetchTool>(part))
          if (part.tool === "edit") return edit(props<typeof EditTool>(part))
          if (part.tool === "codesearch") return codesearch(props<typeof CodeSearchTool>(part))
          if (part.tool === "websearch") return websearch(props<typeof WebSearchTool>(part))
          if (part.tool === "task") return task(props<typeof TaskTool>(part))
          if (part.tool === "todowrite") return todo(props<typeof TodoWriteTool>(part))
          if (part.tool === "skill") return skill(props<typeof SkillTool>(part))
          return fallback(part)
        } catch {
          return fallback(part)
        }
      }

      function emit(type: string, data: Record<string, unknown>) {
        if (args.format === "json") {
          process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + EOL)
          return true
        }
        return false
      }

      // altimate_change start — every subscription has an explicit lifetime so
      // prompt-send failures cannot leave an SSE stream keeping the process alive.
      const eventAbort = new AbortController()
      const events = await sdk.event.subscribe(undefined, { signal: eventAbort.signal })
      // altimate_change end
      let error: string | undefined
      // altimate_change start — turn accounting + dual-attribution
      // termination state for this run (see run-accounting.ts).
      const accounting = RunAccounting.create()
      // altimate_change end
      // altimate_change start — idle-done fallback state (run-mode-only by
      // construction — this exists only in the run command). Thresholds are
      // config-exposed via env with first-principles provenance (see idle-done.ts).
      // Armed ONLY for a local run with run mode active: --attach targets a
      // remote, possibly shared/interactive session, and ALTIMATE_RUN_MODE=0 is
      // the documented opt-out for every run-mode-only mechanism.
      const idleDone = IdleDone.create(
        IdleDone.armedOptions(IdleDone.optionsFromEnv(), {
          attach: Boolean(args.attach),
          runMode: Flag.ALTIMATE_RUN_MODE,
        }),
        {
          isCompactionStep: (messageID) => accounting.isCompactionStep(messageID),
        },
      )
      // altimate_change end

      // Build tracer from config + CLI flags — must never crash the run command
      const tracer = await (async () => {
        try {
          if (args.trace === false) return null

          // altimate_change start — upstream_fix: read tracing config via the server client. The local
          // Config.get() facade cannot resolve the instance ALS across the CLI module boundary in the
          // `run` path (InstanceRef not provided → swallowed by the catch below → tracer null → no trace
          // file is ever written). The v1.17.9 merge reverted this to Config.get(); restore sdk.config.get().
          // Guarded by test/cli/run/run-process.test.ts "--trace writes a session trace artifact".
          // The sdk's generated Config type omits the fork-only `tracing` field; the server returns it
          // at runtime, so assert just that field's shape from ConfigV1 (avoids the local Config.get()).
          const cfg = (await sdk.config.get()).data as { tracing?: ConfigV1.Info["tracing"] } | undefined
          const tracingCfg = cfg?.tracing
          // altimate_change end
          if (tracingCfg?.enabled === false) return null

          const exporters: TraceExporter[] = [new FileExporter(tracingCfg?.dir)]

          if (tracingCfg?.exporters) {
            for (const exp of tracingCfg.exporters) {
              exporters.push(new HttpExporter(exp.name, exp.endpoint, exp.headers))
            }
          }

          return Tracer.withExporters(exporters, { maxFiles: tracingCfg?.maxFiles })
        } catch {
          // Config failure should never prevent the run command from working
          return null
        }
      })()

      // altimate_change start — the event loop takes its stream as a
      // parameter so the idle-done challenge phase can re-run it over a fresh
      // subscription after the deliberate mid-run abort (same accounting, same
      // max-turns budget — the challenge continuation stays budget-enforced).
      // requireBusyFirst: the challenge-phase loop ignores idle events until the
      // challenge turn has actually started (a straggler idle from the abort
      // would otherwise end the phase before the challenge prompt begins).
      async function loop(
        stream: typeof events.stream,
        options?: { requireBusyFirst?: boolean; suppressInterruptedPromptAbort?: boolean },
      ) {
        let sawBusy = false
        // altimate_change end
        const toggles = new Map<string, boolean>()
        // altimate_change start — max-turns budget enforcement (count kept in accounting)
        const maxTurns = args.maxTurns
        // altimate_change end

        // altimate_change start — parameterized stream
        for await (const event of stream) {
          // altimate_change end
          // altimate_change start — record each assistant message's agent so
          // step-start parts (which carry only messageID/sessionID) can be attributed.
          // The assistant message row is persisted — and this event published — before
          // its first step-start part streams, so the lookup is populated in time.
          if (
            event.type === "message.updated" &&
            event.properties.info.role === "assistant" &&
            event.properties.info.sessionID === sessionID
          ) {
            accounting.onAssistantMessage(event.properties.info)
          }
          // altimate_change end
          if (
            event.type === "message.updated" &&
            event.properties.info.role === "assistant" &&
            args.format !== "json" &&
            toggles.get("start") !== true
          ) {
            UI.empty()
            UI.println(`> ${event.properties.info.agent} · ${event.properties.info.modelID}`)
            UI.empty()
            toggles.set("start", true)

            // Enrich trace with resolved model/provider from the first assistant message
            const info = event.properties.info
            tracer?.enrichFromAssistant({
              modelID: info.modelID,
              providerID: info.providerID,
              agent: info.agent,
              variant: info.variant,
            })
          }

          if (event.type === "message.part.updated") {
            const part = event.properties.part
            if (part.sessionID !== sessionID) continue

            // altimate_change start — feed every part event through the
            // idle-done observer (event-stream ordering for build-after-last-write,
            // text-only-turn counting, outstanding-tool suppression).
            idleDone.observePart(part as unknown as IdleDone.PartSlice)
            // altimate_change end

            if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
              tracer?.logToolCall(part as Parameters<Tracer["logToolCall"]>[0])
              if (emit("tool_use", { part })) continue
              if (part.state.status === "completed") {
                tool(part)
                continue
              }
              inline({
                icon: "✗",
                title: `${part.tool} failed`,
              })
              UI.error(part.state.error)
            }

            if (
              part.type === "tool" &&
              part.tool === "task" &&
              part.state.status === "running" &&
              args.format !== "json"
            ) {
              if (toggles.get(part.id) === true) continue
              task(props<typeof TaskTool>(part))
              toggles.set(part.id, true)
            }

            if (part.type === "step-start") {
              tracer?.logStepStart(part)
              // altimate_change start — enforce max-turns budget
              // compaction-machinery steps are excluded from turn accounting —
              // the owning message's agent is resolved via the message.updated lookup
              // above, so compacting models are not differentially charged turns.
              const counted = accounting.onStepStart(part.messageID)
              if (counted && maxTurns && accounting.turnCount > maxTurns) {
                accounting.onBudgetExhausted()
                error = `Budget exceeded: reached ${maxTurns} assistant turn${maxTurns !== 1 ? "s" : ""} limit`
                UI.println(UI.Style.TEXT_DANGER_BOLD + "!", UI.Style.TEXT_NORMAL + ` ${error}. Aborting session.`)
                await sdk.session.abort({ sessionID })
                break
              }
              // altimate_change end
              if (emit("step_start", { part })) continue
            }

            if (part.type === "step-finish") {
              tracer?.logStepFinish(part)
              // altimate_change start — record the model-side finish reason
              accounting.onStepFinish(part.messageID, (part as { reason?: string }).reason)
              // altimate_change end
              // altimate_change start — idle-done fallback firing point.
              // All hard preconditions are checked in idle-done.ts (compaction-gated,
              // build-after-last-write green verify, no outstanding tools/permissions,
              // one-shot). Firing aborts the churning prompt and hands off to the
              // confirm-DONE challenge phase after the event loop drains. Checked
              // BEFORE the json-mode emit-continue so headless drivers take this path too.
              if (idleDone.shouldChallenge()) {
                idleDone.markChallengeIssued()
                accounting.onIdleDoneChallengeIssued()
                const detail = idleDone.snapshot()
                if (!emit("idle_done_challenge", { detail })) {
                  UI.println(
                    UI.Style.TEXT_WARNING_BOLD + "!",
                    UI.Style.TEXT_NORMAL +
                      ` idle-done: completion signature detected (green verify after last write, ${detail.idle_turns} idle turns, ${detail.compactions} compactions) — issuing one-shot confirm-DONE challenge`,
                  )
                }
                await sdk.session.abort({ sessionID })
                // Keep the initial subscription alive until this interrupted
                // generation publishes its ordered MessageAbortedError -> idle
                // tail. Starting the challenge subscription before that tail is
                // drained lets the intentional abort poison the fresh phase.
                continue
              }
              // altimate_change end
              if (emit("step_finish", { part })) continue
            }

            if (part.type === "text" && part.time?.end) {
              tracer?.logText(part)
              // altimate_change start — explicit-done attribution input
              accounting.onText(part.messageID, part.text, part.synthetic === true)
              // altimate_change end
              if (emit("text", { part })) continue
              const text = part.text.trim()
              if (!text) continue
              if (args.output) outputParts.push(text)
              if (!process.stdout.isTTY) {
                process.stdout.write(text + EOL)
                continue
              }
              UI.empty()
              UI.println(text)
              UI.empty()
            }

            if (part.type === "reasoning" && part.time?.end && args.thinking) {
              if (emit("reasoning", { part })) continue
              const text = part.text.trim()
              if (!text) continue
              const line = `Thinking: ${text}`
              if (process.stdout.isTTY) {
                UI.empty()
                UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                UI.empty()
                continue
              }
              process.stdout.write(line + EOL)
            }
          }

          if (event.type === "session.error") {
            const props = event.properties
            if (props.sessionID !== sessionID || !props.error) continue
            // altimate_change start — the idle-done challenge is delivered
            // by aborting the in-flight prompt; that harness-initiated abort is not
            // a run error — don't display it or fold it into the error record.
            if (
              options?.suppressInterruptedPromptAbort &&
              idleDone.challengeIssued &&
              props.error.name === "MessageAbortedError"
            ) {
              continue
            }
            // altimate_change end
            // altimate_change start — serialize the real error name/message/status
            // (never a bare name, "[object Object]", or a literal {}); feed the
            // harness-stop attribution (recoverable overflow errors are excluded there).
            const err = RunAccounting.serializeSessionError(props.error)
            accounting.onSessionError(
              props.error.name,
              "data" in props.error && props.error.data && "message" in props.error.data
                ? String(props.error.data.message)
                : undefined,
            )
            // altimate_change end
            error = error ? error + EOL + err : err
            if (emit("error", { error: props.error })) continue
            UI.error(err)
          }

          // altimate_change start — require an actual recovery event before forgiving overflow
          // A ContextOverflowError is only recoverable after compaction really
          // completes. This event closes the pending-overflow accounting state;
          // without it (disabled/failed compaction) the run exits nonzero.
          if (event.type === "session.compacted" && event.properties.sessionID === sessionID) {
            accounting.onCompactionRecovered()
          }
          // altimate_change end

          // altimate_change start — track busy for the challenge-phase guard
          if (
            event.type === "session.status" &&
            event.properties.sessionID === sessionID &&
            event.properties.status.type === "busy"
          ) {
            sawBusy = true
          }
          // altimate_change end
          if (
            event.type === "session.status" &&
            event.properties.sessionID === sessionID &&
            event.properties.status.type === "idle"
          ) {
            // altimate_change start — ignore stale pre-challenge idles
            if (options?.requireBusyFirst && !sawBusy) continue
            // altimate_change end
            break
          }

          if (event.type === "permission.asked") {
            const permission = event.properties
            if (permission.sessionID !== sessionID) continue
            // altimate_change start — idle-done is suppressed while a
            // permission request is outstanding (hard precondition iii).
            idleDone.onPermissionAsked(permission.id)
            // altimate_change end
            // altimate_change start - yolo mode: auto-approve but respect explicit deny rules.
            // --dangerously-skip-permissions (backport of upstream PR #21266) is treated as
            // an alias — same auto-approve behavior, plus our deny-rule safety net which
            // the upstream implementation lacks.
            const yolo = args.yolo || Flag.ALTIMATE_CLI_YOLO || args["dangerously-skip-permissions"]
            if (yolo) {
              // Check if any pattern matches an explicit deny rule from the session config
              const isDenied = rules.some(
                (r) =>
                  r.action === "deny" &&
                  r.permission === permission.permission &&
                  permission.patterns.some((p) => {
                    if (r.pattern === "*") return true
                    return p.includes(r.pattern) || r.pattern.includes(p)
                  }),
              )
              if (isDenied) {
                UI.println(
                  UI.Style.TEXT_DANGER_BOLD + "!",
                  UI.Style.TEXT_NORMAL +
                    `yolo mode: BLOCKED by deny rule: ${permission.permission} (${permission.patterns.join(", ")})`,
                )
                await sdk.permission.reply({
                  requestID: permission.id,
                  reply: "reject",
                })
              } else {
                UI.println(
                  UI.Style.TEXT_WARNING_BOLD + "!",
                  UI.Style.TEXT_NORMAL +
                    `yolo mode: auto-approved ${permission.permission} (${permission.patterns.join(", ")})`,
                )
                await sdk.permission.reply({
                  requestID: permission.id,
                  reply: "once",
                })
              }
            } else {
              UI.println(
                UI.Style.TEXT_WARNING_BOLD + "!",
                UI.Style.TEXT_NORMAL +
                  `permission requested: ${permission.permission} (${permission.patterns.join(", ")}); auto-rejecting`,
              )
              await sdk.permission.reply({
                requestID: permission.id,
                reply: "reject",
              })
            }
            // altimate_change end
            // altimate_change start — every branch above replied; clear the pending flag
            idleDone.onPermissionResolved(permission.id)
            // altimate_change end
          }
        }
      }

      // Validate agent if specified; capture audience option from agent definition
      const { agent, agentAudience } = await (async () => {
        if (!args.agent) return { agent: undefined, agentAudience: undefined }
        const entry = await Agent.get(args.agent)
        if (!entry) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${args.agent}" not found. Falling back to default agent`,
          )
          return { agent: undefined, agentAudience: undefined }
        }
        if (entry.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${args.agent}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return { agent: undefined, agentAudience: undefined }
        }
        const aud = entry.options?.audience as string | undefined
        return { agent: args.agent, agentAudience: aud }
      })()

      // Build audience system directive (--audience flag overrides agent-level setting)
      const audienceMode = args.audience ?? agentAudience
      const audienceSystem = audienceMode === "executive" ? EXECUTIVE_DIRECTIVE : undefined

      const sessionID = await session(sdk)
      if (!sessionID) {
        UI.error("Session not found")
        process.exit(1)
      }
      await share(sdk, sessionID)

      // Start trace now that sessionID is available
      tracer?.startTrace(sessionID, {
        title: title() || message.slice(0, 80),
        model: args.model,
        agent,
        variant: args.variant,
        prompt: message,
      })
      // altimate_change start - activate tracer for session
      if (tracer) Tracer.setActive(tracer)
      // altimate_change end

      // Register crash handlers to flush the trace on unexpected exit
      const onSigint = () => {
        tracer?.flushSync("Process interrupted")
        process.exit(130)
      }
      const onSigterm = () => {
        tracer?.flushSync("Process interrupted")
        process.exit(143)
      }
      // altimate_change start — honest rc on fatal abort. beforeExit firing
      // before the run finishes means the event loop drained before the run
      // completed — the prompt/event stream was abandoned (observed: a
      // mid-stream provider failure tears everything down and the process used
      // to die here with rc 0). The flag (not just listener removal) makes the
      // outcome sticky in the right direction: a spurious firing during an
      // event-loop gap on a run that later completes must not poison the rc —
      // the success path marks the shared guard finished and restores exitCode.
      const beforeExit = RunAccounting.createBeforeExitGuard(process, () => tracer?.flushSync("Process exited"))
      const onBeforeExit = beforeExit.onBeforeExit
      // altimate_change end
      process.on("SIGINT", onSigint)
      process.on("SIGTERM", onSigterm)
      process.on("beforeExit", onBeforeExit)

      // Start event listener before sending the prompt so no events are missed
      // altimate_change start — pass the stream explicitly (see loop signature)
      let eventLoopFailure: unknown
      const loopPromise = loop(events.stream, { suppressInterruptedPromptAbort: true }).catch((e) => {
        eventLoopFailure = e
        accounting.onSessionError("EventStreamError", e instanceof Error ? e.message : String(e))
        console.error(e)
        // The session.prompt/session.command POST is synchronous and may still
        // be waiting on a hung generation. It shares this signal, so losing SSE
        // releases both sides of the run instead of waiting forever in send().
        eventAbort.abort()
      })
      // altimate_change end

      // altimate_change start — bounded retry-with-backoff on provider 5xx/timeout
      // at the enqueue boundary. Bounds are config-exposed via env (provenance:
      // bounded retries with every retry logged so they can
      // never mask a persistent provider failure; defaults mirror the in-stream
      // SessionRetry posture — bounded and visible). On exhaustion the error is thrown
      // so the process exits nonzero instead of hanging on an idle event that will
      // never arrive.
      // altimate_change start — upstream_fix: cap the upper bound too, not just
      // reject non-finite/negative — an unbounded ALTIMATE_RUN_RETRY_MAX permits
      // runaway retries, and an unbounded base delay compounds through
      // `retryBaseMs * 2 ** attempt` past setTimeout's ~24.8-day int32 ceiling
      // (Node clamps an oversized delay to fire immediately, turning "backoff"
      // into a tight retry loop).
      const envBound = (name: string, fallback: number, max: number) => {
        const raw = process.env[name]?.trim()
        if (!raw) return fallback
        const parsed = Number(raw)
        return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, max) : fallback
      }
      const retryMax = envBound("ALTIMATE_RUN_RETRY_MAX", 3, 20)
      const retryBaseMs = envBound("ALTIMATE_RUN_RETRY_BASE_MS", 1000, 60_000)
      // The per-value bounds alone do NOT keep the compounded delay inside the
      // timer range — see RunAccounting.retryDelayMs, which clamps it.
      // altimate_change end
      // altimate_change start — retry idempotency. `session.prompt`/`command`
      // run the whole task synchronously, so an ambiguous transport failure
      // (timeout, ECONNRESET, gateway 5xx) can arrive AFTER the server accepted
      // the POST and started the run. Re-sending then duplicates the task —
      // a second user message and a second execution. Pinning a stable
      // messageID makes the attempt identifiable: before each retry we ask the
      // server whether that message landed, and only re-send when it did not.
      const sendMessageID = MessageID.ascending()
      const send = () => {
        if (args.command)
          return sdk.session.command(
            {
              sessionID,
              messageID: sendMessageID,
              agent,
              model: args.model,
              command: args.command,
              arguments: message,
              variant: args.variant,
            },
            { signal: eventAbort.signal },
          )
        const model = args.model ? Provider.parseModel(args.model) : undefined
        return sdk.session.prompt(
          {
            sessionID,
            messageID: sendMessageID,
            agent,
            model,
            variant: args.variant,
            parts: [...files, { type: "text", text: message }],
            ...(audienceSystem ? { system: audienceSystem } : {}),
          },
          { signal: eventAbort.signal },
        )
      }
      /** Did the server persist this attempt's user message?
       *  Three-valued ON PURPOSE — a retry may only proceed on definitive
       *  evidence that the message did NOT land. Treating an unreachable
       *  server as "absent" would resend a task that may already be running,
       *  which is the duplication this whole mechanism exists to prevent. */
      const acceptanceState = async (messageID: string): Promise<"accepted" | "absent" | "unknown"> => {
        try {
          const res = (await sdk.session.message({ sessionID, messageID })) as {
            data?: { info?: unknown }
            error?: unknown
            response?: { status?: number }
          }
          if (res?.data?.info) return "accepted"
          // A definitive 404 from a reachable server is the only proof of absence.
          if (res?.response?.status === 404) return "absent"
          return "unknown"
        } catch {
          // The probe itself failed — the server is unreachable, so we cannot tell.
          return "unknown"
        }
      }
      // altimate_change end
      type SendResult = {
        error?: unknown
        response?: Response
        data?: { info?: { finish?: string; error?: { name?: unknown; data?: unknown } } }
      }
      // altimate_change start — run a synthetic follow-up over one bounded,
      // shared request/SSE lifetime. This is used for both the confirm-DONE
      // challenge and the single continuation turn when that challenge is
      // declined. A stream failure aborts the synchronous POST; a POST failure
      // aborts the stream. Stable message IDs preserve retry idempotency.
      const runSyntheticTurn = async (
        text: string,
        kind: "challenge" | "continuation",
      ): Promise<SendResult | undefined> => {
        const turnAbort = new AbortController()
        const eventErrorName = kind === "challenge" ? "ChallengeEventStreamError" : "ContinuationEventStreamError"
        const sendErrorName = kind === "challenge" ? "IdleDoneChallengeFailed" : "IdleDoneContinuationFailed"
        const humanName = kind === "challenge" ? "idle-done challenge" : "idle-done continuation"
        const eventName = kind === "challenge" ? "idle_done_challenge_failed" : "idle_done_continuation_failed"
        const turnEvents = await sdk.event.subscribe(undefined, { signal: turnAbort.signal }).catch((e) => {
          accounting.onSessionError(eventErrorName, e instanceof Error ? e.message : String(e))
          return undefined
        })
        if (!turnEvents) return undefined

        let sendFailed!: () => void
        const sendFailure = new Promise<void>((resolveFailure) => {
          sendFailed = resolveFailure
        })
        let streamFailed = false
        const messageID = MessageID.ascending()
        const promptPromise = (async (): Promise<SendResult | undefined> => {
          // The previous turn may have published idle just before releasing its
          // session lock. Retry that narrow race, but only after definitive
          // proof this exact message was not persisted.
          for (let attempt = 0; ; attempt++) {
            const res = (await sdk.session
              .prompt(
                {
                  sessionID,
                  messageID,
                  agent,
                  model: args.model ? Provider.parseModel(args.model) : undefined,
                  variant: args.variant,
                  ...(audienceSystem ? { system: audienceSystem } : {}),
                  // Synthetic harness text must never replace the authoritative
                  // original task pin when this session is resumed.
                  parts: [{ type: "text", text, synthetic: true }],
                },
                { signal: turnAbort.signal },
              )
              .catch((e) => ({ error: e }) as SendResult)) as SendResult
            if (!res?.error) return res
            const status = res.response?.status
            const detail = RunAccounting.serializeSessionError(res.error)
            const retryable =
              status === 409 || RunAccounting.isRetryableStatus(status) || RunAccounting.isRetryableThrown(res.error)
            if (!retryable) throw new Error(`${humanName} prompt failed: ${detail}`)

            const acceptance = await acceptanceState(messageID)
            if (acceptance === "accepted") return undefined
            if (acceptance === "unknown") {
              throw new Error(
                `${humanName} failed and acceptance could not be determined; ` +
                  `not retrying to avoid duplication — ${detail}`,
              )
            }
            if (attempt >= 8) {
              emit(eventName, { error: detail })
              throw new Error(`${humanName} prompt failed: ${detail}`)
            }
            await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
          }
        })()
        promptPromise.catch(() => sendFailed())
        await Promise.race([
          loop(turnEvents.stream, { requireBusyFirst: true }).catch((e) => {
            streamFailed = true
            accounting.onSessionError(eventErrorName, e instanceof Error ? e.message : String(e))
            console.error(e)
            turnAbort.abort()
          }),
          sendFailure,
        ])
        const result = await promptPromise.catch((e) => {
          if (!streamFailed) accounting.onSessionError(sendErrorName, e instanceof Error ? e.message : String(e))
          return undefined
        })
        turnAbort.abort()
        return result
      }
      // altimate_change end
      let sendResult: SendResult | undefined
      let sendFailure: unknown
      for (let sendAttempt = 0; ; sendAttempt++) {
        let reason: string
        try {
          const res = (await send()) as SendResult
          const status = res?.response?.status
          if (!res?.error || !RunAccounting.isRetryableStatus(status)) {
            sendResult = res
            break
          }
          reason = `provider returned status ${status}`
        } catch (e) {
          if (!RunAccounting.isRetryableThrown(e)) {
            sendFailure = e
            break
          }
          reason = e instanceof Error ? e.message : String(e)
        }
        // altimate_change start — a retry may only proceed on definitive
        // evidence that the message did NOT land. Re-sending an accepted prompt
        // duplicates the task; re-sending on an UNKNOWN state risks the same,
        // so that case fails the run loudly instead of guessing.
        const acceptance = await acceptanceState(sendMessageID)
        if (acceptance === "accepted") {
          // The failure was on the response path only — the run is in flight,
          // so fall through and let the event loop drain to idle.
          if (!emit("retry_skipped", { reason, messageID: sendMessageID })) {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL + ` prompt already accepted by the server; not retrying — ${reason}`,
            )
          }
          break
        }
        if (acceptance === "unknown") {
          sendFailure = new Error(
            `prompt failed and the server could not be reached to determine whether it was accepted; ` +
              `not retrying to avoid running the task twice — ${reason}`,
          )
          break
        }
        // altimate_change end
        if (sendAttempt >= retryMax) {
          sendFailure = new Error(`prompt failed after ${retryMax} retries: ${reason}`)
          break
        }
        const delay = RunAccounting.retryDelayMs(retryBaseMs, sendAttempt)
        if (!emit("retry", { attempt: sendAttempt + 1, max: retryMax, reason, delayMs: delay })) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL + ` retrying prompt (${sendAttempt + 1}/${retryMax}) in ${delay}ms — ${reason}`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      // the prompt response carries the TERMINAL assistant message —
      // inspect it for swallowed abnormal endings (see RunAccounting.onPromptResult).
      if (sendFailure) {
        // Losing SSE intentionally aborts the synchronous POST. Attribute that
        // derivative AbortError to the original stream failure; otherwise it
        // overwrites timeout/error classification and the actionable message.
        if (eventLoopFailure) error = RunAccounting.serializeSessionError(eventLoopFailure)
        else {
          accounting.onPromptSendError(sendFailure)
          error = RunAccounting.serializeSessionError(sendFailure)
        }
        eventAbort.abort()
      } else if (sendResult?.error) {
        if (eventLoopFailure) error = RunAccounting.serializeSessionError(eventLoopFailure)
        else {
          accounting.onPromptSendError(sendResult.error, sendResult.response?.status)
          error = RunAccounting.serializeSessionError(sendResult.error)
        }
        eventAbort.abort()
      } else accounting.onPromptResult(sendResult?.data?.info)
      // altimate_change end

      // Wait for the event loop to drain (breaks when session reaches idle)
      await loopPromise
      // altimate_change start — close the initial SSE lifetime on every outcome
      eventAbort.abort()
      if (eventLoopFailure && !error) error = RunAccounting.serializeSessionError(eventLoopFailure)
      // altimate_change end

      // altimate_change start — one-shot confirm-DONE challenge phase.
      // Reached only when the idle-done detector fired (all hard preconditions
      // held) and aborted the churning prompt. The challenge is a normal prompt:
      // the model either confirms DONE (session ends, done_reason=idle_heuristic)
      // or states what remains and continues working — budget enforcement,
      // accounting, and display all flow through the same loop() over a fresh
      // event subscription. Recursion guard: the detector is one-shot, so the
      // challenge can never breed further challenges. The directive is
      // delivered via the nudge arbiter so this injected turn carries exactly
      // ONE system-authored directive.
      if (idleDone.challengeIssued && !accounting.fatal) {
        // altimate_change start — upstream_fix: mark the challenge reply as
        // sent BEFORE anything in this phase can raise a session-error/prompt-
        // result event, so a genuine failure of the reply itself is never
        // absorbed by the interrupted prompt's own abort suppression.
        accounting.onIdleDoneChallengeReplySent()
        // altimate_change end
        NudgeArbiter.register(sessionID, {
          source: "termination_challenge",
          kind: "confirm_done",
          text: SessionTermination.CONFIRM_DONE_CHALLENGE,
        })
        const challengeDirective = NudgeArbiter.take(sessionID)
        const challengeResult = await runSyntheticTurn(
          challengeDirective?.text ?? SessionTermination.CONFIRM_DONE_CHALLENGE,
          "challenge",
        )
        accounting.onPromptResult(challengeResult?.data?.info)
        const challengeConfirmed = accounting.termination().done_reason === "idle_heuristic"
        accounting.onIdleDoneChallengeCompleted()

        // A model may follow the challenge's "state what remains and continue"
        // branch with a normal text-only stop. That has already returned from
        // SessionPrompt.loop, so enqueue one explicit continuation turn instead
        // of silently finalizing the run at rc 0 with done_reason=none.
        if (!accounting.fatal && !challengeConfirmed) {
          NudgeArbiter.register(sessionID, {
            source: "termination_challenge",
            kind: "continue_after_decline",
            text: SessionTermination.CONTINUE_AFTER_DECLINED_CHALLENGE,
          })
          const continuationDirective = NudgeArbiter.take(sessionID)
          if (!emit("idle_done_continuation", {})) {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL + " idle-done: completion was not confirmed — continuing the remaining work",
            )
          }
          const continuationResult = await runSyntheticTurn(
            continuationDirective?.text ?? SessionTermination.CONTINUE_AFTER_DECLINED_CHALLENGE,
            "continuation",
          )
          accounting.onPromptResult(continuationResult?.data?.info)
          if (!accounting.fatal && accounting.termination().done_reason === "none") {
            accounting.onSessionError(
              "IdleDoneContinuationUnconfirmed",
              "the continuation ended without an explicit DONE confirmation",
            )
          }
        }
      }
      // altimate_change end

      // Remove crash handlers — trace will be finalized cleanly
      // altimate_change start — the run loop drained normally: mark the run
      // finished and clear any exit code a premature beforeExit firing set.
      // accounting.fatal below remains the single authority for a nonzero rc.
      beforeExit.finish()
      // altimate_change end
      process.removeListener("SIGINT", onSigint)
      process.removeListener("SIGTERM", onSigterm)
      process.removeListener("beforeExit", onBeforeExit)

      // altimate_change start — dual-attribution termination
      // record with done_reason. why_model_stopped and why_harness_stopped are
      // independent fields so model-looping, tight budgets, and harness errors
      // are distinguishable in the run output (rc alone conflates them);
      // done_reason distinguishes explicit_done vs idle_heuristic vs none.
      const termination = accounting.termination()
      if (!emit("termination", { ...termination }) && process.stdout.isTTY) {
        UI.println(
          UI.Style.TEXT_DIM +
            `why_model_stopped=${termination.why_model_stopped} why_harness_stopped=${termination.why_harness_stopped} done_reason=${termination.done_reason}` +
            UI.Style.TEXT_NORMAL,
        )
      }
      // altimate_change end

      // Finalize trace and save to disk
      if (tracer) {
        Tracer.setActive(null)
        const tracePath = await tracer.endTrace(error)
        if (tracePath) {
          emit("trace_saved", { path: tracePath })
          if (args.format !== "json" && process.stdout.isTTY) {
            UI.println(UI.Style.TEXT_DIM + `Trace saved: ${tracePath}` + UI.Style.TEXT_NORMAL)
          }
        }
      }

      // Write accumulated text output to file if --output was specified
      if (args.output) {
        const outputPath = path.resolve(args.output)
        const content = outputParts.join("\n\n") || "(no text output — tool-only response)"
        await Bun.write(outputPath, content)
        process.stderr.write(`\n✓ Output saved to: ${outputPath}\n`)
      }

      // altimate_change start — honest rc — exit nonzero on fatal abort
      // (budget exhaustion or an unrecovered session error). Uses process.exitCode
      // (not process.exit) so pending stdout/trace writes still flush.
      if (accounting.fatal) process.exitCode = 1
      // altimate_change end
    }

    if (args.attach) {
      const headers = (() => {
        const password = args.password ?? process.env.OPENCODE_SERVER_PASSWORD
        if (!password) return undefined
        const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
        const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
        return { Authorization: auth }
      })()
      const sdk = createOpencodeClient({ baseUrl: args.attach, directory, headers })
      return await execute(sdk)
    }

    await bootstrap(process.cwd(), async () => {
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        // altimate_change start — upstream_fix: attach basic-auth header to in-process run requests
        // so local `run` still reaches the embedded server when OPENCODE_SERVER_PASSWORD is set
        // (the server enforces basicAuth on all routes; without this the in-process fetch 401s).
        const { ServerAuth } = await import("@/server/auth")
        const auth = ServerAuth.header()
        if (auth) {
          const headers = new Headers(request.headers)
          headers.set("Authorization", auth)
          return Server.Default().fetch(new Request(request, { headers }))
        }
        // altimate_change end
        return Server.Default().fetch(request)
      }) as typeof globalThis.fetch
      const sdk = createOpencodeClient({ baseUrl: "http://altimate-code.internal", fetch: fetchFn })
      await execute(sdk)
    })
  },
})
