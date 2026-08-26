// altimate_change - new file
//
// Mirror a bound workspace's custom skill bundles onto disk, where the existing
// skill discovery in ``@/skill`` finds them with no other change.
//
// Scope (v0): custom uploaded bundles only. The 21 skills that ship with the
// binary already live in ``~/.altimate/builtin``, and the datamate-computed
// skills document MCP tool names rather than this CLI's tools — neither is
// synced here.
//
// Activation is deliberately NOT handled: a synced skill is discovered like any
// other, listed in ``<available_skills>`` by name + description, and loaded when
// the model invokes the Skill tool. Whatever frontmatter an author put in the
// bundle flows through untouched.
//
// Server contract (app/api/datamates/custom_skills.py, mounted at ``/skills``):
//   GET ""                       -> Page[CustomSkillSummary]  (paginated)
//   GET "/{public_id}"           -> CustomSkillDetail  (adds files[] + content)
//   GET "/{public_id}/files/{p}" -> raw file bytes
// The summary carries ``file_count``, not an inventory, and nothing in the API
// exposes a checksum — ``CustomSkillFileMeta`` is ``{path, size}``. So change
// detection is per-skill ``updated_at`` and the only integrity check available
// is byte length.
import fs from "fs/promises"
import path from "path"
import { Flag as CoreFlag } from "@opencode-ai/core/flag/flag"
import { Log } from "@/altimate/util/log"
import { AltimateApi } from "@/altimate/api/client"
import { readLocalBinding, type CachedBinding } from "./state"
import { altimateRequest, WorkspaceApiError } from "./api-client"

const log = Log.create({ service: "altimate-workspace-skill-sync" })

/** Base path for the skills API on the backend (``custom_skills_router`` is
 * mounted at ``/skills`` in ``app/main.py``). */
const SKILLS_BASE = "/skills"

/** The list endpoint is paginated by ``add_pagination(app)``; walk every page
 * rather than trusting the first. A bound is kept so a server that never
 * advances ``page`` cannot spin forever. */
const MAX_PAGES = 50

/** Managed subdirectory. Everything inside is ours and may be replaced
 * wholesale; nothing outside it is ever written or removed. The directory
 * boundary is the ownership marker — we deliberately do NOT stamp a marker
 * into the files themselves, because unlike the VS Code extension (which
 * generates rule files) we mirror author-written content verbatim, and editing
 * it would alter what the model reads. */
const MANAGED_DIR = path.join(".altimate-code", "skill", "_workspace")
const MANIFEST_NAME = ".manifest.json"

export interface ManifestSkill {
  /** Server's ``updated_at``, verbatim. The only change signal the API offers. */
  updatedAt: string
  files: Record<string, number>
}

export interface Manifest {
  version: 1
  tenant: string
  apiUrl: string
  datamateId: number
  skills: Record<string, ManifestSkill>
}

/** A row of ``Page[CustomSkillSummary]``, narrowed to what sync needs. */
interface RemoteSummary {
  publicId: string
  updatedAt: string
}

/** ``CustomSkillDetail.files`` — ``CustomSkillFileMeta`` is ``{path, size}``. */
interface RemoteFile {
  path: string
  size: number
}

export function isEnabled(): boolean {
  return CoreFlag.ALTIMATE_WORKSPACE
}

function managedRoot(directory: string): string {
  return path.join(directory, MANAGED_DIR)
}

/** In-flight sync per canonical project directory, so a bind and a session
 * start racing on the same project do not both stage and swap. */
const inFlight = new Map<string, Promise<void>>()

/** Bumped whenever a sync actually changes what is on disk, for any project.
 * Consumers that cache a view of the skill registry compare the value they last
 * acted on against this one, so a sync triggered elsewhere — a mid-session bind,
 * say — still causes them to refresh, without them having to re-run the sync
 * themselves just to learn whether anything moved. */
let generation = 0

export function snapshotGeneration(): number {
  return generation
}

async function readManifest(directory: string): Promise<Manifest | null> {
  try {
    const raw = await fs.readFile(path.join(managedRoot(directory), MANIFEST_NAME), "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return null
    const m = parsed as Partial<Manifest>
    // A manifest we cannot validate is treated as absent, never as ownership:
    // the tree it describes gets rebuilt rather than trusted.
    if (m.version !== 1) return null
    if (typeof m.datamateId !== "number") return null
    if (typeof m.tenant !== "string" || typeof m.apiUrl !== "string") return null
    if (!m.skills || typeof m.skills !== "object") return null
    return m as Manifest
  } catch {
    return null
  }
}

/** Reject a bundle path that would escape the skill's own directory. */
function safeRelativePath(p: unknown): p is string {
  if (typeof p !== "string" || !p) return false
  if (path.isAbsolute(p)) return false
  return !p.split(/[\\/]/).includes("..")
}

/** Read one page of the list endpoint, refusing anything unrecognised.
 *
 * Returning null means "error", never "empty" — the distinction is what stops a
 * malformed 200 from reading as an empty workspace and deleting the user's
 * tree. ``api-client``'s helpers coerce unknown envelopes to ``[]``, so an
 * empty result is only trustworthy when the envelope itself parsed. */
function parsePage(payload: unknown): { rows: RemoteSummary[]; pages: number } | null {
  if (!payload || typeof payload !== "object") return null
  const p = payload as { items?: unknown; pages?: unknown }
  if (!Array.isArray(p.items)) return null
  const pages = typeof p.pages === "number" && p.pages >= 0 ? p.pages : 1
  const rows: RemoteSummary[] = []
  for (const row of p.items) {
    if (!row || typeof row !== "object") return null
    const r = row as { public_id?: unknown; updated_at?: unknown }
    if (typeof r.public_id !== "string" || !r.public_id) return null
    if (typeof r.updated_at !== "string" || !r.updated_at) return null
    rows.push({ publicId: r.public_id, updatedAt: r.updated_at })
  }
  return { rows, pages }
}

/** ``GET /skills/{id}/files/{path}`` answers ``{path, content}``. Anything else
 * is an error, not an empty file — see ``parsePage`` for why that matters. */
function parseFileContent(body: unknown): string | null {
  if (!body || typeof body !== "object") return null
  const c = (body as { content?: unknown }).content
  return typeof c === "string" ? c : null
}

function parseDetailFiles(payload: unknown): RemoteFile[] | null {
  if (!payload || typeof payload !== "object") return null
  // The detail view wraps its body in ``{skill: {...}}`` while the list view
  // does not wrap at all. Verified against a local backend on `development`;
  // the inconsistency is the contract, so accept the wrapper and also the bare
  // object in case the envelope is ever dropped.
  const inner = (payload as { skill?: unknown }).skill
  const body = inner && typeof inner === "object" ? inner : payload
  const files = (body as { files?: unknown }).files
  if (!Array.isArray(files)) return null
  const out: RemoteFile[] = []
  for (const f of files) {
    if (!f || typeof f !== "object") return null
    const e = f as { path?: unknown; size?: unknown }
    if (!safeRelativePath(e.path)) return null
    if (typeof e.size !== "number" || e.size < 0) return null
    out.push({ path: e.path, size: e.size })
  }
  return out
}

async function removeManaged(directory: string): Promise<void> {
  await fs.rm(managedRoot(directory), { recursive: true, force: true })
}

/** Sync the bound workspace's custom skills into ``directory``.
 *
 * Never throws: skills must not be able to block a bind or a turn. Every
 * failure path leaves whatever is already on disk in place, except the
 * deliberate purge described below. */
export async function syncSkills(directory: string): Promise<{ changed: boolean }> {
  if (!isEnabled()) return { changed: false }
  const canon = path.resolve(directory)
  const existing = inFlight.get(canon)
  if (existing) {
    await existing.catch(() => {})
    return { changed: false }
  }
  let changed = false
  const run = (async () => {
    const binding = await readLocalBinding(canon)
    if (!binding) return

    let creds: { altimateUrl: string; altimateInstanceName: string }
    try {
      creds = await AltimateApi.getCredentials()
    } catch (err) {
      log.warn("no altimate credentials; skipping skill sync", { err: String(err) })
      return
    }

    const manifest = await readManifest(canon)

    // Purge on rebind or account change. ``recordApprovedBinding`` persists the
    // new binding before any sync runs, and skill discovery loads whatever is
    // on disk without consulting this manifest — so leaving a previous
    // workspace's tree in place through a failed pull would silently feed the
    // model another workspace's skills. Empty is correct; wrong-workspace is not.
    const foreign =
      manifest !== null &&
      (manifest.datamateId !== binding.datamateId ||
        manifest.tenant !== creds.altimateInstanceName ||
        manifest.apiUrl !== creds.altimateUrl)
    if (foreign) {
      log.info("this project's snapshot belongs to another workspace or account; dropping it", {
        was: manifest.datamateId,
        now: binding.datamateId,
      })
      await removeManaged(canon)
      changed = true
    }

    const remote = await listAll(binding)
    if (!remote) return // error, not empty — keep what is on disk

    if (!foreign && upToDate(manifest, remote)) return

    if (remote.length === 0) {
      await removeManaged(canon)
      changed = true
      log.info("workspace has no custom skills; removed the local snapshot")
      return
    }

    // Stage a complete snapshot, then swap. A partial bundle is never
    // published: any failure abandons the staging directory and leaves the
    // previous snapshot untouched.
    const root = managedRoot(canon)
    const staging = `${root}.staging-${process.pid}`
    await fs.rm(staging, { recursive: true, force: true })
    const next: Manifest = {
      version: 1,
      tenant: creds.altimateInstanceName,
      apiUrl: creds.altimateUrl,
      datamateId: binding.datamateId,
      skills: {},
    }
    try {
      for (const summary of remote) {
        const detail = await altimateRequest<unknown>(
          "GET",
          `/${encodeURIComponent(summary.publicId)}`,
          { base: SKILLS_BASE },
        )
        const files = parseDetailFiles(detail)
        if (!files) throw new WorkspaceApiError(`unrecognised detail for ${summary.publicId}`)
        const recorded: Record<string, number> = {}
        for (const file of files) {
          const encoded = file.path.split("/").map(encodeURIComponent).join("/")
          // The file endpoint answers with ``{path, content}`` JSON, not the raw
          // object — the server decodes the bundle file and hands back a string.
          const body = await altimateRequest<unknown>(
            "GET",
            `/${encodeURIComponent(summary.publicId)}/files/${encoded}`,
            { base: SKILLS_BASE },
          )
          const content = parseFileContent(body)
          if (content === null) {
            throw new WorkspaceApiError(`unrecognised file body for ${summary.publicId}/${file.path}`)
          }
          // No checksum exists in the API, so length is the only integrity check
          // available. `size` is the stored object's byte count, so the
          // comparison has to be on UTF-8 bytes rather than string length — the
          // two differ for any non-ASCII skill. It still catches a truncated
          // download, which is what would otherwise publish half a skill.
          const bytes = Buffer.from(content, "utf8")
          if (bytes.byteLength !== file.size) {
            throw new WorkspaceApiError(
              `size mismatch for ${summary.publicId}/${file.path}: expected ${file.size}, got ${bytes.byteLength}`,
            )
          }
          const dest = path.join(staging, summary.publicId, file.path)
          await fs.mkdir(path.dirname(dest), { recursive: true })
          await fs.writeFile(dest, bytes)
          recorded[file.path] = file.size
        }
        next.skills[summary.publicId] = { updatedAt: summary.updatedAt, files: recorded }
      }
      // Manifest goes inside the staged tree so files and manifest commit
      // together — a snapshot is never live without the record of what it is.
      await fs.writeFile(path.join(staging, MANIFEST_NAME), JSON.stringify(next, null, 2))
      await fs.rm(root, { recursive: true, force: true })
      await fs.mkdir(path.dirname(root), { recursive: true })
      await fs.rename(staging, root)
      changed = true
      log.info("workspace skills synced", {
        datamateId: binding.datamateId,
        skills: remote.length,
      })
    } catch (err) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
      log.warn("workspace skill sync failed; kept the existing snapshot", { err: String(err) })
    }
  })()
  inFlight.set(canon, run)
  try {
    await run
  } catch (err) {
    log.warn("workspace skill sync errored", { err: String(err) })
  } finally {
    inFlight.delete(canon)
  }
  if (changed) generation++
  return { changed }
}

/** Walk every page of the list endpoint. Returns null on any error or
 * unrecognised payload — callers must treat that as "unknown", not "empty". */
async function listAll(binding: CachedBinding): Promise<RemoteSummary[] | null> {
  const all: RemoteSummary[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    let payload: unknown
    try {
      payload = await altimateRequest<unknown>("GET", "", {
        base: SKILLS_BASE,
        query: { datamate_id: String(binding.datamateId), page: String(page) },
      })
    } catch (err) {
      log.warn("could not list workspace skills; keeping the existing snapshot", {
        err: String(err),
      })
      return null
    }
    const parsed = parsePage(payload)
    if (!parsed) {
      log.warn("workspace skill list was not in a recognised shape; keeping the existing snapshot")
      return null
    }
    all.push(...parsed.rows)
    if (page >= parsed.pages || parsed.rows.length === 0) return all
  }
  log.warn("workspace skill list exceeded the page bound; keeping the existing snapshot")
  return null
}

/** Does the on-disk snapshot already match the remote set?
 *
 * Compared on the server's ``updated_at`` per skill, because the API exposes no
 * checksum and the list carries only ``file_count``. */
function upToDate(manifest: Manifest | null, remote: RemoteSummary[]): boolean {
  if (!manifest) return false
  const ids = Object.keys(manifest.skills)
  if (ids.length !== remote.length) return false
  for (const summary of remote) {
    const local = manifest.skills[summary.publicId]
    if (!local || local.updatedAt !== summary.updatedAt) return false
  }
  return true
}
