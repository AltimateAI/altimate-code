// altimate_change - new file
//
// Local-only store of learning signals captured from normal use (user corrections, repeated tool
// failures) or recorded by integrations (review comments, CI logs). Lives next to the playbook state:
//   <projectRoot>/.altimate-code/learn/signals.jsonl
// Nothing here is ever uploaded. `learn reflect` consumes open signals as feedback.
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { redactSecrets } from "./digest"
import { writeAtomic } from "./store"
import { assertLearnLock, withLearnLock } from "./lock"

export const SIGNAL_KINDS = ["user_correction", "tool_retry", "review", "ci"] as const
export type SignalKind = (typeof SIGNAL_KINDS)[number]

/** Session id for signals recorded by integrations that have no session. */
export const EXTERNAL_SESSION = "external"
export const SIGNAL_TEXT_CAP = 2000

export interface Signal {
  id: string
  kind: SignalKind
  sessionID: string
  messageID?: string
  text: string
  reason: string
  at: string
  status: "open" | "consumed"
  consumedBy?: string
}

export type NewSignal = Pick<Signal, "kind" | "sessionID" | "text" | "reason"> & { messageID?: string }

export const signalsFile = (root: string) => path.join(root, ".altimate-code", "learn", "signals.jsonl")

/** Redacted, then clipped. */
export function clipSignalText(text: string): string {
  return redactSecrets(text).slice(0, SIGNAL_TEXT_CAP)
}

// The shared lock serializes mutations. Track in-flight writes for capture shutdown without a
// second queue: a queued append waiting for the lock must not block nested consumption by its owner.
const writes = new Set<Promise<unknown>>()
function track<T>(task: () => Promise<T>): Promise<T> {
  const next = task()
  writes.add(next)
  void next.finally(() => writes.delete(next)).catch(() => {})
  return next
}

/** Resolves once every write queued so far has finished. */
export async function flushWrites(): Promise<void> {
  await Promise.all([...writes].map((write) => write.catch(() => {})))
}

function parse(raw: string): Signal[] {
  const out: Signal[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const s = JSON.parse(line) as Signal
      if (s && typeof s.id === "string" && typeof s.sessionID === "string" && typeof s.text === "string") out.push(s)
    } catch {}
  }
  return out
}

export async function readSignals(root: string): Promise<Signal[]> {
  try {
    return parse(await fs.readFile(signalsFile(root), "utf8"))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []
    throw e
  }
}

/** Dedupe identity: (session, message, kind). Without a message id, the content stands in for it. */
function dedupeKey(s: Pick<Signal, "sessionID" | "messageID" | "kind" | "text">): string {
  const where = s.messageID ?? `text:${createHash("sha256").update(s.text).digest("hex").slice(0, 16)}`
  return `${s.sessionID}\0${where}\0${s.kind}`
}

/** Records a signal. Returns undefined when it duplicates an existing one or has no text. */
export function appendSignal(root: string, input: NewSignal): Promise<Signal | undefined> {
  const file = signalsFile(root)
  return track(() => withLearnLock(root, async () => {
    const text = clipSignalText(input.text).trim()
    if (!text) return undefined
    const signal: Signal = {
      id: `sig_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      kind: input.kind,
      sessionID: input.sessionID,
      messageID: input.messageID,
      text,
      reason: input.reason,
      at: new Date().toISOString(),
      status: "open",
    }
    const key = dedupeKey(signal)
    if ((await readSignals(root)).some((s) => dedupeKey(s) === key)) return undefined
    await assertLearnLock(root)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await assertLearnLock(root)
    await fs.appendFile(file, JSON.stringify(signal) + "\n")
    return signal
  }))
}

/** Marks signals consumed. Rewrites the file atomically; returns how many changed. */
export function consumeSignals(root: string, ids: readonly string[], consumedBy: string): Promise<number> {
  const file = signalsFile(root)
  return track(() => withLearnLock(root, async () => {
    const wanted = new Set(ids)
    const all = await readSignals(root)
    let changed = 0
    for (const s of all) {
      if (wanted.has(s.id) && s.status === "open") {
        s.status = "consumed"
        s.consumedBy = consumedBy
        changed++
      }
    }
    if (changed > 0) await writeAtomic(root, file, all.map((s) => JSON.stringify(s)).join("\n") + "\n")
    return changed
  }))
}

export interface SignalFilter {
  session?: string
  all?: boolean
}

export async function listSignals(root: string, filter: SignalFilter = {}): Promise<Signal[]> {
  return (await readSignals(root)).filter(
    (s) => (filter.all || s.status === "open") && (!filter.session || s.sessionID === filter.session),
  )
}

/** Session ids that have open signals, in order of their first open signal. */
export function pendingSessions(signals: readonly Signal[]): string[] {
  return [...new Set(signals.filter((s) => s.status === "open").map((s) => s.sessionID))]
}

/** The feedback `learn reflect` learns from: kind picked by the strongest signal, text prefixed per signal. */
export function feedbackFromSignals(signals: readonly Signal[]): { kind: "user" | "ci" | "review"; text: string } {
  const kind = signals.some((s) => s.kind === "user_correction")
    ? "user"
    : signals.some((s) => s.kind === "tool_retry")
      ? "ci"
      : signals[0]?.kind === "review"
        ? "review"
        : "ci"
  const text = signals.map((s) => `[${s.kind}] ${s.text}`).join("\n\n")
  return { kind, text }
}
