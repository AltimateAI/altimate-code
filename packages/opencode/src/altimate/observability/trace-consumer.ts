/**
 * Shared event-stream → trace consumer.
 *
 * Feeds bus events (message.updated, message.part.updated, session.updated)
 * into per-session Trace instances so every front-end that observes the event
 * stream writes the same trace files to ~/.local/share/altimate-code/traces/.
 *
 * Extracted from cli/cmd/tui/worker.ts so the headless server
 * (`altimate serve`, used by the VS Code "Altimate Code" chat panel) produces
 * traces too — previously only the terminal entrypoints (TUI and `run`)
 * instantiated a tracer, and chat sessions were never traced.
 *
 * The per-event logic here is a 1:1 port of the worker's inline handling so
 * both front-ends behave identically:
 *   - traces are NOT finalized on `session.status: idle` — idle fires after
 *     every turn, not at session end; finalization happens on flush()
 *     (shutdown) and on MAX_TRACES eviction. Long-lived sessions keep their
 *     Trace in cache across turns.
 *   - cache-miss re-creation rehydrates the rich on-disk trace
 *     (`rehydrateFromFile`) instead of starting fresh and clobbering it.
 *   - a monotonic stream generation guards getOrCreateTrace against a
 *     concurrent reset() (the consumer's equivalent of the worker's
 *     startEventStream cache-clear) tearing the cache out mid-await.
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

/** Minimal structural view of a bus event — narrowed at each read site. */
interface BusEventLike {
  type?: string
  properties?: Record<string, unknown>
}

export class TraceConsumer {
  private sessionTraces = new Map<string, Trace>()
  // Per-session user message IDs (cleaned up on session end)
  private sessionUserMsgIds = new Map<string, Set<string>>()
  // Monotonic stream generation. Bumped on every reset() so an in-flight
  // getOrCreateTrace() can detect that its owning stream was torn down while
  // it was suspended at the rehydrate await. Keyed on a counter rather than
  // any object identity so the guard doesn't depend on caller behaviour.
  private streamGeneration = 0

  // Cached tracing config — loaded once at first use
  private configLoaded = false
  private enabled = true
  private exporters: TraceExporter[] | undefined
  private maxFiles: number | undefined

  /**
   * Optional overrides bypass config loading entirely — used by tests to
   * inject a FileExporter pointed at a temp directory.
   */
  constructor(overrides?: { exporters?: TraceExporter[]; maxFiles?: number; enabled?: boolean }) {
    if (overrides) {
      this.configLoaded = true
      this.enabled = overrides.enabled ?? true
      this.exporters = overrides.exporters
      this.maxFiles = overrides.maxFiles
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

  private async getOrCreateTrace(sessionID: string): Promise<Trace | null> {
    if (!sessionID || !this.enabled) return null
    if (this.sessionTraces.has(sessionID)) return this.sessionTraces.get(sessionID)!
    // Capture the stream generation that owns this call so we can detect a
    // concurrent reset() that cleared the cache while we were suspended at the
    // rehydrate await below.
    const generationAtEntry = this.streamGeneration
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
        }
      }
      const trace = this.exporters
        ? Trace.withExporters([...this.exporters], { maxFiles: this.maxFiles })
        : Trace.create()
      // Prefer disk-rehydration on cache miss for an existing session (worker
      // restart, MAX_TRACES eviction, post-turn re-creation). startTrace would
      // push a fresh root span into empty `this.spans` and the immediate
      // snapshot would clobber the rich on-disk file.
      if (!(await trace.rehydrateFromFile(sessionID))) {
        trace.startTrace(sessionID, {})
      }
      // If a reset() replaced our stream while we were awaiting rehydrate, this
      // Trace belongs to a stream that's already torn down and its cache
      // cleared. Inserting it now would resurrect an orphan writer into the
      // freshly-cleared map. Discard it and defer to the live stream. The check
      // and the set below run in the same synchronous turn (no await between),
      // so the insert can't race a later reset().
      if (this.streamGeneration !== generationAtEntry) {
        void trace.endTrace().catch(() => {})
        return this.sessionTraces.get(sessionID) ?? null
      }
      Trace.setActive(trace)
      this.sessionTraces.set(sessionID, trace)
      return trace
    } catch {
      return null
    }
  }

  /** Feed one bus event into the per-session traces. Never throws. */
  async handleEvent(event: unknown): Promise<void> {
    try {
      const e = event as BusEventLike
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
            (info.role === "user" ? await this.getOrCreateTrace(resolvedSessionID) : null)
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
            const r = trace ?? (await this.getOrCreateTrace(resolvedSessionID))
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
          const trace = this.sessionTraces.get(part.sessionID) ?? (await this.getOrCreateTrace(part.sessionID))
          if (trace) {
            if (part.type === "step-start") trace.logStepStart(part as Parameters<Trace["logStepStart"]>[0])
            if (part.type === "step-finish") trace.logStepFinish(part as Parameters<Trace["logStepFinish"]>[0])
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
              if (isAuthoredText && part.messageID && this.sessionUserMsgIds.get(part.sessionID)?.has(part.messageID)) {
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
                trace.logText(part as Parameters<Trace["logText"]>[0])
              }
            }
            // altimate_change end
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
      // DO NOT finalize the trace on session.status=idle. `idle` fires after
      // every turn (busy → idle), not at session end. Finalizing per-turn would
      // treat each turn as session end and the next turn's events would hit a
      // cache miss; getOrCreateTrace rehydrates from disk as defense in depth,
      // but the correct behaviour is to keep the Trace live across turns and
      // finalize only on flush() (shutdown) and MAX_TRACES eviction.
    } catch {
      // Trace must never interrupt event forwarding
    }
  }

  /**
   * Bump the stream generation and end all in-flight traces fire-and-forget,
   * then clear state. The worker calls this at the top of every
   * startEventStream so stale per-stream state doesn't leak across stream
   * instances; the generation bump invalidates any getOrCreateTrace suspended
   * at its rehydrate await.
   */
  reset() {
    this.streamGeneration++
    for (const [, trace] of this.sessionTraces) {
      void trace.endTrace().catch(() => {})
    }
    this.sessionTraces.clear()
    this.sessionUserMsgIds.clear()
  }

  /** End all in-flight traces and wait for them. Used on shutdown. */
  async flush() {
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
        await consumer.handleEvent(event)
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
