// altimate_change - new file
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { correctedTurnStart } from "../../../src/altimate/learn/capture"
import { attribute, analyzeRecurrence, formatRecurrence, recurrenceHint, type NamedLesson } from "../../../src/altimate/learn/recurrence"
import { lessonTextHash, readShownSnapshots, type ShownSnapshot } from "../../../src/altimate/learn/delivery"
import type { Signal } from "../../../src/altimate/learn/signals"
import * as Store from "../../../src/altimate/learn/store"

const time = (n: number) => new Date(n * 1000).toISOString()
const lesson: NamedLesson = { name: "team-playbook", lesson: { id: "L-0001", text: "Convert `event_at` timestamps with `to_utc` before storage." } }
const signal = (sessionID = "s1", extra: Partial<Signal> = {}): Signal => ({
  id: `sig_${sessionID}`, kind: "user_correction", sessionID, text: "No, convert event_at timestamps with to_utc.",
  reason: "correction", at: time(5), turnStartedAt: time(2), status: "open", ...extra,
})
const snapshot = (session = "s1", extra: Partial<ShownSnapshot["shown"][number]> = {}): ShownSnapshot => ({
  session, shown: [{ name: lesson.name, id: lesson.lesson.id, textHash: lessonTextHash(lesson.lesson.text), tier: "core", at: time(1), ...extra }],
})
const run = (signals = [signal()], snapshots = [snapshot()], lessons = [lesson]) => attribute(signals, snapshots, lessons)

describe("recurrence attribution", () => {
  test("matching correction after exposure counts, regardless of consumption", () => {
    expect(run().lessons[0]).toMatchObject({ sessions_shown: 1, recurred: 1, unknown: 0 })
    expect(run([signal("s1", { status: "consumed", consumedBy: "reflect" })]).lessons[0].recurred).toBe(1)
    expect(run([signal("s1", { kind: "review" })]).lessons[0].recurred).toBe(0)
  })

  test("mid-turn file exposure, including equality, is during rather than recurrence", () => {
    for (const at of [time(2), time(3)]) {
      expect(run([signal()], [snapshot("s1", { at, tier: "file" })]).lessons[0]).toMatchObject({ recurred: 0, during: 1 })
    }
  })

  test("tool step then file lesson then final assistant resolves to during", () => {
    const history = [
      { id: "user", sessionID: "s1", role: "user", time: { created: 1000 } },
      { id: "tool-step", sessionID: "s1", role: "assistant", time: { created: 2000, completed: 2500 } },
      { id: "final", sessionID: "s1", role: "assistant", time: { created: 4000, completed: 4500 } },
      { id: "correction", sessionID: "s1", role: "user", time: { created: 5000 } },
    ]
    const turnStartedAt = new Date(correctedTurnStart(history, "correction")!).toISOString()
    expect(run([signal("s1", { turnStartedAt })], [snapshot("s1", { tier: "file", at: time(3) })]).lessons[0])
      .toMatchObject({ recurred: 0, during: 1 })
  })

  test("missing, invalid and impossible ordering stays unknown", () => {
    for (const turnStartedAt of [undefined, "bad", time(6)])
      expect(run([signal("s1", { turnStartedAt })]).lessons[0]).toMatchObject({ recurred: 0, unknown: 1 })
    expect(run([signal()], [snapshot("s1", { at: time(5) })]).lessons[0]).toMatchObject({ recurred: 0, unknown: 1 })
  })

  test("a new convention or a shared identifier about a different property does not match", () => {
    for (const text of ["No, pin dependency versions.", "No, index `event_at`", "No, index `other_event_at`", "No, index `to_utc`"]) {
      expect(run([signal("s1", { text })]).lessons[0].recurred).toBe(0)
    }
    const affix = { ...lesson, lesson: { ...lesson.lesson, text: "Convert `*_at` timestamps with `to_utc`" } }
    expect(run([signal("s1", { text: "No, index `event_at`" })], [snapshot()], [affix]).lessons[0].recurred).toBe(0)
    expect(run([signal("s1", { text: "No, timestamps `event_at`" })], [snapshot()], [affix]).lessons[0].recurred).toBe(0)
    const prefix = { ...lesson, lesson: { ...lesson.lesson, text: "Name `stg_` models after their source" } }
    expect(run([signal("s1", { text: "No, rename stg_orders models" })], [snapshot()], [prefix]).lessons[0].recurred).toBe(0)
  })

  test("full anchor needs another content token; backticks on correction are optional", () => {
    expect(run([signal("s1", { text: "No, event_at timestamps" })]).lessons[0].recurred).toBe(1)
    expect(run([signal("s1", { text: "No, event_at" })]).lessons[0].recurred).toBe(0)
  })

  test("lexical fallback requires three distinct tokens and sixty percent", () => {
    const prose = { ...lesson, lesson: { ...lesson.lesson, text: "Preserve original timezone during timestamp conversion" } }
    const shown = snapshot("s1", { textHash: lessonTextHash(prose.lesson.text) })
    expect(run([signal("s1", { text: "No, preserve original timezone during conversion" })], [shown], [prose]).lessons[0].recurred).toBe(1)
    expect(run([signal("s1", { text: "No, timezone timezone conversion" })], [shown], [prose]).lessons[0].recurred).toBe(0)
    expect(run([signal("s1", { text: "No, original timezone conversion" })], [shown], [prose]).lessons[0].recurred).toBe(0)
  })

  test("multiple matching lessons are ambiguous, including same ids in different stores", () => {
    const other = { ...lesson, name: "other-store" }
    const shown = snapshot()
    shown.shown.push({ ...shown.shown[0], name: other.name })
    const result = run([signal()], [shown], [lesson, other])
    expect(result.lessons).toHaveLength(2)
    for (const row of result.lessons) expect(row).toMatchObject({ recurred: 0, ambiguous: 1 })
  })

  test("store-local ids retain independent evidence", () => {
    const other = { name: "other-store", lesson: { id: lesson.lesson.id, text: "Index `customer_id` for efficient lookups." } }
    const shown = snapshot()
    shown.shown.push({ ...shown.shown[0], name: other.name, textHash: lessonTextHash(other.lesson.text) })
    const result = run([signal()], [shown], [lesson, other])
    expect(result.lessons.find((row) => row.name === lesson.name)?.recurred).toBe(1)
    expect(result.lessons.find((row) => row.name === other.name)?.recurred).toBe(0)
  })

  test("an earlier version shown with another matching lesson is not ambiguity evidence", () => {
    const other = { ...lesson, name: "other-store" }
    const shown = snapshot("s1", { textHash: lessonTextHash("Earlier text") })
    shown.shown.push({ ...snapshot().shown[0], name: other.name })
    const result = run([signal()], [shown], [lesson, other])
    expect(result.lessons.find((row) => row.name === lesson.name)).toMatchObject({ ambiguous: 0, earlier_version: 1 })
    expect(result.lessons.find((row) => row.name === other.name)).toMatchObject({ ambiguous: 1 })
  })

  test("earlier lesson version cannot supply current evidence", () => {
    expect(run([signal()], [snapshot("s1", { textHash: lessonTextHash("Earlier text") })]).lessons[0])
      .toMatchObject({ earlier_version: 1, recurred: 0 })
  })

  test("sessions count once; hints require two sessions and the bullet's own normalized text", () => {
    const result = run([signal(), signal("s1", { id: "second" }), signal("s2")], [snapshot(), snapshot("s2")])
    expect(result.lessons[0].recurred).toBe(2)
    expect(recurrenceHint(result, lesson.name, lesson.lesson)).toBe(2)
    expect(recurrenceHint(result, lesson.name, { ...lesson.lesson, text: "Edited candidate" })).toBeUndefined()
    expect(recurrenceHint(result, "another-store", lesson.lesson)).toBeUndefined()
    expect(recurrenceHint(result, lesson.name, { ...lesson.lesson, text: "  " + lesson.lesson.text.replaceAll(" ", "\n  ") })).toBe(2)
    expect(recurrenceHint(run(), lesson.name, lesson.lesson)).toBeUndefined()
    expect(run([signal(), signal("s1", { id: "second" })]).lessons[0].recurred).toBe(1)
  })

  test("unmatched topics need distinct analyzed sessions and expose no correction text", () => {
    const text = "No, index `customer_id` and `_is_deleted` immediately, private discussion."
    const result = run([signal("s1", { text }), signal("s2", { text }), signal("outside", { text })], [snapshot(), snapshot("s2")])
    expect(result.unmatched_topics).toEqual(["_is_deleted", "customer_id"].map((identifier) => ({ identifier, sessions: 2, signal_ids: ["sig_s1", "sig_s2"] })))
    expect(run([signal("s1", { text }), signal("s1", { id: "duplicate", text })]).unmatched_topics).toEqual([])
    expect(JSON.stringify(result)).not.toContain("private discussion")
  })

  test("unmatched topics are capped at five with deterministic ties", () => {
    const text = "No, a_id b_id c_id d_id e_id f_id"
    expect(run([signal("s1", { text }), signal("s2", { text })], [snapshot(), snapshot("s2")]).unmatched_topics.map((topic) => topic.identifier))
      .toEqual(["a_id", "b_id", "c_id", "d_id", "e_id"])
  })

  test("human status lists corrected lessons and summarizes the rest", () => {
    const quiet: NamedLesson = { name: "team-playbook", lesson: { id: "L-0002", text: "Name staging models `stg_<source>__<entity>`." } }
    const shown = snapshot()
    shown.shown.push({ name: quiet.name, id: quiet.lesson.id, textHash: lessonTextHash(quiet.lesson.text), tier: "core", at: time(1) })
    const text = formatRecurrence({ ...run([signal()], [shown], [lesson, quiet]), coverage: { sessions_analyzed: 1, sessions_skipped_malformed: 0, truncated: false } })
    expect(text).toContain("team-playbook/L-0001: 1 sessions shown; 1 matching correction after exposure")
    expect(text).not.toContain("L-0002")
    expect(text).toContain("1 other shown lessons: no observed correction")
  })

  test("human status reports coverage, uncertainty and no matching current lesson", () => {
    const text = formatRecurrence({ ...run([]), coverage: { sessions_analyzed: 1, sessions_skipped_malformed: 0, truncated: false } })
    expect(text).toContain("Recurrence")
    expect(text).toContain("no observed correction")
    expect(text).toContain("counts need capture on")
    expect(text).toContain("no matching current lesson")
    expect(text).not.toContain("followed")
  })
})

test("snapshot analysis is bounded, skips malformed files and never repairs any input", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-recurrence-"))
  try {
    const dir = path.join(root, ".altimate-code", "learn", ".sessions")
    await fs.mkdir(dir, { recursive: true })
    const state = (session: string) => ({ version: 1, session, firstMessage: "m1", section: "", shown: [{
      name: lesson.name, lesson: { ...lesson.lesson, tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0, created: time(0), updated: time(0) },
      tier: "file", at: time(1), queryHash: "hash",
    }], requests: [], compactions: [], counted: [] })
    const old = path.join(dir, "old.json")
    const good = path.join(dir, "good.json")
    const bad = path.join(dir, "bad.json")
    await fs.writeFile(old, JSON.stringify(state("old")))
    await fs.writeFile(good, JSON.stringify(state("s1")))
    await fs.writeFile(bad, "broken")
    await fs.utimes(old, 1, 1)
    await fs.utimes(good, 2, 2)
    await fs.utimes(bad, 3, 3)
    const p = Store.paths(root, lesson.name)
    await fs.mkdir(p.learnDir, { recursive: true })
    await fs.writeFile(p.approved, JSON.stringify([state("s1").shown[0].lesson]))
    const signals = path.join(p.learnDir, "signals.jsonl")
    const raw = JSON.stringify(signal()) + "\nmalformed\n" + JSON.stringify(signal("old")) + "\n"
    await fs.writeFile(signals, raw)
    const result = await analyzeRecurrence(root, { limit: 2 })
    expect(result.coverage).toEqual({ sessions_analyzed: 1, sessions_skipped_malformed: 1, truncated: true })
    expect(result.lessons[0]).toMatchObject({ sessions_shown: 1, recurred: 1 })
    expect(await fs.readFile(bad, "utf8")).toBe("broken")
    expect(await fs.readFile(signals, "utf8")).toBe(raw)
    expect((await fs.readdir(p.learnDir)).sort()).toEqual([path.basename(p.approved), "signals.jsonl"].sort())
    expect((await readShownSnapshots(root, { limit: 0 })).coverage).toMatchObject({ sessions_analyzed: 0, truncated: true })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
