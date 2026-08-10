import { cmd } from "@/cli/cmd/cmd"
import { Rpc } from "@/util/rpc"
import { type rpc } from "../tui/worker"
import path from "path"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import { errorMessage } from "@opencode-ai/tui/util/error"
import { withTimeout } from "@/util/timeout"
// altimate_change start — upstream_fix: TUI network options honor global server config
import { withNetworkOptions, resolveNetworkOptions } from "@/cli/network"
import { AppRuntime } from "@/effect/app-runtime"
// altimate_change end
import { Filesystem } from "@/util/filesystem"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import type { EventSource } from "@opencode-ai/tui/context/sdk"
import { writeHeapSnapshot } from "v8"
import { validateSession } from "../tui/validate-session"
import { win32InstallCtrlCGuard } from "@opencode-ai/tui/terminal-win32"
// altimate_change start — onboarding telemetry: main-thread flush on the TUI exit path
import { Telemetry } from "@/altimate/telemetry"
import * as OnboardingTelemetry from "@/altimate/telemetry/onboarding"
import { AltimateApi } from "@/altimate/api/client"
// altimate_change end

declare global {
  const OPENCODE_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient): EventSource {
  return {
    subscribe: async (handler) => {
      return client.on<GlobalEvent>("global.event", (e) => {
        handler(e)
      })
    },
  }
}

async function target() {
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
  const dist = new URL("./cli/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("../tui/worker.ts", import.meta.url)
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  return Filesystem.resolve(cwd)
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  // altimate_change — rebrand --help text
  describe: "start altimate-code tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        // altimate_change — rebrand --help text
        describe: "path to start altimate-code in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      // altimate_change — checkpoint 8d. Resolved same-directory-only against
      // workspace-link.json (RETURN-LEG.md decision 4) — see altimate/workspace-link/resolve.ts.
      .option("workspace", {
        type: "string",
        describe: "attach this session to a linked workspace, by name",
      }),
  handler: async (args) => {
    const unguard = win32InstallCtrlCGuard()
    try {
      const { TuiConfig } = await import("@/config/tui")
      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the thread and worker share the same directory key.
      const next = resolveThreadDirectory(args.project)
      const file = await target()
      try {
        process.chdir(next)
      } catch {
        UI.error("Failed to change directory to " + next)
        return
      }
      const cwd = Filesystem.resolve(process.cwd())

      // altimate_change start — checkpoint 8d: the --workspace flag / cwd resolution / launch-
      // time drift check. MUST run before the worker starts (needs stdin/stdout for its native
      // prompts) and MUST NOT ever block launch — a failure here (backend unreachable, a
      // malformed local state file, etc.) is logged and swallowed, never fatal to starting the
      // TUI. Sets altimate/workspace-link/session-context.ts's in-memory singleton as a side
      // effect; nothing else here depends on its result.
      try {
        const { resolveWorkspaceForLaunch } = await import("@/altimate/workspace-link/resolve")
        await resolveWorkspaceForLaunch(cwd, args.workspace)
      } catch (err) {
        UI.error(`workspace resolution failed (continuing without a workspace): ${err instanceof Error ? err.message : String(err)}`)
      }
      // altimate_change end

      // altimate_change start — hand the launch correlation id to the worker explicitly. A Bun
      // Worker does not see runtime mutations to process.env, so without this the worker mints its
      // own and the TUI-thread and worker-thread halves of the onboarding funnel cannot be joined.
      const worker = new Worker(file, {
        env: { ...process.env, ALTIMATE_LAUNCH_ID: Telemetry.launchId() },
      } as WorkerOptions)
      // altimate_change end
      const client = Rpc.client<typeof rpc>(worker)
      const reload = () => {
        client.call("reload", undefined).catch(() => {})
      }
      process.on("SIGUSR2", reload)

      let stopped = false
      const stop = async () => {
        if (stopped) return
        stopped = true
        process.off("SIGUSR2", reload)
        // altimate_change start — budget shared with the worker's own flush deadline, so the two
        // halves cannot drift apart and truncate the worker's telemetry buffer.
        await withTimeout(client.call("shutdown", undefined), Telemetry.TUI_SHUTDOWN_BUDGET_MS).catch(() => {})
        // altimate_change end
        worker.terminate()
      }

      // altimate_change start — upstream_fix: clean up TUI worker after failed --session validation
      try {
        const prompt = await input(args.prompt)
        const config = await TuiConfig.get()

        const network = await AppRuntime.runPromise(resolveNetworkOptions(args))
        const external =
          process.argv.includes("--port") ||
          process.argv.includes("--hostname") ||
          process.argv.includes("--mdns") ||
          network.mdns ||
          network.port !== 0 ||
          network.hostname !== "127.0.0.1"

        const transport = external
          ? {
              url: (await client.call("server", network)).url,
              fetch: undefined,
              events: undefined,
            }
          : {
              url: "http://opencode.internal",
              fetch: createWorkerFetch(client),
              events: createEventSource(client),
            }

        try {
          await validateSession({
            url: transport.url,
            sessionID: args.session,
            directory: cwd,
            fetch: transport.fetch,
          })
        } catch (error) {
          UI.error(errorMessage(error))
          process.exitCode = 1
          return
        }

        setTimeout(() => {
          client.call("checkUpgrade", { directory: cwd }).catch(() => {})
        }, 1000).unref?.()

        const { Effect } = await import("effect")
        const { run } = await import("../tui/layer")
        const { createLegacyTuiPluginHost } = await import("@/plugin/tui/runtime")
        await Effect.runPromise(
          run({
            url: transport.url,
            async onSnapshot() {
              const tui = writeHeapSnapshot("tui.heapsnapshot")
              const server = await client.call("snapshot", undefined)
              return [tui, server]
            },
            config,
            pluginHost: createLegacyTuiPluginHost(),
            // altimate_change — onboarding funnel seam. Deliberately a single-line marker, not a
            // start/end pair: this sits inside the "clean up TUI worker after failed --session
            // validation" region, and a nested closing marker truncates the block that
            // test/cli/tui/command.test.ts slices to assert cleanup ordering. (Do not spell that
            // marker out in prose here either — the parser matches the token in comment text and
            // would close the region on this very line.)
            //
            // The TUI renders on this thread, so
            // this reaches the main-process Telemetry module directly (already initialized by the
            // CLI middleware) — no HTTP, no worker round-trip.
            //
            // The `name` → `type` remap is the one untyped point in the chain: packages/tui
            // cannot import the Telemetry event union, so it declares its own mirror in
            // context/onboarding-telemetry.tsx. A test pins the two lists together.
            //
            // Selecting the gateway provider also marks the auth stage, because the browser flow
            // itself runs in the worker and cannot reach this thread's abandonment state.
            onTelemetry: (event) => {
              const { name, ...props } = event
              // The gateway auth flow emits from the WORKER, which cannot see this thread's
              // funnel state. Tell it once, when the funnel opens, so those events are scoped to a
              // real first run instead of firing for every /auth. (No nested marker pair here —
              // see the note above.)
              if (name === "onboarding_started") {
                OnboardingTelemetry.markFunnelActive()
                client.call("onboardingStarted", undefined).catch(() => {})
              }
              if (name === "provider_selected") {
                // Classify here, not in the TUI: a provider a user declared in their own config
                // can be named after their company, so the raw id is only forwarded when it is on
                // the known-public allowlist.
                const { searchAll, providerID, modelID, ...rest } = props as {
                  searchAll?: boolean
                  providerID?: string
                  modelID?: string
                  via_search?: boolean
                }
                const classified = searchAll
                  ? { provider: "search_all" as const }
                  : Telemetry.classifyProvider(providerID ?? "", modelID)
                if (classified.provider === "altimate_gateway") OnboardingTelemetry.markStage("gateway_auth")
                void OnboardingTelemetry.emit({ type: name, ...rest, ...classified } as Parameters<
                  typeof OnboardingTelemetry.emit
                >[0])
                return
              }
              void OnboardingTelemetry.emit({ type: name, ...props } as Parameters<
                typeof OnboardingTelemetry.emit
              >[0])
            },
            directory: cwd,
            fetch: transport.fetch,
            events: transport.events,
            args: {
              continue: args.continue,
              sessionID: args.session,
              agent: args.agent,
              model: args.model,
              prompt,
              fork: args.fork,
            },
          }),
        )
      } finally {
        await stop()
      }
      // altimate_change end
    } finally {
      try {
        unguard?.()
      } catch {}
      // altimate_change start — flush main-thread telemetry before the explicit exit below.
      // This handler ends with process.exit(0), which skips the outer `finally` in src/index.ts
      // that normally calls Telemetry.shutdown(). Without this, every event tracked on the TUI
      // thread since the last 5s interval flush is lost — including onboarding_abandoned, which
      // by definition only fires here. Runs after stop() so the worker has already drained.
      //
      // Bounded from the INSIDE (shutdown → flush → AbortController), not by racing a timer:
      // a lost race would leave the flush running and resetting module state after we resumed.
      // flush() would otherwise block for REQUEST_TIMEOUT_MS (10s) on a blackholed network — a
      // visible hang between the user quitting and the shell prompt returning.
      try {
        // The inner bound covers the flush only. Two things ahead of it can also stall — the
        // credential read, and shutdown()'s await of an initialization the request middleware
        // started — so the whole finalizer is raced too. Racing is safe HERE (unlike inside
        // flush, per the note above) because the only thing after it is process.exit(0): nothing
        // resumes to observe module state a straggler might still be mutating.
        await withTimeout(
          (async () => {
            // Ask whether gateway credentials landed. The success events are emitted on the
            // worker thread and this state is main-thread-owned, so without this a browser
            // sign-in that completed just before the user quit is reported as an abandonment in
            // the same launch that already reported instance_connected.
            const connected = await AltimateApi.isConfigured().catch(() => false)
            await OnboardingTelemetry.emitAbandonedIfIncomplete({ connected })
            await Telemetry.shutdown({ timeoutMs: Telemetry.EXIT_FLUSH_BUDGET_MS })
          })(),
          Telemetry.EXIT_FLUSH_BUDGET_MS + 1000,
        )
      } catch {
        // Never let telemetry delay or break exit.
      }
      // altimate_change end
    }
    process.exit(0)
  },
})
