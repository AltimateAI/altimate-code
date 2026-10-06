// altimate_change - new file
//
// Whole-set local snapshots live under .altimate-code/learn/<name>.
// SKILL.md is only a migration input and an explicit workspace publishing export.
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { createTwoFilesPatch } from "diff"
import * as Playbook from "./playbook"
import * as Lessons from "./lesson"
export type { Lesson, RetiredLesson } from "./lesson"
import { sharedAnchors } from "./anchors"
import { lint, MAX_TEXT, normalizeText, verificationWarning, type Applied, type HarmfulFrom, type Rejected } from "./curator"
import { FEEDBACK_KINDS, type FeedbackKind } from "./reflect"
import { Log } from "@/util/log"
import { assertLearnLock, withLearnLock as transaction } from "./lock"
import type { UsageSummary } from "./usage"
import * as SafeFS from "./safe-fs"

export { transaction }
const log = Log.create({ service: "learn.store" })

export function paths(root: string, name: string) {
  Playbook.validateName(name)
  const learnDir = path.join(root, ".altimate-code", "learn", name)
  const skillDir = path.join(root, ".altimate-code", "skills", name)
  return {
    skillDir,
    skill: path.join(skillDir, "SKILL.md"),
    exportState: path.join(learnDir, "export.json"),
    learnDir,
    approved: path.join(learnDir, "approved.json"),
    usage: path.join(learnDir, "usage.json"),
    candidate: path.join(learnDir, "candidate.json"),
    retired: path.join(learnDir, "retired.json"),
    migration: path.join(learnDir, "migration.json"),
    signals: path.join(learnDir, "signals.jsonl"),
    versions: path.join(learnDir, "versions"),
    history: path.join(learnDir, "history.jsonl"),
    harmful: path.join(learnDir, "harmful.json"),
    pendingReplacements: path.join(learnDir, "pending-replacements.jsonl"),
  }
}

function expectedDirectory(root: string, file: string) {
  const skills = path.join(root, ".altimate-code", "skills")
  const relative = path.relative(skills, file)
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
    ? skills
    : path.join(root, ".altimate-code", "learn")
}

async function read(root: string, file: string): Promise<string | undefined> {
  try {
    const handle = await SafeFS.open(root, file, constants.O_RDONLY, undefined, expectedDirectory(root, file))
    try { return await handle.readFile("utf8") } finally { await handle.close() }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw e
  }
}

/**
 * Where `--feedback` points. For `--feedback -` yargs leaves the option as an empty
 * string and hands the bare `-` over as a positional (a string-typed one coerces it
 * to ""), so stdin is an empty `--feedback` plus such a positional.
 */
export function feedbackSource(feedback: unknown, positionals: readonly unknown[] = []): "stdin" | { file: string } | undefined {
  if (feedback === "-" || (feedback === "" && positionals.some((p) => p === "-" || p === ""))) return "stdin"
  return typeof feedback === "string" && feedback !== "" ? { file: feedback } : undefined
}

/** Why `--feedback -` cannot be read right now, or undefined when it can. A TTY would block forever. */
export function stdinFeedbackProblem(isTTY: boolean | undefined): string | undefined {
  return isTTY
    ? "`--feedback -` reads stdin, but stdin is a terminal. Pipe the feedback in (`ci.log | altimate-code learn reflect ... --feedback -`) or pass a file."
    : undefined
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

/** Short feedback hash: provenance for HARMFUL marks, kept in local state only. */
export const shortHash = (text: string) => sha256(text).slice(0, 8)

/**
 * Identity of one feedback input for the distinct-feedback count: the normalized content (case,
 * whitespace and surrounding blanks do not make feedback "new") together with where it came from
 * (session id or trajectory path), so the same text from another session still counts as another input.
 */
export function feedbackId(feedback: string, origin: string): string {
  const content = feedback.toLowerCase().replace(/\s+/g, " ").trim()
  return shortHash(`${origin}\0${content}`)
}

// Callers hold the learn transaction lock. Rename also protects readers from partial files.
export async function writeAtomic(root: string, file: string, data: string, mode?: number) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  let created = false
  try {
    await assertLearnLock(root)
    const expected = expectedDirectory(root, file)
    await SafeFS.assertSafePath(root, file, expected)
    const handle = await SafeFS.open(root, tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode, expected)
    created = true
    try { await handle.writeFile(data) } finally { await handle.close() }
    await assertLearnLock(root)
    await SafeFS.rename(root, tmp, file, expected)
  } catch (e) {
    if (created) await assertLearnLock(root).then(() => SafeFS.remove(root, tmp, expectedDirectory(root, tmp))).catch(() => {})
    throw e
  }
}

export async function readPromoted(root: string, name: string) {
  await migrate(root, name)
  return read(root, paths(root, name).approved)
}

export async function readCandidate(root: string, name: string) {
  await migrate(root, name)
  return read(root, paths(root, name).candidate)
}

export async function loadApproved(root: string, name: string): Promise<Lessons.Lesson[]> {
  const raw = await readPromoted(root, name)
  return raw === undefined ? [] : Lessons.parse(raw)
}

/** Local counters are independent of reviewed lesson snapshots. */
export async function readUsage(root: string, name: string): Promise<Record<string, number>> {
  const raw = await read(root, paths(root, name).usage)
  if (raw === undefined) return {}
  const usage: Record<string, number> = {}
  let corrupt = false
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) corrupt = true
    else for (const [id, value] of Object.entries(parsed)) {
      if (/^L-[0-9a-f]{4,}$/.test(id) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
        usage[id] = value
      else corrupt = true
    }
  } catch { corrupt = true }
  if (corrupt) log.warn("skipping malformed learn usage records", { name })
  return usage
}

export async function mergeUsage(root: string, name: string, lessons: Lessons.Lesson[]): Promise<Lessons.Lesson[]> {
  const usage = await readUsage(root, name)
  return lessons.map((lesson) => ({ ...lesson, applied: Math.max(lesson.applied, usage[lesson.id] ?? 0) }))
}

export async function loadCandidateLessons(root: string, name: string): Promise<Lessons.Lesson[] | undefined> {
  const raw = await readCandidate(root, name)
  return raw === undefined ? undefined : Lessons.parse(raw)
}

export async function loadRetired(root: string, name: string): Promise<Lessons.RetiredLesson[]> {
  await migrate(root, name)
  const raw = await read(root, paths(root, name).retired)
  if (raw === undefined) return []
  const records: unknown = JSON.parse(raw)
  if (!Array.isArray(records)) throw new StoreError("retired.json must contain an array")
  return records.map((record) => Lessons.RetiredLesson.parse(record))
}

function idDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1]
    for (let j = 0; j < b.length; j++)
      next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(a[i] !== b[j])))
    row = next
  }
  return row[b.length]
}

/** Shared by `learn search` and unknown-id diagnostics; tolerate small ID typos. */
export async function search(root: string, name: string, query: string) {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) throw new StoreError("Search query must contain at least one word.")
  return transaction(root, async () => {
    const approved = await loadApproved(root, name)
    const ids = new Set(approved.map((lesson) => lesson.id))
    const lessons = [
      ...approved.map((lesson) => ({ lesson, state: "approved" as const })),
      ...(await loadRetired(root, name)).filter((lesson) => !ids.has(lesson.id)).map((lesson) => ({ lesson, state: "retired" as const })),
    ]
    const matches = lessons.filter(({ lesson }) => {
      const text = `${lesson.id} ${lesson.text} ${lesson.tags.join(" ")}`.toLowerCase()
      return tokens.every((token) => text.includes(token))
    })
    if (matches.length || tokens.length !== 1 || !/^l-[a-z0-9-]{1,64}$/.test(tokens[0])) return matches
    return lessons.map((match) => ({ match, distance: idDistance(tokens[0], match.lesson.id.toLowerCase()) }))
      .filter(({ distance }) => distance <= 2)
      .sort((a, b) => a.distance - b.distance || a.match.lesson.id.localeCompare(b.match.lesson.id))
      .map(({ match }) => match)
  })
}

/** Pinning is an explicit edit to approved lessons, serialized with reflection and promotion. */
export async function setPinned(root: string, name: string, id: string, pinned: boolean): Promise<Lessons.Lesson> {
  return transaction(root, async () => {
    const approved = await loadApproved(root, name)
    const lesson = approved.find((lesson) => lesson.id === id)
    if (!lesson) {
      const matches = (await search(root, name, id)).slice(0, 5)
      throw new StoreError(`Unknown approved lesson "${id}" in "${name}". ` + (matches.length
        ? `Close matches from \`learn search\`:\n${matches.map(({ lesson, state }) => `  [${lesson.id}] ${state}: ${lesson.text}`).join("\n")}`
        : "No close matches. Use `learn search <query>` to find approved lessons."))
    }
    const candidate = await loadCandidateLessons(root, name)
    const staged = candidate?.find((lesson) => lesson.id === id)
    const updated = new Date().toISOString()
    Object.assign(lesson, { pinned, updated })
    const p = paths(root, name)
    // A person acted on the approved set: no lesson in it is automatic any more (auto-promote.ts).
    await voidAutoOwnership(root, name)
    await writeAtomic(root, p.approved, Lessons.canonical(approved))
    // A candidate already in progress must not undo this pin on the next curation or promotion.
    if (staged) {
      Object.assign(staged, { pinned, updated })
      await writeAtomic(root, p.candidate, Lessons.canonical(candidate))
    }
    await appendHistory(root, name, { action: pinned ? "pin" : "unpin", id })
    return lesson
  })
}

/** Lazy: auto-promote.ts imports this module. */
async function voidAutoOwnership(root: string, name: string) {
  await (await import("./auto-promote")).voidAutoOwnership(root, name)
}

async function reconcileRetired(root: string, name: string) {
  const retired = await loadRetired(root, name)
  if (!retired.length) return
  const approved = new Set((await loadApproved(root, name)).map((lesson) => lesson.id))
  const next = retired.filter((lesson) => !approved.has(lesson.id))
  if (next.length !== retired.length) await writeAtomic(root, paths(root, name).retired, Lessons.canonical(next))
}

export interface SeedOptions {
  applyPaths?: string[]
}

/** The legacy curator sees bullets; snapshots retain the full lesson records. */
export async function loadCandidate(root: string, name: string, opts: SeedOptions = {}): Promise<Playbook.Playbook> {
  const lessons = (await loadCandidateLessons(root, name)) ?? await loadApproved(root, name)
  return Playbook.withBullets(Playbook.create({ name, applyPaths: opts.applyPaths }), lessons.map(Lessons.toBullet))
}

export async function saveCandidate(root: string, name: string, pb: Playbook.Playbook, applied: Applied[] = []) {
  return transaction(root, async () => {
    const p = paths(root, name)
    const previous = (await loadCandidateLessons(root, name)) ?? await loadApproved(root, name)
    const byId = new Map(previous.map((lesson) => [lesson.id, lesson]))
    const ap = /^applyPaths: (\[.*\])$/m.exec(pb.frontmatter)
    const next = Playbook.bullets(pb).map((b) => Lessons.fromBullet(b, byId.get(b.id), ap ? JSON.parse(ap[1]) : undefined))
    const surviving = new Set(next.map((lesson) => lesson.id))
    const removed = previous.filter((lesson) => !surviving.has(lesson.id))
    for (const delta of applied) {
      if (delta.op !== "ADD" || !delta.id || !delta.text || surviving.has(delta.id) || byId.has(delta.id)) continue
      removed.push(Lessons.fromBullet({ id: delta.id, text: delta.text, helpful: 0, harmful: 0 }))
    }
    await assertLearnLock(root)
    await SafeFS.mkdir(root, p.learnDir)
    if (removed.length) {
      const retired = await loadRetired(root, name)
      for (const lesson of removed) {
        const delta = applied.find((entry) => entry.op === "REMOVE" && entry.id === lesson.id)
        const supersededBy = /superseded by (L-[0-9a-f]+)/.exec(delta?.reason ?? "")?.[1]
        const record = { ...Lessons.fromBullet(delta?.removed ?? Lessons.toBullet(lesson), lesson), reason: delta?.reason ?? "removed", ...(supersededBy ? { supersededBy } : {}) }
        const index = retired.findIndex((entry) => entry.id === lesson.id)
        if (index < 0) retired.push(record)
        else retired[index] = record
      }
      await writeAtomic(root, p.retired, Lessons.canonical(retired))
    }
    await writeAtomic(root, p.candidate, Lessons.canonical(next))
  })
}

function skillText(name: string, lessons: Lessons.Lesson[]) {
  const applyPaths = lessons.length && lessons.every((lesson) => lesson.trigger?.paths?.length)
    ? [...new Set(lessons.flatMap((lesson) => lesson.trigger!.paths!))]
    : undefined
  return Playbook.serialize(Playbook.withBullets(Playbook.create({ name, applyPaths }), lessons.map(Lessons.toBullet)))
}

function refuseExport(name: string, directory: string, reason: string) {
  return new StoreError(`Refusing to export "${name}": "${directory}" must be a learn-managed single-file export (${reason}).`)
}

function exportHashes(text: string | undefined): string[] {
  if (text === undefined) return []
  try {
    const hashes: unknown = JSON.parse(text)
    if (Array.isArray(hashes) && hashes.length > 0 && hashes.length <= 2 && hashes.every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) return hashes
  } catch {}
  return []
}

/** Check before loading lessons: legacy migration can also rename malformed SKILL.md files. */
async function existingExport(root: string, name: string): Promise<string | undefined> {
  const p = paths(root, name)
  const refuse = (reason: string) => refuseExport(name, p.skillDir, reason)
  const expected = path.join(root, ".altimate-code", "skills")
  await SafeFS.assertSafePath(root, p.skillDir, expected).catch((error) => {
    if (error instanceof SafeFS.UnsafeLearnPathError) throw refuse(error.message)
    throw error
  })
  const target = await fs.lstat(p.skillDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  if (!target) return undefined
  if (!target.isDirectory()) throw refuse("target is not a regular directory; symlinks are not allowed")
  const entries = await fs.readdir(p.skillDir, { withFileTypes: true })
  // A staging filename alone cannot prove ownership. Preserve extra files, including apparent stale temps.
  const interrupted = !entries.length && exportHashes(await read(root, p.exportState)).length
  if ((entries.length !== 1 || entries[0].name !== "SKILL.md" || !entries[0].isFile()) && !interrupted)
    throw refuse("expected only a regular SKILL.md file, with no extra files, directories, or symlinks")
  if (!entries.length) return undefined
  const existing = (await read(root, p.skill))!
  if (!existing.split(/\r?\n/).includes(Playbook.HEADER) || validateLegacy(name, existing))
    throw refuse("SKILL.md is not an unchanged learn-managed export")
  return existing
}

async function verifyExportHash(root: string, name: string, existing: string) {
  const p = paths(root, name)
  const state = await read(root, p.exportState)
  const hash = sha256(existing)
  if (state !== undefined) {
    if (exportHashes(state).includes(hash)) return
  } else {
    // Older exports have no receipt: accept only an exact generated approved or archived snapshot.
    for (const file of [p.approved, ...(await versionNumbers(root, p.versions)).map((version) => path.join(p.versions, `v${version}.json`))]) {
      const raw = await read(root, file)
      if (raw !== undefined && skillText(name, Lessons.parse(raw)) === existing) return
    }
  }
  throw refuseExport(name, p.skillDir, "SKILL.md is not an unchanged learn-managed export")
}

/** Publish only on demand. Approved local stores replace their exports in auto-loading. */
export async function exportSkill(root: string, name: string): Promise<string> {
  return transaction(root, async () => {
    const p = paths(root, name)
    const existing = await existingExport(root, name)
    const lessons = await loadApproved(root, name)
    if (await read(root, p.approved) === undefined) throw new StoreError(`No approved lessons for "${name}".`)
    if (existing !== undefined) await verifyExportHash(root, name, existing)
    await writeExport(root, name, skillText(name, lessons), existing)
    return p.skill
  })
}

async function writeExport(root: string, name: string, text: string, existing: string | undefined) {
  const p = paths(root, name)
  const hash = sha256(text)
  // Keep both generations until the export is installed so either side of an interrupted rename is retryable.
  await writeAtomic(root, p.exportState, Lessons.canonical(existing === undefined ? [hash] : [...new Set([sha256(existing), hash])]))
  await assertLearnLock(root)
  await SafeFS.mkdir(root, p.skillDir, path.join(root, ".altimate-code", "skills"))
  await writeAtomic(root, p.skill, text)
  await writeAtomic(root, p.exportState, Lessons.canonical([hash]))
}

export interface HistoryEntry {
  ts?: string
  action: "reflect" | "promote" | "auto-promote" | "rollback" | "reject" | "migrated-from" | "pin" | "unpin"
  id?: string
  source?: string
  grandfathered?: Pick<Lessons.Lesson, "id" | "text">[]
  session?: string
  feedbackKind?: string
  feedbackHash?: string
  feedbackFlagged?: boolean
  applied?: Applied[]
  rejected?: Rejected[]
  version?: number
  published?: boolean
  usage?: UsageSummary
  /** auto-promote: ids of the lessons it added or changed, the ones it removed, and the signals behind the reflection. */
  lessons?: string[]
  removed?: string[]
  signals?: number
}

export async function appendHistory(root: string, name: string, entry: HistoryEntry): Promise<HistoryEntry & { ts: string }> {
  return transaction(root, async () => {
    const p = paths(root, name)
    await assertLearnLock(root)
    await SafeFS.mkdir(root, p.learnDir)
    const full = { ts: new Date().toISOString(), ...entry }
    await assertLearnLock(root)
    await writeAtomic(root, p.history, ((await read(root, p.history)) ?? "") + JSON.stringify(full) + "\n", 0o600)
    return full
  })
}

/** Quarantine is actionable even when debug logging is disabled. Never echo malformed content. */
export function quarantineNotice(file: string, backup: string) {
  try { process.stderr.write(`learn: quarantined malformed ${file} as ${backup}; valid records retained where possible.\n`) }
  catch { /* Diagnostics must not interrupt a session. */ }
}

async function quarantine(root: string, file: string, raw: string, repaired: string) {
  // Keep the source in place until the repaired snapshot is atomically installed.
  // A rename-first repair loses all surviving records if that write is interrupted.
  // The content hash lets a retry reuse its durable backup and avoid duplicate warnings.
  await assertLearnLock(root)
  const directory = path.dirname(file)
  const prefix = `${path.basename(file)}.malformed-`
  const hash = sha256(raw)
  const existing = (await fs.readdir(await SafeFS.assertSafePath(root, directory, expectedDirectory(root, directory)))).find((name) => name.startsWith(prefix) && name.endsWith(`-${hash}`))
  if (!existing) {
    const backup = `${file}.malformed-${Date.now()}-${hash}`
    await writeAtomic(root, backup, raw, 0o600)
    quarantineNotice(file, backup)
  }
  await writeAtomic(root, file, repaired)
}

export async function readHarmfulFrom(root: string, name: string): Promise<HarmfulFrom> {
  const file = paths(root, name).harmful
  if ((await read(root, file)) === undefined) return {}
  return transaction(root, async () => {
    const raw = await read(root, file)
    if (raw === undefined) return {}
    const valid: HarmfulFrom = {}
    let corrupt = false
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) corrupt = true
      else for (const [id, value] of Object.entries(parsed)) {
        if (/^L-[0-9a-f]{4,}$/.test(id) && Array.isArray(value) && value.every((v) => typeof v === "string")) valid[id] = value
        else corrupt = true
      }
    } catch { corrupt = true }
    if (corrupt) await quarantine(root, file, raw, JSON.stringify(valid))
    return valid
  })
}

export async function writeHarmfulFrom(root: string, name: string, state: HarmfulFrom) {
  return transaction(root, async () => {
    const p = paths(root, name)
    await assertLearnLock(root)
    await SafeFS.mkdir(root, p.learnDir)
    await writeAtomic(root, p.harmful, JSON.stringify(state))
  })
}

export interface PendingReplacement {
  id: string
  text: string
  reasons: string[]
  feedback: string
  kind: FeedbackKind
  attempts: number
}

export async function readPendingReplacements(root: string, name: string): Promise<PendingReplacement[]> {
  const file = paths(root, name).pendingReplacements
  if ((await read(root, file)) === undefined) return []
  return transaction(root, async () => {
    const raw = await read(root, file)
    if (raw === undefined) return []
    const valid: PendingReplacement[] = []
    let corrupt = false
    for (const line of raw.split("\n").filter((line) => line.trim())) {
      try {
        const record = JSON.parse(line)
        if (!record || typeof record !== "object" || Array.isArray(record) ||
          typeof record.id !== "string" || !/^L-[0-9a-f]{4,}$/.test(record.id) ||
          typeof record.text !== "string" || typeof record.feedback !== "string" ||
          !Array.isArray(record.reasons) || !record.reasons.every((r: unknown) => typeof r === "string") ||
          !FEEDBACK_KINDS.includes(record.kind) || !Number.isSafeInteger(record.attempts) || record.attempts < 0) {
          corrupt = true
          continue
        }
        valid.push(record)
      } catch { corrupt = true }
    }
    if (corrupt) await quarantine(root, file, raw, valid.map((record) => JSON.stringify(record) + "\n").join(""))
    return valid
  })
}

export async function writePendingReplacements(root: string, name: string, records: PendingReplacement[]) {
  return transaction(root, async () => {
    const p = paths(root, name)
    await assertLearnLock(root)
    await SafeFS.mkdir(root, p.learnDir)
    await writeAtomic(root, p.pendingReplacements, records.map((record) => JSON.stringify(record) + "\n").join(""))
  })
}

/** Unified diff promoted -> candidate; empty string when identical. */
export async function diff(root: string, name: string): Promise<string> {
  return (await reviewCandidate(root, name)).diff
}

/** The displayed diff and promotion hash always refer to the same candidate snapshot. */
export async function reviewCandidate(root: string, name: string): Promise<{ diff: string; candidateHash?: string }> {
  return transaction(root, async () => {
    const promoted = (await readPromoted(root, name)) ?? ""
    const candidate = await readCandidate(root, name)
    const canonical = candidate === undefined ? undefined : Lessons.canonical(Lessons.parse(candidate))
    return { diff: candidateDiff(name, promoted ? Lessons.canonical(Lessons.parse(promoted)) : "", canonical), candidateHash: canonical === undefined ? undefined : sha256(canonical) }
  })
}

function candidateDiff(name: string, promoted: string, candidate: string | undefined): string {
  if (candidate === undefined || candidate === promoted) return ""
  const patch = createTwoFilesPatch(`${name}/approved.json`, `${name}/candidate.json`, promoted, candidate, "", "", {
    context: 2,
  })
  const warnings = verificationWarnings(candidate)
  return warnings.length ? `${warnings.join("\n")}\n\n${patch}` : patch
}

/** Recomputed from bullet text, including unchanged bullets outside the diff's context. */
export function verificationWarnings(text: string): string[] {
  return (text.trimStart().startsWith("[") ? Lessons.parse(text) : Playbook.bullets(Playbook.parse(text))).flatMap((bullet) => {
    const warning = verificationWarning(bullet.text)
    return warning ? [`WARNING [${bullet.id}]: ${warning}\n  ${bullet.text}`] : []
  })
}

async function versionNumbers(root: string, dir: string): Promise<number[]> {
  const names = await fs.readdir(await SafeFS.assertSafePath(root, dir)).catch(() => [] as string[])
  return names.flatMap((n) => {
    const m = /^v(\d+)\.json$/.exec(n)
    return m ? [Number(m[1])] : []
  })
}

export interface PromoteOptions {
  allowOverlap?: boolean
  /** The caller obtained interactive confirmation or an explicit --allow-flagged override. */
  allowFlagged?: boolean
  expectedCandidateHash?: string
  grandfathered?: readonly Pick<Lessons.Lesson, "id" | "text">[]
  /** Recorded instead of the plain `promote` entry, in the same transaction. */
  history?: Omit<HistoryEntry, "ts" | "version">
  /**
   * Publish this text instead of the candidate. The candidate must still match `expectedCandidateHash`;
   * the published text gets the same validation and flag checks.
   */
  publish?: string
  /** Leave the candidate staged (it still differs from what was published). */
  keepCandidate?: boolean
  /** Called once the approved set has been replaced, so a caller can tell a later failure from a refusal. */
  onPublished?: () => void
}

/** Re-checks the candidate. It is a plain file a person can edit, and it is about to be published. */
export function validateCandidate(name: string, text: string, opts: PromoteOptions = {}): string | undefined {
  let list: (Playbook.Bullet & Pick<Lessons.Lesson, "trigger">)[]
  try {
    if (text.trimStart().startsWith("[")) list = Lessons.parse(text)
    else {
      const bad = validateLegacy(name, text)
      if (bad) return bad
      list = Playbook.bullets(Playbook.parse(text))
    }
  } catch (error) { return `invalid lesson snapshot: ${error instanceof Error ? error.message : String(error)}` }
  const ids = new Set(list.map((b) => b.id))
  for (const b of list) {
    const bad = lint(b.text, { grandfathered: opts.grandfathered?.some((old) => old.id === b.id && old.text === b.text) }) ?? (normalizeText(b.text) !== b.text ? "contains hidden or non-normalized characters" : undefined)
    if (bad) return `bullet ${b.id} fails lint: ${bad}`
    for (const trigger of b.trigger?.paths ?? []) {
      const bad = lint(trigger) ?? (normalizeText(trigger) !== trigger ? "contains hidden or non-normalized characters" : undefined)
      if (bad) return `bullet ${b.id} path trigger fails lint: ${bad}`
    }
    for (const id of b.coexists ?? []) {
      if (id === b.id) return `bullet ${b.id} cannot declare coexistence with itself`
      if (!ids.has(id)) return `bullet ${b.id} declares coexistence with unknown bullet ${id}`
    }
  }
  if (!opts.allowOverlap) {
    const overlaps: string[] = []
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        if (a.coexists?.includes(b.id) || b.coexists?.includes(a.id)) continue
        const shared = sharedAnchors(a.text, b.text)
        if (shared.length) overlaps.push(`${a.id} overlaps ${b.id} on ${shared.join(", ")}`)
      }
    }
    if (overlaps.length)
      return `${overlaps.join("; ")}: edit the candidate or run \`learn reflect\` to edit, remove, supersede, or declare compatible bullets coexisting`
  }
  return undefined
}

function validateLegacy(name: string, text: string): string | undefined {
  const pb = Playbook.parse(text)
  if (!new RegExp(`^name:\\s*["']?${name}["']?\\s*$`, "m").test(pb.frontmatter))
    return `candidate frontmatter must declare name: ${name}`
  // The frontmatter must be exactly what `Playbook.frontmatter` generates for this name and apply paths,
  // so no extra keys or comment markers ride along into the published skill.
  let applyPaths: string[] | undefined
  const ap = /^applyPaths: (\[.*\])$/m.exec(pb.frontmatter)
  if (ap) {
    try {
      const parsed: unknown = JSON.parse(ap[1])
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) applyPaths = parsed
    } catch {}
    if (!applyPaths) return "candidate frontmatter has an invalid applyPaths"
  }
  if (pb.frontmatter !== Playbook.frontmatter({ name, applyPaths }))
    return "candidate frontmatter was edited by hand; it must match the generated frontmatter"
  if (pb.duplicateIds.length) return `candidate repeats bullet id ${pb.duplicateIds.join(", ")}`
  // Only the managed header, blank lines and well-formed bullets may appear in the body.
  for (const item of pb.items) {
    if (item.kind === "raw" && item.line !== "" && item.line !== Playbook.HEADER)
      return `candidate has an unmanaged line: "${item.line.slice(0, 60)}"`
  }
  if (Playbook.bullets(pb).some((bullet) => !Number.isSafeInteger(bullet.helpful) || !Number.isSafeInteger(bullet.harmful)))
    return "candidate counters must be safe integers"
  return undefined
}

export class StoreError extends Error {}

export async function promote(root: string, name: string, opts: PromoteOptions = {}): Promise<{ archived?: number }> {
  return transaction(root, async () => {
    const p = paths(root, name)
    const candidate = await readCandidate(root, name)
    if (candidate === undefined) throw new StoreError(`No candidate for "${name}". Run \`learn reflect\` first.`)
    if (opts.expectedCandidateHash !== undefined && sha256(Lessons.canonical(Lessons.parse(candidate))) !== opts.expectedCandidateHash)
      throw new StoreError("Candidate changed since the displayed diff; re-run `learn promote` to review it again.")
    const source = opts.publish ?? candidate
    const bad = validateCandidate(name, source, { ...opts, grandfathered: await grandfathered(root, name) })
    if (bad) throw new StoreError(`Refusing to promote: ${bad}`)
    const warnings = verificationWarnings(source)
    if (warnings.length && !opts.allowFlagged)
      throw new StoreError(
        `Refusing to promote flagged lessons without explicit approval:\n${warnings.join("\n")}\n` +
        "Review with `learn promote` interactively, or pass `--yes --allow-flagged` to approve them.",
      )
    // Publish the canonical serialization of what was validated (LF endings), not the raw file.
    const publish = Lessons.canonical(Lessons.parse(source))
    const current = await readPromoted(root, name)
    if (current !== undefined && Lessons.canonical(Lessons.parse(current)) === publish)
      throw new StoreError(`Candidate is identical to the approved lessons; nothing to promote.`)
    // A person's promote ends automatic ownership before anything is written; auto-promote's own publish does not.
    if (opts.history?.action !== "auto-promote") await voidAutoOwnership(root, name)
    let archived: number | undefined
    if (current !== undefined) {
      // A staged candidate can carry older counters. Keep the approved baseline locally before replacing it.
      const usage = await readUsage(root, name)
      for (const lesson of Lessons.parse(current)) usage[lesson.id] = Math.max(lesson.applied, usage[lesson.id] ?? 0)
      await writeAtomic(root, p.usage, Lessons.canonical(usage))
      await assertLearnLock(root)
      await SafeFS.mkdir(root, p.versions)
      archived = Math.max(0, ...(await versionNumbers(root, p.versions))) + 1
      await writeAtomic(root, path.join(p.versions, `v${archived}.json`), current)
    }
    await assertLearnLock(root)
    await SafeFS.mkdir(root, p.learnDir)
    await writeAtomic(root, p.approved, publish)
    opts.onPublished?.()
    // The candidate is consumed: left in place it would read as a pending edit and a later `rollback` +
    // `promote` would silently re-publish it. `keepCandidate` is for a partial publish (auto-promote keeps
    // counter updates staged), where the remaining difference still needs review.
    if (!opts.keepCandidate) {
      await assertLearnLock(root)
      await SafeFS.remove(root, p.candidate)
    }
    await reconcileRetired(root, name)
    await appendHistory(root, name, { ...(opts.history ?? { action: "promote" }), version: archived })
    return { archived }
  })
}

/** Restores the most recently archived version and consumes it. */
export async function rollback(root: string, name: string): Promise<{ restored: number }> {
  return transaction(root, async () => {
    const p = paths(root, name)
    await migrate(root, name)
    const latest = Math.max(0, ...(await versionNumbers(root, p.versions)))
    if (latest === 0) throw new StoreError(`No archived version of "${name}" to roll back to.`)
    const file = path.join(p.versions, `v${latest}.json`)
    const restored = Lessons.parse((await read(root, file))!)
    const skill = await read(root, p.skill)
    let existing: string | undefined
    if (skill !== undefined) {
      try {
        existing = await existingExport(root, name)
        if (existing !== undefined) await verifyExportHash(root, name, existing)
      } catch (error) {
        if (!(error instanceof StoreError)) throw error
        existing = undefined
        try { process.stderr.write(`learn: left ${p.skill} unchanged; the export needs separate reconciliation. Restoring local approved lessons.\n`) }
        catch { /* Diagnostics must not interrupt the local rollback. */ }
      }
    }
    // Rolling back is a person's choice of lessons: none of the restored set is automatic.
    await voidAutoOwnership(root, name)
    if (existing !== undefined) {
      // Preserve the verified baseline before replacing approved.json, including exports predating receipts.
      await writeAtomic(root, p.exportState, Lessons.canonical([sha256(existing)]))
    }
    await writeAtomic(root, p.approved, Lessons.canonical(restored))
    if (existing !== undefined) await writeExport(root, name, skillText(name, restored), existing)
    await assertLearnLock(root)
    await SafeFS.remove(root, file)
    // The staged candidate was built on the version just rolled back; it would resurrect it on `promote`.
    await assertLearnLock(root)
    await SafeFS.remove(root, p.candidate)
    await assertLearnLock(root)
    await SafeFS.remove(root, p.harmful)
    await assertLearnLock(root)
    await SafeFS.remove(root, p.pendingReplacements)
    await reconcileRetired(root, name)
    await appendHistory(root, name, { action: "rollback", version: latest })
    return { restored: latest }
  })
}

export async function reject(root: string, name: string): Promise<boolean> {
  return transaction(root, async () => {
    const p = paths(root, name)
    const hasCandidate = (await readCandidate(root, name)) !== undefined
    await assertLearnLock(root)
    await SafeFS.remove(root, p.candidate)
    await assertLearnLock(root)
    await SafeFS.remove(root, p.harmful)
    await assertLearnLock(root)
    await SafeFS.remove(root, p.pendingReplacements)
    await reconcileRetired(root, name)
    if (!hasCandidate) return false
    await appendHistory(root, name, { action: "reject" })
    return true
  })
}

interface Migration {
  source: string
  complete: boolean
  imports: { file: string; lessons: Lessons.Lesson[] }[]
  malformed?: { file: string; reason: string }[]
}

function parseMigration(text: string, p: ReturnType<typeof paths>): Migration {
  const value = JSON.parse(text)
  if (!value || typeof value !== "object" || Array.isArray(value) || value.source !== p.skill ||
    typeof value.complete !== "boolean" || !Array.isArray(value.imports) ||
    (value.malformed !== undefined && !Array.isArray(value.malformed)))
    throw new Error("Invalid migration journal")
  const version = (file: unknown, extension: string) => typeof file === "string" &&
    path.dirname(file) === p.versions && new RegExp(`^v\\d+\\.${extension}$`).test(path.basename(file))
  const targets = new Set<string>()
  const imports = value.imports.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("file" in entry) || !("lessons" in entry) ||
      typeof entry.file !== "string" ||
      (entry.file !== p.approved && entry.file !== p.candidate && !version(entry.file, "json")) ||
      targets.has(entry.file))
      throw new Error("Invalid migration import target")
    targets.add(entry.file)
    return { file: entry.file, lessons: Lessons.parse(Lessons.canonical(entry.lessons)) }
  })
  const malformed = (value.malformed ?? []).map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("file" in entry) || !("reason" in entry) ||
      typeof entry.file !== "string" || typeof entry.reason !== "string" ||
      (entry.file !== p.skill && entry.file !== path.join(p.learnDir, "candidate.md") && !version(entry.file, "md")))
      throw new Error("Invalid migration quarantine target")
    return { file: entry.file, reason: entry.reason }
  })
  return { source: value.source, complete: value.complete, imports, malformed }
}

async function hasLegacyFiles(root: string, p: ReturnType<typeof paths>): Promise<boolean> {
  const skill = await read(root, p.skill)
  return !!skill?.split(/\r?\n/).includes(Playbook.HEADER) ||
    await read(root, path.join(p.learnDir, "candidate.md")) !== undefined ||
    (await fs.readdir(await SafeFS.assertSafePath(root, p.versions)).catch(() => [] as string[])).some((file) => /^v\d+\.md$/.test(file))
}

/** A persisted import plan makes every rename/write boundary safe to retry after a crash. */
export async function migrate(root: string, name: string): Promise<void> {
  try {
    const p = paths(root, name)
    if (name === Playbook.DEFAULT_NAME && await read(root, path.join(root, ".altimate-code", "learn", "signals.jsonl")) !== undefined)
      await (await import("./signals")).migrateSignals(root, name)
    // A read of an unused store must not create files or acquire a filesystem lock.
    if (await read(root, p.migration) === undefined) {
      if (await read(root, p.approved) !== undefined || await read(root, p.candidate) !== undefined) return
      if (!await hasLegacyFiles(root, p)) return
    }
    await transaction(root, async () => {
      const journal = await read(root, p.migration)
      let migration: Migration | undefined
      if (journal !== undefined) {
        try { migration = parseMigration(journal, p) } catch {}
        if (migration?.complete) return
      }
      if (!migration) {
        // History survives promotion/rejection and prevents an invalid journal from
        // resurrecting legacy candidates or versions already consumed after migration.
        const completed = ((await read(root, p.history)) ?? "").split("\n").some((line) => {
          try {
            const entry = JSON.parse(line)
            return entry?.action === "migrated-from" && entry.source === p.skill
          } catch { return false }
        })
        if (completed) {
          const repaired = Lessons.canonical({ source: p.skill, complete: true, imports: [], malformed: [] })
          if (journal !== undefined) await quarantine(root, p.migration, journal, repaired)
          else await writeAtomic(root, p.migration, repaired)
          return
        }
        if (journal === undefined && (await read(root, p.approved) !== undefined || await read(root, p.candidate) !== undefined)) return
        if (journal === undefined && !await hasLegacyFiles(root, p)) return
        await assertLearnLock(root)
        await SafeFS.mkdir(root, p.learnDir)
        const files = [
          { source: p.skill, file: p.approved },
          { source: path.join(p.learnDir, "candidate.md"), file: p.candidate },
          ...(await fs.readdir(await SafeFS.assertSafePath(root, p.versions)).catch(() => [] as string[]))
            .filter((file) => /^v\d+\.md$/.test(file))
            .sort()
            .map((file) => ({ source: path.join(p.versions, file), file: path.join(p.versions, file.replace(/\.md$/, ".json")) })),
        ]
        migration = { source: p.skill, complete: false, imports: [], malformed: [] }
        for (const entry of files) {
          const raw = await read(root, entry.source)
          if (raw === undefined) continue
          if (entry.source === p.skill && !raw.split(/\r?\n/).includes(Playbook.HEADER)) continue
          const bad = validateLegacy(name, raw)
          if (bad) {
            migration.malformed!.push({ file: entry.source, reason: bad })
            // An invalid live set becomes an empty set; other malformed inputs remain absent.
            if (entry.file === p.approved) migration.imports.push({ file: entry.file, lessons: [] })
            continue
          }
          const pb = Playbook.parse(raw)
          const ap = /^applyPaths: (\[.*\])$/m.exec(pb.frontmatter)
          const timestamp = (await fs.stat(entry.source)).mtime.toISOString()
          migration.imports.push({
            file: entry.file,
            lessons: Playbook.bullets(pb).map((b) => Lessons.fromBullet(b, undefined, ap ? JSON.parse(ap[1]) : undefined, timestamp)),
          })
        }
        // Persist the reconstructed plan before renaming any legacy source. The
        // quarantine helper keeps the corrupt journal recoverable until this write succeeds.
        if (journal !== undefined) await quarantine(root, p.migration, journal, Lessons.canonical(migration))
        else await writeAtomic(root, p.migration, Lessons.canonical(migration))
      }
      for (const entry of migration.malformed ?? []) {
        if (await read(root, entry.file) === undefined) continue
        const backup = `${entry.file}.malformed-${Date.now()}-${randomUUID()}`
        await assertLearnLock(root)
        await SafeFS.rename(root, entry.file, backup, expectedDirectory(root, entry.file))
        quarantineNotice(entry.file, backup)
      }
      for (const entry of migration.imports) {
        if (await read(root, entry.file) !== undefined) continue
        await assertLearnLock(root)
        await SafeFS.mkdir(root, path.dirname(entry.file))
        await writeAtomic(root, entry.file, Lessons.canonical(entry.lessons))
      }
      // Local sidecars stay in place. Their existing repair routines preserve good records.
      await readHarmfulFrom(root, name)
      await readPendingReplacements(root, name)
      const rawHistory = await read(root, p.history)
      const history: HistoryEntry[] = []
      let malformed = false
      for (const line of (rawHistory ?? "").split("\n").filter((line) => line.trim())) {
        try {
          const entry = JSON.parse(line)
          if (!entry || typeof entry !== "object" || typeof entry.action !== "string") malformed = true
          else history.push(entry)
        } catch { malformed = true }
      }
      if (malformed) await quarantine(root, p.history, rawHistory!, history.map((entry) => JSON.stringify(entry) + "\n").join(""))
      if (!history.some((entry) => entry.action === "migrated-from" && entry.source === migration.source))
        await appendHistory(root, name, {
          action: "migrated-from", source: migration.source,
          grandfathered: migration.imports.flatMap((entry) => entry.lessons)
            .filter((lesson) => lesson.text.length > MAX_TEXT).map(({ id, text }) => ({ id, text })),
        })
      await writeAtomic(root, p.migration, Lessons.canonical({ ...migration, complete: true, imports: [], malformed: [] }))
    })
  } catch (error) {
    if (error instanceof SafeFS.UnsafeLearnPathError) throw error
    // Learning must never take down the user's session. The journal resumes on the next use.
    log.warn("learn migration interrupted; will retry on next use", { name, error: String(error) })
  }
}

/** Only unchanged text from previously approved/imported lessons gets the legacy length allowance. */
export async function grandfathered(root: string, name: string, options: { migrate?: boolean } = {}): Promise<Pick<Lessons.Lesson, "id" | "text">[]> {
  if (options.migrate !== false) await migrate(root, name)
  const p = paths(root, name)
  const approved = await read(root, p.approved)
  const trusted = approved === undefined ? [] : Lessons.parse(approved)
  for (const version of await versionNumbers(root, p.versions)) {
    const raw = await read(root, path.join(p.versions, `v${version}.json`))
    if (raw !== undefined) trusted.push(...Lessons.parse(raw))
  }
  const imported = ((await read(root, p.history)) ?? "").split("\n").flatMap((line) => {
    try {
      const entry: HistoryEntry = JSON.parse(line)
      if (entry?.action !== "migrated-from" || !Array.isArray(entry.grandfathered)) return []
      return entry.grandfathered.filter((lesson): lesson is Pick<Lessons.Lesson, "id" | "text"> =>
        typeof lesson?.id === "string" && typeof lesson?.text === "string")
    } catch { return [] }
  })
  return [...trusted, ...imported].filter((lesson) => lesson.text.length > MAX_TEXT)
}
