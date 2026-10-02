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
import { feedbackText, reflect, replace, type FeedbackKind, type Generate } from "./reflect"
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
}

export interface ReflectCoreResult {
  curated: CurateResult
  proposed: number
  flagged: string | undefined
  history: Awaited<ReturnType<typeof Store.appendHistory>>
}

export async function reflectCore(input: ReflectCoreInput): Promise<ReflectCoreResult> {
  const { root, name } = input
  const flagged = flagSuspiciousFeedback(input.feedback)
  const digest = buildDigest(input.source)
  const pb = await Store.loadCandidate(root, name, { applyPaths: input.applyPaths })
  const bullets = Playbook.bullets(pb)
  const deltas = await reflect(
    { digest, feedback: input.feedback, kind: input.kind, bullets },
    input.generate,
  ).catch((e) => {
    throw new Error(`Model call failed (${input.modelLabel ?? "the default model"}): ${errText(e)}`)
  })
  const curated = curate(bullets, deltas, {
    feedbackId: Store.feedbackId(input.feedback, input.origin),
    harmfulFrom: await Store.readHarmfulFrom(root, name),
  })
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
  return { curated, proposed: deltas.length, flagged, history }
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
  const signals = await Signals.listSignals(input.root, { session: input.sessionID })
  if (signals.length === 0) return { status: "none" }
  const { kind, text } = Signals.feedbackFromSignals(signals)
  // Review and CI signals can come from an integration with no local session: reflect on the text alone.
  const external = signals.every((s) => s.kind === "review" || s.kind === "ci")
  const load = input.loadSource ?? sourceFromSession
  const source = await load(input.sessionID).catch((e) => {
    if (external) return { prompts: [], calls: [] } as DigestSource
    throw e
  })
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
  })
  await Signals.consumeSignals(
    input.root,
    signals.map((s) => s.id),
    `reflect@${result.history.ts}`,
  )
  return { status: "done", result, signals, kind }
}

export const candidatePath = (root: string, name: string) => path.relative(root, Store.paths(root, name).candidate)
