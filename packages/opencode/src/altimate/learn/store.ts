// altimate_change - new file
//
// On-disk state for `altimate-code learn`, rooted at the project root:
//   .altimate-code/skills/<name>/SKILL.md          promoted playbook (what teammates get)
//   .altimate-code/learn/<name>/candidate.md       staged edits from `learn reflect`
//   .altimate-code/learn/<name>/versions/v<N>.md   archived promoted versions
//   .altimate-code/learn/<name>/history.jsonl      provenance (never published)
//   .altimate-code/learn/<name>/harmful.json       bullet id -> feedback hashes that marked it HARMFUL (never published)
//   .altimate-code/learn/<name>/pending-replacements.jsonl  removed conventions awaiting recovery (never published)
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { createTwoFilesPatch } from "diff"
import * as Playbook from "./playbook"
import { sharedAnchors } from "./anchors"
import { lint, MAX_BULLETS, normalizeText,type Applied, type HarmfulFrom, type Rejected } from "./curator"
import { FEEDBACK_KINDS, type FeedbackKind } from "./reflect"
import { Log } from "@/util/log"
import { withLearnLock as transaction } from "./lock"

export { transaction }
const log = Log.create({ service: "learn.store" })

export const DEFAULT_APPLY_PATH = "dbt_project.yml"

export function paths(root: string, name: string) {
  Playbook.validateName(name)
  const learnDir = path.join(root, ".altimate-code", "learn", name)
  const skillDir = path.join(root, ".altimate-code", "skills", name)
  return {
    skillDir,
    skill: path.join(skillDir, "SKILL.md"),
    learnDir,
    candidate: path.join(learnDir, "candidate.md"),
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
export async function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, file)
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

export async function readPromoted(root: string, name: string) {
  return read(paths(root, name).skill)
}

export async function readCandidate(root: string, name: string) {
  return read(paths(root, name).candidate)
}

export interface SeedOptions {
  applyPaths?: string[]
}

/** The candidate to edit: the staged one, else a copy of the promoted playbook, else a new one. */
export async function loadCandidate(root: string, name: string, opts: SeedOptions = {}): Promise<Playbook.Playbook> {
  const existing = (await readCandidate(root, name)) ?? (await readPromoted(root, name))
  if (existing !== undefined) return Playbook.parse(existing)
  let applyPaths = opts.applyPaths
  if (!applyPaths || applyPaths.length === 0) {
    const hasDbt = await fs.stat(path.join(root, DEFAULT_APPLY_PATH)).then(
      (s) => s.isFile(),
      () => false,
    )
    applyPaths = hasDbt ? [DEFAULT_APPLY_PATH] : undefined
  }
  return Playbook.create({ name, applyPaths })
}

export async function saveCandidate(root: string, name: string, pb: Playbook.Playbook) {
  return transaction(root, async () => {
    const p = paths(root, name)
    await fs.mkdir(p.learnDir, { recursive: true })
    await writeAtomic(p.candidate, Playbook.serialize(pb))
  })
}

export interface HistoryEntry {
  ts?: string
  action: "reflect" | "promote" | "rollback" | "reject"
  session?: string
  feedbackKind?: string
  feedbackHash?: string
  feedbackFlagged?: boolean
  applied?: Applied[]
  rejected?: Rejected[]
  version?: number
  published?: boolean
}

export async function appendHistory(root: string, name: string, entry: HistoryEntry): Promise<HistoryEntry & { ts: string }> {
  return transaction(root, async () => {
    const p = paths(root, name)
    await fs.mkdir(p.learnDir, { recursive: true })
    const full = { ts: new Date().toISOString(), ...entry }
    await fs.appendFile(p.history, JSON.stringify(full) + "\n")
    return full
  })
}

async function quarantine(file: string, raw: string, repaired: string) {
  const backup = `${file}.corrupt.${Date.now()}.${randomUUID()}`
  await fs.writeFile(backup, raw, { mode: 0o600 })
  await writeAtomic(file, repaired)
  log.warn("quarantined malformed learn state; valid records retained", { file, backup })
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
    if (corrupt) await quarantine(file, raw, JSON.stringify(valid))
    return valid
  })
}

export async function writeHarmfulFrom(root: string, name: string, state: HarmfulFrom) {
  return transaction(root, async () => {
    const p = paths(root, name)
    await fs.mkdir(p.learnDir, { recursive: true })
    await writeAtomic(p.harmful, JSON.stringify(state))
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
    if (corrupt) await quarantine(file, raw, valid.map((record) => JSON.stringify(record) + "\n").join(""))
    return valid
  })
}

export async function writePendingReplacements(root: string, name: string, records: PendingReplacement[]) {
  return transaction(root, async () => {
    const p = paths(root, name)
    await fs.mkdir(p.learnDir, { recursive: true })
    await writeAtomic(p.pendingReplacements, records.map((record) => JSON.stringify(record) + "\n").join(""))
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
    return { diff: candidateDiff(name, promoted, candidate), candidateHash: candidate === undefined ? undefined : sha256(candidate) }
  })
}

function candidateDiff(name: string, promoted: string, candidate: string | undefined): string {
  if (candidate === undefined || candidate === promoted) return ""
  return createTwoFilesPatch(`${name}/SKILL.md (promoted)`, `${name}/SKILL.md (candidate)`, promoted, candidate, "", "", {
    context: 2,
  })
}

async function versionNumbers(dir: string): Promise<number[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  return names.flatMap((n) => {
    const m = /^v(\d+)\.md$/.exec(n)
    return m ? [Number(m[1])] : []
  })
}

export interface PromoteOptions {
  allowOverlap?: boolean
  expectedCandidateHash?: string
}

/** Re-checks the candidate. It is a plain file a person can edit, and it is about to be published. */
export function validateCandidate(name: string, text: string, opts: PromoteOptions = {}): string | undefined {
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
  const list = Playbook.bullets(pb)
  const ids = new Set(list.map((b) => b.id))
  if (list.length > MAX_BULLETS) return `candidate has ${list.length} bullets (max ${MAX_BULLETS})`
  for (const b of list) {
    const bad = lint(b.text) ?? (normalizeText(b.text) !== b.text ? "contains hidden or non-normalized characters" : undefined)
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

export class StoreError extends Error {}

export async function promote(root: string, name: string, opts: PromoteOptions = {}): Promise<{ archived?: number }> {
  return transaction(root, async () => {
    const p = paths(root, name)
    const candidate = await readCandidate(root, name)
    if (candidate === undefined) throw new StoreError(`No candidate for "${name}". Run \`learn reflect\` first.`)
    if (opts.expectedCandidateHash !== undefined && sha256(candidate) !== opts.expectedCandidateHash)
      throw new StoreError("Candidate changed since the displayed diff; re-run `learn promote` to review it again.")
    const bad = validateCandidate(name, candidate, opts)
    if (bad) throw new StoreError(`Refusing to promote: ${bad}`)
    // Publish the canonical serialization of what was validated (LF endings), not the raw file.
    const publish = Playbook.serialize(Playbook.parse(candidate))
    const current = await readPromoted(root, name)
    if (current === publish) throw new StoreError(`Candidate is identical to the promoted playbook; nothing to promote.`)
    let archived: number | undefined
    if (current !== undefined) {
      await fs.mkdir(p.versions, { recursive: true })
      archived = Math.max(0, ...(await versionNumbers(p.versions))) + 1
      await writeAtomic(path.join(p.versions, `v${archived}.md`), current)
    }
    await fs.mkdir(p.skillDir, { recursive: true })
    await writeAtomic(p.skill, publish)
    // The candidate is consumed: left in place it would read as a pending edit and a later `rollback` +
    // `promote` would silently re-publish it.
    await fs.rm(p.candidate, { force: true })
    await appendHistory(root, name, { action: "promote", version: archived })
    return { archived }
  })
}

/** Restores the most recently archived version and consumes it. */
export async function rollback(root: string, name: string): Promise<{ restored: number }> {
  return transaction(root, async () => {
    const p = paths(root, name)
    const latest = Math.max(0, ...(await versionNumbers(p.versions)))
    if (latest === 0) throw new StoreError(`No archived version of "${name}" to roll back to.`)
    const file = path.join(p.versions, `v${latest}.md`)
    await writeAtomic(p.skill, await fs.readFile(file, "utf8"))
    await fs.rm(file)
    // The staged candidate was built on the version just rolled back; it would resurrect it on `promote`.
    await fs.rm(p.candidate, { force: true })
    await fs.rm(p.harmful, { force: true })
    await fs.rm(p.pendingReplacements, { force: true })
    await appendHistory(root, name, { action: "rollback", version: latest })
    return { restored: latest }
  })
}

export async function reject(root: string, name: string): Promise<boolean> {
  return transaction(root, async () => {
    const p = paths(root, name)
    const hasCandidate = (await readCandidate(root, name)) !== undefined
    await fs.rm(p.candidate, { force: true })
    await fs.rm(p.harmful, { force: true })
    await fs.rm(p.pendingReplacements, { force: true })
    if (!hasCandidate) return false
    await appendHistory(root, name, { action: "reject" })
    return true
  })
}
