// altimate_change - new file
//
// The reflect pipeline shared by `learn reflect`, `learn reflect --pending` and the auto-reflect hook at
// the end of `run`: digest -> reflector -> curator -> candidate + history. Kept free of CLI and Effect
// so it can run in-process with an injected `generate`.
import path from "node:path"
import type { InstanceContext } from "@/project/instance-context"
import { Log } from "@/util/log"
import * as Playbook from "./playbook"
import * as Store from "./store"
import * as Signals from "./signals"
import { curate, flagSuspiciousFeedback, type CurateResult } from "./curator"
import { buildDigest, redactSecrets, sourceFromMessages, type DigestSource } from "./digest"
import { FEEDBACK_CAP, feedbackText, reflect, replace, type FeedbackKind, type Generate } from "./reflect"
import { sharedAnchors } from "./anchors"
import { processClaims } from "./claims"

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
  maxStored?: number
  /** Shown in the error when the model call fails, e.g. `--model x` or `the default model`. */
  modelLabel?: string
  /** Consumed in the same locked transition as the candidate and history. */
  signalIDs?: string[]
  /** A signal claim must still be owned when the model result is published. */
  beforeCommit?: () => Promise<void>
  /** Scope-limited imports must not send another session's queued replacement feedback. */
  recoverPending?: boolean
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
      const bad = Store.validateCandidate(name, raw, { allowOverlap: true, grandfathered: await Store.grandfathered(root, name) })
      if (bad) throw new Error(`Unsafe lesson store: ${bad}. Repair it or run \`learn reject\` before reflecting.`)
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
  const originalText = new Map(Playbook.bullets(snapshot).map((b) => [b.id, b.text]))
  const deltas = await reflect(
    { digest, feedback: input.feedback, kind: input.kind, bullets: Playbook.bullets(snapshot) },
    input.generate,
  ).catch((e) => {
    throw new Error(`Model call failed (${input.modelLabel ?? "the default model"}): ${errText(e)}`)
  })
  // Reuse provisional ADD ids when re-curating after replacement generation so any model-declared
  // coexistence still names the same bullet. Freshness checks below reject changed relationships.
  const allocated: string[] = []
  const allocator = () => {
    let index = 0
    return (taken: Iterable<string> = []) => {
      const used = new Set(taken)
      if (!allocated[index] || used.has(allocated[index])) allocated[index] = Playbook.newId(used)
      return allocated[index++]
    }
  }
  const prepare = async (newId: typeof Playbook.newId) => {
    if (input.signalIDs) {
      const open = new Set((await Signals.listSignals(root, {}, name)).map((s) => s.id))
      if (input.signalIDs.some((id) => !open.has(id)))
        throw new Error("Some feedback signals were already consumed by another reflection; re-run reflect for the remaining signals.")
    }
    // The model ran without the lock. Re-read and re-curate against the current candidate so
    // intervening reflections, promotions, and manual edits cannot be overwritten by this snapshot.
    const pb = await prepareReflection(root, name, input.applyPaths)
    const bullets = Playbook.bullets(pb)
    // Compare before our own ADDs and EDITs so replacement eviction can distinguish them from
    // concurrent changes that must remain protected for this entire reflection.
    const protectedIDs = new Set(bullets.filter((b) => originalText.get(b.id) !== b.text).map((b) => b.id))
    const curated = curate(bullets, deltas, {
      newId,
      maxStored: input.maxStored,
      snapshot: Playbook.bullets(snapshot),
      feedbackId: Store.feedbackId(input.feedback, input.origin),
      harmfulFrom: await Store.readHarmfulFrom(root, name),
    })
    // Keep all feedback when any proposal is stale, even if independent ADDs succeeded. The retry
    // sees fresh text and folds duplicate ADDs into HELPFUL. Unrelated recoveries below must also
    // leave feedback pending when all of its own proposals were rejected.
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
    return { pb, curated, pending, onlyRejected, protectedIDs }
  }
  const key = (record: Store.PendingReplacement) => JSON.stringify([
    record.id, record.text, record.reasons, record.feedback, record.kind, record.attempts,
  ])
  const overlaps = (bullets: Playbook.Bullet[], record: Store.PendingReplacement) =>
    bullets.filter((b) => sharedAnchors(b.text, record.text).length > 0)
  const context = (bullets: Playbook.Bullet[]) => JSON.stringify(bullets.map((b) => [b.id, b.text, b.coexists ?? []]))
  const applyReplacement = (
    curated: CurateResult,
    record: Store.PendingReplacement,
    replacement: NonNullable<Awaited<ReturnType<typeof replace>>>,
    newId: typeof Playbook.newId,
    snapshot: Playbook.Bullet[],
    protectedIDs: Set<string>,
  ) => {
    const result = curate(curated.next, [{ op: "ADD", ...replacement, reason: `replacement for ${record.id}` }], {
      newId,
      // Omitted ids also count as changed. Preserve edits from either unlocked model call.
      snapshot: snapshot.filter((b) => !protectedIDs.has(b.id)),
      harmfulFrom: curated.harmfulFrom,
      priorApplied: curated.applied,
      maxStored: input.maxStored,
    })
    curated.next = result.next
    curated.harmfulFrom = result.harmfulFrom
    curated.applied.push(...result.applied.map((a) => a.op === "ADD" ? { ...a, note: "replacement" } : a))
    curated.rejected.push(...result.rejected)
    return result.applied.find((a) => a.op === "ADD")?.id
  }
  const newId = allocator()
  const planned = await Store.transaction(root, () => prepare(newId))
  const generated = new Map<string, {
    snapshot: Playbook.Bullet[]
    replacement: Awaited<ReturnType<typeof replace>> | undefined
  }>()
  // Both model calls run outside the lock. Nothing from this plan is published until the final
  // transaction re-reads the candidate, signals and recovery queue and checks each model's context.
  for (const record of planned.pending.slice(0, input.recoverPending === false ? 0 : MAX_REPLACEMENTS)) {
    const snapshot = planned.curated.next
    const replacement = await replace({
      ...record,
      feedbackExcerpt: record.feedback,
      bullets: overlaps(snapshot, record),
    }, input.generate).catch((e) => {
      log.warn("replacement failed; keeping removal", { id: record.id, error: redactSecrets(errText(e)) })
      return undefined
    })
    generated.set(key(record), { snapshot, replacement })
    if (replacement) applyReplacement(planned.curated, record, replacement, newId, snapshot, planned.protectedIDs)
  }
  return Store.transaction(root, async () => {
    await input.beforeCommit?.()
    const newId = allocator()
    const { pb, curated, pending, onlyRejected, protectedIDs } = await prepare(newId)
    const resolved = new Set<Store.PendingReplacement>()
    const replacements = new Map<Store.PendingReplacement, string>()
    // New or changed recoveries remain queued, unattempted. Older recoveries keep their priority.
    for (const record of pending.slice(0, MAX_REPLACEMENTS)) {
      const proposal = generated.get(key(record))
      if (!proposal) continue
      const { snapshot, replacement } = proposal
      if (context(overlaps(snapshot, record)) !== context(overlaps(curated.next, record))) {
        if (replacement) curated.rejected.push({
          delta: { op: "ADD", ...replacement, reason: `replacement for ${record.id}` },
          reason: "changed concurrently; will be reconsidered",
        })
        continue
      }
      record.attempts++
      if (replacement === null) {
        resolved.add(record)
        continue
      }
      if (!replacement) continue
      const id = applyReplacement(curated, record, replacement, newId, snapshot, protectedIDs)
      if (id) replacements.set(record, id)
    }
    const remaining = pending.filter((record) => {
      if (input.recoverPending === false) return true
      if (resolved.has(record) || curated.next.some((b) => b.id === replacements.get(record))) return false
      if (record.attempts < MAX_REPLACEMENT_ATTEMPTS) return true
      log.warn("pending replacement expired", { id: record.id, attempts: record.attempts })
      return false
    })
    if (curated.applied.length > 0) {
      const replacements = Object.fromEntries(
        curated.applied.flatMap((a) => (a.op === "ADD" && a.supersedes && a.id ? [[a.supersedes, a.id]] : [])),
      )
      await Store.saveCandidate(root, name, Playbook.withBullets(pb, curated.next, replacements), curated.applied)
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
    const changedConcurrently = curated.rejected.some((r) => r.reason === "changed concurrently; will be reconsidered")
    if (input.signalIDs && !onlyRejected && !changedConcurrently)
      await Signals.consumeSignals(root, input.signalIDs, `reflect@${history.ts}`, name)
    return { curated, proposed: deltas.length, flagged, history }
  })
}

export async function sourceFromSession(sessionID: string, context?: InstanceContext): Promise<DigestSource> {
  const { SessionID } = await import("../../session/schema")
  const sid = SessionID.make(sessionID)
  if (context) {
    const [{ Effect }, { Session }, { AppRuntime }, { InstanceRef }] = await Promise.all([
      import("effect"),
      import("../../session/session"),
      import("@/effect/app-runtime"),
      import("@/effect/instance-ref"),
    ])
    return AppRuntime.runPromise(Effect.gen(function* () {
      const session = yield* Session.Service
      yield* session.get(sid).pipe(Effect.mapError(() => new Error(
        `Session not found: ${sessionID}. For a session from another project, use --trajectory.`,
      )))
      const messages = yield* session.messages({ sessionID: sid })
      // The Effect facade exposes core message brands; its runtime values are the same MessageV2 records.
      return sourceFromMessages(messages as unknown as Parameters<typeof sourceFromMessages>[0])
    }).pipe(Effect.provideService(InstanceRef, context)))
  }
  const { Session } = await import("../../session")
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
  getGenerate: (source: DigestSource) => Promise<Generate>
  applyPaths?: string[]
  maxStored?: number
  modelLabel?: string
  loadSource?: (sessionID: string) => Promise<DigestSource>
  /** Startup recovery only includes feedback present in its initial snapshot. */
  signalIDs?: readonly string[]
  /** Rechecked after async preparation and before every model call/publication. */
  shouldContinue?: () => boolean
  claimManager?: typeof processClaims
  recoverPending?: boolean
}

export type ReflectSessionResult =
  | { status: "none" }
  | { status: "done"; result: ReflectCoreResult; signals: Signals.Signal[]; kind: FeedbackKind }

/**
 * Reflects on a session's open signals. They are marked consumed (by the history entry) only after the
 * reflection succeeded; any failure leaves them open for a retry.
 */
export async function reflectSessionSignals(input: ReflectSessionInput): Promise<ReflectSessionResult> {
  if (input.shouldContinue?.() === false) return { status: "none" }
  await Signals.flushWrites()
  const wanted = input.signalIDs && new Set(input.signalIDs)
  const open = (await Signals.listSignals(input.root, { session: input.sessionID }, input.name))
    .filter((signal) => !wanted || wanted.has(signal.id))
  if (open.length === 0) return { status: "none" }
  // Include whole signals only. feedbackText clips by this same budget, so anything left out
  // stays open for the next reflection, including after a successful no-op response.
  const signals: Signals.Signal[] = []
  for (const signal of open) {
    if (Signals.feedbackFromSignals([...signals, signal]).text.trim().length > FEEDBACK_CAP) break
    signals.push(signal)
  }
  if (signals.length === 0) throw new Error("The first signal exceeds the reflection feedback budget.")
  const ids = signals.map((signal) => signal.id)
  const claim = await (input.claimManager ?? processClaims).acquire(input.root, input.name, ids)
  if (!claim) return { status: "none" }
  let cancelled = false
  const continuing = () => {
    if (input.shouldContinue?.() !== false) return
    cancelled = true
    throw new Error("Learning reflection cancelled; signals remain open.")
  }
  const check = async () => {
    await claim.assert()
    continuing()
  }
  try {
    await check()
    const { kind, text } = Signals.feedbackFromSignals(signals)
    // The CLI's explicit external bucket accepts user feedback as well as review and CI text.
    const external = input.sessionID === Signals.EXTERNAL_SESSION || signals.every((s) => s.kind === "review" || s.kind === "ci")
    const load = input.loadSource ?? sourceFromSession
    const source = await load(input.sessionID).catch((e) => {
      if (external) return { prompts: [], calls: [] } as DigestSource
      throw e
    })
    await prepareReflection(input.root, input.name, input.applyPaths)
    await check()
    continuing()
    const generate = await input.getGenerate(source)
    const result = await reflectCore({
      root: input.root,
      name: input.name,
      source,
      feedback: text,
      kind,
      origin: input.sessionID,
      session: input.sessionID,
      generate: async (request) => {
        await check()
        // No async boundary between the last disposal/deadline check and invoking the provider.
        continuing()
        return generate(request)
      },
      beforeCommit: check,
      applyPaths: input.applyPaths,
      maxStored: input.maxStored,
      modelLabel: input.modelLabel ?? (source.model ? `model ${source.model.providerID}/${source.model.modelID}` : undefined),
      signalIDs: ids,
      recoverPending: input.recoverPending,
    })
    return { status: "done", result, signals, kind }
  } catch (error) {
    if (cancelled) return { status: "none" }
    throw error
  } finally {
    await claim.release()
  }
}

export const candidatePath = (root: string, name: string) => path.relative(root, Store.paths(root, name).candidate)
