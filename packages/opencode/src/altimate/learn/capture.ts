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

export type TurnMessage = MessageLike & { synthetic?: boolean; compaction?: boolean; replay?: boolean }

type TurnPart = { type: string; synthetic?: boolean; metadata?: Record<string, unknown> }

/**
 * Session history as turn boundaries. All-synthetic text continues a turn unless the message carries user input
 * (an attachment or agent mention, whose text companions are synthetic). Compaction and its replay are marked.
 */
export function turnMessages(messages: readonly { info: MessageLike; parts: readonly TurnPart[] }[]): TurnMessage[] {
  return messages.map(({ info, parts }) => {
    const text = parts.filter((part) => part.type === "text")
    return {
      ...info,
      synthetic: text.length > 0 && text.every((part) => part.synthetic) && !parts.some((part) => part.type === "file" || part.type === "agent"),
      compaction: parts.some((part) => part.type === "compaction"),
      replay: text.some((part) => typeof part.metadata?.learnOriginalMessage === "string"),
    }
  })
}

/**
 * Start of the agent's response to the request the correction answers. Synthetic continuations are not
 * requests. A request right after a compaction may be its replay, so its turn start is unknown.
 */
export function correctedTurnStart(messages: readonly TurnMessage[], messageID: string): number | undefined {
  const end = messages.findIndex((message) => message.id === messageID && message.role === "user")
  if (end < 0) return
  const previous = messages.slice(0, end).findLastIndex((message) => message.role === "user" && !message.synthetic && !message.compaction)
  if (previous < 0 || messages[previous].replay) return
  if (messages.slice(0, previous).findLast((message) => message.role === "user")?.compaction) return
  return messages.slice(previous + 1, end).find((message) => message.role === "assistant")?.time?.created
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
  turnStart?: (sessionID: string, messageID: string) => Promise<number | undefined>
  record: (signal: NewSignal) => Promise<Signal | undefined>
}

export class Capture {
  private messages = new Map<string, MessageLike>()
  private pendingParts = new Map<string, PartLike>()
  private sessionsWithAssistant = new Map<string, number>()
  private corrected = new Set<string>()
  private trackers = new Map<string, ToolRetryTracker>()
  private pending = new Set<Promise<unknown>>()

  constructor(private deps: CaptureDeps) {}

  onMessage(info: MessageLike) {
    this.messages.delete(info.id)
    this.messages.set(info.id, info)
    if (this.messages.size > RECENT_ID_CAP) this.messages.delete(this.messages.keys().next().value!)
    if (info.role === "assistant" && info.time?.completed && info.time.created !== undefined)
      this.rememberAssistant(info.sessionID, info.time.created)
    // Message and part subscriptions run independently; replay text only after its role is known.
    for (const [id, part] of this.pendingParts) {
      if (part.messageID !== info.id) continue
      this.pendingParts.delete(id)
      this.track(this.userText(part))
    }
  }

  private rememberAssistant(sessionID: string, created: number) {
    const earliest = this.sessionsWithAssistant.get(sessionID)
    this.sessionsWithAssistant.delete(sessionID)
    this.sessionsWithAssistant.set(sessionID, Math.min(earliest ?? Infinity, created))
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
    if (part.synthetic || part.ignored || !part.text) return
    const message = this.messages.get(part.messageID)
    if (!message) {
      this.pendingParts.delete(part.id)
      this.pendingParts.set(part.id, part)
      if (this.pendingParts.size > RECENT_ID_CAP) this.pendingParts.delete(this.pendingParts.keys().next().value!)
      return
    }
    if (message.role !== "user") return
    const reason = correctionReason(part.text)
    if (!reason) return
    // Later updates of a recorded correction deduplicate to its first signal; skip their history reads.
    if (this.corrected.has(part.messageID)) return
    const prior = this.sessionsWithAssistant.get(part.sessionID)
    const known = prior !== undefined && message.time?.created !== undefined && prior < message.time.created
    if (!known && !(await this.deps.hasPriorAssistant(part.sessionID, part.messageID))) return
    const start = await this.deps.turnStart?.(part.sessionID, part.messageID).catch((error) => {
      log.warn("learn turn start unavailable", { error })
      return undefined
    })
    await this.deps.record({
      kind: "user_correction",
      ...(start !== undefined && Number.isFinite(start) ? { turnStartedAt: new Date(start).toISOString() } : {}),
      ...(message.time?.created !== undefined && Number.isFinite(message.time.created) ? { correctedAt: new Date(message.time.created).toISOString() } : {}),
      sessionID: part.sessionID,
      messageID: part.messageID,
      text: part.text,
      reason,
    })
    remember(this.corrected, part.messageID, RECENT_ID_CAP)
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

// altimate_change start — workspace rules: a per-project gate the rules service sets from the full learning decision
// (the person's /rules choice can turn learning off while config still has learn.capture on). No gate: record.
const gates = new Map<string, () => Promise<boolean>>()

/** Set (or clear, with undefined) whether corrections are recorded for the project at `directory`. */
export function setCaptureGate(directory: string, gate: (() => Promise<boolean>) | undefined) {
  if (gate) gates.set(directory, gate)
  else gates.delete(directory)
}
// altimate_change end

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
// altimate_change start — returns a stop function once capture runs (workspace rules stop it when learning turns off)
export async function startCapture(
  ctx: { directory: string; worktree: string },
  options: { force?: boolean } = {},
): Promise<(() => Promise<void>) | undefined> {
  // altimate_change end
  try {
    const root = ctx.worktree !== "/" ? ctx.worktree : ctx.directory
    const { Config } = await import("@/config/config")
    // altimate_change start — `force`: workspace rules turned learning on for this project (the person set nothing)
    if (!options.force && !captureEnabled((await Config.get()).learn)) return
    // altimate_change end
    const { Bus } = await import("@/bus")
    const { MessageV2 } = await import("../../session/message-v2")
    const { Session } = await import("../../session")
    const { SessionID } = await import("../../session/schema")
    const capture = new Capture({
      record: async (signal) => {
        // Fails closed: a gate that cannot decide (unreadable rules state) must not record a correction the person
        // may have turned off.
        const gate = gates.get(ctx.directory)
        if (gate && !(await gate().catch(() => false))) return
        return appendSignal(root, signal)
      },
      turnStart: async (sessionID, messageID) => {
        const messages = await Session.messages({ sessionID: SessionID.make(sessionID) })
        return correctedTurnStart(turnMessages(messages), messageID)
      },
      hasPriorAssistant: async (sessionID, beforeMessageID) => {
        const messages = await Session.messages({ sessionID: SessionID.make(sessionID) })
        const before = messages.findIndex((message) => message.info.id === beforeMessageID)
        return before >= 0 && messages.slice(0, before).some((m) => m.info.role === "assistant" && !!m.info.time.completed)
      },
    })
    active.add(capture)
    const subscriptions: Array<() => void> = []
    // altimate_change start — one stop path for disposal and for workspace rules
    // One stop, shared: a second caller (the instance disposer overlapping a settings change) waits for the
    // same flush instead of returning before the pending signal writes land.
    let stopping: Promise<void> | undefined
    const stopCapture = () =>
      (stopping ??= (async () => {
        for (const stop of subscriptions) stop()
        await capture.flush()
        await flushWrites()
        active.delete(capture)
        unregister()
      })())
    const unregister = registerDisposer(async (directory) => {
      if (directory === ctx.directory) await stopCapture()
    })
    // altimate_change end
    subscriptions.push(
      await subscribeWhenReady(() => Bus.subscribe(MessageV2.Event.Updated, (evt) => capture.onMessage(evt.properties.info))),
    )
    subscriptions.push(
      await subscribeWhenReady(() =>
        Bus.subscribe(MessageV2.Event.PartUpdated, (evt) => void capture.onPart(evt.properties.part as PartLike)),
      ),
    )
    log.info("learn capture started", { root })
    return stopCapture
  } catch (e) {
    log.warn("learn capture not started", { error: e instanceof Error ? e.message : String(e) })
    return undefined
  }
}
