// altimate_change - new file
//
// On-disk state for `altimate-code learn`, rooted at the project root:
//   .altimate-code/skills/<name>/SKILL.md          promoted playbook (what teammates get)
//   .altimate-code/learn/<name>/candidate.md       staged edits from `learn reflect`
//   .altimate-code/learn/<name>/versions/v<N>.md   archived promoted versions
//   .altimate-code/learn/<name>/history.jsonl      provenance (never published)
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { createTwoFilesPatch } from "diff"
import * as Playbook from "./playbook"
import { lint, MAX_BULLETS, type Applied, type Rejected } from "./curator"

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

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

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
  const p = paths(root, name)
  await fs.mkdir(p.learnDir, { recursive: true })
  await fs.writeFile(p.candidate, Playbook.serialize(pb))
}

export interface HistoryEntry {
  ts?: string
  action: "reflect" | "promote" | "rollback" | "reject"
  session?: string
  feedbackKind?: string
  feedbackHash?: string
  applied?: Applied[]
  rejected?: Rejected[]
  version?: number
  published?: boolean
}

export async function appendHistory(root: string, name: string, entry: HistoryEntry) {
  const p = paths(root, name)
  await fs.mkdir(p.learnDir, { recursive: true })
  await fs.appendFile(p.history, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n")
}

/** Unified diff promoted -> candidate; empty string when identical. */
export async function diff(root: string, name: string): Promise<string> {
  const promoted = (await readPromoted(root, name)) ?? ""
  const candidate = await readCandidate(root, name)
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

/** Re-checks the candidate. It is a plain file a person can edit, and it is about to be published. */
export function validateCandidate(name: string, text: string): string | undefined {
  const pb = Playbook.parse(text)
  if (!new RegExp(`^name:\\s*["']?${name}["']?\\s*$`, "m").test(pb.frontmatter))
    return `candidate frontmatter must declare name: ${name}`
  const list = Playbook.bullets(pb)
  if (list.length > MAX_BULLETS) return `candidate has ${list.length} bullets (max ${MAX_BULLETS})`
  for (const b of list) {
    const bad = lint(b.text)
    if (bad) return `bullet ${b.id} fails lint: ${bad}`
  }
  return undefined
}

export class StoreError extends Error {}

export async function promote(root: string, name: string): Promise<{ archived?: number }> {
  const p = paths(root, name)
  const candidate = await readCandidate(root, name)
  if (candidate === undefined) throw new StoreError(`No candidate for "${name}". Run \`learn reflect\` first.`)
  const bad = validateCandidate(name, candidate)
  if (bad) throw new StoreError(`Refusing to promote: ${bad}`)
  const current = await readPromoted(root, name)
  if (current === candidate) throw new StoreError(`Candidate is identical to the promoted playbook; nothing to promote.`)
  let archived: number | undefined
  if (current !== undefined) {
    await fs.mkdir(p.versions, { recursive: true })
    archived = Math.max(0, ...(await versionNumbers(p.versions))) + 1
    await fs.writeFile(path.join(p.versions, `v${archived}.md`), current)
  }
  await fs.mkdir(p.skillDir, { recursive: true })
  await fs.writeFile(p.skill, candidate)
  await appendHistory(root, name, { action: "promote", version: archived })
  return { archived }
}

/** Restores the most recently archived version and consumes it. */
export async function rollback(root: string, name: string): Promise<{ restored: number }> {
  const p = paths(root, name)
  const latest = Math.max(0, ...(await versionNumbers(p.versions)))
  if (latest === 0) throw new StoreError(`No archived version of "${name}" to roll back to.`)
  const file = path.join(p.versions, `v${latest}.md`)
  await fs.writeFile(p.skill, await fs.readFile(file, "utf8"))
  await fs.rm(file)
  await appendHistory(root, name, { action: "rollback", version: latest })
  return { restored: latest }
}

export async function reject(root: string, name: string): Promise<boolean> {
  const p = paths(root, name)
  if ((await readCandidate(root, name)) === undefined) return false
  await fs.rm(p.candidate)
  await appendHistory(root, name, { action: "reject" })
  return true
}
