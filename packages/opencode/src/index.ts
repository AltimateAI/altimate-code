import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { ConsoleCommand } from "./cli/cmd/account"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { InstallationVersion, InstallationLocal } from "@opencode-ai/core/installation/version"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
// altimate_change start — workspace-serve: dev-only workspace serve command
import { WorkspaceServeCommand } from "./cli/cmd/workspace-serve"
// altimate_change end
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
// altimate_change start — gitlab: native GitLab MR review integration
import { GitlabCommand } from "./cli/cmd/gitlab"
// altimate_change end
// altimate_change start — review: dbt PR review command
import { ReviewCommand } from "./cli/cmd/review"
// altimate_change end
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/attach"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
// altimate_change start — trace: session trace command
import { TraceCommand } from "./cli/cmd/trace"
// altimate_change end
// altimate_change start — top-level skill command
import { SkillCommand } from "./cli/cmd/skill"
// altimate_change end
// altimate_change start — check: deterministic SQL check command
import { CheckCommand } from "./cli/cmd/check"
// altimate_change end
// altimate_change start — link: workspace-binding subcommand
import { LinkCommand } from "./cli/cmd/link"
// altimate_change end
import { errorMessage } from "./util/error"
import { PluginCommand } from "./cli/cmd/plug"
import { Heap } from "./cli/heap"
// altimate_change start - telemetry import
import { Telemetry } from "./telemetry"
// altimate_change end
// altimate_change start - welcome banner
import { showWelcomeBannerIfNeeded } from "./cli/welcome"
// altimate_change end

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  // altimate_change start - branding: match altimate-code script name in help passthrough
  if (!text.startsWith("altimate-code ")) {
    // altimate_change end
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

let cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  // altimate_change start - script name
  .scriptName("altimate-code")
  // altimate_change end
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  // altimate_change start - yolo mode as global flag
  .option("yolo", {
    describe: "auto-approve all permission prompts (explicit deny rules still enforced)",
    type: "boolean",
    default: false,
  })
  // altimate_change end
  // altimate_change start - workspace precedence escape hatch
  .option("integrations", {
    describe:
      "where warehouse tools run: 'workspace' (default) lets the bound workspace's engine serve the types it provides; 'local' keeps every connection on the local drivers",
    type: "string",
    choices: ["workspace", "local"],
  })
  // altimate_change end
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }
    // altimate_change start - workspace precedence escape hatch
    if (opts.integrations) process.env.ALTIMATE_INTEGRATIONS = String(opts.integrations)
    // altimate_change end

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)
    // altimate_change start - datapilot env var
    process.env.DATAPILOT = "1"
    // altimate_change end

    // altimate_change start - propagate --yolo flag to env var so Flag.ALTIMATE_CLI_YOLO picks it up
    if ("yolo" in opts && opts.yolo) {
      process.env.ALTIMATE_CLI_YOLO = "true"
    }
    // altimate_change end

    // altimate_change start - telemetry init
    // Initialize telemetry early so events from MCP, engine, auth are captured.
    // init() is idempotent — safe to call again later in session prompt.
    Telemetry.init().catch(() => {})
    // altimate_change end

    // altimate_change start - welcome banner on first run after install/upgrade
    showWelcomeBannerIfNeeded()
    // altimate_change end
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  // altimate_change start — gitlab: native GitLab MR review integration
  .command(GitlabCommand)
  // altimate_change end
  // altimate_change start — review: dbt PR review command
  .command(ReviewCommand)
  // altimate_change end
  .command(PrCommand)
  .command(SessionCommand)
  .command(PluginCommand)
  .command(DbCommand)
  // altimate_change start — trace: session trace command
  .command(TraceCommand)
  // altimate_change end
  // altimate_change start — top-level skill command
  .command(SkillCommand)
  // altimate_change end
  // altimate_change start — check: register deterministic SQL check command
  .command(CheckCommand)
  // altimate_change end

// altimate_change start — link: gated on Flag.ALTIMATE_WORKSPACE (pilot)
// so the command isn't registered — and doesn't show in --help — for users
// who haven't opted in to the workspaces feature via ALTIMATE_WORKSPACE=1.
// (M1 in the consensus review.)
if (Flag.ALTIMATE_WORKSPACE) {
  cli = cli.command(LinkCommand)
}
// altimate_change end

// altimate_change start — workspace-serve: register dev-only workspace serve command
if (InstallationLocal) {
  cli = cli.command(WorkspaceServeCommand)
}
// altimate_change end

cli = cli
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // altimate_change start - telemetry flush
  // Flush any buffered telemetry events before exiting.
  // This is critical for non-session commands (auth, upgrade, mcp, etc.)
  // that track events but don't go through the session prompt shutdown path.
  // shutdown() is idempotent — safe even if session prompt already called it.
  try {
    await Telemetry.shutdown()
  } catch {
    // Telemetry failure must never prevent shutdown
  }
  // altimate_change end
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
