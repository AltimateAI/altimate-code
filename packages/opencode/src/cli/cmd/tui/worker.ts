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
// altimate_change start — recap: tracing in TUI
import { Recap, FileExporter, HttpExporter, type TraceExporter } from "@/altimate/observability/tracing"
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

// altimate_change start — recap: per-session recaps
const sessionRecaps = new Map<string, Recap>()
const sessionUserMsgIds = new Map<string, Set<string>>() // Per-session user message IDs (cleaned up on session end)
const MAX_RECAPS = 100

// Cached tracing config — loaded once at first use
let tracingConfigLoaded = false
let tracingEnabled = true
let tracingExporters: TraceExporter[] | undefined
let tracingMaxFiles: number | undefined

async function loadTracingConfig() {
  if (tracingConfigLoaded) return
  tracingConfigLoaded = true
  try {
    const cfg = await Config.get()
    const tc = cfg.tracing
    if (tc?.enabled === false) { tracingEnabled = false; return }
    const exporters: TraceExporter[] = [new FileExporter(tc?.dir)]
    if (tc?.exporters) {
      for (const exp of tc.exporters) {
        exporters.push(new HttpExporter(exp.name, exp.endpoint, exp.headers))
      }
    }
    tracingExporters = exporters
    tracingMaxFiles = tc?.maxFiles
  } catch {
    // Config failure should not prevent TUI from working
  }
}
// altimate_change end

// altimate_change start — recap: renamed getOrCreateTracer → getOrCreateRecap
function getOrCreateRecap(sessionID: string): Recap | null {
  if (!sessionID || !tracingEnabled) return null
  if (sessionRecaps.has(sessionID)) return sessionRecaps.get(sessionID)!
  try {
    if (sessionRecaps.size >= MAX_RECAPS) {
      const oldest = sessionRecaps.keys().next().value
      if (oldest) {
        Log.Default.warn(`[tracing] Evicting recap for session ${oldest} — ${MAX_RECAPS} concurrent sessions reached`)
        sessionRecaps.get(oldest)?.endTrace().catch(() => {})
        sessionRecaps.delete(oldest)
        sessionUserMsgIds.delete(oldest)
      }
    }
    const recap = tracingExporters
      ? Recap.withExporters([...tracingExporters], { maxFiles: tracingMaxFiles })
      : Recap.create()
    recap.startTrace(sessionID, {})
    Recap.setActive(recap)
    sessionRecaps.set(sessionID, recap)
    return recap
  } catch {
    return null
  }
}
// altimate_change end

const startEventStream = (input: { directory: string; workspaceID?: string }) => {
  if (eventStream.abort) eventStream.abort.abort()
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
    // Load tracing config once before processing events
    await loadTracingConfig()
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
        // altimate_change start — recap: feed events to per-session recap
        try {
          if (event.type === "message.updated") {
            const info = (event as any).properties?.info
            // Resolve sessionID: use info.sessionID directly, or fall back to
            // finding the session via info.parentID (assistant messages may only
            // carry the parent message ID, not the session ID).
            let resolvedSessionID = info?.sessionID as string | undefined
            if (!resolvedSessionID && info?.parentID) {
              for (const [sid, msgIds] of sessionUserMsgIds) {
                if (msgIds.has(info.parentID)) {
                  resolvedSessionID = sid
                  break
                }
              }
            }
            if (resolvedSessionID) {
              // Create recap eagerly on user message (arrives before part events)
              const recap = sessionRecaps.get(resolvedSessionID) ?? (info.role === "user" ? getOrCreateRecap(resolvedSessionID) : null)
              if (info.role === "user") {
                if (info.id) {
                  if (!sessionUserMsgIds.has(resolvedSessionID)) sessionUserMsgIds.set(resolvedSessionID, new Set())
                  sessionUserMsgIds.get(resolvedSessionID)!.add(info.id)
                }
                if (recap) {
                  const title = (info as any).summary?.title || (info as any).summary?.body
                  if (title) recap.setTitle(String(title).slice(0, 80), String(title))
                }
              }
              if (info.role === "assistant") {
                const r = recap ?? getOrCreateRecap(resolvedSessionID)
                r?.enrichFromAssistant({
                  modelID: info.modelID,
                  providerID: info.providerID,
                  agent: info.agent,
                  variant: info.variant,
                })
              }
            }
          }
          // altimate_change end
          // altimate_change start — recap: renamed tracer→recap, sessionTracers→sessionRecaps in part events
          if (event.type === "message.part.updated") {
            const part = (event as any).properties?.part
            if (part) {
              // Create recap on first event for this session (lazy creation)
              const recap = sessionRecaps.get(part.sessionID) ?? getOrCreateRecap(part.sessionID)
              if (recap) {
                if (part.type === "step-start") recap.logStepStart(part)
                if (part.type === "step-finish") recap.logStepFinish(part)
                if (part.type === "text" && part.time?.end) {
                  if (part.messageID && sessionUserMsgIds.get(part.sessionID)?.has(part.messageID)) {
                    // This is user prompt text — capture as title/prompt
                    const text = String(part.text || "")
                    if (text) recap.setTitle(text.slice(0, 80), text)
                  } else {
                    // This is assistant response text
                    recap.logText(part)
                  }
                }
                if (part.type === "tool" && (part.state?.status === "completed" || part.state?.status === "error")) {
                  recap.logToolCall(part)
                }
              }
            }
          }
          // altimate_change end
          // altimate_change start — recap: session title capture and finalization (renamed variables)
          // Capture session title from session.updated events
          if (event.type === "session.updated") {
            const info = (event as any).properties?.info
            if (info?.id && info?.title) {
              const recap = sessionRecaps.get(info.id)
              if (recap) recap.setTitle(String(info.title))
            }
          }
          // Finalize recap when session reaches idle (completed)
          if (event.type === "session.status") {
            const sid = (event as any).properties?.sessionID
            const status = (event as any).properties?.status?.type
            if (status === "idle" && sid) {
              const recap = sessionRecaps.get(sid)
              if (recap) {
                void recap.endTrace().catch(() => {})
                sessionRecaps.delete(sid)
                sessionUserMsgIds.delete(sid)
              }
            }
          }
        } catch {
          // Recap must never interrupt event forwarding
        }
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
    startEventStream({ directory: process.cwd(), workspaceID: input.workspaceID })
  },
  async shutdown() {
    Log.Default.info("worker shutting down")
    if (eventStream.abort) eventStream.abort.abort()
    // altimate_change start — recap: flush all active recaps on shutdown
    for (const [sid, recap] of sessionRecaps) {
      await recap.endTrace().catch(() => {})
    }
    sessionRecaps.clear()
    sessionUserMsgIds.clear()
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
