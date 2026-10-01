// altimate_change - new file
//
// The playbook is a project skill (SKILL.md) holding one bullet per learned
// convention. This module only parses and serializes it. The format is chosen so
// that parse -> serialize is lossless: frontmatter is kept as raw text, and any
// body line that is not a managed bullet is kept verbatim in place.
//
// Nothing here may carry provenance (session ids, task ids): the file is
// published to the workspace. Provenance lives in history.jsonl only.
import { randomBytes } from "node:crypto"

export const PLAYBOOK_DESCRIPTION =
  "Conventions this team's CI and reviewers enforce, learned from past sessions. Apply them to related work."
export const DEFAULT_NAME = "team-playbook"
export const HEADER = "<!-- learned-playbook v1; managed by `altimate-code learn`. Edit via `learn`, not by hand. -->"

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const BULLET_RE = /^- \[(L-[0-9a-f]{4,})\] (.*) <!-- h:(\d+) x:(\d+) -->\r?$/

export interface Bullet {
  id: string
  text: string
  helpful: number
  harmful: number
}

type Item = { kind: "raw"; line: string } | { kind: "bullet"; bullet: Bullet }

export interface Playbook {
  /** Everything from the opening `---` through the closing `---` line, verbatim. */
  frontmatter: string
  items: Item[]
  /** Ids that appeared on more than one bullet in the parsed text. Later copies were re-id'd so no text is lost. */
  duplicateIds: string[]
}

export function validateName(name: string): string {
  if (!NAME_RE.test(name) || name.length > 64)
    throw new Error(`Invalid playbook name "${name}": use lowercase letters, digits and single hyphens.`)
  return name
}

export function newId(taken: Iterable<string> = []): string {
  const used = new Set(taken)
  for (;;) {
    const id = `L-${randomBytes(2).toString("hex")}`
    if (!used.has(id)) return id
  }
}

export interface FrontmatterInput {
  name: string
  applyPaths?: string[]
}

/** `applyPaths` when given, else `alwaysApply: true`. */
export function frontmatter(input: FrontmatterInput): string {
  const lines = ["---", `name: ${input.name}`, `description: ${JSON.stringify(PLAYBOOK_DESCRIPTION)}`]
  if (input.applyPaths && input.applyPaths.length > 0)
    lines.push(`applyPaths: [${input.applyPaths.map((p) => JSON.stringify(p)).join(", ")}]`)
  else lines.push("alwaysApply: true")
  lines.push("---")
  return lines.join("\n")
}

export function create(input: FrontmatterInput): Playbook {
  return {
    frontmatter: frontmatter(input),
    items: [{ kind: "raw", line: HEADER }, { kind: "raw", line: "" }],
    duplicateIds: [],
  }
}

export function parse(text: string): Playbook {
  const lines = text.split(/\r?\n/)
  let front = ""
  let start = 0
  if (lines[0]?.trimEnd() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---")
    if (end > 0) {
      front = lines.slice(0, end + 1).join("\n")
      start = end + 1
    }
  }
  const items: Item[] = lines.slice(start).map((line): Item => {
    const m = BULLET_RE.exec(line)
    if (!m) return { kind: "raw", line }
    return { kind: "bullet", bullet: { id: m[1], text: m[2], helpful: Number(m[3]), harmful: Number(m[4]) } }
  })
  // A hand edit can repeat an id; `withBullets` keys on ids, so a later copy would silently lose its text.
  const taken = new Set(items.flatMap((i) => (i.kind === "bullet" ? [i.bullet.id] : [])))
  const seen = new Set<string>()
  const duplicateIds: string[] = []
  for (const item of items) {
    if (item.kind !== "bullet") continue
    if (seen.has(item.bullet.id)) {
      if (!duplicateIds.includes(item.bullet.id)) duplicateIds.push(item.bullet.id)
      item.bullet.id = newId(taken)
      taken.add(item.bullet.id)
    }
    seen.add(item.bullet.id)
  }
  return { frontmatter: front, items, duplicateIds }
}

export function serializeBullet(b: Bullet): string {
  return `- [${b.id}] ${b.text} <!-- h:${b.helpful} x:${b.harmful} -->`
}

export function serialize(pb: Playbook): string {
  const body = pb.items.map((i) => (i.kind === "raw" ? i.line : serializeBullet(i.bullet)))
  return pb.frontmatter ? [pb.frontmatter, ...body].join("\n") : body.join("\n")
}

export function bullets(pb: Playbook): Bullet[] {
  return pb.items.flatMap((i) => (i.kind === "bullet" ? [{ ...i.bullet }] : []))
}

/** Replace the bullet set. Surviving bullets keep their position; bullets absent
 * from `next` are dropped; new ones go after the last bullet, or after the header
 * when there is none yet. */
export function withBullets(pb: Playbook, next: Bullet[]): Playbook {
  const byId = new Map(next.map((b) => [b.id, b]))
  const seen = new Set<string>()
  const items: Item[] = []
  let insertAt = -1
  for (const item of pb.items) {
    if (item.kind === "raw") {
      items.push(item)
      continue
    }
    const b = byId.get(item.bullet.id)
    if (!b) continue
    seen.add(b.id)
    items.push({ kind: "bullet", bullet: { ...b } })
    insertAt = items.length
  }
  const added: Item[] = next.filter((b) => !seen.has(b.id)).map((b) => ({ kind: "bullet", bullet: { ...b } }))
  if (insertAt < 0) {
    // No bullets yet: after the last non-blank body line, before the trailing blank (final newline).
    insertAt = items.length
    while (insertAt > 0 && items[insertAt - 1].kind === "raw" && (items[insertAt - 1] as { line: string }).line === "")
      insertAt--
  }
  items.splice(insertAt, 0, ...added)
  return { frontmatter: pb.frontmatter, items, duplicateIds: pb.duplicateIds }
}
