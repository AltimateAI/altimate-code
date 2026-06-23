import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
// altimate_change start — trace: session tracing in headless serve
import { subscribeTraceConsumer } from "../../altimate/observability/trace-consumer"
// altimate_change end
// altimate_change start — self-update on headless serve startup
import { scheduleStartupUpgradeCheck } from "./serve-upgrade-check"
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
    // altimate_change start — sync datamate URL from IDE MCP config on serve startup.
    // When a VS Code/Cursor window restarts, the extension picks a new local port and
    // rewrites its MCP config. Re-reading it here keeps altimate-code.json in sync
    // without requiring any user action.
    const { syncDatamateUrlFromVscodeMcp } = await import("../../altimate/datamate-transport")
    await syncDatamateUrlFromVscodeMcp(process.cwd())
    // altimate_change end
    const server = await Server.listen(opts)
    console.log(`altimate-code server listening on http://${server.hostname}:${server.port}`)
    // altimate_change end

    // altimate_change start — trace: session tracing in headless serve
    // Sessions driven over HTTP (e.g. the VS Code chat panel) have no TUI
    // worker observing the event stream, so traces were never written in
    // serve mode. Subscribe the shared trace consumer to the in-process
    // event stream so serve sessions produce the same trace files as the
    // terminal entrypoints.
    //
    // `directory` is the SDK workspace/routing context, NOT the trace output
    // location — trace files always go to the configured tracing dir
    // (`tracing.dir`, default ~/.local/share/altimate-code/traces/).
    const traceSub = subscribeTraceConsumer({ directory: process.cwd() })

    // altimate_change start — self-update on startup
    // A headless `serve` is how the VS Code / Cursor extension runs
    // altimate-code, and it is the ONLY long-running entrypoint that never
    // checked for updates: auto-update was wired solely into the TUI bootstrap
    // (cli/cmd/tui/thread.ts → worker.checkUpgrade → upgrade()). As a result the
    // extension fleet froze at whatever version was installed at onboarding.
    // Fire the missing trigger here; see serve-upgrade-check.ts for why it runs
    // in (but never disposes) the process.cwd() instance.
    scheduleStartupUpgradeCheck()
    // altimate_change end

    // Finalize traces on shutdown. `serve` blocks forever on the promise below
    // and otherwise dies abruptly on signal, so without these handlers the
    // consumer's stop()/flush()/endTrace() never runs and serve traces are
    // left un-finalized (status never "completed", no summary/narrative).
    // Mirrors the SIGINT/SIGTERM/beforeExit pattern in cli/cmd/run.ts.
    let isShuttingDown = false
    const shutdown = async (code: number) => {
      if (isShuttingDown) return
      isShuttingDown = true
      await traceSub.stop()
      await server.stop()
      process.exit(code)
    }
    // Exit with signal-conventional codes (128 + signal number) so a
    // SIGINT/SIGTERM isn't masked as a successful (0) run. beforeExit is a
    // normal drain, so it exits 0. Matches cli/cmd/run.ts.
    process.once("SIGINT", () => void shutdown(130))
    process.once("SIGTERM", () => void shutdown(143))
    process.once("beforeExit", () => void shutdown(0))
    // altimate_change end

    await new Promise(() => {})
  },
})
