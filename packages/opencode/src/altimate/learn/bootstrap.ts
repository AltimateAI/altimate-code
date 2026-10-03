// altimate_change - new file
// Explicit, consented history import. Preview is read-only; extraction is checkpointed before
// reflection, so a failed/limited run can resume through the normal signal claim path.
import fs from "node:fs/promises"
import type { Provider } from "@/provider/provider"
import { correctionReason } from "./correction"
import { ToolRetryTracker } from "./capture"
import { buildDigest, createDigestAccumulator, redactSecrets, type DigestSource } from "./digest"
import { buildPrompt, FEEDBACK_CAP, type Generate, type GenerateUsage } from "./reflect"
import { reflectSessionSignals, errText } from "./session-reflect"
import * as Signals from "./signals"
import * as Store from "./store"
import { DEFAULT_NAME, validateName } from "./playbook"
import { readBootstrapState, updateBootstrapState } from "./bootstrap-state"
import { historyMessages, historySession, historySessions, type HistorySession } from "./bootstrap-history"
import { accountUsage } from "./usage"

export const DEFAULT_BOOTSTRAP_LIMIT = 200
export const DEFAULT_MAX_REFLECTIONS = 20
export const DEFAULT_MAX_SECONDS = 300

export interface BootstrapOptions {
  root: string
  projectID: string
  directory: string
  name?: string
  since?: string
  limit?: number
  maxReflections?: number
  maxSeconds?: number
  maxStored?: number
  yes?: boolean
  dryRun?: boolean
}

export interface BootstrapModel {
  providerID: string
  modelID: string
  /** USD per million tokens, from the configured provider's model metadata. */
  cost?: Provider.Model["cost"]
  generate: (abortSignal: AbortSignal, onUsage: (usage: GenerateUsage) => void) => Promise<Generate>
}

export interface BootstrapDeps {
  resolveModel: () => Promise<BootstrapModel>
  out: (text: string) => void
  isTTY: boolean
  confirm: () => Promise<boolean>
  now?: () => number
  history?: {
    sessions: typeof historySessions
    session: typeof historySession
    messages: typeof historyMessages
  }
}

export interface BootstrapSummary {
  signalsFound: number
  signalsAdded: number
  reflectionsRun: number
  candidatesAdded: number
  candidatesEdited: number
  inputTokens: number
  outputTokens: number
  tokensEstimated: boolean
  estimatedCost: number
  failures: number
}

/** Durations are relative to the scope snapshot; an ISO date is an inclusive creation boundary. */
export function bootstrapSince(value: string, now: number): number {
  const duration = /^(\d+)([dhw])$/.exec(value)
  const result = duration
    ? now - Number(duration[1]) * ({ h: 3_600_000, d: 86_400_000, w: 604_800_000 }[duration[2]]!)
    : /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) ? Date.parse(value) : NaN
  if (!Number.isFinite(result) || result < 0 || result > now)
    throw new Error("--since must be a past ISO date or a duration such as 30d, 24h, or 4w.")
  return result
}

function integer(value: number, name: string, minimum: number) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}.`)
  return value
}

const tokenEstimate = (text: string) => Math.ceil(text.length / 4)
const identity = (signal: Signals.NewSignal) => JSON.stringify([
  signal.sessionID, signal.kind, signal.kind === "tool_retry" ? signal.partID ?? signal.messageID : signal.messageID,
])

/** Provider setup may not accept cancellation; abandoning it must never start a late request. */
async function withinDeadline<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  let abort: () => void = () => {}
  const expired = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("Bootstrap time budget exhausted; signals remain open."))
    signal.addEventListener("abort", abort, { once: true })
  })
  try { return await Promise.race([work(), expired]) }
  finally { signal.removeEventListener("abort", abort) }
}

interface SessionPlan {
  session: HistorySession
  source: DigestSource
  signals: Signals.NewSignal[]
  pending: Signals.Signal[]
}

function feedbackBatches(signals: Signals.NewSignal[]) {
  const batches: Signals.NewSignal[][] = []
  for (const signal of signals) {
    const current = batches.at(-1)
    const size = (items: Signals.NewSignal[]) => items.map((s) => `[${s.kind}] ${s.text}`).join("\n\n").length
    if (!current || size([...current, signal]) > FEEDBACK_CAP) batches.push([signal])
    else current.push(signal)
  }
  return batches
}

export async function bootstrap(options: BootstrapOptions, deps: BootstrapDeps): Promise<BootstrapSummary | undefined> {
  const now = deps.now ?? Date.now
  const name = options.name ?? DEFAULT_NAME
  validateName(name)
  const limit = integer(options.limit ?? DEFAULT_BOOTSTRAP_LIMIT, "--limit", 1)
  const maxReflections = integer(options.maxReflections ?? DEFAULT_MAX_REFLECTIONS, "--max-reflections", 0)
  const maxSeconds = integer(options.maxSeconds ?? DEFAULT_MAX_SECONDS, "--max-seconds", 1)
  const since = bootstrapSince(options.since ?? "30d", now())
  const history = deps.history ?? { sessions: historySessions, session: historySession, messages: historyMessages }
  const state = await readBootstrapState(options.root, name)
  const stored = await Signals.readSignalsSnapshot(options.root, name)
  const known = new Set(stored.map(identity))
  const boundary = { projectID: options.projectID, directory: options.directory }
  const cursorMatches = !state.scope || (state.scope.projectID === options.projectID && state.scope.directory === options.directory)
  const before = cursorMatches && state.cursor && state.cursor.created >= since ? state.cursor : undefined
  const selected: HistorySession[] = []
  // Finish an interrupted window before traversing older history. Pending IDs never bypass
  // today's project, privacy, date or session-count bounds.
  const pendingIDs = new Set([...state.pendingSessions, ...stored.filter((s) => s.source === "bootstrap" && s.status === "open").map((s) => s.sessionID)])
  for (const sessionID of pendingIDs) {
    if (!stored.some((s) => s.sessionID === sessionID && s.source === "bootstrap" && s.status === "open")) continue
    const session = history.session({ ...boundary, sessionID })
    if (session && session.time.created >= since) selected.push(session)
  }
  selected.sort((a, b) => b.time.created - a.time.created || b.id.localeCompare(a.id))
  // A smaller limit on resume must still finish the oldest outstanding corrections first.
  selected.splice(0, Math.max(0, selected.length - limit))
  const resuming = selected.length > 0
  if (!resuming) {
    for (const session of history.sessions({ ...boundary, since, limit, before })) selected.push(session)
  }
  const oldest = selected.at(-1)
  selected.reverse()
  const plans: SessionPlan[] = []
  for (const session of selected) {
    const digest = createDigestAccumulator()
    const tracker = new ToolRetryTracker()
    const seen = state.sessions[session.id]
    const messages = new Set(seen?.messageIDs ?? [])
    const parts = new Set(seen?.partIDs ?? [])
    const signals: Signals.NewSignal[] = []
    let assistant = false
    let hasUser = false
    for await (const message of history.messages(session.id)) {
      digest.add(message)
      if (message.info.role === "user") {
        const text = message.parts.flatMap((part) => part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []).join("\n")
        const reason = hasUser && assistant && !messages.has(message.info.id) ? correctionReason(text) : undefined
        hasUser = true
        if (reason) {
          const signal: Signals.NewSignal = {
            kind: "user_correction", sessionID: session.id, messageID: message.info.id,
            text: Signals.clipSignalText(text), reason, source: "bootstrap",
          }
          if (!known.has(identity(signal))) signals.push(signal)
          known.add(identity(signal))
          messages.add(message.info.id)
        }
      } else if (message.info.role === "assistant") {
        if (message.info.time.completed) assistant = true
        for (const part of message.parts) {
          if (part.type !== "tool") continue
          // Replay even seen parts so the retry episode's context is reconstructed on resume.
          const episode = tracker.observe(part)
          if (!episode || parts.has(part.id)) continue
          const signal: Signals.NewSignal = {
            kind: "tool_retry", sessionID: session.id, messageID: episode.messageID, partID: part.id,
            text: Signals.clipSignalText(`Tool \`${episode.tool}\` failed ${episode.count} consecutive times. Last error: ${episode.error}`),
            reason: redactSecrets(`tool ${episode.tool} failed ${episode.count} consecutive times`), source: "bootstrap",
          }
          // Old live captures had only message identity. Do not import that same episode again.
          const legacy = stored.some((s) => s.sessionID === session.id && s.kind === "tool_retry" && !s.partID && s.messageID === episode.messageID)
          if (!legacy && !known.has(identity(signal))) signals.push(signal)
          known.add(identity(signal))
          parts.add(part.id)
        }
      }
    }
    plans.push({ session, source: digest.source(), signals,
      pending: stored.filter((s) => s.sessionID === session.id && s.source === "bootstrap" && s.status === "open") })
  }
  const model = await deps.resolveModel()
  const label = `${model.providerID}/${model.modelID}`
  const all = plans.flatMap((plan) => [...plan.pending, ...plan.signals])
  let estimatedInput = 0
  let estimatedReflections = 0
  // Read raw snapshots without migration/repair: preview and cancellation never write learn state.
  const files = Store.paths(options.root, name)
  const read = (file: string) => fs.readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return undefined
    throw e
  })
  const lessonChars = ((await read(files.candidate)) ?? (await read(files.approved)) ?? "").length
  for (const plan of plans) {
    for (const batch of feedbackBatches([...plan.pending, ...plan.signals])) {
      if (estimatedReflections >= maxReflections) break
      const request = buildPrompt({ digest: buildDigest(plan.source), bullets: [], kind: "user",
        feedback: batch.map((s) => `[${s.kind}] ${s.text}`).join("\n\n") })
      estimatedInput += tokenEstimate(request.system + request.prompt) + Math.ceil(lessonChars / 4)
      estimatedReflections++
    }
  }
  deps.out(`Bootstrap scope: ${plans.length} root session(s) in ${options.directory} (project ${options.projectID}).`)
  deps.out(`Date range: ${plans.length ? `${new Date(plans[0].session.time.created).toISOString()} to ${new Date(plans.at(-1)!.session.time.created).toISOString()}` : "no matching sessions"}; since ${new Date(since).toISOString()}.`)
  deps.out(`Signals found: ${all.length} (${all.filter((s) => s.kind === "user_correction").length} corrections, ${all.filter((s) => s.kind === "tool_retry").length} tool failures; ${all.length - plans.reduce((n, p) => n + p.signals.length, 0)} pending).`)
  deps.out(`Model/provider: ${label}. Estimated input tokens: ${estimatedInput} for up to ${estimatedReflections} reflection(s), excluding candidate growth.`)
  deps.out(`Limits: ${limit} sessions, ${maxReflections} reflections, ${maxSeconds}s total after confirmation.`)
  deps.out("Bootstrap sends redacted excerpts of past sessions to this model and stages candidate lessons only.")
  if (options.dryRun) {
    for (const signal of all) deps.out(`[${signal.sessionID}] [${signal.kind}] ${Signals.clipSignalText(signal.text)}`)
    deps.out("Dry run: nothing sent and no bootstrap state changed.")
    return
  }
  if (!options.yes) {
    if (!deps.isTTY) throw new Error("Refusing to bootstrap without confirmation in a non-interactive session; pass --yes or --dry-run.")
    if (!(await deps.confirm())) { deps.out("Cancelled. Nothing sent."); return }
  }
  const deadline = now() + maxSeconds * 1000
  const abortSignal = AbortSignal.timeout(maxSeconds * 1000)
  const ready = () => now() < deadline && !abortSignal.aborted
  const summary: BootstrapSummary = { signalsFound: all.length, signalsAdded: 0, reflectionsRun: 0,
    candidatesAdded: 0, candidatesEdited: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, tokensEstimated: false, failures: 0 }
  // Persist each session as one signal batch. The signal file goes first; if checkpointing fails,
  // re-extraction is harmless because appendSignals also checks durable message/part identities.
  let extracted = 0
  for (const plan of plans) {
    if (!ready()) break
    summary.signalsAdded += (await Signals.appendSignals(options.root, plan.signals, name)).length
    await updateBootstrapState(options.root, (current) => {
      const previous = current.sessions[plan.session.id] ?? { messageIDs: [], partIDs: [] }
      const found = [...plan.pending, ...plan.signals]
      current.sessions[plan.session.id] = {
        messageIDs: [...new Set([...previous.messageIDs, ...found.flatMap((s) => s.kind === "user_correction" && s.messageID ? [s.messageID] : [])])],
        partIDs: [...new Set([...previous.partIDs, ...found.flatMap((s) => s.partID ? [s.partID] : [])])],
      }
      if (found.length && !current.pendingSessions.includes(plan.session.id)) current.pendingSessions.push(plan.session.id)
    }, name)
    extracted++
  }
  if (!resuming && extracted === plans.length) await updateBootstrapState(options.root, (current) => {
    // A short final page completes the sweep. Start from the newest session next time so newly
    // created sessions and new corrections in existing sessions are eventually discovered.
    if (JSON.stringify(current.cursor) === JSON.stringify(state.cursor) && JSON.stringify(current.scope) === JSON.stringify(state.scope)) {
      current.cursor = selected.length === limit && oldest ? { created: oldest.time.created, id: oldest.id } : undefined
      current.scope = boundary
    }
  }, name)

  let stop = false
  for (const plan of plans) {
    if (stop || !ready() || summary.reflectionsRun >= maxReflections) break
    const allowed = new Set([...plan.pending, ...plan.signals].map(identity))
    while (ready() && summary.reflectionsRun < maxReflections) {
      const pending = (await Signals.listSignals(options.root, { session: plan.session.id }, name)).filter((s) => s.source === "bootstrap")
      const open = pending.filter((s) => allowed.has(identity(s)))
      if (!open.length) {
        if (!pending.length) await updateBootstrapState(options.root, (current) => {
          current.pendingSessions = current.pendingSessions.filter((id) => id !== plan.session.id)
        }, name)
        break
      }
      deps.out(`Reflecting session ${plan.session.id}: ${open.length} open signal(s) (${summary.reflectionsRun + 1}/${maxReflections})...`)
      try {
        const result = await reflectSessionSignals({
          root: options.root, name, sessionID: plan.session.id, maxStored: options.maxStored,
          recoverPending: false,
          modelLabel: label, signalIDs: open.map((s) => s.id), shouldContinue: ready,
          loadSource: async () => plan.source,
          getGenerate: async () => {
            summary.reflectionsRun++
            let usage: GenerateUsage | undefined
            const generate = await withinDeadline(abortSignal, () => model.generate(abortSignal, (value) => { usage = value }))
            return async (request, onUsage) => {
              usage = undefined
              const estimated = tokenEstimate(request.system + request.prompt)
              // Failed requests can still be billed; retain the input estimate if no usage arrives.
              let output: unknown
              let completed = false
              try {
                output = await withinDeadline(abortSignal, () => generate(request))
                completed = true
                return output
              } finally {
                const measured = usage as GenerateUsage | undefined
                const accounted = await accountUsage(model, {
                  ...measured,
                  estimatedCost: measured?.inputTokens !== undefined && measured?.outputTokens !== undefined ? measured.estimatedCost : undefined,
                  inputTokens: measured?.inputTokens ?? estimated,
                  outputTokens: measured?.outputTokens ?? (completed ? tokenEstimate(JSON.stringify(output) ?? "") : 0),
                })
                summary.inputTokens += accounted.inputTokens
                summary.outputTokens += accounted.outputTokens
                summary.estimatedCost += accounted.estimatedCost
                if (measured?.inputTokens === undefined || measured?.outputTokens === undefined) summary.tokensEstimated = true
                onUsage?.(accounted)
              }
            }
          },
        })
        if (result.status === "none") { stop = true; break }
        summary.candidatesAdded += result.result.curated.applied.filter((delta) => delta.op === "ADD").length
        summary.candidatesEdited += result.result.curated.applied.filter((delta) => delta.op === "EDIT").length
        const remaining = await Signals.listSignals(options.root, { session: plan.session.id }, name)
        if (!remaining.some((s) => s.source === "bootstrap")) await updateBootstrapState(options.root, (current) => {
          current.pendingSessions = current.pendingSessions.filter((id) => id !== plan.session.id)
        }, name)
        if (result.signals.some((signal) => remaining.some((s) => s.id === signal.id))) {
          deps.out("Feedback remains open after curation; stopping to preserve chronological order.")
          stop = true
          break
        }
      } catch (error) {
        summary.failures++
        deps.out(`Reflection failed for ${plan.session.id}: ${redactSecrets(errText(error))}. Signals remain open.`)
        stop = true
        break
      }
    }
  }
  deps.out(`Bootstrap summary: ${summary.signalsFound} signals found, ${summary.signalsAdded} added; ${summary.reflectionsRun} reflections run; candidate lessons: ${summary.candidatesAdded} added, ${summary.candidatesEdited} edited.`)
  deps.out(`Tokens${summary.tokensEstimated ? " (estimated)" : ""}: ${summary.inputTokens} input, ${summary.outputTokens} output. Estimated cost: $${summary.estimatedCost.toFixed(6)}.`)
  if (!ready() || stop || (await Signals.readSignalsSnapshot(options.root, name)).some((s) => s.source === "bootstrap" && s.status === "open"))
    deps.out("Unfinished signals remain queued; re-run `learn bootstrap` to continue.")
  deps.out("Next: `learn show`, then `learn promote` after review.")
  return summary
}
