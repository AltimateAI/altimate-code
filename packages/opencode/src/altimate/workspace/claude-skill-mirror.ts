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

import { constants } from "node:fs"
import fs from "fs/promises"
import path from "path"
import { Log } from "@/altimate/util/log"
import { AltimateApi } from "@/altimate/api/client"
import { ownManifest, snapshotRoot } from "./skill-sync"

const log = Log.create({ service: "altimate-workspace-claude-skill-mirror" })

const SKILLS_DIR = path.join(".claude", "skills")
/** Present in every directory this module wrote, naming the skill. Only marked directories are
 * replaced or removed, so a skill the user wrote with the same name is never touched; a marked
 * directory under another name (a user's renamed copy) is not ours either. */
const MARKER = ".altimate-workspace-skill"
const MARKER_TEXT =
  "Copied from the linked Altimate workspace by the altimate-code plugin. Edits here are replaced.\n"
/** Staging directories: `.<name>.altimate-staging-XXXXXX` (and `.old` for the copy a swap moves
 * aside). The infix keeps a user's own hidden directories from ever matching. */
const STAGING_INFIX = ".altimate-staging-"
const STAGING_PATTERN = /^\.[a-z0-9][a-z0-9-]{0,63}\.altimate-staging-[A-Za-z0-9_]{6,8}(\.old)?$/
/** One sync at a time per project, shared with the plugin's Python script: an atomic `mkdir`,
 * the one lock both runtimes have. The holder renews it; one not renewed for LOCK_STALE_MS
 * belongs to a sync that died and is taken over; one that is not free within LOCK_WAIT_MS
 * leaves the copies as they are. */
const LOCK_DIR = ".altimate-workspace-sync.lock"
const LOCK_STALE_MS = 120_000
// Shorter than the plugin's: a sync waits on this, and a lock that is not free changes nothing.
const LOCK_WAIT_MS = 2_000
/** Staging older than this is abandoned; a retired snapshot younger than this is a swap in progress. */
const SWAP_MS = 600_000
/** Where the snapshot is moved aside while a new one is swapped in. */
const SNAPSHOT_STAGING = path.join(".altimate-code", "skill-staging")
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
  "claude.md",
  "claude.local.md",
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
/** `key: value`, with the whitespace after the colon as Python's `\s` (JS `\s` also takes U+FEFF). */
const FIELD_LINE = new RegExp(`^([A-Za-z_][\\p{L}\\p{N}_-]*):[${PY_WHITESPACE}]*([^\\n]*)$`, "u")

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
    const match = FIELD_LINE.exec(lines[i])
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

/** True while some process has moved the live snapshot aside to swap a new one in: a `retired-*`
 * entry, in a staging directory changed within SWAP_MS. The rename into it updates the
 * directory's mtime on every platform; the retired tree keeps its old mtime. */
async function snapshotIsSwapping(directory: string): Promise<boolean> {
  const staging = path.join(directory, SNAPSHOT_STAGING)
  const st = await fs.lstat(staging).catch(() => null)
  if (!st || Date.now() - st.mtimeMs >= SWAP_MS) return false
  const entries = await fs.readdir(staging).catch(() => [] as string[])
  return entries.some((entry) => entry.startsWith("retired-"))
}

/** The manifest is the one read, and still belongs to the signed-in account (no sign-out or
 * switch since). */
async function snapshotUnchanged(directory: string, manifest: string | null): Promise<boolean> {
  if ((await manifestText(directory)) !== manifest) return false
  return manifest === null || (await ownManifest(directory)) !== null
}

interface Snapshot {
  skills: WorkspaceSkill[]
  /** The manifest as read, or null without one: removal runs only while it is unchanged. */
  manifest: string | null
}

/** The manifest's text, null when there is none, or undefined when it cannot be read or its
 * path runs through a symlink. */
async function manifestText(directory: string): Promise<string | null | undefined> {
  const root = snapshotRoot(directory)
  const parts = path.relative(directory, root).split(path.sep)
  for (let i = 1; i <= parts.length; i++) {
    const st = await fs.lstat(path.join(directory, ...parts.slice(0, i))).catch(() => null)
    if (st?.isSymbolicLink()) return undefined
  }
  try {
    // lstat too: Windows has no O_NOFOLLOW.
    if ((await fs.lstat(path.join(root, ".manifest.json"))).isSymbolicLink()) return undefined
    return await readNoFollow(path.join(root, ".manifest.json"), "utf8")
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? null : undefined
  }
}

/** Read a file, never through a symlink (O_NOFOLLOW does not exist on Windows). */
async function readNoFollow(file: string): Promise<Buffer>
async function readNoFollow(file: string, encoding: "utf8"): Promise<string>
async function readNoFollow(file: string, encoding?: "utf8"): Promise<Buffer | string> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    return encoding ? await handle.readFile(encoding) : await handle.readFile()
  } finally {
    await handle.close()
  }
}

/** The usable skills, none when there is no snapshot or it may not be served to the signed-in
 * account (so copies are removed), or null when the snapshot or the credentials cannot be read,
 * a listed skill directory is missing, or a swap is in progress (so nothing changes). */
async function readSnapshot(directory: string): Promise<Snapshot | null> {
  const raw = await manifestText(directory)
  if (raw === undefined) return null
  if (raw === null) return (await snapshotIsSwapping(directory)) ? null : { skills: [], manifest: null }
  try {
    JSON.parse(raw)
  } catch {
    return null
  }
  const manifest = await ownManifest(directory)
  if (!manifest) {
    // Another account's snapshot removes the copies, but a manifest that vanished or broke since
    // the read above is a swap in progress, not an answer.
    try {
      JSON.parse(await fs.readFile(path.join(snapshotRoot(directory), ".manifest.json"), "utf8"))
    } catch {
      return null
    }
    // Signed out removes them too; credentials that exist but cannot be read are not an answer.
    if (await AltimateApi.isConfigured()) {
      try {
        await AltimateApi.getCredentials()
      } catch {
        return null
      }
    }
    return { skills: [], manifest: raw }
  }
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
      // A listed directory that is gone means the snapshot changed under us.
      return null
    }
    let bytes: Buffer
    try {
      // A skill without a regular SKILL.md (missing, a link, a directory) is skipped; lstat also
      // covers Windows, which has no O_NOFOLLOW.
      if (!(await fs.lstat(path.join(source, "SKILL.md"))).isFile()) continue
      bytes = await readNoFollow(path.join(source, "SKILL.md"))
    } catch (err) {
      // A skill without a SKILL.md, or with a symlinked one, is skipped; one that cannot be read
      // is unknown, so nothing is pruned.
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === "ENOENT" || code === "ELOOP") continue
      return null
    }
    let text: string
    try {
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
  return { skills, manifest: raw }
}

/** A marked, non-symlinked directory whose marker names it. Markers without a name (written by
 * earlier versions) still count; a copy the user renamed does not. */
async function isOurs(dir: string): Promise<boolean> {
  try {
    if ((await fs.lstat(dir)).isSymbolicLink()) return false
    // Strict UTF-8 and \r\n, \r or \n line ends, as the plugin's Python reads it.
    // ignoreBOM keeps a leading U+FEFF in the text, as Python's utf-8 codec does.
    const names = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(await fs.readFile(path.join(dir, MARKER)))
      .split(/\r\n?|\n/)
      .filter((line) => line.startsWith("skill: "))
      .map((line) => line.slice("skill: ".length))
    return names.length === 0 || names[0] === path.basename(dir)
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
  // First, so a copy interrupted part-way is still kept out of git.
  await fs.writeFile(path.join(staging, ".gitignore"), GITIGNORE_TEXT, "utf8")
  await copyTree(skill.source, staging)
  const rendered = renderSkill(skill.name, skill.description, skill.body)
  if (hasCommandMarker(rendered.slice(rendered.indexOf("\n---\n") + 5)))
    throw new Error(`workspace skill ${skill.name} still has a command marker`)
  await fs.writeFile(path.join(staging, "SKILL.md"), rendered, "utf8")
  await fs.writeFile(path.join(staging, MARKER), `${MARKER_TEXT}skill: ${skill.name}\n`, "utf8")
}

async function fileSizes(root: string, dir = root, found = new Map<string, number>()): Promise<Map<string, number>> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) await fileSizes(root, p, found)
    else found.set(path.relative(root, p), (await fs.stat(p)).size)
  }
  return found
}

/** Same files with the same bytes. Sizes first; contents one file pair at a time, so a large
 * bundle is never held in memory whole. */
async function sameTree(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([fileSizes(a), fileSizes(b)])
    if (left.size !== right.size) return false
    for (const [rel, size] of left) if (right.get(rel) !== size) return false
    for (const rel of left.keys()) {
      const [x, y] = await Promise.all([fs.readFile(path.join(a, rel)), fs.readFile(path.join(b, rel))])
      if (!x.equals(y)) return false
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

interface Lock {
  path: string
  token: string
}

/** The lock once this process holds it, or null when it is not free within LOCK_WAIT_MS.
 * Ownership is an empty `<token>` directory inside the lock, which git does not show and which
 * no other holder can have. */
async function acquireLock(targetRoot: string): Promise<Lock | null> {
  const lock = path.join(targetRoot, LOCK_DIR)
  const token = `${process.pid}-${process.hrtime.bigint()}`
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await fs.mkdir(lock)
      await fs.mkdir(path.join(lock, token))
      return { path: lock, token }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return null
    }
    await breakStaleLock(lock)
    if (Date.now() > deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Remove a lock whose holder stopped renewing it. The rename lets one taker win. A lock renewed
 * meanwhile goes back only while the path is free; otherwise its holder finds its token gone
 * and stops. */
async function breakStaleLock(lock: string): Promise<void> {
  const tomb = `${lock}.stale-${process.pid}-${process.hrtime.bigint()}`
  try {
    if (Date.now() - (await fs.lstat(lock)).mtimeMs <= LOCK_STALE_MS) return
    await fs.rename(lock, tomb)
    if (Date.now() - (await fs.lstat(tomb)).mtimeMs <= LOCK_STALE_MS && !(await lexists(lock))) {
      await fs.rename(tomb, lock)
      return
    }
  } catch {
    return
  }
  await fs.rm(tomb, { recursive: true, force: true }).catch(() => {})
}

async function holdsLock(lock: Lock): Promise<boolean> {
  const own = await fs.lstat(path.join(lock.path, lock.token)).catch(() => null)
  const dir = await fs.lstat(lock.path).catch(() => null)
  return !!own?.isDirectory() && !dir?.isSymbolicLink()
}

/** Keep a held lock fresh, so a long sync is not taken for a dead one. False once it is lost. */
async function renewLock(lock: Lock): Promise<boolean> {
  if (!(await holdsLock(lock))) return false
  await fs.utimes(lock.path, new Date(), new Date()).catch(() => {})
  return true
}

/** Remove the lock only while it is still this process's. */
async function releaseLock(lock: Lock): Promise<void> {
  if (await holdsLock(lock)) await fs.rm(lock.path, { recursive: true, force: true }).catch(() => {})
}

/** Staging left by a sync that was killed. Only our staging names match, and under the lock no
 * other sync runs; the age is a margin for a sync that has not taken the lock yet. */
async function removeAbandonedStaging(targetRoot: string): Promise<void> {
  for (const entry of await fs.readdir(targetRoot).catch(() => [] as string[])) {
    if (entry.startsWith(`${LOCK_DIR}.stale-`)) {
      // A lock taken over from a dead sync whose removal was interrupted.
      const st = await fs.lstat(path.join(targetRoot, entry)).catch(() => null)
      if (st && !st.isSymbolicLink() && Date.now() - st.mtimeMs > LOCK_STALE_MS)
        await fs.rm(path.join(targetRoot, entry), { recursive: true, force: true }).catch(() => {})
      continue
    }
    if (!STAGING_PATTERN.test(entry)) continue
    const dir = path.join(targetRoot, entry)
    const st = await fs.lstat(dir).catch(() => null)
    if (!st || st.isSymbolicLink() || !st.isDirectory() || Date.now() - st.mtimeMs < SWAP_MS) continue
    const ignore = await fs.readFile(path.join(dir, ".gitignore"), "utf8").catch(() => "")
    if (ignore === GITIGNORE_TEXT) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function sync(directory: string, withdraw: boolean): Promise<boolean> {
  const targetRoot = path.join(directory, SKILLS_DIR)
  if (!(await isDir(targetRoot))) {
    // Nothing to remove; create the directory only when there is something to copy.
    if (withdraw || !(await readSnapshot(directory))?.skills.length) return false
    await fs.mkdir(targetRoot, { recursive: true })
  }
  const lock = await acquireLock(targetRoot)
  if (!lock) return false
  try {
    await removeAbandonedStaging(targetRoot)
    if (withdraw) return await reconcile(directory, targetRoot, { skills: [], manifest: null }, lock, false)
    const snapshot = await readSnapshot(directory)
    return snapshot ? await reconcile(directory, targetRoot, snapshot, lock, true) : false
  } finally {
    await releaseLock(lock)
  }
}

async function reconcile(
  directory: string,
  targetRoot: string,
  snapshot: Snapshot,
  lock: Lock,
  checkManifest: boolean,
): Promise<boolean> {
  const skills = snapshot.skills
  let changed = false
  const wanted = new Set<string>()
  for (const skill of skills) {
    const { name } = skill
    if (wanted.has(name)) continue
    const target = path.join(targetRoot, name)
    // A skill the user wrote under this name stays as it is; the workspace one is skipped.
    if ((await lexists(target)) && !(await isOurs(target))) continue
    wanted.add(name)
    // Taken over as dead: the new holder finishes the job.
    if (!(await renewLock(lock))) return changed
    const staging = await fs.mkdtemp(path.join(targetRoot, `.${name}${STAGING_INFIX}`))
    const aside = `${staging}.old`
    try {
      try {
        await buildCopy(skill, staging)
      } catch (err) {
        log.warn("skipped workspace skill", { name, err: String(err) })
        continue
      }
      const exists = await isDir(target)
      if (exists && (await sameTree(staging, target))) continue
      // Building can outlast the lock, and the snapshot can be swapped while it is copied: either
      // way nothing more is published; the next sync picks up the new state.
      if (!(await renewLock(lock)) || (checkManifest && !(await snapshotUnchanged(directory, snapshot.manifest))))
        return changed
      // Move the old copy aside rather than deleting it, so a failed swap leaves it in place.
      try {
        if (exists) await fs.rename(target, aside)
        await fs.rename(staging, target)
      } catch (err) {
        if (exists && !(await lexists(target))) await fs.rename(aside, target).catch(() => {})
        // One skill's failed swap leaves its copy and does not stop the others.
        log.warn("could not update workspace skill", { name, err: String(err) })
        continue
      }
      // Only after a successful swap: if restoring failed above, the aside copy is the only one left.
      await fs.rm(aside, { recursive: true, force: true }).catch(() => {})
      changed = true
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
    }
  }
  // Removal only for the snapshot read above: one swapped in meanwhile is the next sync's.
  if (!(await renewLock(lock)) || (checkManifest && (await manifestText(directory)) !== snapshot.manifest)) return changed
  if (await isDir(targetRoot)) {
    for (const entry of await fs.readdir(targetRoot)) {
      const entryPath = path.join(targetRoot, entry)
      // Staging and lock directories start with "." and never match.
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
 * Copying is skipped when `ALTIMATE_CLAUDE_SKILL_SYNC=0` (withdrawal still runs), and for a project with no `.claude` directory:
 * one that does not use Claude Code is left alone, and the plugin creates `.claude/skills` on
 * its first session. Never throws; a failure leaves the existing copies as they were. */
export async function mirrorClaudeSkills(
  directory: string,
  opts?: { withdraw?: boolean },
): Promise<{ changed: boolean }> {
  try {
    // Withdrawal (unlink, feature off) is not copying, so the off switch does not stop it.
    if (process.env.ALTIMATE_CLAUDE_SKILL_SYNC === "0" && opts?.withdraw !== true) return { changed: false }
    const project = path.resolve(directory)
    if (!(await lexists(path.join(project, ".claude")))) return { changed: false }
    // A symlinked `.claude` or `.claude/skills` could point outside the project; never write or remove through it.
    for (const link of [path.join(project, ".claude"), path.join(project, SKILLS_DIR)])
      if (await fs.lstat(link).then((st) => st.isSymbolicLink(), () => false)) return { changed: false }
    return { changed: await sync(project, opts?.withdraw === true) }
  } catch (err) {
    log.warn("workspace skill copy to .claude/skills failed", { err: String(err) })
    return { changed: false }
  }
}
