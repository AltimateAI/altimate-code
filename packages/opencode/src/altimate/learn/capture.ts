// altimate_change - new file
//
// Automatic learning-signal capture, opt-in (config `learn.capture: true` or ALTIMATE_LEARN_CAPTURE=1).
// A Bus subscription started once per instance records, to the local signal store only:
//   - user_correction: a user message that follows at least one completed assistant message and that
//     `correctionReason` classifies as a correction (the first prompt is a task, never a correction);
//   - tool_retry: the same tool failing 3+ consecutive times, measured from tool-part error states.
// Capture is fail-safe: it logs and swallows every error, and never touches the prompt loop.
import { Log } from "../../util/log"
import { correctionReason } from "./correction"
import { appendSignal, type NewSignal, type Signal } from "./signals"

const log = Log.create({ service: "learn.capture" })

export const RETRY_THRESHOLD = 3
const RETRY_ERROR_CAP = 500

const truthy = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true"
const falsy = (v: string | undefined) => v === "0" || v?.toLowerCase() === "false"

interface LearnConfig {
  capture?: boolean
  auto_reflect?: boolean
  model?: string
}

/** Env wins over config in both directions, so a run can opt out as well as in. */
export function captureEnabled(cfg?: LearnConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env["ALTIMATE_LEARN_CAPTURE"]
  if (truthy(v)) return true
  if (falsy(v)) return false
  return cfg?.capture === true
}

/** Auto-reflect needs capture: without signals there is nothing to reflect on. */
export function autoReflectEnabled(cfg?: LearnConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!captureEnabled(cfg, env)) return false
  const v = env["ALTIMATE_LEARN_AUTO"]
  if (truthy(v)) return true
  if (falsy(v)) return false
  return cfg?.auto_reflect === true
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
    this.seen.add(part.id)
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
      return { tool: part.tool, count: this.count, error: this.lastError.slice(0, RETRY_ERROR_CAP), messageID: part.messageID }
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
  /** True when the session has a completed assistant message other than the one being classified. */
  hasPriorAssistant: (sessionID: string, exceptMessageID: string) => Promise<boolean>
  record: (signal: NewSignal) => Promise<Signal | undefined>
}

export class Capture {
  private userMessages = new Set<string>()
  private sessionsWithAssistant = new Set<string>()
  private trackers = new Map<string, ToolRetryTracker>()
  private pending = new Set<Promise<unknown>>()

  constructor(private deps: CaptureDeps) {}

  onMessage(info: MessageLike) {
    if (info.role === "user") this.userMessages.add(info.id)
    else if (info.role === "assistant" && info.time?.completed) this.sessionsWithAssistant.add(info.sessionID)
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
    const known = this.sessionsWithAssistant.has(part.sessionID)
    if (!known && !(await this.deps.hasPriorAssistant(part.sessionID, part.messageID))) return
    this.sessionsWithAssistant.add(part.sessionID)
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
    let tracker = this.trackers.get(part.sessionID)
    if (!tracker) this.trackers.set(part.sessionID, (tracker = new ToolRetryTracker()))
    const episode = tracker.observe({ id: part.id, messageID: part.messageID, tool: part.tool, state: part.state })
    if (!episode) return
    await this.deps.record({
      kind: "tool_retry",
      sessionID: part.sessionID,
      messageID: episode.messageID,
      text: `Tool \`${episode.tool}\` failed ${episode.count} consecutive times. Last error: ${episode.error}`,
      reason: `tool ${episode.tool} failed ${episode.count} consecutive times`,
    })
  }
}

// The instance's active capture, so `run` can flush it before reflecting.
let active: Capture | undefined

export async function flushCapture() {
  await active?.flush()
}

/**
 * `Bus.subscribe` is synchronous and throws while the bus runtime is still building (only possible when
 * capture starts before anything else used the bus). It is ready within a few ticks, so retry briefly.
 */
async function subscribeWhenReady(subscribe: () => unknown) {
  for (let attempt = 0; ; attempt++) {
    try {
      subscribe()
      return
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
    let enabled = truthy(process.env["ALTIMATE_LEARN_CAPTURE"])
    if (!enabled && !falsy(process.env["ALTIMATE_LEARN_CAPTURE"])) {
      const { Config } = await import("@/config/config")
      enabled = captureEnabled((await Config.get()).learn)
    }
    if (!enabled) return
    const { Bus } = await import("@/bus")
    const { MessageV2 } = await import("../../session/message-v2")
    const { Session } = await import("../../session")
    const { SessionID } = await import("../../session/schema")
    const capture = new Capture({
      record: (signal) => appendSignal(root, signal),
      hasPriorAssistant: async (sessionID, exceptMessageID) => {
        const messages = await Session.messages({ sessionID: SessionID.make(sessionID) })
        return messages.some((m) => m.info.role === "assistant" && m.info.id !== exceptMessageID && !!m.info.time.completed)
      },
    })
    active = capture
    await subscribeWhenReady(() => Bus.subscribe(MessageV2.Event.Updated, (evt) => capture.onMessage(evt.properties.info)))
    await subscribeWhenReady(() =>
      Bus.subscribe(MessageV2.Event.PartUpdated, (evt) => void capture.onPart(evt.properties.part as PartLike)),
    )
    log.info("learn capture started", { root })
  } catch (e) {
    log.warn("learn capture not started", { error: e instanceof Error ? e.message : String(e) })
  }
}
