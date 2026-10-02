// altimate_change - new file
//
// The reflect pipeline shared by `learn reflect`, `learn reflect --pending` and the auto-reflect hook at
// the end of `run`: digest -> reflector -> curator -> candidate + history. Kept free of CLI and Effect
// so it can run in-process with an injected `generate`.
import path from "node:path"
import { Log } from "@/util/log"
import * as Playbook from "./playbook"
import * as Store from "./store"
import * as Signals from "./signals"
import { curate, flagSuspiciousFeedback, type CurateResult } from "./curator"
import { buildDigest, redactSecrets, sourceFromMessages, type DigestSource } from "./digest"
import { FEEDBACK_CAP, feedbackText, reflect, replace, type FeedbackKind, type Generate } from "./reflect"
import { sharedAnchors } from "./anchors"

const log = Log.create({ service: "learn.reflect" })
const MAX_REPLACEMENTS = 3
const MAX_REPLACEMENT_ATTEMPTS = 5

/** Named errors (e.g. ModelNotFoundError) carry their detail in `data`, not `message`. */
export function errText(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const data = (e as { data?: unknown }).data
  if (e.message && e.message !== e.name) return e.message
  return data ? `${e.name}: ${JSON.stringify(data)}` : e.name
}

export interface ReflectCoreInput {
  root: string
  name: string
  source: DigestSource
  feedback: string
  kind: FeedbackKind
  /** Session id or trajectory path: scopes the distinct-feedback count. */
  origin: string
  session?: string
  generate: Generate
  applyPaths?: string[]
  /** Shown in the error when the model call fails, e.g. `--model x` or `the default model`. */
  modelLabel?: string
  /** Consumed in the same locked transition as the candidate and history. */
  signalIDs?: string[]
}

export interface ReflectCoreResult {
  curated: CurateResult
  proposed: number
  flagged: string | undefined
  history: Awaited<ReturnType<typeof Store.appendHistory>>
}

/** Decode and screen persisted state before resolving or calling a model. */
export async function prepareReflection(root: string, name: string, applyPaths?: string[]) {
  return Store.transaction(root, async () => {
    const raw = (await Store.readCandidate(root, name)) ?? (await Store.readPromoted(root, name))
    if (raw !== undefined) {
      const bad = Store.validateCandidate(name, raw, { allowOverlap: true })
      if (bad) throw new Error(`Unsafe playbook state: ${bad}. Repair it or run \`learn reject\` before reflecting.`)
    }
    const pb = await Store.loadCandidate(root, name, { applyPaths })
    await Store.readHarmfulFrom(root, name)
    await Store.readPendingReplacements(root, name)
    return pb
  })
}

export async function reflectCore(input: ReflectCoreInput): Promise<ReflectCoreResult> {
  const { root, name } = input
  const flagged = flagSuspiciousFeedback(input.feedback)
  const digest = buildDigest(input.source)
  const snapshot = await prepareReflection(root, name, input.applyPaths)
  const deltas = await reflect(
    { digest, feedback: input.feedback, kind: input.kind, bullets: Playbook.bullets(snapshot) },
    input.generate,
  ).catch((e) => {
    throw new Error(`Model call failed (${input.modelLabel ?? "the default model"}): ${errText(e)}`)
  })
  return Store.transaction(root, async () => {
    if (input.signalIDs) {
      const open = new Set((await Signals.listSignals(root)).map((s) => s.id))
      if (input.signalIDs.some((id) => !open.has(id)))
        throw new Error("Some feedback signals were already consumed by another reflection; re-run reflect for the remaining signals.")
    }
    // The model ran without the lock. Re-read and re-curate against the current candidate so
    // intervening reflections, promotions, and manual edits cannot be overwritten by this snapshot.
    const pb = await prepareReflection(root, name, input.applyPaths)
    const bullets = Playbook.bullets(pb)
    const curated = curate(bullets, deltas, {
      snapshot: Playbook.bullets(snapshot),
      feedbackId: Store.feedbackId(input.feedback, input.origin),
      harmfulFrom: await Store.readHarmfulFrom(root, name),
    })
    // Unrelated pending recoveries may apply changes below; they must not consume feedback whose
    // own proposals were all rejected. A later reflection needs to reconsider it with fresh text.
    const onlyRejected = deltas.length > 0 && curated.rejected.length === deltas.length
    const removed = bullets.filter((b) =>
      !curated.next.some((n) => n.id === b.id) &&
      curated.applied.some((a) => a.op === "REMOVE" && a.id === b.id && a.note !== "cap eviction") &&
      !curated.next.some((n) => {
        // Only the final text and its relationship declarations can replace a removed rule.
        const change = curated.applied.findLast((a) => (a.op === "ADD" || a.op === "EDIT") && a.id === n.id)
        return change && (change.supersedes === b.id ||
          (!change.coexists?.includes(b.id) && sharedAnchors(n.text, b.text).length > 0))
      }),
    )
    const pending = await Store.readPendingReplacements(root, name)
    for (const bullet of removed) {
      if (pending.some((p) => p.id === bullet.id && p.text === bullet.text)) continue
      pending.push({
        id: bullet.id,
        text: redactSecrets(bullet.text),
        reasons: [...new Set([...deltas, ...curated.applied]
          .filter((d) => d.id === bullet.id && (d.op === "HARMFUL" || d.op === "REMOVE"))
          .map((d) => feedbackText(d.reason)))],
        feedback: feedbackText(input.feedback),
        kind: input.kind,
        attempts: 0,
      })
    }
    const resolved = new Set<Store.PendingReplacement>()
    const replacements = new Map<Store.PendingReplacement, string>()
    // Older recoveries go first; removals beyond this reflection's cap remain queued, unattempted.
    for (const record of pending.slice(0, MAX_REPLACEMENTS)) {
      record.attempts++
      try {
        const replacement = await replace({
          ...record,
          feedbackExcerpt: record.feedback,
          bullets: curated.next.filter((b) => sharedAnchors(b.text, record.text).length > 0),
        }, input.generate)
        if (replacement === null) {
          resolved.add(record)
          continue
        }
        const result = curate(curated.next, [{ op: "ADD", ...replacement, reason: `replacement for ${record.id}` }], {
          harmfulFrom: curated.harmfulFrom,
          priorApplied: curated.applied,
        })
        curated.next = result.next
        curated.harmfulFrom = result.harmfulFrom
        curated.applied.push(...result.applied.map((a) => a.op === "ADD" ? { ...a, note: "replacement" } : a))
        curated.rejected.push(...result.rejected)
        const added = result.applied.find((a) => a.op === "ADD")
        if (added?.id) replacements.set(record, added.id)
      } catch (e) {
        log.warn("replacement failed; keeping removal", { id: record.id, error: redactSecrets(errText(e)) })
      }
    }
    const remaining = pending.filter((record) => {
      if (resolved.has(record) || curated.next.some((b) => b.id === replacements.get(record))) return false
      if (record.attempts < MAX_REPLACEMENT_ATTEMPTS) return true
      log.warn("pending replacement expired", { id: record.id, attempts: record.attempts })
      return false
    })
    if (curated.applied.length > 0) {
      const replacements = Object.fromEntries(
        curated.applied.flatMap((a) => (a.op === "ADD" && a.supersedes && a.id ? [[a.supersedes, a.id]] : [])),
      )
      await Store.saveCandidate(root, name, Playbook.withBullets(pb, curated.next, replacements))
    }
    await Store.writePendingReplacements(root, name, remaining)
    await Store.writeHarmfulFrom(root, name, curated.harmfulFrom)
    const history = await Store.appendHistory(root, name, {
      action: "reflect",
      session: input.session,
      feedbackKind: input.kind,
      feedbackHash: Store.sha256(input.feedback),
      feedbackFlagged: flagged ? true : undefined,
      applied: curated.applied,
      rejected: curated.rejected,
    })
    if (input.signalIDs && !onlyRejected) await Signals.consumeSignals(root, input.signalIDs, `reflect@${history.ts}`)
    return { curated, proposed: deltas.length, flagged, history }
  })
}

export async function sourceFromSession(sessionID: string): Promise<DigestSource> {
  const { Session } = await import("../../session")
  const { SessionID } = await import("../../session/schema")
  const sid = SessionID.make(sessionID)
  try {
    await Session.get(sid)
  } catch {
    throw new Error(`Session not found: ${sessionID}. For a session from another project, use --trajectory.`)
  }
  return sourceFromMessages(await Session.messages({ sessionID: sid }))
}

export interface ReflectSessionInput {
  root: string
  name: string
  sessionID: string
  /** Called only when the session has open signals, so a model is not resolved for nothing. */
  getGenerate: () => Promise<Generate>
  applyPaths?: string[]
  modelLabel?: string
  loadSource?: (sessionID: string) => Promise<DigestSource>
}

export type ReflectSessionResult =
  | { status: "none" }
  | { status: "done"; result: ReflectCoreResult; signals: Signals.Signal[]; kind: FeedbackKind }

/**
 * Reflects on a session's open signals. They are marked consumed (by the history entry) only after the
 * reflection succeeded; any failure leaves them open for a retry.
 */
export async function reflectSessionSignals(input: ReflectSessionInput): Promise<ReflectSessionResult> {
  await Signals.flushWrites()
  const open = await Signals.listSignals(input.root, { session: input.sessionID })
  if (open.length === 0) return { status: "none" }
  // Include whole signals only. feedbackText clips by this same budget, so anything left out
  // stays open for the next reflection, including after a successful no-op response.
  const signals: Signals.Signal[] = []
  for (const signal of open) {
    if (Signals.feedbackFromSignals([...signals, signal]).text.trim().length > FEEDBACK_CAP) break
    signals.push(signal)
  }
  if (signals.length === 0) throw new Error("The first signal exceeds the reflection feedback budget.")
  const { kind, text } = Signals.feedbackFromSignals(signals)
  // The CLI's explicit external bucket accepts user feedback as well as review and CI text.
  const external = input.sessionID === Signals.EXTERNAL_SESSION || signals.every((s) => s.kind === "review" || s.kind === "ci")
  const load = input.loadSource ?? sourceFromSession
  const source = await load(input.sessionID).catch((e) => {
    if (external) return { prompts: [], calls: [] } as DigestSource
    throw e
  })
  await prepareReflection(input.root, input.name, input.applyPaths)
  const generate = await input.getGenerate()
  const result = await reflectCore({
    root: input.root,
    name: input.name,
    source,
    feedback: text,
    kind,
    origin: input.sessionID,
    session: input.sessionID,
    generate,
    applyPaths: input.applyPaths,
    modelLabel: input.modelLabel,
    signalIDs: signals.map((s) => s.id),
  })
  return { status: "done", result, signals, kind }
}

export const candidatePath = (root: string, name: string) => path.relative(root, Store.paths(root, name).candidate)
