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
import { Log } from "@/altimate/util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { AltimateApi } from "@/altimate/api/client"
import { ConflictError, NotFoundError, altimateRequest } from "./api-client"

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

export class BundleTooLargeError extends Error {}

/** The workspace already has a skill of this name owned by this user, and this
 * machine has no id for it — so it was published from somewhere else.
 *
 * A distinct type rather than re-raising the API's `ConflictError`: that one
 * carries a structured server detail, and constructing a fake one to hold a
 * client-authored sentence would misrepresent the envelope. */
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

  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const relative = path.relative(root, full).split(path.sep).join("/")
      const raw = await fs.readFile(full)
      let content: string
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(raw)
      } catch {
        throw new BinaryFileError(relative)
      }
      bytes += raw.byteLength
      files.push({ path: relative, content })
      if (files.length > MAX_BUNDLE_FILES)
        throw new BundleTooLargeError(`This skill has more than ${MAX_BUNDLE_FILES} files.`)
      if (bytes > MAX_BUNDLE_BYTES)
        throw new BundleTooLargeError(`This skill is larger than ${MAX_BUNDLE_BYTES / (1024 * 1024)}MB.`)
    }
  }

  await walk(root)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return files
}

/** True when this path lives inside the workspace-owned snapshot. */
export function isManagedSkill(projectDirectory: string, skillDirectory: string): boolean {
  const managed = path.resolve(projectDirectory, MANAGED_DIR)
  const candidate = path.resolve(skillDirectory)
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

/** Keyed on the resolved skill directory so a rename of the skill's *name* does
 * not orphan its id, and two skills in different projects cannot collide. */
async function recordPublished(skillDir: string, record: PublishedRecord): Promise<void> {
  const ledger = await readLedger()
  ledger[path.resolve(skillDir)] = record
  try {
    await Filesystem.writeJson(ledgerPath(), ledger)
  } catch (err) {
    // Best-effort. Losing the id costs a 409 on the next publish, not data.
    log.warn("could not record the published skill id", { err: String(err) })
  }
}

async function knownPublicId(skillDir: string): Promise<string | null> {
  const creds = await AltimateApi.getCredentials().catch(() => null)
  if (!creds) return null
  const record = (await readLedger())[path.resolve(skillDir)]
  if (!record) return null
  // Scoped to the account it was published under. The same checkout pointed at a
  // different tenant must not update an id that does not exist there.
  if (record.tenant !== creds.altimateInstanceName || record.apiUrl !== creds.altimateUrl) return null
  return record.publicId
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
  if (isManagedSkill(input.projectDirectory, input.skillDirectory))
    throw new ManagedSkillError(input.skillDirectory)

  const files = await collectBundle(input.skillDirectory)
  if (files.length === 0) throw new BundleTooLargeError("This skill directory has no files to publish.")
  const bytes = files.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0)

  const existing = await knownPublicId(input.skillDirectory)
  if (existing) {
    try {
      await altimateRequest<unknown>("PATCH", `/${encodeURIComponent(existing)}`, {
        base: SKILLS_BASE,
        body: { name: input.name, description: input.description, files },
        allowEmptyBody: true,
      })
      return { action: "updated", publicId: existing, name: input.name, files: files.length, bytes }
    } catch (err) {
      // The skill was deleted in the workspace since we published it. Falling
      // through to create is the useful answer; failing would strand the user
      // with a local id they cannot see or clear.
      if (!(err instanceof NotFoundError)) throw err
      log.info("published skill no longer exists in the workspace; creating it again", {
        publicId: existing,
      })
    }
  }

  let created: unknown
  try {
    created = await altimateRequest<unknown>("POST", "", {
      base: SKILLS_BASE,
      body: { name: input.name, description: input.description, files },
    })
  } catch (err) {
    // Names are unique per creator server-side. Reached when the same skill was
    // published from another machine, so this one holds no id for it.
    if (err instanceof ConflictError) throw new SkillNameConflictError(input.name)
    throw err
  }

  const publicId = extractPublicId(created)
  if (!publicId) throw new Error("The workspace accepted the skill but did not return an id for it.")

  const creds = await AltimateApi.getCredentials()
  await recordPublished(input.skillDirectory, {
    publicId,
    tenant: creds.altimateInstanceName,
    apiUrl: creds.altimateUrl,
  })
  return { action: "created", publicId, name: input.name, files: files.length, bytes }
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
