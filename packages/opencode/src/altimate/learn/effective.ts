// altimate_change - new file
//
// The effective lesson set when sync is on: local lessons plus the approved team lessons pulled from the
// workspace (`remote.json`), keyed by qualified identity (repo_identity, store, lesson_key).
//
// - For the same identity the remote lesson wins, and an exact-identity tombstone hides the local copy.
//   Local lessons always have this repository's identity; pending or rejected proposals never hide anything.
// - Remote lessons become `Lesson` records with an `L-` id: their key, or a stable alias derived from the
//   identity when that key is already taken (another repository's lesson with the same key, under sharing).
// - Coexists references are projected server-side; they are still filtered to lessons present here.
//
// `Store.loadApproved()` stays local-only: this overlay is applied by delivery and curation, never written
// into `approved.json` or `candidate.json`.
import { createHash } from "node:crypto"
import type { Lesson } from "./lesson"
import type { Bullet } from "./playbook"
import { identityKey, type Identity, type Remote } from "./ledger"
import type { LessonOut } from "../workspace/lesson-api"

export type Source = "local" | "remote"

export interface RemoteEntry {
  id: string
  identity: Identity
  remote: LessonOut
  coexists: string[]
}

export interface Resolved {
  /** Local lesson ids hidden by a remote lesson or a tombstone with the same identity. */
  hidden: Set<string>
  remote: RemoteEntry[]
}

export const localIdentity = (store: string, key: string, remote: Pick<Remote, "repo_identity">): Identity =>
  ({ repo_identity: remote.repo_identity, store, lesson_key: key })
export const remoteIdentity = (lesson: Pick<LessonOut, "repo_identity" | "store" | "lesson_key">): Identity =>
  ({ repo_identity: lesson.repo_identity, store: lesson.store, lesson_key: lesson.lesson_key })

const alias = (identity: Identity, attempt: number) =>
  "L-" + createHash("sha256").update(`alias\0${attempt}\0${identityKey(identity)}`).digest("hex").slice(0, 16)

/** Resolve one store's remote lessons against the local lesson ids. */
export function resolve(store: string, localIds: readonly string[], remote: Remote | undefined): Resolved {
  if (!remote) return { hidden: new Set(), remote: [] }
  const lessons = remote.lessons.filter((lesson) => lesson.store === store)
  const live = new Set(lessons.map((lesson) => identityKey(remoteIdentity(lesson))))
  const tombstones = new Set(remote.tombstones.filter((t) => t.store === store).map(identityKey))
  const hidden = new Set(localIds.filter((id) => {
    const key = identityKey(localIdentity(store, id, remote))
    return live.has(key) || tombstones.has(key)
  }))
  // This repository's lessons claim their keys first, then workspace-wide ones, then other repositories'.
  const rank = (lesson: LessonOut) => lesson.repo_identity === remote.repo_identity ? 0 : lesson.repo_identity === null ? 1 : 2
  const ordered = [...lessons].sort((a, b) => rank(a) - rank(b) || (a.lesson_key < b.lesson_key ? -1 : a.lesson_key > b.lesson_key ? 1 : 0) ||
    ((a.repo_identity ?? "") < (b.repo_identity ?? "") ? -1 : 1))
  const used = new Set(localIds.filter((id) => !hidden.has(id)))
  const entries: RemoteEntry[] = []
  for (const lesson of ordered) {
    const identity = remoteIdentity(lesson)
    let id = lesson.lesson_key
    for (let attempt = 0; used.has(id); attempt++) id = alias(identity, attempt)
    used.add(id)
    entries.push({ id, identity, remote: lesson, coexists: [] })
  }
  const byKey = new Map<string, RemoteEntry[]>()
  for (const entry of entries) byKey.set(entry.identity.lesson_key, [...(byKey.get(entry.identity.lesson_key) ?? []), entry])
  for (const entry of entries) {
    const ids = entry.remote.coexists.flatMap((key) => {
      const matches = byKey.get(key) ?? []
      const target = matches.find((m) => m.identity.repo_identity === entry.identity.repo_identity) ??
        matches.find((m) => m.identity.repo_identity === null) ?? matches[0]
      return target && target !== entry ? [target.id] : []
    })
    entry.coexists = [...new Set(ids)]
  }
  return { hidden, remote: entries }
}

export function toLesson(entry: RemoteEntry): Lesson {
  const r = entry.remote
  return {
    id: entry.id, text: r.text, tags: [...r.tags], scope: "project",
    ...(r.pinned ? { pinned: true } : {}),
    ...(r.trigger_paths.length ? { trigger: { paths: [...r.trigger_paths] } } : {}),
    helpful: r.helpful, harmful: r.harmful, applied: r.applied,
    ...(entry.coexists.length ? { coexists: [...entry.coexists] } : {}),
    created: r.updated_at, updated: r.updated_at,
  }
}

export function toBullet(entry: RemoteEntry): Bullet {
  const r = entry.remote
  return {
    id: entry.id, text: r.text, helpful: r.helpful, harmful: r.harmful,
    ...(r.pinned ? { pinned: true } : {}),
    ...(entry.coexists.length ? { coexists: [...entry.coexists] } : {}),
  }
}

export interface EffectiveEntry {
  lesson: Lesson
  source: Source
  /** Unknown (undefined) for local lessons until the first pull names this repository's identity. */
  identity?: Identity
  remote?: LessonOut
}

/** Local lessons (minus hidden ones) followed by remote lessons. Without a remote cache: exactly the local set. */
export function effectiveLessons(store: string, local: readonly Lesson[], remote: Remote | undefined): EffectiveEntry[] {
  const resolved = resolve(store, local.map((lesson) => lesson.id), remote)
  return [
    ...local.filter((lesson) => !resolved.hidden.has(lesson.id)).map((lesson): EffectiveEntry => ({
      lesson, source: "local", ...(remote ? { identity: localIdentity(store, lesson.id, remote) } : {}),
    })),
    ...resolved.remote.map((entry): EffectiveEntry => ({ lesson: toLesson(entry), source: "remote", identity: entry.identity, remote: entry.remote })),
  ]
}

/**
 * What the curator sees besides the local snapshot: remote lessons as read-only bullets under `L-` ids,
 * and the reverse map from those ids back to the remote lesson. The `Lesson` schema is strict, so the
 * identity cannot ride along on the bullet itself.
 */
export interface CuratorView {
  store: string
  repoIdentity: string
  hidden: Set<string>
  bullets: Bullet[]
  byId: Map<string, RemoteEntry>
}

export function curatorView(store: string, localIds: readonly string[], remote: Remote | undefined): CuratorView | undefined {
  if (!remote) return undefined
  const resolved = resolve(store, localIds, remote)
  return {
    store,
    repoIdentity: remote.repo_identity,
    hidden: resolved.hidden,
    bullets: resolved.remote.map(toBullet),
    byId: new Map(resolved.remote.map((entry) => [entry.id, entry])),
  }
}

/** The curator's input: the visible local bullets with remote bullets after them. */
export function withRemote(local: readonly Bullet[], view: CuratorView | undefined): Bullet[] {
  if (!view) return [...local]
  return [...local.filter((bullet) => !view.hidden.has(bullet.id)), ...view.bullets]
}

export const RETIRED_MARK = "retired by team — not delivered"
export const REPLACED_MARK = "team version delivered instead"

/**
 * Why a local lesson is not delivered as itself: retired in the workspace (an exact-identity tombstone), or
 * shadowed by the team's approved lesson for the same identity with different content. Absent: delivered.
 */
export function hiddenReasons(store: string, local: readonly Pick<Lesson, "id" | "text">[], remote: Remote | undefined): Map<string, string> {
  const reasons = new Map<string, string>()
  if (!remote) return reasons
  const tombstones = new Set(remote.tombstones.filter((t) => t.store === store).map(identityKey))
  const live = new Map(remote.lessons.filter((l) => l.store === store).map((l) => [identityKey(remoteIdentity(l)), l]))
  for (const lesson of local) {
    const key = identityKey(localIdentity(store, lesson.id, remote))
    const team = live.get(key)
    if (team) {
      if (team.text !== lesson.text) reasons.set(lesson.id, REPLACED_MARK)
    } else if (tombstones.has(key)) reasons.set(lesson.id, RETIRED_MARK)
  }
  return reasons
}
