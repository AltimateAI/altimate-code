/**
 * Shared event-stream → trace consumer.
 *
 * Feeds bus events (message.updated, message.part.updated, session.updated,
 * session.status) into per-session Trace instances so every front-end that
 * observes the event stream writes the same trace files to
 * ~/.local/share/altimate-code/traces/.
 *
 * Extracted from cli/cmd/tui/worker.ts so the headless server
 * (`altimate serve`, used by the VS Code "Altimate Code" chat panel) produces
 * traces too — previously only the terminal entrypoints (TUI and `run`)
 * instantiated a tracer, and chat sessions were never traced.
 *
 * Consumers:
 *   - cli/cmd/tui/worker.ts — feeds events from its own SDK event loop
 *   - cli/cmd/serve.ts      — uses subscribeTraceConsumer() below
 */
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { setTimeout as sleep } from "node:timers/promises"
import { Config } from "@/config/config"
import { Log } from "@/util/log"
import { Server } from "@/server/server"
import { Flag } from "@/flag/flag"
import { Trace, FileExporter, HttpExporter, type TraceExporter } from "./tracing"

const MAX_TRACES = 100

/**
 * How long to wait after `session.status: idle` before finalizing a trace.
 *
 * Sessions emit trailing events after going idle — e.g. the user message is
 * re-published with its generated `summary` once title generation completes.
 * Finalizing immediately on idle would delete the trace from the map, and
 * the straggler would then lazily re-create an EMPTY trace for the same
 * sessionID whose finalization overwrites the rich `<sessionId>.json` file.
 * Any event arriving during the grace window is absorbed into the live
 * trace and pushes the finalization back.
 */
const FINALIZE_GRACE_MS = 2_000

/** Minimal structural view of a bus event — narrowed at each read site. */
interface BusEventLike {
  type?: string
  properties?: Record<string, unknown>
}

export class TraceConsumer {
  private sessionTraces = new Map<string, Trace>()
  // Per-session user message IDs (cleaned up on session end)
  private sessionUserMsgIds = new Map<string, Set<string>>()
  // Sessions that went idle and are waiting out the finalize grace window
  private pendingEnd = new Map<string, ReturnType<typeof setTimeout>>()

  // Cached tracing config — loaded once at first use
  private configLoaded = false
  private enabled = true
  private exporters: TraceExporter[] | undefined
  private maxFiles: number | undefined
  private finalizeGraceMs = FINALIZE_GRACE_MS

  /**
   * Optional overrides bypass config loading entirely — used by tests to
   * inject a FileExporter pointed at a temp directory and shrink the
   * finalize grace window.
   */
  constructor(overrides?: {
    exporters?: TraceExporter[]
    maxFiles?: number
    enabled?: boolean
    finalizeGraceMs?: number
  }) {
    if (overrides) {
      this.configLoaded = true
      this.enabled = overrides.enabled ?? true
      this.exporters = overrides.exporters
      this.maxFiles = overrides.maxFiles
      if (overrides.finalizeGraceMs !== undefined) this.finalizeGraceMs = overrides.finalizeGraceMs
    }
  }

  /** Load tracing config once. Safe to call repeatedly. */
  async loadConfig() {
    if (this.configLoaded) return
    this.configLoaded = true
    try {
      const cfg = await Config.get()
      const tc = cfg.tracing
      if (tc?.enabled === false) {
        this.enabled = false
        return
      }
      const exporters: TraceExporter[] = [new FileExporter(tc?.dir)]
      if (tc?.exporters) {
        for (const exp of tc.exporters) {
          exporters.push(new HttpExporter(exp.name, exp.endpoint, exp.headers))
        }
      }
      this.exporters = exporters
      this.maxFiles = tc?.maxFiles
    } catch {
      // Config failure should not prevent the host (TUI/serve) from working
    }
  }

  private getOrCreateTrace(sessionID: string): Trace | null {
    if (!sessionID || !this.enabled) return null
    if (this.sessionTraces.has(sessionID)) return this.sessionTraces.get(sessionID)!
    try {
      if (this.sessionTraces.size >= MAX_TRACES) {
        const oldest = this.sessionTraces.keys().next().value
        if (oldest) {
          Log.Default.warn(`[tracing] Evicting trace for session ${oldest} — ${MAX_TRACES} concurrent sessions reached`)
          this.sessionTraces
            .get(oldest)
            ?.endTrace()
            .catch(() => {})
          this.sessionTraces.delete(oldest)
          this.sessionUserMsgIds.delete(oldest)
          const pendingTimer = this.pendingEnd.get(oldest)
          if (pendingTimer) {
            clearTimeout(pendingTimer)
            this.pendingEnd.delete(oldest)
          }
        }
      }
      const trace = this.exporters
        ? Trace.withExporters([...this.exporters], { maxFiles: this.maxFiles })
        : Trace.create()
      trace.startTrace(sessionID, {})
      Trace.setActive(trace)
      this.sessionTraces.set(sessionID, trace)
      return trace
    } catch {
      return null
    }
  }

  /**
   * Schedule (or push back) finalization of a session's trace. Fires after
   * the grace window unless another event for the session arrives first.
   */
  private scheduleEnd(sessionID: string) {
    const existing = this.pendingEnd.get(sessionID)
    if (existing) clearTimeout(existing)
    this.pendingEnd.set(
      sessionID,
      setTimeout(() => {
        this.pendingEnd.delete(sessionID)
        const trace = this.sessionTraces.get(sessionID)
        if (trace) {
          void trace.endTrace().catch(() => {})
          this.sessionTraces.delete(sessionID)
          this.sessionUserMsgIds.delete(sessionID)
        }
      }, this.finalizeGraceMs),
    )
  }

  /** Feed one bus event into the per-session traces. Never throws. */
  handleEvent(event: unknown) {
    try {
      const e = event as BusEventLike
      // Any activity for a session that is waiting out the finalize grace
      // window pushes the finalization back — trailing events (e.g. the
      // user message re-published with its generated summary) are absorbed
      // into the live trace instead of re-creating an empty one.
      {
        const props = e.properties as Record<string, any> | undefined
        const sid = props?.sessionID ?? props?.info?.sessionID ?? props?.part?.sessionID ?? props?.info?.id
        if (typeof sid === "string" && this.pendingEnd.has(sid)) this.scheduleEnd(sid)
      }
      if (e.type === "message.updated") {
        const info = e.properties?.info as Record<string, any> | undefined
        // Resolve sessionID: use info.sessionID directly, or fall back to
        // finding the session via info.parentID (assistant messages may only
        // carry the parent message ID, not the session ID).
        let resolvedSessionID = info?.sessionID as string | undefined
        if (!resolvedSessionID && info?.parentID) {
          for (const [sid, msgIds] of this.sessionUserMsgIds) {
            if (msgIds.has(info.parentID)) {
              resolvedSessionID = sid
              break
            }
          }
        }
        if (info && resolvedSessionID) {
          // Create trace eagerly on user message (arrives before part events)
          const trace =
            this.sessionTraces.get(resolvedSessionID) ??
            (info.role === "user" ? this.getOrCreateTrace(resolvedSessionID) : null)
          if (info.role === "user") {
            if (info.id) {
              if (!this.sessionUserMsgIds.has(resolvedSessionID))
                this.sessionUserMsgIds.set(resolvedSessionID, new Set())
              this.sessionUserMsgIds.get(resolvedSessionID)!.add(info.id)
            }
            if (trace) {
              const title = info.summary?.title || info.summary?.body
              if (title) trace.setTitle(String(title).slice(0, 80), String(title))
            }
          }
          if (info.role === "assistant") {
            const r = trace ?? this.getOrCreateTrace(resolvedSessionID)
            r?.enrichFromAssistant({
              modelID: info.modelID,
              providerID: info.providerID,
              agent: info.agent,
              variant: info.variant,
            })
          }
        }
      }
      if (e.type === "message.part.updated") {
        const part = e.properties?.part as Record<string, any> | undefined
        if (part) {
          // Create trace on first event for this session (lazy creation)
          const trace = this.sessionTraces.get(part.sessionID) ?? this.getOrCreateTrace(part.sessionID)
          if (trace) {
            if (part.type === "step-start") trace.logStepStart(part as Parameters<Trace["logStepStart"]>[0])
            if (part.type === "step-finish") trace.logStepFinish(part as Parameters<Trace["logStepFinish"]>[0])
            if (part.type === "text" && part.time?.end) {
              if (part.messageID && this.sessionUserMsgIds.get(part.sessionID)?.has(part.messageID)) {
                // This is user prompt text — capture as title/prompt
                const text = String(part.text || "")
                if (text) trace.setTitle(text.slice(0, 80), text)
              } else {
                // This is assistant response text
                trace.logText(part as Parameters<Trace["logText"]>[0])
              }
            }
            if (part.type === "tool" && (part.state?.status === "completed" || part.state?.status === "error")) {
              trace.logToolCall(part as Parameters<Trace["logToolCall"]>[0])
            }
          }
        }
      }
      // Capture session title from session.updated events
      if (e.type === "session.updated") {
        const info = e.properties?.info as Record<string, any> | undefined
        if (info?.id && info?.title) {
          const trace = this.sessionTraces.get(info.id)
          if (trace) trace.setTitle(String(info.title))
        }
      }
      // Finalize trace when session reaches idle (completed) — after the
      // grace window, so post-idle stragglers don't clobber the trace file.
      if (e.type === "session.status") {
        const props = e.properties as Record<string, any> | undefined
        const sid = props?.sessionID
        const status = props?.status?.type
        if (status === "idle" && sid && this.sessionTraces.has(sid)) {
          this.scheduleEnd(sid)
        }
      }
    } catch {
      // Trace must never interrupt event forwarding
    }
  }

  /**
   * End all in-flight traces fire-and-forget and clear state.
   * Used before (re)starting an event stream so stale per-stream state
   * doesn't leak across stream instances.
   */
  reset() {
    for (const [, timer] of this.pendingEnd) clearTimeout(timer)
    this.pendingEnd.clear()
    for (const [, trace] of this.sessionTraces) {
      void trace.endTrace().catch(() => {})
    }
    this.sessionTraces.clear()
    this.sessionUserMsgIds.clear()
  }

  /** End all in-flight traces and wait for them. Used on shutdown. */
  async flush() {
    for (const [, timer] of this.pendingEnd) clearTimeout(timer)
    this.pendingEnd.clear()
    for (const [, trace] of this.sessionTraces) {
      await trace.endTrace().catch(() => {})
    }
    this.sessionTraces.clear()
    this.sessionUserMsgIds.clear()
  }
}

/**
 * Subscribe to the in-process event stream and feed every event to a
 * TraceConsumer. Mirrors the TUI worker's event loop for hosts that don't
 * have one of their own — i.e. `altimate serve`, where sessions are driven
 * over HTTP (the VS Code chat panel) and no other event consumer exists.
 *
 * Trace failures must never affect the server, so every step is best-effort.
 */
export function subscribeTraceConsumer(input: { directory: string }): { stop: () => Promise<void> } {
  const consumer = new TraceConsumer()
  const abort = new AbortController()
  const signal = abort.signal

  // In-process fetch against the default app — same pattern as the TUI
  // worker. The Bus is process-wide, so events published by sessions served
  // by the TCP listener arrive on this subscription too.
  const fetchFn = (async (fetchInput: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(fetchInput, init)
    const password = Flag.OPENCODE_SERVER_PASSWORD
    if (password) {
      const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
      request.headers.set("Authorization", `Basic ${btoa(`${username}:${password}`)}`)
    }
    return Server.Default().fetch(request)
  }) as typeof globalThis.fetch

  const sdk = createOpencodeClient({
    baseUrl: "http://altimate-code.internal",
    directory: input.directory,
    fetch: fetchFn,
    signal,
  })

  ;(async () => {
    await consumer.loadConfig()
    while (!signal.aborted) {
      const events = await Promise.resolve(sdk.event.subscribe({}, { signal })).catch(() => undefined)

      if (!events) {
        await sleep(250)
        continue
      }

      for await (const event of events.stream) {
        consumer.handleEvent(event)
      }

      if (!signal.aborted) {
        await sleep(250)
      }
    }
  })().catch((error) => {
    Log.Default.error("trace event stream error", {
      error: error instanceof Error ? error.message : error,
    })
  })

  return {
    stop: async () => {
      abort.abort()
      await consumer.flush()
    },
  }
}
