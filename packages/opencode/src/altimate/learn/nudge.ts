// altimate_change - new file
// TUI-only, in-memory correction counting. Never import capture, signals or reflection here.
import { claimNudge } from "./nudge-state"

export const NUDGE_MESSAGE =
  "You corrected the agent 2 times this session. Run `altimate-code learn enable` so it remembers these next time."
export const NUDGE_TOAST = NUDGE_MESSAGE + "\nDon't show again: `altimate-code learn nudge off`."

interface Message {
  id: string
  sessionID: string
  role: string
  time?: { created?: number; completed?: number }
}

interface Part {
  messageID: string
  sessionID: string
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
}

interface Session {
  project: string
  assistant: boolean
  users: Map<string, boolean>
  corrections: Set<string>
  attempted: boolean
}

interface Dependencies {
  enabled: () => boolean
  eligible: (sessionID: string) => boolean
  project: () => string
  hasPriorAssistant?: (sessionID: string, messageID: string) => boolean
  show: (message: string) => void
  claim?: (project: string) => Promise<boolean>
}

/** Lives only as long as the interactive TUI. Neither text nor classifier results are persisted. */
export class LearnNudge {
  private sessions = new Map<string, Session>()
  private pending = Promise.resolve()
  private stopped = false

  constructor(private deps: Dependencies) {}

  private allowed(sessionID: string) {
    if (this.stopped) return false
    if (this.deps.enabled()) {
      this.dispose()
      return false
    }
    return this.deps.eligible(sessionID)
  }

  private session(sessionID: string) {
    const project = this.deps.project()
    let session = this.sessions.get(sessionID)
    if (!session || session.project !== project) {
      session = { project, assistant: false, users: new Map(), corrections: new Set(), attempted: false }
      this.sessions.set(sessionID, session)
    }
    return session
  }

  onMessage(info: Message) {
    if (!this.allowed(info.sessionID)) return
    const session = this.session(info.sessionID)
    if (session.attempted) return
    if (info.role === "assistant" && info.time?.completed) session.assistant = true
    if (info.role === "user" && !session.users.has(info.id)) {
      session.users.set(info.id, session.assistant || (this.deps.hasPriorAssistant?.(info.sessionID, info.id) ?? false))
    }
  }

  onPart(part: Part): Promise<void> {
    if (!this.allowed(part.sessionID) || part.type !== "text" || part.synthetic || part.ignored || !part.text)
      return this.pending
    const session = this.sessions.get(part.sessionID)
    if (!session?.users.get(part.messageID) || session.attempted) return this.pending
    // Serialize classification with idle. A fast response must not beat the lazy import.
    return this.enqueue(async () => {
      if (!this.allowed(part.sessionID) || session.corrections.has(part.messageID) || session.attempted) return
      const { correctionReason } = await import("./correction")
      if (!this.allowed(part.sessionID)) return
      if (correctionReason(part.text!)) session.corrections.add(part.messageID)
    })
  }

  onIdle(sessionID: string): Promise<void> {
    if (!this.allowed(sessionID)) return this.pending
    const session = this.sessions.get(sessionID)
    if (!session) return this.pending
    return this.enqueue(async () => {
      if (!this.allowed(sessionID) || session.project !== this.deps.project()) return
      if (session.attempted || session.corrections.size < 2) return
      // Consume the first qualifying idle even if persistence fails: a quiet tip must never retry spam.
      session.attempted = true
      const claimed = await (this.deps.claim ?? claimNudge)(session.project)
      if (claimed && this.allowed(sessionID) && session.project === this.deps.project()) this.deps.show(NUDGE_TOAST)
    })
  }

  private enqueue(task: () => Promise<void>) {
    // A failed read/write/classifier must not affect the interactive session or leak message text to logs.
    this.pending = this.pending.then(task).catch(() => {})
    return this.pending
  }

  dispose() {
    this.stopped = true
    this.sessions.clear()
  }
}
