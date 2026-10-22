import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import * as WorkspaceClient from "@/altimate/workspace/client"

// Small JSON-only surface for external clients. Content is stdin, never argv.
export const WorkspaceClientCommand = cmd({
  command: "workspace-client <action>",
  describe: "workspace context for coding clients (JSON; no model calls)",
  builder: (yargs) =>
    yargs
      .positional("action", { type: "string", choices: ["list", "context", "remember"] as const, demandOption: true })
      .option("directory", { type: "string", default: process.cwd() })
      .option("token", { type: "string", describe: "Workspace receipt from context (required for remember)" })
      .option("id", { type: "string", describe: "Memory block id (remember only)" }),
  async handler(args) {
    console.log = console.error.bind(console)
    const print = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
    try {
      if (args.action === "list") {
        print({ ok: true, workspaces: await WorkspaceClient.listWorkspaces() })
        return
      }
      await bootstrap(args.directory, async () => {
        if (args.action === "context") {
          print({ ok: true, ...(await WorkspaceClient.context(args.directory)) })
          return
        }
        if (!args.token || !args.id) throw new Error("remember requires --token and --id, with memory text on stdin.")
        let content = ""
        process.stdin.setEncoding("utf8")
        for await (const chunk of process.stdin) {
          content += chunk
          if (content.length > 2048) throw new Error("Memory must contain at most 2048 characters.")
        }
        print({ ok: true, ...(await WorkspaceClient.remember(args.directory, args.token, args.id, content)) })
      })
    } catch (error) {
      print({ ok: false, error: error instanceof Error ? error.message : String(error) })
      process.exitCode = 1
    }
  },
})
