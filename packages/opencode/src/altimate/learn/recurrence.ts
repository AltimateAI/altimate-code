// altimate_change - new file
import fs from "node:fs/promises"
import path from "node:path"
import { Log } from "@/util/log"
import { anchors } from "./anchors"
import { lessonTextHash, readShownSnapshots, type ShownSnapshot } from "./delivery"
import { parse, type Lesson } from "./lesson"
import { validateName } from "./playbook"
import { readSignalsSnapshot, type Signal } from "./signals"
import * as SafeFS from "./safe-fs"
import * as Store from "./store"

const log = Log.create({ service: "learn.recurrence" })
const STOP = new Set("the and for with that this from into when then than are was were have has had not use using should must always never only all any each your you our its their them they these those also but can will would could does do don't a an to of in on at as is be it or by if".split(" "))
const identifiers = (text: string) => new Set(text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [])
const tokens = (text: string) => new Set([...identifiers(text)].filter((word) => word.length >= 3 && !STOP.has(word)))
const key = (name: string, id: string, textHash: string) => JSON.stringify([name, id, textHash])
export type NamedLesson = { name: string; lesson: Pick<Lesson, "id" | "text"> }
export type LessonRecurrence = {
  name: string
  id: string
  textHash: string
  sessions_shown: number
  recurred: number
  during: number
  unknown: number
  ambiguous: number
  earlier_version: number
}

export function attribute(signals: readonly Signal[], snapshots: readonly ShownSnapshot[], lessons: readonly NamedLesson[]) {
  const prepared = lessons.map(({ name, lesson }) => ({
    name, id: lesson.id, textHash: lessonTextHash(lesson.text),
    anchors: [...anchors(lesson.text)].filter((word) => !word.startsWith("_") && !word.endsWith("_")),
    tokens: tokens(lesson.text),
  }))
  const sessions = new Map(snapshots.map((snapshot) => [snapshot.session, snapshot.shown]))
  const rows = new Map<string, {
    row: LessonRecurrence
    counts: Record<"sessions_shown" | "recurred" | "during" | "unknown" | "ambiguous" | "earlier_version", Set<string>>
  }>()
  for (const snapshot of snapshots) {
    for (const shown of snapshot.shown) {
      const current = prepared.find((lesson) => lesson.name === shown.name && lesson.id === shown.id)
      const hash = current?.textHash ?? shown.textHash
      const identity = key(shown.name, shown.id, hash)
      if (!rows.has(identity)) rows.set(identity, {
        row: { name: shown.name, id: shown.id, textHash: hash, sessions_shown: 0, recurred: 0, during: 0, unknown: 0, ambiguous: 0, earlier_version: 0 },
        counts: { sessions_shown: new Set(), recurred: new Set(), during: new Set(), unknown: new Set(), ambiguous: new Set(), earlier_version: new Set() },
      })
      const counts = rows.get(identity)!.counts
      counts.sessions_shown.add(snapshot.session)
      if (current && shown.textHash !== current.textHash) counts.earlier_version.add(snapshot.session)
    }
  }
  const unmatched = new Map<string, { sessions: Set<string>; signals: Set<string> }>()
  for (const signal of signals) {
    if (signal.kind !== "user_correction" || !sessions.has(signal.sessionID)) continue
    const words = identifiers(signal.text)
    const content = tokens(signal.text)
    const matches = prepared.filter((lesson) => {
      const overlap = [...lesson.tokens].filter((word) => content.has(word))
      return lesson.anchors.some((anchor) => words.has(anchor) && overlap.some((word) => word !== anchor)) ||
        (overlap.length >= 3 && overlap.length / lesson.tokens.size >= 0.6)
    })
    if (!matches.length) {
      const topics = new Set([...words].filter((word) => word.includes("_")))
      for (const anchor of anchors(signal.text)) topics.add(anchor)
      for (const topic of topics) {
        if (!unmatched.has(topic)) unmatched.set(topic, { sessions: new Set(), signals: new Set() })
        unmatched.get(topic)!.sessions.add(signal.sessionID)
        unmatched.get(topic)!.signals.add(signal.id)
      }
      continue
    }
    // Only lessons this session saw in their current text compete; one never shown cannot explain the correction.
    const exposed = matches.flatMap((lesson) => {
      const counts = rows.get(key(lesson.name, lesson.id, lesson.textHash))?.counts
      const shown = sessions.get(signal.sessionID)!.filter((entry) =>
        entry.name === lesson.name && entry.id === lesson.id && entry.textHash === lesson.textHash)
      return counts && shown.length ? [{ counts, shown }] : []
    })
    for (const { counts, shown } of exposed) {
      if (exposed.length > 1) {
        counts.ambiguous.add(signal.sessionID)
        continue
      }
      for (const entry of shown) {
        const at = Date.parse(entry.at)
        const start = Date.parse(signal.turnStartedAt ?? "")
        const correction = Date.parse(signal.at)
        if (!Number.isFinite(at) || !Number.isFinite(start) || !Number.isFinite(correction) || start >= correction || at >= correction)
          counts.unknown.add(signal.sessionID)
        else if (at < start) counts.recurred.add(signal.sessionID)
        else counts.during.add(signal.sessionID)
      }
    }
  }
  return {
    lessons: [...rows.values()].map(({ row, counts }) => {
      for (const field of Object.keys(counts) as (keyof typeof counts)[]) row[field] = counts[field].size
      return row
    }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id) || a.textHash.localeCompare(b.textHash)),
    unmatched_topics: [...unmatched].filter(([, value]) => value.sessions.size >= 2)
      .map(([identifier, value]) => ({ identifier, sessions: value.sessions.size, signal_ids: [...value.signals].sort() }))
      .sort((a, b) => b.sessions - a.sessions || a.identifier.localeCompare(b.identifier)).slice(0, 5),
  }
}

/** With `name`, only that store's lessons and signals are attributed. */
export async function analyzeRecurrence(root: string, options: { limit?: number; name?: string } = {}) {
  const { snapshots, coverage } = await readShownSnapshots(root, options)
  const dir = path.join(root, ".altimate-code", "learn")
  await SafeFS.assertSafePath(root, dir)
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  const lessons: NamedLesson[] = []
  const signals: Signal[] = []
  const sessions = new Set(snapshots.map((snapshot) => snapshot.session))
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    try { validateName(entry.name) } catch { continue }
    if (options.name !== undefined && entry.name !== options.name) continue
    if (sessions.size) signals.push(...(await readSignalsSnapshot(root, entry.name)).filter((signal) => sessions.has(signal.sessionID)))
    const file = Store.paths(root, entry.name).approved
    try {
      await SafeFS.assertSafePath(root, file)
      for (const lesson of parse(await fs.readFile(file, "utf8"))) lessons.push({ name: entry.name, lesson })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn("learn recurrence approved store skipped", { name: entry.name, error })
    }
  }
  return { ...attribute(signals, snapshots, lessons), coverage }
}

export function recurrenceHint(result: Pick<ReturnType<typeof attribute>, "lessons">, name: string, bullet: { id: string; text: string }) {
  const evidence = result.lessons.find((lesson) => lesson.name === name && lesson.id === bullet.id && lesson.textHash === lessonTextHash(bullet.text))
  return evidence && evidence.recurred >= 2 ? evidence.recurred : undefined
}

// Uncorrected lessons are summarized; a store can hold up to 1,000.
const corrected = (lesson: LessonRecurrence) => lesson.recurred + lesson.during + lesson.unknown + lesson.ambiguous > 0

export function formatRecurrence(result: Awaited<ReturnType<typeof analyzeRecurrence>>) {
  return [
    "Recurrence (observed counts need capture on):",
    `  Coverage: ${result.coverage.sessions_analyzed} sessions; ${result.coverage.sessions_skipped_malformed} malformed skipped; truncated: ${result.coverage.truncated ? "yes" : "no"}`,
    ...result.lessons.filter(corrected).map((lesson) => `  ${lesson.name}/${lesson.id}: ${lesson.sessions_shown} sessions shown; ${lesson.recurred ? `${lesson.recurred} matching correction after exposure` : "no observed correction"}; ${lesson.during} during turn; ${lesson.unknown} unknown order; ${lesson.ambiguous} ambiguous; ${lesson.earlier_version} earlier version`),
    `  ${result.lessons.filter((lesson) => !corrected(lesson)).length} other shown lessons: no observed correction`,
    "  Topics with no matching current lesson:",
    ...result.unmatched_topics.map((topic) => `    ${topic.identifier}: ${topic.sessions} sessions (${topic.signal_ids.join(", ")})`),
  ].join("\n")
}
