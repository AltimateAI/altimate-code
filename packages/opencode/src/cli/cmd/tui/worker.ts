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
import { Trace, FileExporter, HttpExporter, type TraceExporter } from "@/altimate/observability/tracing"
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

// altimate_change start — trace: monotonic stream generation. Bumped on every
// startEventStream() so an in-flight getOrCreateTrace() can detect that its
// owning stream was torn down while it was suspended at an await. Keyed on a
// counter rather than the AbortController's object identity so the guard does
// not silently depend on startEventStream always allocating a fresh controller.
let streamGeneration = 0
// altimate_change end

// altimate_change start — trace: per-session traces
const sessionTraces = new Map<string, Trace>()
const sessionUserMsgIds = new Map<string, Set<string>>() // Per-session user message IDs (cleaned up on session end)
const MAX_TRACES = 100

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

// altimate_change start — trace: get or create per-session trace
async function getOrCreateTrace(sessionID: string): Promise<Trace | null> {
  if (!sessionID || !tracingEnabled) return null
  if (sessionTraces.has(sessionID)) return sessionTraces.get(sessionID)!
  // altimate_change start — capture the stream generation that owns this call so
  // we can detect a concurrent startEventStream() (e.g. setWorkspace) that
  // aborted us and cleared the cache while we were suspended at the rehydrate
  // await below. A counter (not AbortController identity) so we don't depend on
  // startEventStream's allocation strategy.
  const generationAtEntry = streamGeneration
  // altimate_change end
  try {
    if (sessionTraces.size >= MAX_TRACES) {
      const oldest = sessionTraces.keys().next().value
      if (oldest) {
        Log.Default.warn(`[tracing] Evicting trace for session ${oldest} — ${MAX_TRACES} concurrent sessions reached`)
        sessionTraces.get(oldest)?.endTrace().catch(() => {})
        sessionTraces.delete(oldest)
        sessionUserMsgIds.delete(oldest)
      }
    }
    const trace = tracingExporters
      ? Trace.withExporters([...tracingExporters], { maxFiles: tracingMaxFiles })
      : Trace.create()
    // altimate_change start — prefer disk-rehydration on cache miss for an
    // existing session (worker restart, MAX_TRACES eviction). startTrace would
    // push a fresh root span into empty `this.spans` and the immediate
    // snapshot would clobber the rich on-disk file. Defense in depth in
    // addition to keeping the cache alive across turns.
    // Async to keep the event-stream loop unblocked on large existing traces.
    if (!(await trace.rehydrateFromFile(sessionID))) {
      trace.startTrace(sessionID, {})
    }
    // altimate_change end
    // altimate_change start — if a new stream replaced ours while we were
    // awaiting rehydrate, this Trace belongs to a stream that's already been
    // aborted and its cache cleared. Inserting it now would resurrect an orphan
    // writer into the freshly-cleared map. Discard it and defer to whatever the
    // live stream has. The check and the set below run in the same synchronous
    // turn (no await between them), so the insert can't race a later
    // startEventStream — this closes the suspend-at-await hole specifically.
    if (streamGeneration !== generationAtEntry) {
      void trace.endTrace().catch(() => {})
      return sessionTraces.get(sessionID) ?? null
    }
    Trace.setActive(trace)
    sessionTraces.set(sessionID, trace)
    return trace
    // altimate_change end
  } catch {
    return null
  }
}
// altimate_change end

const startEventStream = (input: { directory: string; workspaceID?: string }) => {
  if (eventStream.abort) eventStream.abort.abort()
  // altimate_change start — new stream generation; invalidates any in-flight
  // getOrCreateTrace() suspended at its rehydrate await (see generationAtEntry).
  streamGeneration++
  // altimate_change end
  // Clear stale per-stream trace state before starting a new stream instance
  for (const [, trace] of sessionTraces) {
    void trace.endTrace().catch(() => {})
  }
  sessionTraces.clear()
  sessionUserMsgIds.clear()

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
        // altimate_change start — trace: feed events to per-session trace
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
              // Create trace eagerly on user message (arrives before part events)
              const trace =
                sessionTraces.get(resolvedSessionID) ??
                (info.role === "user" ? await getOrCreateTrace(resolvedSessionID) : null)
              if (info.role === "user") {
                if (info.id) {
                  if (!sessionUserMsgIds.has(resolvedSessionID)) sessionUserMsgIds.set(resolvedSessionID, new Set())
                  sessionUserMsgIds.get(resolvedSessionID)!.add(info.id)
                }
                if (trace) {
                  const title = (info as any).summary?.title || (info as any).summary?.body
                  if (title) trace.setTitle(String(title).slice(0, 80), String(title))
                }
              }
              if (info.role === "assistant") {
                const r = trace ?? (await getOrCreateTrace(resolvedSessionID))
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
          // altimate_change start — trace: part events
          if (event.type === "message.part.updated") {
            const part = (event as any).properties?.part
            if (part) {
              // Create trace on first event for this session (lazy creation)
              const trace = sessionTraces.get(part.sessionID) ?? (await getOrCreateTrace(part.sessionID))
              if (trace) {
                if (part.type === "step-start") trace.logStepStart(part)
                if (part.type === "step-finish") trace.logStepFinish(part)
                // altimate_change start — split the user-vs-assistant text routes.
                // User text parts arrive without `time.end` set (it's a meaningful
                // concept only for processing-end of assistant chunks), so the old
                // `&& part.time?.end` gate dropped the prompt entirely. We trust
                // `sessionUserMsgIds.has(messageID)` as the user-text signal and
                // call `setPrompt(text)` only — never `setTitle` — to avoid racing
                // the auto-generated title from `session.updated` (Path C).
                if (part.type === "text") {
                  // altimate_change start — skip synthetic / ignored text parts.
                  // `Session.createUserMessage` (prompt.ts) attaches many `synthetic: true`
                  // text parts to the user message — MCP resource banners, decoded file
                  // contents, retry/reminder text, plan-mode reminders, agent-handoff
                  // tags. They all share the user's `messageID` so they would otherwise
                  // pass the `sessionUserMsgIds` check below and override `metadata.prompt`
                  // with the LAST synthetic blob (typically file content) and render one
                  // fake "▶ You" bubble per synthetic part in the chat tab. The synthetic
                  // and ignored flags exist precisely to mark non-authored content; this
                  // is exactly the place to consult them. We skip silently rather than
                  // `continue`-ing the event-loop iteration because the outer loop still
                  // needs to forward the event downstream via `Rpc.emit`.
                  const isAuthoredText = !part.synthetic && !part.ignored
                  // altimate_change end
                  if (
                    isAuthoredText &&
                    part.messageID &&
                    sessionUserMsgIds.get(part.sessionID)?.has(part.messageID)
                  ) {
                    const text = String(part.text || "")
                    if (text) {
                      trace.setPrompt(text)
                      // altimate_change start — record each user message as a span
                      // so the chat tab can render multi-turn conversations.
                      // Without a span, the viewer can only display `metadata.prompt`
                      // (singular) and every subsequent user message is silently
                      // dropped from the conversation rendering.
                      trace.logUserMessage(text)
                      // altimate_change end
                    }
                  } else if (isAuthoredText && part.time?.end) {
                    // Assistant response text (only counts when processing-end fires)
                    trace.logText(part)
                  }
                }
                // altimate_change end
                if (part.type === "tool" && (part.state?.status === "completed" || part.state?.status === "error")) {
                  trace.logToolCall(part)
                }
              }
            }
          }
          // altimate_change end
          // altimate_change start — trace: session title capture and finalization
          // Capture session title from session.updated events
          if (event.type === "session.updated") {
            const info = (event as any).properties?.info
            if (info?.id && info?.title) {
              const trace = sessionTraces.get(info.id)
              if (trace) trace.setTitle(String(info.title))
            }
          }
          // altimate_change start — DO NOT finalize the trace on session.status=idle.
          // `idle` fires after every turn (busy → idle transition), not at session end.
          // Calling `endTrace` + `sessionTraces.delete` here treats each turn as the
          // end of the session: the next event for the same session in a later turn
          // hits a cache miss in getOrCreateTrace, constructs a fresh Trace.create()
          // with empty `this.spans`, and the immediate `snapshot()` clobbers the
          // rich on-disk `ses_<id>.json` with a single root-span file. Symptoms:
          //   - waterfall view collapses to the system-prompt span after every turn
          //   - "What was asked / No prompt recorded" because metadata.prompt was
          //     captured on the destroyed instance, never on the replacement
          // Sessions in altimate-code are long-lived across many turns; the Trace
          // should live as long as the worker has the session in cache. Finalization
          // happens on `shutdown` (worker.ts:312) and on MAX_TRACES eviction
          // (worker.ts:87). No per-turn finalization is correct.
          // altimate_change end
        } catch {
          // Trace must never interrupt event forwarding
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
    for (const [sid, trace] of sessionTraces) {
      await trace.endTrace().catch(() => {})
    }
    sessionTraces.clear()
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
