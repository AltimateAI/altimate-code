// altimate_change start — bounded fork-only run trace routing
// Fork-only run trace routing. Session ancestry authorizes capture; it never
// changes which events the CLI uses for answers, budgets, or termination.
import { LLMRequestEvent, Trace, USER_MESSAGE_INPUT_MAX_CHARS } from "../../altimate/observability/tracing"
import { bigintReplacer } from "../../altimate/util/json"
import { Log } from "../../altimate/util/log"

interface SessionInfo {
  id: string
  parentID?: string
}
interface Event {
  type: string
  properties: Record<string, any>
}
interface SessionState {
  trace: Trace
  parentID?: string
  users: Set<string>
  prompts: Set<string>
  errors: Map<string, string>
  busy: boolean
  taskLinks: Array<{ sessionId: string; messageId: string; callId: string }>
}

const CAPTURE_OMISSIONS = [
  "effective_system_prompt: requires an identity-bearing event at the LLM request boundary after system transforms and provider instructions",
  "resolved_tool_catalog: requires an identity-bearing event at the LLM request boundary after filtering, stubs, and retrieval",
  "internal_custom_spans: global active tracing is disabled for run because it cannot attribute concurrent child sessions",
]
const MAX_PENDING_EVENTS = 2000

function traceError(error: unknown): string {
  const serialized = JSON.stringify(error, (key, value) => {
    if (key === "responseHeaders") return undefined
    if (typeof value === "string") {
      return value.slice(0, key === "responseBody" ? 1000 : USER_MESSAGE_INPUT_MAX_CHARS)
    }
    return bigintReplacer(key, value)
  })
  return (serialized ?? "Unknown error").slice(0, USER_MESSAGE_INPUT_MAX_CHARS)
}

export class RunTracing {
  private sessions = new Map<string, SessionState>()
  private parents = new Map<string, string | undefined>()
  private pending: Array<{ sessionID: string; event: Event }> = []
  private lookedUp = new Set<string>()
  private pendingLinks = new Map<string, SessionState["taskLinks"]>()
  private requestCaptured = new Set<string>()
  private omittedEvents = 0
  private admission = Promise.resolve()

  constructor(
    private rootID: string,
    private root: Trace,
    private lookup: {
      get: (sessionID: string) => Promise<SessionInfo | undefined>
      children: (sessionID: string) => Promise<SessionInfo[]>
    },
  ) {
    this.sessions.set(rootID, this.state(root))
    root.setCaptureOmissions(CAPTURE_OMISSIONS)
    this.updateManifest()
  }

  private state(trace: Trace, parentID?: string): SessionState {
    return { trace, parentID, users: new Set(), prompts: new Set(), errors: new Map(), busy: false, taskLinks: [] }
  }

  private updateManifest() {
    this.root.setRunLineage({
      rootSessionId: this.rootID,
      sessions: [...this.sessions].map(([sessionId, state]) => ({
        sessionId,
        parentSessionId: state.parentID,
        traceId: state.trace.getIdentity().traceId,
        taskLinks: state.taskLinks,
      })),
    })
    if (this.omittedEvents) {
      // Preserve the root's capture status when updating the pending-event count.
      this.root.setCaptureOmissions([
        ...CAPTURE_OMISSIONS.filter(
          (item) => !this.requestCaptured.has(this.rootID) || item.startsWith("internal_custom_spans:"),
        ),
        `pending_events: ${this.omittedEvents} unverified events omitted after the ${MAX_PENDING_EVENTS}-event buffer limit`,
      ])
    }
  }

  private admit() {
    // Seeding and live events can discover the same child while its snapshot
    // is being read. Serialize admission so only one writer owns that child.
    const admission = this.admission.then(() => this.admitSessions())
    this.admission = admission.catch(() => {})
    return admission
  }

  private async admitSessions() {
    // A grandchild's creation may precede its parent's creation on a resumed
    // or reconnected stream. Resolve the known edges to a fixed point.
    let changed = true
    while (changed) {
      changed = false
      for (const [id, parentID] of this.parents) {
        if (this.sessions.has(id) || !parentID || !this.sessions.has(parentID)) continue
        const trace = await this.root.forkSession(id, { captureOmissions: CAPTURE_OMISSIONS })
        trace.setRunLineage({ rootSessionId: this.rootID, parentSessionId: parentID })
        const state = this.state(trace, parentID)
        state.taskLinks = this.pendingLinks.get(id) ?? []
        this.pendingLinks.delete(id)
        this.sessions.set(id, state)
        changed = true
      }
    }
    // Replay in original arrival order, with each session's own generation state.
    const pending = this.pending
    this.pending = []
    for (const item of pending) {
      if (this.sessions.has(item.sessionID)) this.capture(item.sessionID, item.event)
      else this.pending.push(item)
    }
    this.updateManifest()
  }

  private remember(info: SessionInfo) {
    if (info.id === this.rootID || this.sessions.has(info.id)) return
    this.parents.set(info.id, info.parentID)
    return this.admit()
  }

  private async verify(id: string, ancestors = new Set<string>()): Promise<boolean> {
    if (this.sessions.has(id)) return true
    if (ancestors.has(id)) return false
    ancestors.add(id)
    if (!this.lookedUp.has(id)) {
      this.lookedUp.add(id)
      const info = await this.lookup.get(id).catch(() => undefined)
      if (info?.id === id) await this.remember(info)
    }
    const parent = this.parents.get(id)
    if (parent && (await this.verify(parent, ancestors))) await this.admit()
    return this.sessions.has(id)
  }

  /** Seed existing children recursively before sending a resumed run's prompt. */
  async seed() {
    const visited = new Set<string>()
    const visit = async (id: string) => {
      if (visited.has(id)) return
      visited.add(id)
      const children = await this.lookup.children(id).catch(() => [])
      for (const child of children) {
        if (child.parentID !== id) continue
        await this.remember(child)
        await visit(child.id)
      }
    }
    await visit(this.rootID)
  }

  /** Observe before the CLI root filter. Tracing failure must not affect the run. */
  async observe(input: unknown) {
    try {
      const event = input as Event
      const props = event.properties
      if (!props) return
      if (event.type === "session.created" || event.type === "session.updated") {
        const info = props.info as SessionInfo | undefined
        if (!info?.id) return
        await this.remember(info)
        if (info.parentID) await this.verify(info.id)
      }
      const id =
        props.part?.sessionID ??
        props.info?.sessionID ??
        props.sessionID ??
        (event.type.startsWith("session.") ? props.info?.id : undefined)
      if (typeof id !== "string") return
      if (!(await this.verify(id))) {
        if (this.pending.length >= MAX_PENDING_EVENTS) {
          this.pending.shift()
          this.omittedEvents++
          this.updateManifest()
        }
        this.pending.push({ sessionID: id, event })
        return
      }
      this.capture(id, event)
      // Replayed early task parts register links in capture() too. Verify only
      // through real ancestry; a task result naming another session is not proof.
      for (const childID of this.pendingLinks.keys()) await this.verify(childID)
    } catch (error) {
      // Event consumers must remain live even when an individual recording fails.
      Log.Default.debug("[tracing] run event capture failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private capture(id: string, event: Event) {
    const state = this.sessions.get(id)!
    const trace = state.trace
    const props = event.properties
    if (event.type === LLMRequestEvent.type) {
      trace.logLLMRequest(LLMRequestEvent.properties.parse(props))
      this.requestCaptured.add(id)
      return
    }
    if (event.type === "message.updated") {
      const info = props.info
      if (info.role === "user") state.users.add(info.id)
      if (info.role === "assistant") {
        trace.enrichFromAssistant(info)
        if (info.error) state.errors.set(String(info.error.name), traceError(info.error))
        else if (info.finish === "error" || info.finish === "other") {
          state.errors.set("AbnormalFinish", `Assistant ended with ${info.finish}`)
        }
      }
    }
    if (event.type === "session.status") state.busy = props.status?.type !== "idle"
    if (event.type === "session.error" && props.error) {
      state.errors.set(String(props.error.name), traceError(props.error))
    }
    if (event.type === "session.compacted") state.errors.delete("ContextOverflowError")
    if (event.type !== "message.part.updated") return
    const part = props.part
    if (part.type === "tool" && part.tool === "task") {
      const childID = part.state?.metadata?.sessionId ?? part.state?.input?.task_id
      if (typeof childID === "string" && childID && part.messageID && part.callID) {
        const link = { sessionId: id, messageId: String(part.messageID), callId: String(part.callID) }
        const links = this.sessions.get(childID)?.taskLinks ?? this.pendingLinks.get(childID) ?? []
        if (
          !links.some(
            (existing) =>
              existing.sessionId === id && existing.messageId === link.messageId && existing.callId === link.callId,
          )
        ) {
          links.push(link)
          if (this.sessions.has(childID)) this.updateManifest()
        }
        if (!this.sessions.has(childID)) this.pendingLinks.set(childID, links)
      }
    }
    if (part.type === "step-start") trace.logStepStart(part)
    if (part.type === "step-finish") trace.logStepFinish(part)
    if (part.type === "tool" && ["completed", "error"].includes(part.state?.status)) trace.logToolCall(part)
    if (part.type === "reasoning" && part.time?.end) trace.logReasoning(part)
    if (part.type === "text" && !part.ignored) {
      if (state.users.has(part.messageID)) {
        if (!part.text || state.prompts.has(part.id)) return
        state.prompts.add(part.id)
        const now = Date.now()
        trace.logSpan({
          name: part.synthetic ? "synthetic-prompt" : "user-prompt",
          input: part.text.slice(0, USER_MESSAGE_INPUT_MAX_CHARS),
          startTime: now,
          endTime: now,
          attributes: { sessionId: id, messageId: part.messageID, synthetic: part.synthetic === true },
        })
      } else if (part.time?.end) trace.logText(part)
    }
  }

  flushSync(reason: string) {
    this.updateManifest()
    for (const state of this.sessions.values()) state.trace.flushSync(reason)
  }

  async finish(rootError?: string) {
    this.updateManifest()
    await Promise.allSettled(
      [...this.sessions]
        .filter(([id]) => id !== this.rootID)
        .map(([, state]) => {
          const error =
            [...state.errors.values()].join("\n") ||
            (state.busy ? "The root run ended while this child session was still active." : undefined)
          return state.trace.endTrace(error)
        }),
    )
    return this.root.endTrace(rootError)
  }
}
// altimate_change end
