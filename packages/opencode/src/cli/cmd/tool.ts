// altimate_change - new file
//
// Model-free access to the data tools: `tool list`, `tool run` and the optional `tool daemon`
// that keeps warehouse connections and the schema cache warm between calls. The tool modules are
// loaded lazily so the rest of the CLI does not pay for them at startup.
import type { Argv } from "yargs"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import type { Runner, ToolResult } from "../../altimate/tool-cli/runner"
import { resolveWorkspaceTools, workspaceContextSection } from "../../altimate/tool-cli/workspace-tools"

/** Reads all of stdin; `readFileSync(0)` works for pipes and for here-docs, which Bun exposes as files. */
function readStdin(): string {
  return readFileSync(0, "utf8")
}

/** The tool arguments from `--args`, `--args-file` or stdin (`--args -`); an empty object when none are given. */
async function readArgs(args: { args?: string; "args-file"?: string }): Promise<unknown> {
  if (args.args !== undefined && args["args-file"] !== undefined) throw new Error("Use either --args or --args-file, not both.")
  const text =
    args["args-file"] !== undefined
      ? readFileSync(args["args-file"], "utf8")
      : args.args === "-"
        ? readStdin()
        : args.args
  if (args.args === "-" && (text === undefined || text.trim() === "")) throw new Error("--args - was given but stdin is empty.")
  if (text === undefined || text.trim() === "") return {}
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Tool arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Runs `fn` with a runner for `directory`; `connections` replaces the project and global connection sources. */
async function withRunner<T>(
  directory: string,
  connections: string | undefined,
  workspaceTools: boolean,
  fn: (runner: Runner) => Promise<T>,
): Promise<T> {
  const { createRunner } = await import("../../altimate/tool-cli/runner")
  return bootstrap(directory, async () => {
    if (connections) await (await import("../../altimate/native/connections/registry")).loadFile(connections)
    const runner = await createRunner({ workspaceTools })
    try {
      return await fn(runner)
    } finally {
      await runner.close()
    }
  })
}

async function inProcess(
  directory: string,
  name: string,
  toolArgs: unknown,
  allowWrite: boolean,
  connections: string | undefined,
  workspaceTools: boolean,
): Promise<ToolResult> {
  process.chdir(directory)
  return withRunner(directory, connections, workspaceTools, (runner) => runner.run(name, toolArgs, { allowWrite }))
}

/** Reloads the connections when a source file was created, edited or removed since the last reload. */
async function connectionsRefresher(
  directory: string,
  connections: string | undefined,
): Promise<() => Promise<void>> {
  const Registry = await import("../../altimate/native/connections/registry")
  const files = connections
    ? [connections]
    : [Registry.globalConfigPath(), path.join(directory, ".altimate-code", "connections.json")]
  const stamp = () =>
    files
      .map((file) => {
        try {
          const st = statSync(file)
          return `${st.mtimeMs}:${st.size}`
        } catch {
          return "missing"
        }
      })
      .join("|")
  let last = stamp()
  return async () => {
    const now = stamp()
    if (now === last) return
    if (connections) await Registry.loadFile(connections)
    else await Registry.reload()
    last = now
  }
}

const connectionsOption = {
  describe: "use only this connections JSON file instead of the project and global connection configs",
  type: "string",
  default: process.env.ALTIMATE_TOOL_CONNECTIONS || undefined,
  defaultDescription: "$ALTIMATE_TOOL_CONNECTIONS",
} as const

// No default: unset means on when the project is linked to a workspace; --no-workspace-tools turns them off.
const workspaceToolsOption = {
  describe:
    "expose the linked workspace tools (workspace_context, workspace_skill, workspace_execute); on by default when the project is linked, --no-workspace-tools disables",
  type: "boolean",
} as const

function firstLine(text: string, width: number): string {
  const line = text.split("\n")[0].trim()
  return line.length > width ? line.slice(0, width - 1) + "…" : line
}

const ToolListCommand = cmd({
  command: "list",
  describe: "list the data tools available to `tool run`",
  builder: (yargs: Argv) =>
    yargs
      .option("json", { describe: "print id, description and input schema as JSON", type: "boolean", default: false })
      .option("connections", connectionsOption)
      .option("workspace-tools", workspaceToolsOption),
  handler: async (args) => {
    const workspaceTools = await resolveWorkspaceTools(args["workspace-tools"], process.cwd())
    const tools = await withRunner(process.cwd(), args.connections, workspaceTools, (runner) => runner.list())
    if (args.json) {
      console.log(JSON.stringify(tools, null, 2))
      return
    }
    const width = Math.max(...tools.map((tool) => tool.id.length))
    for (const tool of tools) console.log(`${tool.id.padEnd(width)}  ${firstLine(tool.description, 100)}`)
  },
})

const ToolContextCommand = cmd({
  command: "context",
  describe: "print the analyst method and the connections known at startup (what `mcp serve` sends as instructions)",
  builder: (yargs: Argv) =>
    yargs
      .option("json", { describe: "print {instructions, connections} as JSON", type: "boolean", default: false })
      .option("connections", connectionsOption)
      .option("workspace-tools", workspaceToolsOption),
  handler: async (args) => {
    const workspaceTools = await resolveWorkspaceTools(args["workspace-tools"], process.cwd())
    const { instructions, connections } = await bootstrap(process.cwd(), async () => {
      const Registry = await import("../../altimate/native/connections/registry")
      try {
        if (args.connections) await Registry.loadFile(args.connections)
        const { serverInstructions } = await import("../../altimate/mcp-server/server")
        const connections = Registry.list().warehouses.map(({ name, type }) => ({ name, type }))
        const base = await serverInstructions()
        const workspace = workspaceTools ? await workspaceContextSection(process.cwd()) : undefined
        return { instructions: workspace ? `${base}\n\n${workspace}` : base, connections }
      } finally {
        await Registry.closeAll()
      }
    })
    if (args.json) console.log(JSON.stringify({ instructions, connections }, null, 2))
    else console.log(instructions)
  },
})

const ToolSchemaCommand = cmd({
  command: "schema <name>",
  describe: "print one tool's description and JSON input schema",
  builder: (yargs: Argv) =>
    yargs
      .positional("name", { describe: "tool id (see `tool list`)", type: "string", demandOption: true })
      .option("connections", connectionsOption)
      .option("workspace-tools", workspaceToolsOption),
  handler: async (args) => {
    const workspaceTools = await resolveWorkspaceTools(args["workspace-tools"], process.cwd())
    const tools = await withRunner(process.cwd(), args.connections, workspaceTools, (runner) => runner.list())
    const tool = tools.find((candidate) => candidate.id === args.name)
    if (!tool) {
      console.error(`Unknown tool: ${args.name}. Run \`tool list\` for the available tools.`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(tool, null, 2))
  },
})

const ToolRunCommand = cmd({
  command: "run <name>",
  describe: "run one data tool without a model and print its result",
  builder: (yargs: Argv) =>
    yargs
      .positional("name", { describe: "tool id (see `tool list`)", type: "string", demandOption: true })
      .option("args", { describe: "tool arguments as a JSON object, or - to read them from stdin", type: "string" })
      .option("args-file", { describe: "read the tool arguments (JSON) from a file", type: "string" })
      .option("allow-write", {
        describe: "allow writes (DROP DATABASE, DROP SCHEMA and TRUNCATE stay blocked)",
        type: "boolean",
        default: false,
      })
      .option("daemon", {
        describe: "use a long-running process that keeps connections warm; --no-daemon runs in this process",
        type: "boolean",
        default: true,
      })
      .option("json", { describe: "print {status,title,output,metadata} as JSON", type: "boolean", default: false })
      .option("connections", connectionsOption)
      .option("workspace-tools", workspaceToolsOption),
  handler: async (args) => {
    const name = String(args.name)
    let result: ToolResult
    try {
      const toolArgs = await readArgs(args)
      const directory = process.cwd()
      const workspaceTools = await resolveWorkspaceTools(args["workspace-tools"], directory)
      const daemon = await import("../../altimate/tool-cli/daemon")
      const reply = args.daemon && !daemon.daemonDisabled()
        ? await daemon.runViaDaemon(directory, InstallationVersion, {
            id: randomUUID(),
            name,
            args: toolArgs,
            allowWrite: args["allow-write"],
          }, { connections: args.connections, workspaceTools })
        : undefined
      result = reply ?? (await inProcess(directory, name, toolArgs, args["allow-write"], args.connections, workspaceTools))
    } catch (error) {
      result = { status: "error", title: "Tool run failed", output: error instanceof Error ? error.message : String(error), metadata: {} }
    }
    if (result.status === "error" && !result.output.startsWith("Unknown tool"))
      result = { ...result, output: `${result.output}\nInput schema: altimate-code tool schema ${name}` }
    if (args.json) {
      console.log(JSON.stringify({ status: result.status, title: result.title, output: result.output, metadata: result.metadata }))
    } else if (result.status === "error") {
      console.error(result.output)
    } else {
      console.log(result.output)
    }
    if (result.status === "error") process.exitCode = 1
  },
})

const ToolDaemonCommand = cmd({
  command: "daemon [action]",
  describe: "run, inspect or stop the long-running tool process for a project",
  builder: (yargs: Argv) =>
    yargs
      .positional("action", { describe: "start (default), status or stop", type: "string", choices: ["start", "status", "stop"], default: "start" })
      .option("dir", { describe: "project directory (defaults to cwd)", type: "string" })
      .option("connections", connectionsOption)
      .option("workspace-tools", workspaceToolsOption),
  handler: async (args) => {
    const daemon = await import("../../altimate/tool-cli/daemon")
    const directory = daemon.resolveDirectory(args.dir ?? process.cwd())
    const workspaceTools = await resolveWorkspaceTools(args["workspace-tools"], directory)
    // Resolved before the chdir below, so the socket key and the load agree on one file.
    const connections = args.connections ? path.resolve(args.connections) : undefined
    const file = daemon.socketPath(directory, InstallationVersion, undefined, connections, workspaceTools)
    if (args.action === "status" || args.action === "stop") {
      const reply = await daemon.send(file, { id: randomUUID(), op: args.action })
      if (!reply) {
        console.log(`No tool daemon running for ${directory}`)
        if (args.action === "status") process.exitCode = 1
        return
      }
      console.log(args.action === "status" ? JSON.stringify(reply.metadata, null, 2) : `Stopped tool daemon for ${directory}`)
      return
    }
    const { createRunner } = await import("../../altimate/tool-cli/runner")
    process.chdir(directory)
    await bootstrap(directory, async () => {
      if (connections) await (await import("../../altimate/native/connections/registry")).loadFile(connections)
      const runner = await createRunner({ workspaceTools })
      try {
        const refreshConnections = await connectionsRefresher(directory, connections)
        const { releaseFileConnections } = await import("../../altimate/native/connections/registry")
        const running = await daemon.startDaemon({
          directory,
          version: InstallationVersion,
          runner,
          file,
          releaseFiles: releaseFileConnections,
          refreshConnections,
        })
        await running.closed
      } catch (error) {
        await runner.close()
        // Another daemon already owns this directory; losing the race is not a failure.
        if (error instanceof Error && error.message.startsWith("A tool daemon is already running")) return
        throw error
      }
    })
  },
})

export const ToolCommand = cmd({
  command: "tool",
  describe: "run altimate-code data tools directly, without a model",
  builder: (yargs: Argv) => yargs.command(ToolListCommand).command(ToolContextCommand).command(ToolSchemaCommand).command(ToolRunCommand).command(ToolDaemonCommand).demandCommand(),
  async handler() {},
})
