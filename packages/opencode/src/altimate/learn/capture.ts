// altimate_change - new file
//
// Automatic learning-signal capture, opt-in (config `learn.capture: true` or ALTIMATE_LEARN_CAPTURE=1).
// A Bus subscription started once per instance records, to the local signal store only:
//   - user_correction: a user message that follows at least one completed assistant message and that
//     `correctionReason` classifies as a correction (the first prompt is a task, never a correction);
//   - tool_retry: the same tool failing 3+ consecutive times, measured from tool-part error states.
// Capture is fail-safe: it logs and swallows every error, and never touches the prompt loop.
import { Log } from "../../util/log"
import { registerDisposer } from "../../effect/instance-registry"
import { correctionReason } from "./correction"
import { redactSecrets } from "./digest"
import { appendSignal, flushWrites, type NewSignal, type Signal } from "./signals"
import { captureEnabled } from "./config"

export { captureEnabled, autoReflectEnabled } from "./config"

const log = Log.create({ service: "learn.capture" })

export const RETRY_THRESHOLD = 3
const RETRY_ERROR_CAP = 500
const RECENT_ID_CAP = 1024
const SESSION_CAP = 128

/** Capture caches are best-effort; retain recent activity without growing for the process lifetime. */
function remember(ids: Set<string>, id: string, cap: number) {
  ids.delete(id)
  ids.add(id)
  if (ids.size > cap) ids.delete(ids.values().next().value!)
}

export interface ToolPartLike {
  id: string
  messageID: string
  tool: string
  state: { status: string; error?: string }
}

export interface RetryEpisode {
  tool: string
  count: number
  error: string
  messageID: string
  partID: string
}

/** Counts consecutive failures of one tool; reports each episode once, when it reaches the threshold. */
export class ToolRetryTracker {
  private tool: string | undefined
  private count = 0
  private reported = false
  private lastError = ""
  private seen = new Set<string>()

  observe(part: ToolPartLike): RetryEpisode | undefined {
    const status = part.state.status
    if (status !== "error" && status !== "completed") return undefined
    // A terminal state can be published more than once; count each call a single time.
    if (this.seen.has(part.id)) return undefined
    remember(this.seen, part.id, RECENT_ID_CAP)
    if (status === "completed") {
      this.tool = undefined
      this.count = 0
      this.reported = false
      return undefined
    }
    if (part.tool !== this.tool) {
      this.tool = part.tool
      this.count = 0
      this.reported = false
    }
    this.count++
    this.lastError = part.state.error ?? ""
    if (this.count >= RETRY_THRESHOLD && !this.reported) {
      this.reported = true
      return {
        tool: part.tool,
        count: this.count,
        error: redactSecrets(this.lastError).slice(0, RETRY_ERROR_CAP),
        messageID: part.messageID,
        partID: part.id,
      }
    }
    return undefined
  }
}

export interface MessageLike {
  id: string
  sessionID: string
  role: string
  time?: { created?: number; completed?: number }
}

export interface PartLike {
  id: string
  sessionID: string
  messageID: string
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  tool?: string
  state?: { status: string; error?: string }
}

export interface CaptureDeps {
  /** True when the session has a completed assistant message before the user message being classified. */
  hasPriorAssistant: (sessionID: string, beforeMessageID: string) => Promise<boolean>
  record: (signal: NewSignal) => Promise<Signal | undefined>
}

export class Capture {
  private userMessages = new Set<string>()
  private sessionsWithAssistant = new Map<string, string>()
  private trackers = new Map<string, ToolRetryTracker>()
  private pending = new Set<Promise<unknown>>()

  constructor(private deps: CaptureDeps) {}

  onMessage(info: MessageLike) {
    if (info.role === "user") remember(this.userMessages, info.id, RECENT_ID_CAP)
    else if (info.role === "assistant" && info.time?.completed) this.rememberAssistant(info.sessionID, info.id)
  }

  private rememberAssistant(sessionID: string, messageID: string) {
    const earliest = this.sessionsWithAssistant.get(sessionID)
    this.sessionsWithAssistant.delete(sessionID)
    this.sessionsWithAssistant.set(sessionID, earliest && earliest < messageID ? earliest : messageID)
    if (this.sessionsWithAssistant.size > SESSION_CAP)
      this.sessionsWithAssistant.delete(this.sessionsWithAssistant.keys().next().value!)
  }

  onPart(part: PartLike) {
    if (part.type === "text") return this.track(this.userText(part))
    if (part.type === "tool") return this.track(this.toolPart(part))
  }

  /** Resolves when every handler started so far has finished. */
  async flush() {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }

  private track(work: Promise<unknown>) {
    const p = work.catch((e) => log.warn("capture failed", { error: e instanceof Error ? e.message : String(e) }))
    this.pending.add(p)
    void p.finally(() => this.pending.delete(p))
    return p
  }

  private async userText(part: PartLike) {
    if (!this.userMessages.has(part.messageID) || part.synthetic || part.ignored || !part.text) return
    const reason = correctionReason(part.text)
    if (!reason) return
    const prior = this.sessionsWithAssistant.get(part.sessionID)
    const known = prior !== undefined && prior < part.messageID
    if (!known && !(await this.deps.hasPriorAssistant(part.sessionID, part.messageID))) return
    // A successful history lookup proves an assistant exists before this ID, not before older messages.
    this.rememberAssistant(part.sessionID, part.messageID)
    await this.deps.record({
      kind: "user_correction",
      sessionID: part.sessionID,
      messageID: part.messageID,
      text: part.text,
      reason,
    })
  }

  private async toolPart(part: PartLike) {
    if (!part.tool || !part.state) return
    const tracker = this.trackers.get(part.sessionID) ?? new ToolRetryTracker()
    this.trackers.delete(part.sessionID)
    this.trackers.set(part.sessionID, tracker)
    if (this.trackers.size > SESSION_CAP) this.trackers.delete(this.trackers.keys().next().value!)
    const episode = tracker.observe({ id: part.id, messageID: part.messageID, tool: part.tool, state: part.state })
    if (!episode) return
    await this.deps.record({
      kind: "tool_retry",
      sessionID: part.sessionID,
      messageID: episode.messageID,
      partID: episode.partID,
      text: `Tool \`${episode.tool}\` failed ${episode.count} consecutive times. Last error: ${episode.error}`,
      reason: `tool ${episode.tool} failed ${episode.count} consecutive times`,
    })
  }
}

// Keep every active capture drainable when more than one instance is open.
const active = new Set<Capture>()

export async function flushCapture() {
  await Promise.all([...active].map((capture) => capture.flush()))
  await flushWrites()
}

/**
 * `Bus.subscribe` is synchronous and throws while the bus runtime is still building (only possible when
 * capture starts before anything else used the bus). It is ready within a few ticks, so retry briefly.
 */
async function subscribeWhenReady<T>(subscribe: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return subscribe()
    } catch (e) {
      if (attempt >= 40) throw e
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

/**
 * Starts capture for one instance when enabled. Called once from instance bootstrap inside the instance
 * context. Never throws.
 */
export async function startCapture(ctx: { directory: string; worktree: string }): Promise<void> {
  try {
    const root = ctx.worktree !== "/" ? ctx.worktree : ctx.directory
    const { Config } = await import("@/config/config")
    if (!captureEnabled((await Config.get()).learn)) return
    const { Bus } = await import("@/bus")
    const { MessageV2 } = await import("../../session/message-v2")
    const { Session } = await import("../../session")
    const { SessionID } = await import("../../session/schema")
    const capture = new Capture({
      record: (signal) => appendSignal(root, signal),
      hasPriorAssistant: async (sessionID, beforeMessageID) => {
        const messages = await Session.messages({ sessionID: SessionID.make(sessionID) })
        return messages.some((m) => m.info.role === "assistant" && m.info.id < beforeMessageID && !!m.info.time.completed)
      },
    })
    active.add(capture)
    const subscriptions: Array<() => void> = []
    const unregister = registerDisposer(async (directory) => {
      if (directory !== ctx.directory) return
      for (const stop of subscriptions) stop()
      await capture.flush()
      await flushWrites()
      active.delete(capture)
      unregister()
    })
    subscriptions.push(
      await subscribeWhenReady(() => Bus.subscribe(MessageV2.Event.Updated, (evt) => capture.onMessage(evt.properties.info))),
    )
    subscriptions.push(
      await subscribeWhenReady(() =>
        Bus.subscribe(MessageV2.Event.PartUpdated, (evt) => void capture.onPart(evt.properties.part as PartLike)),
      ),
    )
    log.info("learn capture started", { root })
  } catch (e) {
    log.warn("learn capture not started", { error: e instanceof Error ? e.message : String(e) })
  }
}
