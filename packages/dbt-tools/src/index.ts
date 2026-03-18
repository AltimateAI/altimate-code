import { join, resolve } from "path"
import { existsSync } from "fs"
import { read, type Config } from "./config"
import { init } from "./commands/init"
import { validate } from "./check"

const USAGE = {
  commands: {
    init: "Auto-detect dbt project and write config",
    doctor: "Check prerequisites (Python, dbt, project)",
    info: "Get project info (paths, targets, version)",
    compile: "Compile a model (Jinja to SQL) --model <name>",
    "compile-query": "Compile a raw query --query <sql> [--model <name>]",
    build: "Build a model --model <name> [--downstream]",
    run: "Run a model --model <name> [--downstream]",
    test: "Test a model --model <name>",
    "build-project": "Build entire project",
    execute: "Execute SQL --query <sql> [--model <name>] [--limit <n>]",
    columns: "Get columns of model --model <name>",
    "columns-source": "Get columns of source --source <name> --table <name>",
    "column-values": "Get column values --model <name> --column <col>",
    children: "Get downstream models --model <name>",
    parents: "Get upstream models --model <name>",
    deps: "Install dbt dependencies",
    "add-packages": "Add dbt packages --packages pkg1,pkg2",
  },
}

const cmd = process.argv[2]
const rest = process.argv.slice(3)

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

function diagnose(err: Error): { error: string; fix?: string } {
  const msg = err.message || String(err)
  if (msg.includes("private field") || msg.includes("#stdin") || msg.includes("#stdout")) {
    return {
      error: "Internal error: Bun runtime incompatibility with python-bridge. Please report this issue.",
      fix: "Try updating: bun install, or file a bug at https://github.com/AltimateAI/altimate-code/issues",
    }
  }
  if (msg.includes("IPC channel") || msg.includes("ERR_IPC_CHANNEL_CLOSED")) {
    return {
      error: "Failed to start Python bridge. The dbt Python process exited unexpectedly.",
      fix: "Check your dbt installation: run `dbt debug` in your project directory. Then run: altimate-dbt doctor",
    }
  }
  if (msg.includes("ENOENT") || msg.includes("spawn")) {
    return {
      error: `Could not start process: ${msg}`,
      fix: "Ensure Python and dbt are installed and accessible. Run: altimate-dbt doctor",
    }
  }
  if (msg.includes("ModuleNotFoundError") || msg.includes("No module named")) {
    return {
      error: `Missing Python package: ${msg}`,
      fix: "Install dbt in your Python environment: pip install dbt-core",
    }
  }
  if (msg.includes("Python process closed")) {
    return {
      error: `dbt Python process crashed: ${msg}`,
      fix: "Verify your dbt project is valid: run `dbt debug` in your project directory",
    }
  }
  return { error: msg, fix: "Run: altimate-dbt doctor" }
}

function output(result: unknown) {
  const fmt = rest.includes("--format") && rest[rest.indexOf("--format") + 1] === "text"
  if (fmt && typeof result === "object" && result !== null) {
    const obj = result as Record<string, unknown>
    if ("error" in obj) {
      console.error(String(obj.error))
      if ("fix" in obj) console.error(String(obj.fix))
      process.exit(1)
    }
    if ("sql" in obj) {
      console.log(String(obj.sql))
      return
    }
    if ("stdout" in obj) {
      console.log(String(obj.stdout))
      return
    }
  }
  console.log(JSON.stringify(result, null, 2))
  if (result && typeof result === "object" && "error" in result) process.exit(1)
}

function bail(err: unknown): never {
  const result: Record<string, unknown> = diagnose(err instanceof Error ? err : new Error(String(err)))
  // Include buffered dbt logs for diagnostics (see #249 — logs are buffered
  // in-memory instead of written to stderr to avoid TUI corruption).
  try {
    const { getRecentDbtLogs } = require("./log-buffer") as typeof import("./log-buffer")
    const logs = getRecentDbtLogs()
    if (logs.length > 0) {
      result.logs = logs
    }
  } catch {
    // log-buffer might not have been loaded yet
  }
  console.log(JSON.stringify(result, null, 2))
  process.exit(1)
}

// Catch unhandled rejections (bluebird throws outside normal promise chains)
process.on("unhandledRejection", bail)
process.on("uncaughtException", bail)

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help") return USAGE

  if (cmd === "init") return init(rest)

  const cfg = await read()
  if (!cfg) return { error: "No config found. Run: altimate-dbt init" }

  // Override projectRoot: --project-dir flag > cwd auto-detect > config
  const dirFlag = flag(rest, "project-dir")
  if (dirFlag) {
    cfg.projectRoot = resolve(dirFlag)
  } else {
    const cwdProject = join(process.cwd(), "dbt_project.yml")
    if (existsSync(cwdProject) && resolve(process.cwd()) !== resolve(cfg.projectRoot)) {
      cfg.projectRoot = resolve(process.cwd())
    }
  }

  if (cmd === "doctor") return (await import("./commands/doctor")).doctor(cfg)

  // Validate prerequisites before loading the heavy adapter
  const issue = await validate(cfg)
  if (issue) return { error: issue }

  // Configure CLI fallbacks with the project's Python environment
  const { configure } = await import("./dbt-cli")
  configure({ pythonPath: cfg.pythonPath, projectRoot: cfg.projectRoot })

  // Lazy import to avoid loading python-bridge until needed
  let adapter
  try {
    const { create } = await import("./adapter")
    adapter = await create(cfg)
  } catch (err) {
    return diagnose(err instanceof Error ? err : new Error(String(err)))
  }

  let result: unknown
  try {
    switch (cmd) {
      case "info":
        result = await (await import("./commands/info")).info(adapter)
        break
      case "compile":
        result = await (await import("./commands/compile")).compile(adapter, rest)
        break
      case "compile-query":
        result = await (await import("./commands/compile")).query(adapter, rest)
        break
      case "build":
        result = await (await import("./commands/build")).build(adapter, rest)
        break
      case "run":
        result = await (await import("./commands/build")).run(adapter, rest)
        break
      case "test":
        result = await (await import("./commands/build")).test(adapter, rest)
        break
      case "build-project":
        result = await (await import("./commands/build")).project(adapter)
        break
      case "execute":
        result = await (await import("./commands/execute")).execute(adapter, rest)
        break
      case "columns":
        result = await (await import("./commands/columns")).columns(adapter, rest)
        break
      case "columns-source":
        result = await (await import("./commands/columns")).source(adapter, rest)
        break
      case "column-values":
        result = await (await import("./commands/columns")).values(adapter, rest)
        break
      case "children":
        result = await (await import("./commands/graph")).children(adapter, rest)
        break
      case "parents":
        result = await (await import("./commands/graph")).parents(adapter, rest)
        break
      case "deps":
        result = await (await import("./commands/deps")).deps(adapter)
        break
      case "add-packages":
        result = await (await import("./commands/deps")).add(adapter, rest)
        break
      default:
        result = { error: `Unknown command: ${cmd}`, usage: USAGE }
    }
  } finally {
    try { await adapter.dispose() } catch {}
  }

  return result
}

main().then(output).catch(bail)
