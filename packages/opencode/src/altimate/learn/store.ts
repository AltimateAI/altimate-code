// altimate_change - new file
//
// Whole-set local snapshots live under .altimate-code/learn/<name>.
// SKILL.md is only a migration input and an explicit workspace publishing export.
import { createHash, randomUUID } from "node:crypto"
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

export { transaction }
const log = Log.create({ service: "learn.store" })

export function paths(root: string, name: string) {
  Playbook.validateName(name)
  const learnDir = path.join(root, ".altimate-code", "learn", name)
  const skillDir = path.join(root, ".altimate-code", "skills", name)
  return {
    skillDir,
    skill: path.join(skillDir, "SKILL.md"),
    learnDir,
    approved: path.join(learnDir, "approved.json"),
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

async function read(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8")
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
  try {
    await assertLearnLock(root)
    await fs.writeFile(tmp, data, { mode })
    await assertLearnLock(root)
    await fs.rename(tmp, file)
  } catch (e) {
    await assertLearnLock(root).then(() => fs.rm(tmp, { force: true })).catch(() => {})
    throw e
  }
}

export async function readPromoted(root: string, name: string) {
  await migrate(root, name)
  return read(paths(root, name).approved)
}

export async function readCandidate(root: string, name: string) {
  await migrate(root, name)
  return read(paths(root, name).candidate)
}

export async function loadApproved(root: string, name: string): Promise<Lessons.Lesson[]> {
  const raw = await readPromoted(root, name)
  return raw === undefined ? [] : Lessons.parse(raw)
}

export async function loadCandidateLessons(root: string, name: string): Promise<Lessons.Lesson[] | undefined> {
  const raw = await readCandidate(root, name)
  return raw === undefined ? undefined : Lessons.parse(raw)
}

export async function loadRetired(root: string, name: string): Promise<Lessons.RetiredLesson[]> {
  await migrate(root, name)
  const raw = await read(paths(root, name).retired)
  if (raw === undefined) return []
  const records: unknown = JSON.parse(raw)
  if (!Array.isArray(records)) throw new StoreError("retired.json must contain an array")
  return records.map((record) => Lessons.RetiredLesson.parse(record))
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
    await fs.mkdir(p.learnDir, { recursive: true })
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

/** Publish only on demand. Managed exports remain excluded from local auto-loading. */
export async function exportSkill(root: string, name: string): Promise<string> {
  return transaction(root, async () => {
    const lessons = await loadApproved(root, name)
    const p = paths(root, name)
    if (await read(p.approved) === undefined) throw new StoreError(`No approved lessons for "${name}".`)
    const applyPaths = lessons.length && lessons.every((lesson) => lesson.trigger?.paths?.length)
      ? [...new Set(lessons.flatMap((lesson) => lesson.trigger!.paths!))]
      : undefined
    const pb = Playbook.withBullets(Playbook.create({ name, applyPaths }), lessons.map(Lessons.toBullet))
    await assertLearnLock(root)
    await fs.mkdir(p.skillDir, { recursive: true })
    await writeAtomic(root, p.skill, Playbook.serialize(pb))
    return p.skill
  })
}

export interface HistoryEntry {
  ts?: string
  action: "reflect" | "promote" | "rollback" | "reject" | "migrated-from"
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
}

export async function appendHistory(root: string, name: string, entry: HistoryEntry): Promise<HistoryEntry & { ts: string }> {
  return transaction(root, async () => {
    const p = paths(root, name)
    await assertLearnLock(root)
    await fs.mkdir(p.learnDir, { recursive: true })
    const full = { ts: new Date().toISOString(), ...entry }
    await assertLearnLock(root)
    await writeAtomic(root, p.history, ((await read(p.history)) ?? "") + JSON.stringify(full) + "\n")
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
  const existing = (await fs.readdir(directory)).find((name) => name.startsWith(prefix) && name.endsWith(`-${hash}`))
  if (!existing) {
    const backup = `${file}.malformed-${Date.now()}-${hash}`
    await writeAtomic(root, backup, raw, 0o600)
    quarantineNotice(file, backup)
  }
  await writeAtomic(root, file, repaired)
}

export async function readHarmfulFrom(root: string, name: string): Promise<HarmfulFrom> {
  const file = paths(root, name).harmful
  if ((await read(file)) === undefined) return {}
  return transaction(root, async () => {
    const raw = await read(file)
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
    await fs.mkdir(p.learnDir, { recursive: true })
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
  if ((await read(file)) === undefined) return []
  return transaction(root, async () => {
    const raw = await read(file)
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
    await fs.mkdir(p.learnDir, { recursive: true })
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

async function versionNumbers(dir: string): Promise<number[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
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
}

/** Re-checks the candidate. It is a plain file a person can edit, and it is about to be published. */
export function validateCandidate(name: string, text: string, opts: PromoteOptions = {}): string | undefined {
  let list: Playbook.Bullet[]
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
    const bad = validateCandidate(name, candidate, { ...opts, grandfathered: await grandfathered(root, name) })
    if (bad) throw new StoreError(`Refusing to promote: ${bad}`)
    const warnings = verificationWarnings(candidate)
    if (warnings.length && !opts.allowFlagged)
      throw new StoreError(
        `Refusing to promote flagged lessons without explicit approval:\n${warnings.join("\n")}\n` +
        "Review with `learn promote` interactively, or pass `--yes --allow-flagged` to approve them.",
      )
    // Publish the canonical serialization of what was validated (LF endings), not the raw file.
    const publish = Lessons.canonical(Lessons.parse(candidate))
    const current = await readPromoted(root, name)
    if (current !== undefined && Lessons.canonical(Lessons.parse(current)) === publish)
      throw new StoreError(`Candidate is identical to the approved lessons; nothing to promote.`)
    let archived: number | undefined
    if (current !== undefined) {
      await assertLearnLock(root)
      await fs.mkdir(p.versions, { recursive: true })
      archived = Math.max(0, ...(await versionNumbers(p.versions))) + 1
      await writeAtomic(root, path.join(p.versions, `v${archived}.json`), current)
    }
    await assertLearnLock(root)
    await fs.mkdir(p.learnDir, { recursive: true })
    await writeAtomic(root, p.approved, publish)
    // The candidate is consumed: left in place it would read as a pending edit and a later `rollback` +
    // `promote` would silently re-publish it.
    await assertLearnLock(root)
    await fs.rm(p.candidate, { force: true })
    await reconcileRetired(root, name)
    await appendHistory(root, name, { action: "promote", version: archived })
    return { archived }
  })
}

/** Restores the most recently archived version and consumes it. */
export async function rollback(root: string, name: string): Promise<{ restored: number }> {
  return transaction(root, async () => {
    const p = paths(root, name)
    await migrate(root, name)
    const latest = Math.max(0, ...(await versionNumbers(p.versions)))
    if (latest === 0) throw new StoreError(`No archived version of "${name}" to roll back to.`)
    const file = path.join(p.versions, `v${latest}.json`)
    await writeAtomic(root, p.approved, Lessons.canonical(Lessons.parse(await fs.readFile(file, "utf8"))))
    await assertLearnLock(root)
    await fs.rm(file)
    // The staged candidate was built on the version just rolled back; it would resurrect it on `promote`.
    await assertLearnLock(root)
    await fs.rm(p.candidate, { force: true })
    await assertLearnLock(root)
    await fs.rm(p.harmful, { force: true })
    await assertLearnLock(root)
    await fs.rm(p.pendingReplacements, { force: true })
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
    await fs.rm(p.candidate, { force: true })
    await assertLearnLock(root)
    await fs.rm(p.harmful, { force: true })
    await assertLearnLock(root)
    await fs.rm(p.pendingReplacements, { force: true })
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

/** A persisted import plan makes every rename/write boundary safe to retry after a crash. */
export async function migrate(root: string, name: string): Promise<void> {
  try {
    const p = paths(root, name)
    if (name === Playbook.DEFAULT_NAME && await read(path.join(root, ".altimate-code", "learn", "signals.jsonl")) !== undefined)
      await (await import("./signals")).migrateSignals(root, name)
    // A read of an unused store must not create files or acquire a filesystem lock.
    if (await read(p.migration) === undefined) {
      if (await read(p.approved) !== undefined || await read(p.candidate) !== undefined) return
      const skill = await read(p.skill)
      if (!skill?.split(/\r?\n/).includes(Playbook.HEADER)) return
    }
    await transaction(root, async () => {
      const journal = await read(p.migration)
      let migration: Migration | undefined
      if (journal !== undefined) {
        try { migration = parseMigration(journal, p) } catch {}
        if (migration?.complete) return
      }
      if (!migration) {
        // History survives promotion/rejection and prevents an invalid journal from
        // resurrecting legacy candidates or versions already consumed after migration.
        const completed = ((await read(p.history)) ?? "").split("\n").some((line) => {
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
        if (journal === undefined && (await read(p.approved) !== undefined || await read(p.candidate) !== undefined)) return
        const skill = await read(p.skill)
        if (journal === undefined && !skill?.split(/\r?\n/).includes(Playbook.HEADER)) return
        await assertLearnLock(root)
        await fs.mkdir(p.learnDir, { recursive: true })
        const files = [
          { source: p.skill, file: p.approved },
          { source: path.join(p.learnDir, "candidate.md"), file: p.candidate },
          ...(await fs.readdir(p.versions).catch(() => [] as string[]))
            .filter((file) => /^v\d+\.md$/.test(file))
            .sort()
            .map((file) => ({ source: path.join(p.versions, file), file: path.join(p.versions, file.replace(/\.md$/, ".json")) })),
        ]
        migration = { source: p.skill, complete: false, imports: [], malformed: [] }
        for (const entry of files) {
          const raw = await read(entry.source)
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
        if (await read(entry.file) === undefined) continue
        const backup = `${entry.file}.malformed-${Date.now()}-${randomUUID()}`
        await assertLearnLock(root)
        await fs.rename(entry.file, backup)
        quarantineNotice(entry.file, backup)
      }
      for (const entry of migration.imports) {
        if (await read(entry.file) !== undefined) continue
        await assertLearnLock(root)
        await fs.mkdir(path.dirname(entry.file), { recursive: true })
        await writeAtomic(root, entry.file, Lessons.canonical(entry.lessons))
      }
      // Local sidecars stay in place. Their existing repair routines preserve good records.
      await readHarmfulFrom(root, name)
      await readPendingReplacements(root, name)
      const rawHistory = await read(p.history)
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
    // Learning must never take down the user's session. The journal resumes on the next use.
    log.warn("learn migration interrupted; will retry on next use", { name, error: String(error) })
  }
}

/** Only unchanged text from previously approved/imported lessons gets the legacy length allowance. */
export async function grandfathered(root: string, name: string): Promise<Pick<Lessons.Lesson, "id" | "text">[]> {
  await migrate(root, name)
  const p = paths(root, name)
  const trusted = await loadApproved(root, name)
  for (const version of await versionNumbers(p.versions)) {
    const raw = await read(path.join(p.versions, `v${version}.json`))
    if (raw !== undefined) trusted.push(...Lessons.parse(raw))
  }
  const imported = ((await read(p.history)) ?? "").split("\n").flatMap((line) => {
    try {
      const entry: HistoryEntry = JSON.parse(line)
      return entry.action === "migrated-from" ? entry.grandfathered ?? [] : []
    } catch { return [] }
  })
  return [...trusted, ...imported].filter((lesson) => lesson.text.length > MAX_TEXT)
}
