// altimate_change - new file
//
// Publishing a locally-authored skill to the linked workspace — the upload half
// of `skill-sync.ts`, which only ever pulls.
//
// Shaped so agents and commands can ride the same path later. A workspace skill
// is a NAMED BUNDLE OF FILES, and nothing below is skill-specific except the
// endpoint it posts to and the `SKILL.md` it reads a name out of. `collectBundle`
// and the binary guard take a directory, not a skill.
//
// Three rules this module exists to enforce, each of which is a bug if skipped:
//
//   1. Refuse non-UTF-8 files, naming the path. The wire format is
//      `{path, content}` with content as a STRING — the server does
//      `content.encode("utf-8")` on the way in and hands back a decoded string on
//      the way out. A bundle carrying a PNG therefore cannot round-trip: the
//      declared byte size stops matching after the re-encode and `skill-sync`
//      skips the whole skill, logging a warning nobody sees. Caught here it is
//      one clear local error; caught there it is a skill that silently vanishes
//      from every OTHER machine, days later, with nothing tying the symptom to
//      the cause.
//
//   2. Never publish from the managed snapshot. `.altimate-code/skill/_workspace`
//      holds skills the workspace sent us, and it sits under the same
//      `{skill,skills}/**​/SKILL.md` glob as the user's own — deliberately, since
//      that is how they load. A publish that walked "every skill in this project"
//      would upload the workspace's own skills back to it.
//
//   3. Remember the server's id after a first publish, so publishing again
//      UPDATES rather than creating a second bundle. Names are unique per creator
//      server-side, so a blind re-create answers 409 rather than duplicating —
//      but that turns an ordinary second publish into an error the user has to
//      interpret.
import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import { realpathSync } from "fs"
import { Log } from "@/altimate/util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { AltimateApi } from "@/altimate/api/client"
import { ConflictError, ForbiddenError, NotFoundError, altimateRequest } from "./api-client"
import { resolveBinding } from "./state"

const log = Log.create({ service: "altimate-workspace-skill-publish" })

const SKILLS_BASE = "/skills"
/** Must stay in step with `skill-sync.ts`. Duplicated rather than exported from
 * there because importing it would pull the whole sync module — and its
 * process-global store — into every caller that only wants to publish. */
const MANAGED_DIR = path.join(".altimate-code", "skill", "_workspace")

/** Mirrors the server's own ceilings so an oversized bundle fails locally, with a
 * usable message, instead of after a long upload. */
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024
const MAX_BUNDLE_FILES = 200

/** Never published, whatever is in the directory.
 *
 * A skill directory is a folder the user works in, so it accumulates things
 * that are not the skill: an editor's swap file, macOS's `.DS_Store`, a `.git`
 * from a skill installed by clone — and `.env`, which is the one that matters.
 * Publishing is a share: a public skill's bundle is readable tenant-wide, and
 * a secret that reaches it cannot be recalled by deleting the file locally.
 * Skipped silently, where a named refusal would be noise about files the user
 * did not mean to publish either. */
const NEVER_PUBLISH_DIRS = new Set([".git", "node_modules", "__pycache__"])
function isJunkFile(name: string): boolean {
  return (
    name === ".DS_Store" ||
    name === "Thumbs.db" ||
    name === ".env" ||
    name.startsWith(".env.") ||
    name.endsWith("~") ||
    name.endsWith(".swp") ||
    name.endsWith(".swo")
  )
}
/** The shared request budget is 15s and covers the upload itself; a legal 10MB
 * bundle needs ~5.5 Mbps sustained just to fit inside it. Uploads get their
 * own. */
const UPLOAD_TIMEOUT_MS = 120_000
const READ_CHUNK_BYTES = 256 * 1024

export interface BundleFile {
  path: string
  content: string
}

export class BinaryFileError extends Error {
  constructor(readonly filePath: string) {
    super(
      `"${filePath}" is not UTF-8 text. Workspace skill bundles are transported as text, ` +
        `so binary files cannot be published — remove it, or keep it outside the skill.`,
    )
    this.name = "BinaryFileError"
  }
}

export class ManagedSkillError extends Error {
  constructor(readonly filePath: string) {
    super(
      `"${filePath}" is a skill this workspace sent to you, not one you authored. ` +
        `Publishing it would send the workspace's own skill back to it.`,
    )
    this.name = "ManagedSkillError"
  }
}

export class BundleTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BundleTooLargeError"
  }
}

/** Nothing to publish. Its own type: a caller switching on errors must not file
 * "empty" under the size ceiling. */
export class EmptyBundleError extends Error {
  constructor() {
    super("This skill directory has no files to publish.")
    this.name = "EmptyBundleError"
  }
}

/** A bundle must be self-contained. Local discovery follows links, so a skill
 * that reaches its files through one works here — and a publish that silently
 * skipped the link would arrive everywhere else with those files missing, the
 * same silent-vanish rule 1 exists to prevent. Following the link instead would
 * publish whatever it points at, which may be outside the project entirely. */
export class SymlinkError extends Error {
  constructor(readonly filePath: string) {
    super(
      `"${filePath}" is a symbolic link. Workspace skill bundles must be self-contained — ` +
        `copy the target into the skill, or keep it outside.`,
    )
    this.name = "SymlinkError"
  }
}

/** The workspace already has a skill of this name owned by this user, and this
 * machine has no id for it — so it was published from somewhere else.
 *
 * A distinct type rather than re-raising the API's `ConflictError`: that one
 * carries a structured server detail, and constructing a fake one to hold a
 * client-authored sentence would misrepresent the envelope. */
/** The project is not linked to a workspace, so there is nowhere to publish to.
 * Raised BEFORE anything is uploaded: publishing first and failing to attach
 * would leave a skill on the server attached to nothing — invisible in every
 * workspace UI, which is exactly the report that motivated this module. */
export class NotLinkedError extends Error {
  constructor() {
    super("This project is not linked to a workspace. Run `altimate-code link` first.")
    this.name = "NotLinkedError"
  }
}

/** The skill exists on the server but could not be attached to the workspace.
 * Carries the id so the caller can say so precisely: the next publish takes the
 * update path and retries the attachment, so nothing is stranded. */
export class AttachFailedError extends Error {
  constructor(
    readonly publicId: string,
    cause: unknown,
  ) {
    super(`The skill was uploaded (id ${publicId}) but could not be attached to the workspace: ${String(cause)}`)
    this.name = "AttachFailedError"
  }
}

/** The skill changed in the workspace between this publish reading it and
 * writing it — someone edited it in the web UI mid-upload. The server's
 * compare-and-swap refused, nothing was written, and publishing again picks up
 * their version. A distinct type because the advice is "try again", where a
 * name conflict's is "rename". */
export class SkillChangedElsewhereError extends Error {
  constructor(readonly skillName: string) {
    super(
      `"${skillName}" was edited in the workspace while this publish was uploading, ` +
        `so nothing was changed. Publish again to apply your version on top of theirs.`,
    )
    this.name = "SkillChangedElsewhereError"
  }
}

export class SkillNameConflictError extends Error {
  constructor(readonly skillName: string) {
    super(
      `You already have a skill named "${skillName}" in this workspace. It was published ` +
        `from somewhere else, so this machine cannot update it — rename this one, or edit ` +
        `it in the workspace.`,
    )
    this.name = "SkillNameConflictError"
  }
}

export interface PublishReport {
  action: "created" | "updated"
  publicId: string
  name: string
  files: number
  bytes: number
  /** The workspace the skill is now attached to. */
  datamateId: number
}

/** Read one directory into a bundle, refusing anything that cannot survive the
 * transport.
 *
 * Strict decoding is the whole point: `TextDecoder` with `fatal: true` throws on
 * an invalid sequence, where the default silently substitutes U+FFFD and would
 * hand us a "valid" string that reassembles into a different file. */
export async function collectBundle(dir: string): Promise<BundleFile[]> {
  const root = path.resolve(dir)
  const files: BundleFile[] = []
  let bytes = 0

  const tooLarge = () => new BundleTooLargeError(`This skill is larger than ${MAX_BUNDLE_BYTES / (1024 * 1024)}MB.`)

  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      const relative = path.relative(root, full).split(path.sep).join("/")
      if (entry.isDirectory()) {
        if (NEVER_PUBLISH_DIRS.has(entry.name)) continue
        await walk(full)
        continue
      }
      if (isJunkFile(entry.name)) continue
      // Named, not skipped. `readdir` reports a link as neither file nor
      // directory, and a bare `continue` here dropped it from the bundle with
      // nothing said.
      if (entry.isSymbolicLink()) throw new SymlinkError(relative)
      if (!entry.isFile()) continue
      // Bounded read. `readFile` pulls the whole file into memory before any
      // size check can run, so a single oversized file got through the very
      // guard meant to stop it — and a stat beforehand only narrows the
      // window, since the file can grow between the stat and the read. The
      // stat is kept as the cheap refusal; the read itself goes through a
      // handle in chunks and stops the moment the budget is exceeded, so
      // what is held in memory never passes the limit by more than a chunk.
      // Before the read, like the byte ceiling: file 201 was read and decoded
      // in full before being rejected.
      if (files.length >= MAX_BUNDLE_FILES)
        throw new BundleTooLargeError(`This skill has more than ${MAX_BUNDLE_FILES} files.`)
      const allowed = MAX_BUNDLE_BYTES - bytes
      const handle = await fs.open(full, "r")
      let raw: Buffer
      try {
        const stat = await handle.stat()
        if (stat.size > allowed) throw tooLarge()
        const chunks: Buffer[] = []
        let total = 0
        for (;;) {
          const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES)
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, total)
          if (bytesRead === 0) break
          total += bytesRead
          if (total > allowed) throw tooLarge()
          chunks.push(chunk.subarray(0, bytesRead))
        }
        raw = Buffer.concat(chunks, total)
      } finally {
        await handle.close()
      }
      let content: string
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(raw)
      } catch {
        throw new BinaryFileError(relative)
      }
      bytes += raw.byteLength
      files.push({ path: relative, content })
    }
  }

  await walk(root)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return files
}

/** True when this path lives inside the workspace-owned snapshot. */
export function isManagedSkill(projectDirectory: string, skillDirectory: string): boolean {
  // `path.resolve` is lexical: it normalises `..` and makes the path absolute,
  // but it does not follow links. A skill directory that IS a symlink into the
  // workspace-owned snapshot therefore resolved to its own link path, missed
  // this check, and `collectBundle` then walked through the link and published
  // the workspace's own skills back to it. Compare real paths where they exist.
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      // Absent or unreadable: fall back to the lexical form. A path that does
      // not exist cannot be a link into the snapshot, and `collectBundle` will
      // fail on it in a moment anyway.
      return path.resolve(p)
    }
  }
  const managed = real(path.resolve(projectDirectory, MANAGED_DIR))
  const candidate = real(skillDirectory)
  return candidate === managed || candidate.startsWith(managed + path.sep)
}

// ---------------------------------------------------------------------------
// Published-id bookkeeping
//
// A local file rather than `SKILL.md` frontmatter, deliberately. Frontmatter is
// committed, so the id would travel with the skill: a colleague cloning the repo
// and publishing would UPDATE the original author's bundle rather than create
// their own. It would also put a server identifier into a file the user edits by
// hand, and show up in every diff. The id is a fact about "this machine published
// this skill to this workspace", which is exactly the scope of local state.
// ---------------------------------------------------------------------------

interface PublishedRecord {
  publicId: string
  tenant: string
  apiUrl: string
}

function ledgerPath(): string {
  return path.join(Global.Path.state, "altimate-published-skills.json")
}

/** Shape check, not a cast. The file comes off disk and could be anything — an
 * older layout, hand-edited, half-written. A malformed row must be dropped rather
 * than trusted into a PATCH against a garbage id. */
function isPublishedRecord(value: unknown): value is PublishedRecord {
  if (!value || typeof value !== "object") return false
  const r = value as Record<string, unknown>
  return typeof r.publicId === "string" && typeof r.tenant === "string" && typeof r.apiUrl === "string"
}

async function readLedger(): Promise<Record<string, PublishedRecord>> {
  try {
    const raw = await Filesystem.readText(ledgerPath())
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    // Per-entry, so one corrupt row costs its own skill a re-create rather than
    // discarding every other skill's id.
    const out: Record<string, PublishedRecord> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>))
      if (isPublishedRecord(value)) out[key] = value
    return out
  } catch {
    // Absent or unreadable both mean "nothing known", which costs a create that
    // may 409 — recoverable — rather than an update against a guessed id.
    return {}
  }
}

/** The account a publish runs under, as the ledger scopes it. The key
 * fingerprint is in it because the server scopes skill names per CREATOR:
 * two users of one tenant who publish the same directory are two creators,
 * and a ledger keyed on tenant alone handed the second user the first user's
 * id — a PATCH the server refuses with 403. A digest, never the key itself:
 * the ledger is a plain file. */
interface LedgerScope {
  tenant: string
  apiUrl: string
  keyDigest: string
}

function keyDigest(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16)
}

async function currentScope(): Promise<LedgerScope | null> {
  const creds = await AltimateApi.getCredentials().catch(() => null)
  if (!creds) return null
  return { tenant: creds.altimateInstanceName, apiUrl: creds.altimateUrl, keyDigest: keyDigest(creds.altimateApiKey) }
}

/** The skill directory as the ledger identifies it: its real path. `path.resolve`
 * is lexical, so one directory reached through a link — `/tmp` and
 * `/private/tmp`, a linked worktree — was two ledger keys, and the second
 * publish created again and 409'd on its own name. Same fallback
 * `isManagedSkill` uses: a path that does not exist cannot be a link. */
function skillIdentity(skillDir: string): string {
  try {
    return realpathSync(skillDir)
  } catch {
    return path.resolve(skillDir)
  }
}

/** Keyed on the skill directory AND the account it was published under, so a
 * rename of the skill's *name* does not orphan its id, two skills in different
 * projects cannot collide, and — the reason the account is in the key —
 * publishing one directory to two accounts keeps an id for each.
 *
 * A bare directory key held one record, so switching accounts overwrote the
 * previous account's id: switching back created a second skill and then 409'd on
 * the name that was already there, with no way to reach the original. */
function ledgerKey(skillDir: string, scope: LedgerScope): string {
  return `${scope.tenant}|${scope.apiUrl}|${scope.keyDigest}|${skillIdentity(skillDir)}`
}

/** Serialises ledger access, the same way `memory-index` serialises its own.
 * Two publishes running at once each read, mutate and write the whole file, so
 * the later write dropped the earlier one's id — and that skill's next publish
 * created again and 409'd on its own name. Reads go through it too: a read that
 * overlapped a queued write saw a ledger without the id it was about to hold.
 *
 * In-process only. Two `altimate` processes publishing at once still race the
 * file; the atomic write below keeps that from corrupting it, and the cost of
 * losing is one id — a 409 on that skill's next publish, not data. */
let ledgerChain: Promise<unknown> = Promise.resolve()

function withLedger<T>(task: () => Promise<T>): Promise<T> {
  const run = ledgerChain.then(task)
  ledgerChain = run.catch(() => {})
  return run
}

async function recordPublished(skillDir: string, scope: LedgerScope, record: PublishedRecord): Promise<void> {
  return withLedger(async () => {
    try {
      // Re-read INSIDE the chain: a copy read before the previous write landed
      // would carry that write away again when this one persists.
      const ledger = await readLedger()
      ledger[ledgerKey(skillDir, scope)] = record
      // Atomic (write-then-rename), so a process killed mid-write leaves the
      // previous ledger rather than a truncated one — which `readLedger`
      // would read as empty, dropping EVERY skill's id at once.
      Filesystem.writeJsonAtomic(ledgerPath(), ledger)
    } catch (err) {
      // Best-effort. Losing the id costs a 409 on the next publish, not data.
      log.warn("could not record the published skill id", { err: String(err) })
    }
  })
}

async function knownPublicId(skillDir: string, scope: LedgerScope): Promise<string | null> {
  return withLedger(async () => {
    const ledger = await readLedger()
    // Composite key first; fall back to the pre-fingerprint composite key and
    // then to the directory-only key, so ids written by earlier versions are
    // not stranded into a needless re-create.
    const record =
      ledger[ledgerKey(skillDir, scope)] ??
      ledger[`${scope.tenant}|${scope.apiUrl}|${path.resolve(skillDir)}`] ??
      ledger[path.resolve(skillDir)]
    if (!record) return null
    // Still checked, not implied by the key: the fallback lookups above can
    // return a legacy row belonging to another account.
    if (record.tenant !== scope.tenant || record.apiUrl !== scope.apiUrl) return null
    return record.publicId
  })
}

/** One publish per skill directory at a time. The ledger chain serialises the
 * bookkeeping, but two publishes of the SAME directory overlapping their
 * lookup-and-create both found no id, both POSTed, and the loser was told the
 * skill "was published from somewhere else" — by this machine, seconds ago. */
const publishChains = new Map<string, Promise<unknown>>()

function withPublishLock<T>(skillDir: string, task: () => Promise<T>): Promise<T> {
  const key = skillIdentity(skillDir)
  const run = (publishChains.get(key) ?? Promise.resolve()).then(task)
  const settled = run.catch(() => {}).then(() => {
    if (publishChains.get(key) === settled) publishChains.delete(key)
  })
  publishChains.set(key, settled)
  return run
}

/** Attach a published skill to the workspace this project is bound to.
 *
 * Creating a skill and attaching it are two calls on the server, and only the
 * first was ever made. A skill that is created but attached to nothing does not
 * appear in any workspace — the CLI lists workspace skills with
 * ``GET /skills?datamate_id=``, and so does the web UI — so from the user's
 * side "publish" had done nothing visible.
 *
 * ``PUT /skills/{id}/datamates`` REPLACES the whole set. A bare put with one id
 * would silently detach the skill from every other workspace it was already on,
 * so the current set is read first and merged. */
async function attachToWorkspace(publicId: string, datamateId: number): Promise<void> {
  type Attached = { attached_datamate_ids?: unknown }
  const detail = await altimateRequest<Attached & { skill?: Attached }>("GET", `/${encodeURIComponent(publicId)}`, {
    base: SKILLS_BASE,
  })
  // The server answers `{skill: {...}}` (`CustomSkillResponse`); a flat body
  // is tolerated the way `extractPublicId` tolerates both. Reading only the
  // top level found nothing, and the replace below then detached the skill
  // from every workspace it was already on.
  const raw = detail?.skill?.attached_datamate_ids ?? detail?.attached_datamate_ids
  const current = Array.isArray(raw) ? raw.filter((n): n is number => Number.isInteger(n)) : []
  if (current.includes(datamateId)) return
  await altimateRequest<unknown>("PUT", `/${encodeURIComponent(publicId)}/datamates`, {
    base: SKILLS_BASE,
    body: { datamate_ids: [...current, datamateId] },
    allowEmptyBody: true,
  })
}

/** Publish a skill directory to the workspace, creating it or updating the bundle
 * already published from this machine.
 *
 * `privacy` is left unset: the server defaults to `private`. Publishing should
 * attach a skill to a workspace, not disclose it to the whole organisation as a
 * side effect of a command whose name says nothing about visibility. */
export async function publishSkill(input: {
  projectDirectory: string
  skillDirectory: string
  name: string
  description: string
}): Promise<PublishReport> {
  return withPublishLock(input.skillDirectory, () => publishSkillUnlocked(input))
}

async function publishSkillUnlocked(input: {
  projectDirectory: string
  skillDirectory: string
  name: string
  description: string
}): Promise<PublishReport> {
  if (isManagedSkill(input.projectDirectory, input.skillDirectory))
    throw new ManagedSkillError(input.skillDirectory)

  // Before the bundle is even read. An unlinked project has nowhere to attach
  // to, and uploading first would create the orphan this module exists to
  // prevent.
  const binding = await resolveBinding(input.projectDirectory)
  if (!binding) throw new NotLinkedError()

  const files = await collectBundle(input.skillDirectory)
  if (files.length === 0) throw new EmptyBundleError()
  const bytes = files.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0)

  // Resolved once and pinned. The ledger lookup and the record after the
  // upload must describe the same account, or a credential change mid-publish
  // files the id under one and looks for it under the other.
  const scope = await currentScope()
  if (!scope) throw new NotLinkedError()

  const existing = await knownPublicId(input.skillDirectory, scope)
  if (existing) {
    try {
      await altimateRequest<unknown>("PATCH", `/${encodeURIComponent(existing)}`, {
        base: SKILLS_BASE,
        // `replace_bundle` because `files` is the WHOLE bundle every time —
        // `collectBundle` walks the directory, so a path missing from it is a
        // file the user deleted. Without the flag the server refuses any
        // publish that drops a path (409, by design: a partial `files` array
        // from a REST-conventional client used to delete the rest silently).
        // For this client the deletion IS the intent, and saying so is what
        // makes "delete a file, publish again" work at all.
        body: { name: input.name, description: input.description, files, replace_bundle: true },
        allowEmptyBody: true,
        timeoutMs: UPLOAD_TIMEOUT_MS,
      })
      // Attached on update too: a skill published before this project was
      // linked to its current workspace is otherwise updated but still absent
      // from it.
      try {
        await attachToWorkspace(existing, binding.datamateId)
      } catch (err) {
        throw new AttachFailedError(existing, err)
      }
      return {
        action: "updated",
        publicId: existing,
        name: input.name,
        files: files.length,
        bytes,
        datamateId: binding.datamateId,
      }
    } catch (err) {
      // The skill was deleted in the workspace since we published it. Falling
      // through to create is the useful answer; failing would strand the user
      // with a local id they cannot see or clear.
      // The update path answers 409 for three different things, and calling
      // all of them a name conflict told the user to rename a skill whose name
      // was never the problem — with no way forward, since renaming does not
      // help. Told apart by the server's own message.
      if (err instanceof ConflictError) throw updateConflict(err, input.name)
      // 403: the id is someone else's. Reachable through the legacy ledger
      // keys, which predate creator scoping — on a shared machine a row
      // written by another user of the same tenant is found and the server
      // refuses the update. Their skill is not ours to touch; create our own,
      // which records under the scoped key and never consults the legacy one
      // again.
      if (err instanceof ForbiddenError) {
        log.info("published skill belongs to another user; creating our own", { publicId: existing })
      } else if (err instanceof NotFoundError) {
        log.info("published skill no longer exists in the workspace; creating it again", {
          publicId: existing,
        })
      } else throw err
    }
  }

  let created: unknown
  try {
    created = await altimateRequest<unknown>("POST", "", {
      base: SKILLS_BASE,
      body: { name: input.name, description: input.description, files },
      timeoutMs: UPLOAD_TIMEOUT_MS,
    })
  } catch (err) {
    // Names are unique per creator server-side. Reached when the same skill was
    // published from another machine, so this one holds no id for it.
    if (err instanceof ConflictError) throw new SkillNameConflictError(input.name)
    throw err
  }

  const publicId = extractPublicId(created)
  if (!publicId) throw new Error("The workspace accepted the skill but did not return an id for it.")

  await recordPublished(input.skillDirectory, scope, { publicId, tenant: scope.tenant, apiUrl: scope.apiUrl })
  // After the id is recorded, deliberately. If the attach fails, the next
  // publish finds the id, takes the update path, and attaches again — rather
  // than creating a second copy and 409ing on the name.
  try {
    await attachToWorkspace(publicId, binding.datamateId)
  } catch (err) {
    throw new AttachFailedError(publicId, err)
  }
  return { action: "created", publicId, name: input.name, files: files.length, bytes, datamateId: binding.datamateId }
}

/** Which of the update path's conflicts this is. The server distinguishes them
 * in its detail; this module's typed errors then carry advice that fits.
 * Anything unrecognised keeps the server's own words rather than being
 * relabelled — a wrong explanation is worse than a bare one. */
function updateConflict(err: ConflictError, skillName: string): Error {
  const detail = err.detail.message ?? ""
  if (/already have a skill named/i.test(detail)) return new SkillNameConflictError(skillName)
  if (/changed while you were editing/i.test(detail)) return new SkillChangedElsewhereError(skillName)
  return err
}

/** Accepts the documented `{public_id}` and a `{skill: {public_id}}` envelope, so
 * a compat wrapper on either side does not strand the id — the same tolerance
 * `skill-sync` applies to the list and detail shapes. */
function extractPublicId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null
  const direct = (payload as { public_id?: unknown }).public_id
  if (typeof direct === "string" && direct) return direct
  const nested = (payload as { skill?: { public_id?: unknown } }).skill?.public_id
  if (typeof nested === "string" && nested) return nested
  return null
}
