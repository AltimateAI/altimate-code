import { Installation } from "@/installation"
import { Server } from "@/server/server"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import type { BunWebSocketData } from "hono/bun"
import { Flag } from "@/flag/flag"
import { setTimeout as sleep } from "node:timers/promises"
// altimate_change start — trace: session tracing in TUI
import { TraceConsumer } from "@/altimate/observability/trace-consumer"
// altimate_change end

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  level: (() => {
    if (Installation.isLocal()) return "DEBUG"
    return "INFO"
  })(),
})

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Bun.Server<BunWebSocketData> | undefined

const eventStream = {
  abort: undefined as AbortController | undefined,
}

// altimate_change start — trace: per-session traces (shared consumer)
// All per-session trace state + event handling lives in TraceConsumer so the
// headless `serve` entrypoint (VS Code chat panel) gets identical behaviour.
// reset() bumps the consumer's stream generation (the equivalent of the old
// inline cache-clear) to invalidate any in-flight rehydrate.
const traceConsumer = new TraceConsumer()
// altimate_change end

const startEventStream = (input: { directory: string; workspaceID?: string }) => {
  if (eventStream.abort) eventStream.abort.abort()
  // altimate_change start — trace: clear stale per-stream trace state before
  // starting a new stream instance. reset() also bumps the consumer's stream
  // generation, invalidating any in-flight getOrCreateTrace() suspended at its
  // rehydrate await.
  traceConsumer.reset()
  // altimate_change end

  const abort = new AbortController()
  eventStream.abort = abort
  const signal = abort.signal

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const auth = getAuthorizationHeader()
    if (auth) request.headers.set("Authorization", auth)
    return Server.Default().fetch(request)
  }) as typeof globalThis.fetch

  const sdk = createOpencodeClient({
    baseUrl: "http://altimate-code.internal",
    directory: input.directory,
    experimental_workspaceID: input.workspaceID,
    fetch: fetchFn,
    signal,
  })

  ;(async () => {
    // altimate_change start — trace: load tracing config once before processing events
    await traceConsumer.loadConfig()
    // altimate_change end
    while (!signal.aborted) {
      const events = await Promise.resolve(
        sdk.event.subscribe(
          {},
          {
            signal,
          },
        ),
      ).catch(() => undefined)

      if (!events) {
        await sleep(250)
        continue
      }

      for await (const event of events.stream) {
        // altimate_change start — trace: feed events to per-session trace
        await traceConsumer.handleEvent(event)
        // altimate_change end

        Rpc.emit("event", event as Event)
      }

      if (!signal.aborted) {
        await sleep(250)
      }
    }
  })().catch((error) => {
    Log.Default.error("event stream error", {
      error: error instanceof Error ? error.message : error,
    })
  })
}

// altimate_change start — track the last workspaceID used to start the event stream
// so `setWorkspace` becomes idempotent on unchanged values. SolidJS effects in the
// session route can fire on every `session()` signal change (including agent-finish);
// without this guard, every fire propagates to `startEventStream` which clears
// `sessionTraces`, which causes the next snapshot from a freshly-created Trace to
// overwrite the rich on-disk trace with a near-empty one. Symptom: waterfall view
// collapses to the system-prompt span after every turn.
let currentWorkspaceID: string | undefined
// altimate_change end

startEventStream({ directory: process.cwd() })

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = getAuthorizationHeader()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await Instance.provide({
      directory: input.directory,
      init: InstanceBootstrap,
      fn: async () => {
        await upgrade().catch((err) => {
          // Never silently swallow upgrade errors — if this fails, users
          // get locked on old versions with no way to self-heal.
          console.error("[upgrade] check failed:", String(err))
        })
      },
    })
  },
  async reload() {
    Config.global.reset()
    await Instance.disposeAll()
  },
  async setWorkspace(input: { workspaceID?: string }) {
    // altimate_change start — idempotency guard; see currentWorkspaceID comment above
    if (input.workspaceID === currentWorkspaceID) return
    currentWorkspaceID = input.workspaceID
    // altimate_change end
    startEventStream({ directory: process.cwd(), workspaceID: input.workspaceID })
  },
  async shutdown() {
    Log.Default.info("worker shutting down")
    if (eventStream.abort) eventStream.abort.abort()
    // altimate_change start — trace: flush all active traces on shutdown
    await traceConsumer.flush()
    // altimate_change end
    await Instance.disposeAll()
    if (server) server.stop(true)
  },
}

Rpc.listen(rpc)

function getAuthorizationHeader(): string | undefined {
  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return `Basic ${btoa(`${username}:${password}`)}`
}
