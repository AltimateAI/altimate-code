// altimate_change - new file
//
// Turning local lesson changes into review-queue proposals (`POST /batch` items), driven by the ledger:
//
// - no server record for the lesson         -> `add` (a local edit of an unknown lesson is an add too)
// - the caller's own open proposal          -> a revision of it (`revises_public_id` / `revises_version`)
// - an approved lesson on the server        -> `edit` or `remove` with `replaces` listing every target at
//                                              its version; "ADD X supersedes Y, Z" is one edit with key X
//
// The base (target versions, the revised proposal's version) is captured when the change is made, from the
// last pull and the ledger, and never refreshed before sending: substituting a newer version would overwrite a
// change someone else made on the server. Removals are never inferred from team lessons missing locally, and
// counter-only changes are not proposals.
//
// Reflection curates against the effective set (effective.ts). `partition` splits its result: changes to local
// lessons go to `candidate.json` as before; anything involving a remote lesson (editing, removing or superseding
// it, or declaring coexistence with it) goes only to the outbox, so team lessons never reach `approved.json`.
import { createHash, randomUUID } from "node:crypto"
import type { Applied, CurateResult } from "./curator"
import { lint, normalizeText } from "./curator"
import type { Lesson } from "./lesson"
import type { Bullet } from "./playbook"
import { identityKey, readOutbox, readRemote, readSyncState, sameScope, textHash, writeOutbox, writeSyncState, forScope, type Identity, type Proposal, type Remote, type Scope, type SyncState } from "./ledger"
import { localIdentity, remoteIdentity, resolve, type CuratorView } from "./effective"
import type { BatchItem, CoexistsRef, Origin, TargetRef, UsageItem } from "../workspace/lesson-api"
import { assertLearnLock } from "./lock"
import * as Store from "./store"

/** A change to one lesson, before the ledger decides how to propose it. */
export interface Intent {
  kind: "upsert" | "remove"
  /** Upsert: the key of the lesson's new content. Remove: the key of the lesson removed. */
  lesson_key: string
  /** The identity the change applies to; local lessons have this repository's identity. */
  identity: Identity
  text: string
  tags: string[]
  trigger_paths: string[]
  pinned: boolean
  coexists: CoexistsRef[]
  /** Upsert only: identities of lessons it supersedes (curator `supersedes`, implicit or explicit). */
  supersedes: Identity[]
  provenance?: string
  origin: Origin
}

/** The server's canonical JSON (`json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`). */
export function canonicalJson(value: unknown): string {
  const ordered = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(ordered)
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, ordered(x)]))
    return v
  }
  return JSON.stringify(ordered(value))
}

/** The server's `submission_hash` (and `content_hash`): sha256 of the canonical JSON of the material fields. */
export function submissionHash(item: Pick<BatchItem, "change_type" | "text" | "tags" | "trigger_paths" | "coexists" | "pinned" | "replaces">): string {
  const { change_type, text, tags, trigger_paths, coexists, pinned, replaces } = item
  return createHash("sha256").update(canonicalJson({ change_type, text, tags, trigger_paths, coexists, pinned, replaces }), "utf8").digest("hex")
}

const clean = (text: string) => normalizeText(text).trim()

export const coexistsRef = (key: string, sourceText: string, targetText: string): CoexistsRef =>
  ({ lesson_key: key, source_text_hash: textHash(clean(sourceText)), target_text_hash: textHash(clean(targetText)) })

/** Local lesson -> upsert intent. `texts` resolves coexists ids to the referenced lesson's key and text. */
export function lessonIntent(store: string, remote: Pick<Remote, "repo_identity">, lesson: Pick<Lesson, "id" | "text" | "tags" | "trigger" | "pinned" | "coexists" | "provenance">, origin: Origin, texts: (id: string) => { key: string; text: string } | undefined, supersedes: Identity[] = []): Intent {
  return {
    kind: "upsert",
    lesson_key: lesson.id,
    identity: localIdentity(store, lesson.id, remote),
    text: clean(lesson.text),
    tags: [...lesson.tags],
    trigger_paths: (lesson.trigger?.paths ?? []).map(clean),
    pinned: lesson.pinned === true,
    coexists: (lesson.coexists ?? []).flatMap((id) => {
      const target = texts(id)
      return target ? [coexistsRef(target.key, lesson.text, target.text)] : []
    }),
    supersedes,
    ...(lesson.provenance ? { provenance: lesson.provenance } : {}),
    origin,
  }
}

/** Counter-only differences are not lesson changes (the same rule auto-promote applies). */
const material = (lesson: Lesson) => JSON.stringify([lesson.text, lesson.tags, lesson.pinned === true, lesson.trigger?.paths ?? [], lesson.coexists ?? []])

/** A promote's changes: the approved set before and the set being published. */
export function promoteIntents(store: string, remote: Pick<Remote, "repo_identity">, before: readonly Lesson[], after: readonly Lesson[], origin: Origin, supersededBy: ReadonlyMap<string, string> = new Map()): Intent[] {
  const previous = new Map(before.map((lesson) => [lesson.id, lesson]))
  const next = new Map(after.map((lesson) => [lesson.id, lesson]))
  const texts = (id: string) => {
    const lesson = next.get(id)
    return lesson && { key: id, text: lesson.text }
  }
  const intents: Intent[] = []
  for (const lesson of after) {
    const old = previous.get(lesson.id)
    if (old && material(old) === material(lesson)) continue
    const supersedes = before.filter((b) => !next.has(b.id) && supersededBy.get(b.id) === lesson.id).map((b) => localIdentity(store, b.id, remote))
    intents.push(lessonIntent(store, remote, lesson, origin, texts, supersedes))
  }
  const replaced = new Set(after.flatMap((lesson) => before.filter((b) => !next.has(b.id) && supersededBy.get(b.id) === lesson.id).map((b) => b.id)))
  for (const lesson of before) {
    if (next.has(lesson.id) || replaced.has(lesson.id)) continue
    intents.push({ ...lessonIntent(store, remote, lesson, origin, () => undefined), kind: "remove", coexists: [] })
  }
  return intents
}

export interface Partition {
  /** The local candidate: remote lessons and changes involving them removed, hidden local lessons kept. */
  next: Bullet[]
  /** Deltas about local lessons only, for `Store.saveCandidate`'s retired bookkeeping. */
  applied: Applied[]
  intents: Intent[]
  /** HELPFUL/HARMFUL marks on remote lessons, keyed by public_id. */
  usage: UsageItem[]
}

/**
 * Split a curation over the effective set. `local` is the full local snapshot the curator started from
 * (including lessons hidden by a remote lesson or tombstone); `lessons` carries their store-only metadata.
 */
export function partition(input: {
  view: CuratorView
  local: readonly Bullet[]
  lessons: ReadonlyMap<string, Lesson>
  curated: Pick<CurateResult, "next" | "applied">
  origin: Origin
  applyPaths?: string[]
}): Partition {
  const { view, curated } = input
  const isRemote = (id: string | undefined) => id !== undefined && view.byId.has(id)
  const finalById = new Map(curated.next.map((bullet) => [bullet.id, bullet]))
  const supersededBy = (id: string) => curated.applied.filter((a) => a.op === "REMOVE" && a.id && a.reason === `superseded by ${id}`).map((a) => a.id!)
  // An added lesson that supersedes or coexists with a remote lesson exists only as a proposal.
  const involved = new Set(curated.applied.flatMap((a) => {
    if (a.op !== "ADD" || !a.id) return []
    const coexists = finalById.get(a.id)?.coexists ?? a.coexists ?? []
    return [...supersededBy(a.id), ...(a.supersedes ? [a.supersedes] : []), ...coexists].some(isRemote) ? [a.id] : []
  }))
  const keep = (id: string) => !isRemote(id) && !involved.has(id)
  const strip = (bullet: Bullet): Bullet => {
    const coexists = bullet.coexists?.filter((id) => !isRemote(id) && !involved.has(id))
    const { coexists: _, ...rest } = bullet
    return coexists?.length ? { ...rest, coexists } : rest
  }
  const next = curated.next.filter((bullet) => keep(bullet.id)).map(strip)
  // Hidden local lessons were not shown to the curator; they stay in the local snapshot unchanged.
  const local = [...input.local]
  for (const [index, bullet] of local.entries()) {
    if (!view.hidden.has(bullet.id) || next.some((b) => b.id === bullet.id)) continue
    next.splice(Math.min(index, next.length), 0, { ...bullet })
  }
  const applied = curated.applied.filter((a) => !isRemote(a.id) && !(a.op === "ADD" && a.id && involved.has(a.id)))

  const identityOf = (id: string): Identity => view.byId.get(id)?.identity ?? localIdentity(view.store, id, { repo_identity: view.repoIdentity })
  const texts = (id: string) => {
    const remote = view.byId.get(id)
    if (remote) return { key: remote.identity.lesson_key, text: finalById.get(id)?.text ?? remote.remote.text }
    const bullet = finalById.get(id) ?? local.find((b) => b.id === id)
    return bullet && { key: id, text: bullet.text }
  }
  const intents: Intent[] = []
  const touched = new Set<string>()
  for (const delta of curated.applied) {
    if (!delta.id || touched.has(delta.id)) continue
    if (delta.op === "HELPFUL" || delta.op === "HARMFUL") continue
    // Superseded targets are carried by the superseding lesson's edit; cap evictions are not decisions.
    if (delta.op === "REMOVE" && (delta.note === "superseded" || delta.note === "cap eviction")) continue
    touched.add(delta.id)
    const bullet = finalById.get(delta.id)
    if (!bullet) {
      // Removed (an ADD later superseded within the same reflection was never anywhere: skip it).
      if (delta.op === "ADD") continue
      const remote = view.byId.get(delta.id)
      const lesson = input.lessons.get(delta.id) ?? local.find((b) => b.id === delta.id)
      const text = remote?.remote.text ?? lesson?.text
      if (text === undefined) continue
      intents.push({
        kind: "remove", lesson_key: identityOf(delta.id).lesson_key, identity: identityOf(delta.id), text: clean(text),
        tags: remote ? [...remote.remote.tags] : [...(input.lessons.get(delta.id)?.tags ?? [])],
        trigger_paths: remote ? [...remote.remote.trigger_paths] : [...(input.lessons.get(delta.id)?.trigger?.paths ?? [])],
        pinned: remote ? remote.remote.pinned : input.lessons.get(delta.id)?.pinned === true,
        coexists: [], supersedes: [], origin: input.origin,
      })
      continue
    }
    const remote = view.byId.get(delta.id)
    const stored = input.lessons.get(delta.id)
    const meta = remote
      ? { tags: remote.remote.tags, trigger: remote.remote.trigger_paths.length ? { paths: remote.remote.trigger_paths } : undefined, pinned: remote.remote.pinned, provenance: undefined }
      : stored ?? { tags: [], trigger: input.applyPaths?.length ? { paths: input.applyPaths } : undefined, pinned: bullet.pinned, provenance: undefined }
    const supersedes = delta.op === "ADD" ? [...new Set([...supersededBy(delta.id), ...(delta.supersedes ? [delta.supersedes] : [])])].map(identityOf) : []
    const intent = lessonIntent(view.store, { repo_identity: view.repoIdentity }, {
      id: delta.id, text: bullet.text, tags: meta.tags, trigger: meta.trigger, pinned: meta.pinned, coexists: bullet.coexists, provenance: meta.provenance,
    }, input.origin, texts, supersedes)
    // An edited remote lesson keeps its identity and key.
    intents.push(remote ? { ...intent, lesson_key: remote.identity.lesson_key, identity: remote.identity } : intent)
  }
  const usage = new Map<string, UsageItem>()
  for (const delta of curated.applied) {
    if ((delta.op !== "HELPFUL" && delta.op !== "HARMFUL") || !delta.id) continue
    const remote = view.byId.get(delta.id)
    if (!remote) continue
    const item = usage.get(remote.remote.public_id) ?? { public_id: remote.remote.public_id, applied: 0, helpful: 0, harmful: 0 }
    if (delta.op === "HELPFUL") item.helpful = Math.min(50, item.helpful + 1)
    else item.harmful = Math.min(50, item.harmful + 1)
    usage.set(remote.remote.public_id, item)
  }
  return { next, applied, intents, usage: [...usage.values()] }
}

/** The server's approved record for an identity: the last pull first, then the ledger. */
function approvedRef(identity: Identity, remote: Remote | undefined, state: SyncState): TargetRef | undefined {
  const key = identityKey(identity)
  const lesson = remote?.lessons.find((l) => identityKey(remoteIdentity(l)) === key)
  if (lesson) return { public_id: lesson.public_id, version: lesson.version }
  if (remote?.tombstones.some((t) => identityKey(t) === key)) return undefined
  return state.ledger[key]?.approved
}

/** Derive the wire item for an intent from the ledger as it stands now; undefined when there is nothing to propose. */
export function toItem(intent: Intent, remote: Remote | undefined, state: SyncState): BatchItem | undefined {
  const key = identityKey(intent.identity)
  const pending = state.ledger[key]?.pending
  const base = {
    lesson_key: intent.lesson_key, text: intent.text, tags: intent.tags, trigger_paths: intent.trigger_paths,
    coexists: intent.coexists, pinned: intent.pinned, provenance: intent.provenance ?? null, origin: intent.origin,
  }
  if (intent.kind === "remove") {
    const target = approvedRef(intent.identity, remote, state)
    // Removing a lesson the server never approved is nothing to propose; an open proposal cannot be withdrawn here.
    if (!target) return undefined
    // The server lints a removal's text too: send the approved lesson's current content.
    const current = remote?.lessons.find((l) => l.public_id === target.public_id)
    return {
      ...base, change_type: "remove", coexists: [], replaces: [target], revises_public_id: null, revises_version: null,
      ...(current ? { text: current.text, tags: [...current.tags], trigger_paths: [...current.trigger_paths], pinned: current.pinned } : {}),
    }
  }
  const replaces: TargetRef[] = []
  const seen = new Set<string>()
  for (const identity of [intent.identity, ...intent.supersedes]) {
    const target = approvedRef(identity, remote, state)
    if (!target || seen.has(target.public_id)) continue
    seen.add(target.public_id)
    replaces.push(target)
  }
  // An edit identical to its single same-key target is a counter-only change.
  const same = remote?.lessons.find((l) => identityKey(remoteIdentity(l)) === key)
  if (same && replaces.length === 1 && same.text === intent.text && same.pinned === intent.pinned &&
    JSON.stringify(same.tags) === JSON.stringify(intent.tags) && JSON.stringify(same.trigger_paths) === JSON.stringify(intent.trigger_paths) &&
    !intent.coexists.length) return undefined
  return {
    ...base,
    change_type: replaces.length ? "edit" : "add",
    replaces,
    revises_public_id: pending?.public_id ?? null,
    revises_version: pending?.version ?? null,
  }
}

/** Why the server would refuse this item as it is (the same per-text checks as `Store.validateCandidate`). */
export function unsyncableReason(item: Pick<BatchItem, "text" | "trigger_paths">): string | undefined {
  const check = (text: string) => lint(text) ?? (normalizeText(text) !== text ? "contains hidden or non-normalized characters" : undefined)
  const bad = check(item.text)
  if (bad) return bad === `longer than 140 characters` ? "not syncable: too long (over 140 characters); shorten it to share it" : `not syncable: ${bad}`
  for (const trigger of item.trigger_paths) {
    const reason = check(trigger)
    if (reason) return `not syncable: path trigger ${reason}`
  }
  return undefined
}

/**
 * Queue proposals for `intents` under the learn lock. Unsent proposals for the same lesson are replaced
 * (keeping their base); a lesson with a held proposal queues behind it as held too. Returns the queued count.
 */
export async function enqueue(root: string, store: string, scope: Scope, intents: readonly Intent[], usage: readonly UsageItem[] = []): Promise<number> {
  if (!intents.length && !usage.length) return 0
  await assertLearnLock(root)
  const remoteRaw = await readRemote(root, store)
  const remote = remoteRaw && sameScope(remoteRaw.scope, scope) ? remoteRaw : undefined
  const state = forScope(await readSyncState(root, store), scope)
  const outbox = await readOutbox(root, store)
  const now = new Date().toISOString()
  let queued = 0
  let stateChanged = false
  for (const intent of intents) {
    const sameLesson = (p: Proposal) => sameScope(p.scope, scope) && p.item.lesson_key === intent.lesson_key
    const earlier = outbox.proposals.filter((p) => sameLesson(p) && p.state === "queued")
    const held = outbox.proposals.find((p) => sameLesson(p) && p.state === "held")
    outbox.proposals = outbox.proposals.filter((p) => !earlier.includes(p))
    const item = toItem(intent, remote, state)
    if (!item) continue
    // Never send what the server refuses (and would be retried forever): record it for `learn status`.
    const unsyncable = unsyncableReason(item)
    if (unsyncable) {
      state.unsyncable[intent.lesson_key] = unsyncable
      stateChanged = true
      continue
    }
    if (state.unsyncable[intent.lesson_key]) {
      delete state.unsyncable[intent.lesson_key]
      stateChanged = true
    }
    // Coalesce with an unsent proposal for the same lesson: its base (targets and revision) still applies.
    for (const previous of earlier) {
      for (const target of previous.item.replaces) if (!item.replaces.some((t) => t.public_id === target.public_id)) item.replaces.push(target)
      if (item.replaces.length && item.change_type === "add") item.change_type = "edit"
      item.revises_public_id ??= previous.item.revises_public_id
      item.revises_version ??= previous.item.revises_version
    }
    const hash = submissionHash(item)
    const entry = state.ledger[identityKey(intent.identity)]
    // Already the open proposal, or already decided (a rejected submission is never re-sent).
    if (entry?.pending?.submission_hash === hash || entry?.receipts.some((r) => r.submission_hash === hash)) continue
    outbox.proposals.push({
      id: randomUUID(), scope, created_at: now,
      state: held ? "held" : "queued",
      ...(held ? { reason: "an earlier proposal for this lesson is held; run `learn push --resubmit " + intent.lesson_key + "`" } : {}),
      repo_identity: intent.identity.repo_identity, item, submission_hash: hash, targets: intent.supersedes,
    })
    queued++
  }
  if (usage.length) outbox.usage.push({ batch_id: randomUUID(), scope, created_at: now, items: [...usage] })
  await writeOutbox(root, store, outbox)
  if (stateChanged) await writeSyncState(root, store, state)
  return queued
}

/**
 * First sync: upload the staged set as `add` (origin `backfill`), best lessons first, at most `cap` per run.
 * The staged set is the candidate when one exists: anything it lacks versus approved is an intentional removal
 * and is not uploaded. Progress is recorded in `state.backfill`, so an interrupted backfill resumes.
 */
export function backfillIntents(store: string, staged: readonly Lesson[], remote: Remote, state: SyncState, cap: number): { intents: Intent[]; done: string[]; complete: boolean } {
  if (state.backfill.complete) return { intents: [], done: [], complete: true }
  const done = new Set(state.backfill.done)
  const hidden = resolve(store, staged.map((lesson) => lesson.id), remote).hidden
  const byId = new Map(staged.map((lesson) => [lesson.id, lesson]))
  const texts = (id: string) => {
    const lesson = byId.get(id)
    return lesson && { key: id, text: lesson.text }
  }
  const order = staged.filter((lesson) => !done.has(lesson.id))
    .sort((a, b) => (b.helpful - b.harmful) - (a.helpful - a.harmful) || (a.id < b.id ? -1 : 1))
  const intents: Intent[] = []
  const processed: string[] = []
  for (const lesson of order) {
    if (intents.length >= cap) break
    processed.push(lesson.id)
    const entry = state.ledger[identityKey(localIdentity(store, lesson.id, remote))]
    if (hidden.has(lesson.id) || entry?.approved || entry?.pending || entry?.receipts.length) continue
    intents.push(lessonIntent(store, remote, lesson, "backfill", texts))
  }
  return { intents, done: processed, complete: processed.length === order.length }
}

/** Under the learn lock, before a promote publishes: queue its changes as proposals (sync on, cache present). */
export async function recordPromotion(root: string, store: string, scope: Scope, before: readonly Lesson[], after: readonly Lesson[], origin: Origin): Promise<number> {
  const remoteRaw = await readRemote(root, store)
  if (!remoteRaw || !sameScope(remoteRaw.scope, scope)) return 0
  const retired = await Store.loadRetired(root, store).catch(() => [])
  const supersededBy = new Map(retired.flatMap((lesson) => (lesson.supersededBy ? [[lesson.id, lesson.supersededBy] as const] : [])))
  return enqueue(root, store, scope, promoteIntents(store, remoteRaw, before, after, origin, supersededBy))
}
