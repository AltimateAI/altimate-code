// altimate_change - new file
//
// Local-only store of learning signals captured from normal use (user corrections, repeated tool
// failures) or recorded by integrations (review comments, CI logs). Lives next to the lesson state:
//   <projectRoot>/.altimate-code/learn/<name>/signals.jsonl
// Nothing here is ever uploaded. `learn reflect` consumes open signals as feedback.
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { redactSecrets } from "./digest"
import { quarantineNotice, writeAtomic } from "./store"
import { assertLearnLock, withLearnLock } from "./lock"
import { DEFAULT_NAME, validateName } from "./playbook"
import { Log } from "@/util/log"

const log = Log.create({ service: "learn.signals" })

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
  partID?: string
  source?: "bootstrap" | "import-reviews"
  provenance?: string
  resolved?: boolean
  text: string
  reason: string
  at: string
  status: "open" | "consumed"
  consumedBy?: string
}

export type NewSignal = Pick<Signal, "kind" | "sessionID" | "text" | "reason" | "messageID" | "partID" | "source" | "provenance" | "resolved">

export function signalsFile(root: string, name = DEFAULT_NAME): string {
  validateName(name)
  return path.join(root, ".altimate-code", "learn", name, "signals.jsonl")
}

/** Redacted, then clipped. */
export function clipSignalText(text: string): string {
  return redactSecrets(text).slice(0, SIGNAL_TEXT_CAP)
}

/** Redact URL components separately so a normal host/path is not mistaken for one high-entropy secret. */
export function redactProvenance(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" && url.protocol !== "http:") return clipSignalText(value)
    url.username = ""
    url.password = ""
    url.search = ""
    url.pathname = url.pathname.split("/").map((part) => redactSecrets(decodeURIComponent(part))).join("/")
    url.hash = redactSecrets(decodeURIComponent(url.hash))
    return url.href.slice(0, SIGNAL_TEXT_CAP)
  } catch { return clipSignalText(value) }
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

function parse(raw: string): { signals: Signal[]; malformed: boolean } {
  const out: Signal[] = []
  let malformed = false
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const s = JSON.parse(line) as Signal
      if (s && typeof s.id === "string" && typeof s.sessionID === "string" && typeof s.text === "string" &&
        SIGNAL_KINDS.includes(s.kind) && typeof s.reason === "string" && typeof s.at === "string" &&
        (s.status === "open" || s.status === "consumed") &&
        (s.messageID === undefined || typeof s.messageID === "string") &&
        (s.partID === undefined || typeof s.partID === "string") &&
        (s.source === undefined || s.source === "bootstrap" || s.source === "import-reviews") &&
        (s.provenance === undefined || typeof s.provenance === "string") &&
        (s.resolved === undefined || typeof s.resolved === "boolean") &&
        (s.consumedBy === undefined || typeof s.consumedBy === "string")) out.push(s)
      else malformed = true
    } catch { malformed = true }
  }
  return { signals: out, malformed }
}

async function read(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw e
  }
}

const serialize = (signals: Signal[]) => signals.map((signal) => JSON.stringify(signal) + "\n").join("")

async function readCurrent(root: string, file: string): Promise<Signal[]> {
  const parsed = parse((await read(file)) ?? "")
  if (!parsed.malformed) return parsed.signals
  return withLearnLock(root, async () => {
    const raw = (await read(file)) ?? ""
    const current = parse(raw)
    if (!current.malformed) return current.signals
    // Preserve the original before replacing it. A failed repair can reuse the same backup;
    // valid records remain available in the source until the atomic write succeeds.
    const directory = path.dirname(file)
    const prefix = `${path.basename(file)}.malformed-`
    const hash = createHash("sha256").update(raw).digest("hex")
    const existing = (await fs.readdir(directory)).find((name) => name.startsWith(prefix) && name.endsWith(`-${hash}`))
    if (!existing) {
      const backup = `${file}.malformed-${Date.now()}-${hash}`
      await writeAtomic(root, backup, raw, 0o600)
      quarantineNotice(file, backup)
    }
    await writeAtomic(root, file, serialize(current.signals))
    return current.signals
  })
}

/** Old capture had one project-wide queue. It belongs only to the default named store. */
export async function migrateSignals(root: string, name = DEFAULT_NAME): Promise<void> {
  if (name !== DEFAULT_NAME) return
  const legacy = path.join(root, ".altimate-code", "learn", "signals.jsonl")
  try {
    if ((await read(legacy)) === undefined) return
    await withLearnLock(root, async () => {
      const raw = await read(legacy)
      if (raw === undefined) return
      const imported = parse(raw)
      const file = signalsFile(root, name)
      const current = await readCurrent(root, file)
      // A crash after the atomic destination write leaves the source to be replayed. Prefer the
      // destination's state, including consumption that happened after the interrupted import.
      const ids = new Set(current.map((signal) => signal.id))
      const keys = new Set(current.map(dedupeKey))
      for (const signal of imported.signals) {
        const key = dedupeKey(signal)
        if (ids.has(signal.id) || keys.has(key)) continue
        current.push(signal)
        ids.add(signal.id)
        keys.add(key)
      }
      await assertLearnLock(root)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await writeAtomic(root, file, serialize(current))
      await assertLearnLock(root)
      if (imported.malformed) {
        const backup = `${legacy}.malformed-${Date.now()}-${randomUUID()}`
        await fs.rename(legacy, backup)
        quarantineNotice(legacy, backup)
      } else await fs.rm(legacy)
    })
  } catch (error) {
    log.warn("learning signal migration deferred; it will retry on next use", { error: error instanceof Error ? error.message : String(error) })
  }
}

export async function readSignals(root: string, name = DEFAULT_NAME): Promise<Signal[]> {
  const file = signalsFile(root, name)
  await migrateSignals(root, name)
  return readCurrent(root, file)
}

/** Read-only scope previews never migrate or repair signal storage. */
export async function readSignalsSnapshot(root: string, name = DEFAULT_NAME): Promise<Signal[]> {
  const file = signalsFile(root, name)
  return parse((await read(file)) ?? "").signals
}

/** Tool parts distinguish retry signals within an assistant turn; older capture used messages. */
function dedupeKey(s: Pick<Signal, "sessionID" | "messageID" | "partID" | "kind" | "text">): string {
  const where = s.kind === "tool_retry" && s.partID ? `part:${s.partID}` :
    s.messageID ?? `text:${createHash("sha256").update(s.text).digest("hex").slice(0, 16)}`
  return `${s.sessionID}\0${where}\0${s.kind}`
}

/** Records a signal. Returns undefined when it duplicates an existing one or has no text. */
export async function appendSignal(root: string, input: NewSignal, name = DEFAULT_NAME): Promise<Signal | undefined> {
  return (await appendSignals(root, [input], name))[0]
}

/** Redacts and deduplicates a batch using one locked read/rewrite, including within the batch. */
export function appendSignals(root: string, inputs: readonly NewSignal[], name = DEFAULT_NAME): Promise<Signal[]> {
  const file = signalsFile(root, name)
  if (!inputs.length) return Promise.resolve([])
  return track(() => withLearnLock(root, async () => {
    const existing = await readSignals(root, name)
    const keys = new Set(existing.map(dedupeKey))
    const retryMessages = new Set<string>()
    const legacyRetryMessages = new Set<string>()
    const messageKey = (s: NewSignal) => `${s.sessionID}\0${s.messageID}`
    const remember = (s: Signal) => {
      keys.add(dedupeKey(s))
      if (s.kind !== "tool_retry" || !s.messageID) return
      retryMessages.add(messageKey(s))
      if (!s.partID) legacyRetryMessages.add(messageKey(s))
    }
    existing.forEach(remember)
    const added: Signal[] = []
    for (const input of inputs) {
      const text = clipSignalText(input.text).trim()
      if (!text) continue
      const signal: Signal = {
        id: `sig_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        kind: input.kind,
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
        source: input.source,
        provenance: input.provenance === undefined ? undefined : redactProvenance(input.provenance),
        resolved: input.resolved,
        text,
        reason: clipSignalText(input.reason),
        at: new Date().toISOString(),
        status: "open",
      }
      if (keys.has(dedupeKey(signal))) continue
      // A live signal without a part id still covers its whole message, in either append order.
      if (signal.kind === "tool_retry" && signal.messageID &&
        (legacyRetryMessages.has(messageKey(signal)) || (!signal.partID && retryMessages.has(messageKey(signal))))) continue
      added.push(signal)
      remember(signal)
    }
    if (!added.length) return []
    await assertLearnLock(root)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await assertLearnLock(root)
    await writeAtomic(root, file, serialize([...existing, ...added]))
    return added
  }))
}

/** Marks signals consumed. Rewrites the file atomically; returns how many changed. */
export function consumeSignals(root: string, ids: readonly string[], consumedBy: string, name = DEFAULT_NAME): Promise<number> {
  const file = signalsFile(root, name)
  return track(() => withLearnLock(root, async () => {
    const wanted = new Set(ids)
    const all = await readSignals(root, name)
    let changed = 0
    for (const s of all) {
      if (wanted.has(s.id) && s.status === "open") {
        s.status = "consumed"
        s.consumedBy = consumedBy
        changed++
      }
    }
    if (changed > 0) await writeAtomic(root, file, serialize(all))
    return changed
  }))
}

export interface SignalFilter {
  session?: string
  all?: boolean
}

export async function listSignals(root: string, filter: SignalFilter = {}, name = DEFAULT_NAME): Promise<Signal[]> {
  return (await readSignals(root, name)).filter(
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
    : signals.some((s) => s.kind === "tool_retry" || s.kind === "ci")
      ? "ci"
      : signals[0]?.kind === "review"
        ? "review"
        : "ci"
  const text = signals.map((s) => `[${s.kind}] ${s.text}`).join("\n\n")
  return { kind, text }
}
