// altimate_change - new file
//
// Mirror the workspace skill snapshot into Claude Code's project skills directory
// (`<project>/.claude/skills/<name>/`), so linking or refreshing a project puts the
// skills on disk before any Claude Code session starts.
//
// Behaviour, marker file name and on-disk layout are shared with the Claude Code plugin's
// `sync-workspace-skills.py`, which runs the same sync at session start. Both must agree on
// what is owned and what a copy looks like, so changes here belong in both places.
//
// A workspace skill is written by whoever can upload to the workspace, and Claude Code acts on
// frontmatter that pre-approves tools (`allowed-tools`) or registers hooks, and on `!` command
// blocks in a skill body. So a copy keeps only `name` and `description`, leaves no `!` beside a
// backtick or fence, and skips the paths Claude Code reads as skills, hooks or other components.

import fs from "fs/promises"
import path from "path"
import { Log } from "@/altimate/util/log"
import { ownManifest, snapshotRoot } from "./skill-sync"

const log = Log.create({ service: "altimate-workspace-claude-skill-mirror" })

const SKILLS_DIR = path.join(".claude", "skills")
/** Present in every directory this module wrote. Only marked directories are replaced or
 * removed, so a skill the user wrote with the same name is never touched. */
const MARKER = ".altimate-workspace-skill"
const MARKER_TEXT =
  "Copied from the linked Altimate workspace by the altimate-code plugin. Edits here are replaced.\n"
/** Keeps copies out of version control. */
const GITIGNORE_TEXT = "*\n"
/** Claude Code skill names: lowercase letters, digits and hyphens. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
/** `!` before a backtick starts an inline command; `!` right after a fence opens a command block. */
const BANG_BEFORE_BACKTICK = /!(?=`)/g
const BANG_AFTER_FENCE = /(`{3,}|~{3,})!+/g
/** Paths Claude Code reads as configuration or components. Compared lowercased: default macOS
 * and Windows filesystems ignore case. */
const BLOCKED_DIRS = new Set(["hooks", "skills", "agents", "commands", "output-styles", "monitors", "bin"])
const BLOCKED_FILES = new Set([
  "skill.md",
  ".mcp.json",
  ".lsp.json",
  "settings.json",
  "settings.local.json",
  "plugin.json",
  "hooks.json",
])
/** What Python's `str.strip()` removes. JS `trim()` differs (it strips U+FEFF, and not U+001C-U+001F). */
const PY_WHITESPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"
const PY_STRIP = new RegExp(`^[${PY_WHITESPACE}]+|[${PY_WHITESPACE}]+$`, "g")

function pyStrip(s: string): string {
  return s.replace(PY_STRIP, "")
}

/** `json.dumps` with its default `ensure_ascii`: everything outside printable ASCII is escaped
 * as UTF-16 code units, so the bytes match what the Python script writes. */
function jsonAscii(value: string): string {
  return JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  )
}

/** Top-level scalar keys of the frontmatter and the body after it. Handles plain, quoted and
 * block (`|`, `>`) scalars, which is what skill names and descriptions use. */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } | null {
  const lines = text.split("\n")
  if (pyStrip(lines[0]) !== "---") return null
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (pyStrip(lines[i]) === "---") {
      end = i
      break
    }
  }
  if (end < 0) return null
  const fields: Record<string, string> = {}
  let i = 1
  while (i < end) {
    const match = /^([A-Za-z_][\p{L}\p{N}_-]*):[\s]*([^\n]*)$/u.exec(lines[i])
    i++
    if (!match) continue
    const key = match[1]
    const raw = pyStrip(match[2])
    if (raw[0] === "|" || raw[0] === ">") {
      const block: string[] = []
      while (i < end && (!pyStrip(lines[i]) || lines[i][0] === " " || lines[i][0] === "\t")) {
        block.push(pyStrip(lines[i]))
        i++
      }
      fields[key] = pyStrip(block.filter((part) => part).join(raw[0] === "|" ? "\n" : " "))
    } else if ((raw[0] === '"' || raw[0] === "'") && raw.length > 1 && raw[raw.length - 1] === raw[0]) {
      const inner = raw.slice(1, -1)
      fields[key] = raw[0] === "'" ? inner.replaceAll("''", "'") : inner.replaceAll('\\"', '"')
    } else {
      fields[key] = raw
    }
  }
  return { fields, body: lines.slice(end + 1).join("\n") }
}

/** Leave no `!` touching a backtick or fence, so no form of command block survives. Repeated
 * until stable: one rewrite can form a new marker from its neighbours. */
export function neutraliseCommands(body: string): string {
  while (true) {
    const cleaned = body.replace(BANG_AFTER_FENCE, "$1").replace(BANG_BEFORE_BACKTICK, "! ")
    if (cleaned === body) return cleaned
    body = cleaned
  }
}

function hasCommandMarker(text: string): boolean {
  return new RegExp(BANG_BEFORE_BACKTICK.source).test(text) || new RegExp(BANG_AFTER_FENCE.source).test(text)
}

function renderSkill(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${jsonAscii(description)}\n---\n${neutraliseCommands(body)}`
}

interface WorkspaceSkill {
  source: string
  name: string
  description: string
  body: string
}

/** Each usable workspace skill; empty when there is no snapshot servable to the current
 * account, so the copies are removed. */
async function readSnapshot(directory: string): Promise<WorkspaceSkill[]> {
  const manifest = await ownManifest(directory)
  if (!manifest) return []
  const root = snapshotRoot(directory)
  const skills: WorkspaceSkill[] = []
  for (const id of Object.keys(manifest.skills)) {
    // Each id is one directory under the snapshot, never a path out of it.
    if (!id || id.startsWith(".") || id.includes("/") || id.includes("\\")) continue
    const source = path.join(root, id)
    try {
      const st = await fs.lstat(source)
      if (st.isSymbolicLink() || !st.isDirectory()) continue
    } catch {
      continue
    }
    let text: string
    try {
      const bytes = await fs.readFile(path.join(source, "SKILL.md"))
      // Fatal decode and universal newlines, as the Python script reads text.
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/g, "\n")
    } catch {
      continue
    }
    const parsed = parseFrontmatter(text)
    if (!parsed || Object.keys(parsed.fields).length === 0) continue
    const name = parsed.fields.name ?? ""
    const description = parsed.fields.description ?? ""
    if (NAME_PATTERN.test(name) && description) skills.push({ source, name, description, body: parsed.body })
  }
  return skills
}

async function isOurs(dir: string): Promise<boolean> {
  try {
    if ((await fs.lstat(dir)).isSymbolicLink()) return false
    return (await fs.stat(path.join(dir, MARKER))).isFile()
  } catch {
    return false
  }
}

async function lexists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

function isBlockedDir(name: string): boolean {
  return name.startsWith(".") || BLOCKED_DIRS.has(name.toLowerCase())
}

async function copyTree(source: string, staging: string): Promise<void> {
  await fs.mkdir(staging, { recursive: true })
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name)
    const dst = path.join(staging, entry.name)
    // Symlinks are never followed or copied.
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (!isBlockedDir(entry.name)) await copyTree(src, dst)
    } else if (entry.isFile()) {
      if (entry.name.startsWith(".") || BLOCKED_FILES.has(entry.name.toLowerCase())) continue
      await fs.copyFile(src, dst)
    }
  }
}

async function buildCopy(skill: WorkspaceSkill, staging: string): Promise<void> {
  await copyTree(skill.source, staging)
  const rendered = renderSkill(skill.name, skill.description, skill.body)
  if (hasCommandMarker(rendered.slice(rendered.indexOf("\n---\n") + 5)))
    throw new Error(`workspace skill ${skill.name} still has a command marker`)
  await fs.writeFile(path.join(staging, "SKILL.md"), rendered, "utf8")
  await fs.writeFile(path.join(staging, ".gitignore"), GITIGNORE_TEXT, "utf8")
  await fs.writeFile(path.join(staging, MARKER), MARKER_TEXT, "utf8")
}

async function listing(root: string, dir = root, found = new Map<string, Buffer>()): Promise<Map<string, Buffer>> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) await listing(root, p, found)
    else found.set(path.relative(root, p), await fs.readFile(p))
  }
  return found
}

async function sameTree(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([listing(a), listing(b)])
    if (left.size !== right.size) return false
    for (const [rel, bytes] of left) {
      const other = right.get(rel)
      if (!other || !bytes.equals(other)) return false
    }
    return true
  } catch {
    return false
  }
}

async function isDir(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then((s) => s.isDirectory())
    .catch(() => false)
}

async function sync(directory: string, withdraw: boolean): Promise<boolean> {
  const skills = withdraw ? [] : await readSnapshot(directory)
  const targetRoot = path.join(directory, SKILLS_DIR)
  let changed = false
  const wanted = new Set<string>()
  for (const skill of skills) {
    const { name } = skill
    if (wanted.has(name)) continue
    const target = path.join(targetRoot, name)
    // A skill the user wrote under this name stays as it is; the workspace one is skipped.
    if ((await lexists(target)) && !(await isOurs(target))) continue
    wanted.add(name)
    await fs.mkdir(targetRoot, { recursive: true })
    const staging = await fs.mkdtemp(path.join(targetRoot, `.${name}.`))
    try {
      try {
        await buildCopy(skill, staging)
      } catch (err) {
        log.warn("skipped workspace skill", { name, err: String(err) })
        continue
      }
      const exists = await isDir(target)
      if (exists && (await sameTree(staging, target))) continue
      if (exists) await fs.rm(target, { recursive: true, force: true })
      await fs.rename(staging, target)
      changed = true
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
    }
  }
  if (await isDir(targetRoot)) {
    for (const entry of await fs.readdir(targetRoot)) {
      const entryPath = path.join(targetRoot, entry)
      // Staging directories start with "." and never match; another session may be using one.
      if (NAME_PATTERN.test(entry) && !wanted.has(entry) && (await isOurs(entryPath))) {
        await fs.rm(entryPath, { recursive: true, force: true }).catch(() => {})
        changed = true
      }
    }
  }
  return changed
}

/** Make `<directory>/.claude/skills` match the workspace skill snapshot: copy each skill in,
 * remove the copies of skills that are gone, and remove them all when the snapshot is absent or
 * not served to the signed-in account. `withdraw` removes every copy regardless of the snapshot
 * (unlink, feature off).
 *
 * Skipped when `ALTIMATE_CLAUDE_SKILL_SYNC=0`, and for a project with no `.claude` directory:
 * one that does not use Claude Code is left alone, and the plugin creates `.claude/skills` on
 * its first session. Never throws; a failure leaves the existing copies as they were. */
export async function mirrorClaudeSkills(
  directory: string,
  opts?: { withdraw?: boolean },
): Promise<{ changed: boolean }> {
  try {
    if (process.env.ALTIMATE_CLAUDE_SKILL_SYNC === "0") return { changed: false }
    const project = path.resolve(directory)
    if (!(await lexists(path.join(project, ".claude")))) return { changed: false }
    return { changed: await sync(project, opts?.withdraw === true) }
  } catch (err) {
    log.warn("workspace skill copy to .claude/skills failed", { err: String(err) })
    return { changed: false }
  }
}
