import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Workspace } from "../../control-plane/workspace"
import { Project } from "../../project/project"
import { Installation } from "../../installation"
// altimate_change start — trace: session tracing in headless serve
import { subscribeTraceConsumer } from "../../altimate/observability/trace-consumer"
// altimate_change end

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  // altimate_change start — upstream_fix: branding regression in describe + log line
  describe: "starts a headless altimate-code server",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    const server = await Server.listen(opts)
    console.log(`altimate-code server listening on http://${server.hostname}:${server.port}`)
    // altimate_change end

    // altimate_change start — trace: session tracing in headless serve
    // Sessions driven over HTTP (e.g. the VS Code chat panel) have no TUI
    // worker observing the event stream, so traces were never written in
    // serve mode. Subscribe the shared trace consumer to the in-process
    // event stream so serve sessions produce the same trace files as the
    // terminal entrypoints.
    const traceSub = subscribeTraceConsumer({ directory: process.cwd() })

    // Finalize traces on shutdown. `serve` blocks forever on the promise below
    // and otherwise dies abruptly on signal, so without these handlers the
    // consumer's stop()/flush()/endTrace() never runs and serve traces are
    // left un-finalized (status never "completed", no summary/narrative).
    // Mirrors the SIGINT/SIGTERM/beforeExit pattern in cli/cmd/run.ts.
    let isShuttingDown = false
    const shutdown = async () => {
      if (isShuttingDown) return
      isShuttingDown = true
      await traceSub.stop()
      await server.stop()
      process.exit(0)
    }
    process.once("SIGINT", () => void shutdown())
    process.once("SIGTERM", () => void shutdown())
    process.once("beforeExit", () => void shutdown())
    // altimate_change end

    await new Promise(() => {})
  },
})
