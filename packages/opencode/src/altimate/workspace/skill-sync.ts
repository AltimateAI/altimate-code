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
import fs from "fs/promises"
import path from "path"
import { createHash } from "node:crypto"
import { Flag as CoreFlag } from "@opencode-ai/core/flag/flag"
import { Log } from "@/altimate/util/log"
import { AltimateApi } from "@/altimate/api/client"
import { readLocalBinding, type CachedBinding } from "./state"
import { altimateRequest, altimateRequestBytes, WorkspaceApiError } from "./api-client"

const log = Log.create({ service: "altimate-workspace-skill-sync" })

/** Base path for the skills API on the backend. */
const SKILLS_BASE = "/datamates/custom-skills"

/** Managed subdirectory. Everything inside is ours and may be replaced
 * wholesale; nothing outside it is ever written or removed. The directory
 * boundary is the ownership marker — we deliberately do NOT stamp a marker
 * into the files themselves, because unlike the VS Code extension (which
 * generates rule files) we mirror author-written content verbatim, and editing
 * it would alter what the model reads and break hash comparison. */
const MANAGED_DIR = path.join(".altimate-code", "skill", "_workspace")
const MANIFEST_NAME = ".manifest.json"

export interface SkillFileEntry {
  path: string
  sha256: string
}

export interface ManifestSkill {
  files: Record<string, string>
}

export interface Manifest {
  version: 1
  tenant: string
  apiUrl: string
  datamateId: number
  skills: Record<string, ManifestSkill>
}

/** A skill as the list endpoint describes it, narrowed to what sync needs. */
interface RemoteSkill {
  public_id: string
  files: SkillFileEntry[]
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

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function readManifest(directory: string): Promise<Manifest | null> {
  try {
    const raw = await fs.readFile(path.join(managedRoot(directory), MANIFEST_NAME), "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return null
    const m = parsed as Partial<Manifest>
    // A manifest we cannot validate is treated as absent, never as ownership:
    // the tree it describes gets replaced rather than trusted.
    if (m.version !== 1) return null
    if (typeof m.datamateId !== "number") return null
    if (typeof m.tenant !== "string" || typeof m.apiUrl !== "string") return null
    if (!m.skills || typeof m.skills !== "object") return null
    return m as Manifest
  } catch {
    return null
  }
}

/** Parse the list response, refusing anything we do not positively recognise.
 *
 * This is the guard that stops a malformed 200 from reading as "the workspace
 * has no skills" and deleting the user's tree — ``api-client``'s list helpers
 * coerce an unrecognised envelope to ``[]``, so an empty array is only
 * trustworthy when it arrived as an actual array. */
function parseSkillList(payload: unknown): RemoteSkill[] | null {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { items?: unknown }).items)
      ? (payload as { items: unknown[] }).items
      : null
  if (!rows) return null
  const out: RemoteSkill[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") return null
    const r = row as { public_id?: unknown; files?: unknown }
    if (typeof r.public_id !== "string" || !r.public_id) return null
    if (!Array.isArray(r.files)) return null
    const files: SkillFileEntry[] = []
    for (const f of r.files) {
      if (!f || typeof f !== "object") return null
      const e = f as { path?: unknown; sha256?: unknown }
      if (typeof e.path !== "string" || typeof e.sha256 !== "string") return null
      // Refuse anything that would escape the skill's own directory.
      if (path.isAbsolute(e.path) || e.path.split(/[\\/]/).includes("..")) return null
      files.push({ path: e.path, sha256: e.sha256 })
    }
    out.push({ public_id: r.public_id, files })
  }
  return out
}

/** Does the on-disk snapshot already match the remote list exactly? */
function upToDate(manifest: Manifest | null, binding: CachedBinding, remote: RemoteSkill[]): boolean {
  if (!manifest) return false
  if (manifest.datamateId !== binding.datamateId) return false
  const ids = Object.keys(manifest.skills)
  if (ids.length !== remote.length) return false
  for (const skill of remote) {
    const local = manifest.skills[skill.public_id]
    if (!local) return false
    if (Object.keys(local.files).length !== skill.files.length) return false
    for (const f of skill.files) {
      if (local.files[f.path] !== f.sha256) return false
    }
  }
  return true
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

    const manifest = await readManifest(canon)

    // Rebind purge. ``recordApprovedBinding`` persists the new binding before
    // any sync runs, and skill discovery loads whatever is on disk without
    // consulting this manifest — so leaving a previous workspace's tree in
    // place through a failed pull would silently feed the model another
    // workspace's skills. Empty is correct here; wrong-workspace is not.
    let creds: { altimateUrl: string; altimateInstanceName: string }
    try {
      creds = await AltimateApi.getCredentials()
    } catch (err) {
      log.warn("no altimate credentials; skipping skill sync", { err: String(err) })
      return
    }

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

    let payload: unknown
    try {
      payload = await altimateRequest<unknown>("GET", "", {
        base: SKILLS_BASE,
        query: { datamate_id: String(binding.datamateId) },
      })
    } catch (err) {
      // A failed list is NOT an empty workspace. Keep what is on disk.
      log.warn("could not list workspace skills; keeping the existing snapshot", {
        err: String(err),
      })
      return
    }

    const remote = parseSkillList(payload)
    if (!remote) {
      log.warn("workspace skill list was not in a recognised shape; keeping the existing snapshot")
      return
    }

    if (!foreign && upToDate(manifest, binding, remote)) return

    if (remote.length === 0) {
      await removeManaged(canon)
      changed = true
      log.info("workspace has no custom skills; removed the local snapshot")
      return
    }

    // Stage a complete snapshot, then swap. A partial bundle is never
    // published: any download or hash failure abandons the staging directory
    // and leaves the previous snapshot untouched.
    const root = managedRoot(canon)
    const staging = `${root}.staging-${process.pid}`
    await fs.rm(staging, { recursive: true, force: true })
    // Record the account this snapshot came from. Discovery does not read the
    // manifest, so this does not gate loading — the purge above is what
    // protects against another workspace's skills reaching the model.
    const next: Manifest = {
      version: 1,
      tenant: creds.altimateInstanceName,
      apiUrl: creds.altimateUrl,
      datamateId: binding.datamateId,
      skills: {},
    }
    try {
      for (const skill of remote) {
        const files: Record<string, string> = {}
        for (const file of skill.files) {
          const bytes = await altimateRequestBytes(
            `/${encodeURIComponent(skill.public_id)}/files/${file.path.split("/").map(encodeURIComponent).join("/")}`,
            { base: SKILLS_BASE },
          )
          const got = hashBytes(bytes)
          if (got !== file.sha256) {
            throw new WorkspaceApiError(
              `checksum mismatch for ${skill.public_id}/${file.path}`,
            )
          }
          const dest = path.join(staging, skill.public_id, file.path)
          await fs.mkdir(path.dirname(dest), { recursive: true })
          await fs.writeFile(dest, bytes)
          files[file.path] = file.sha256
        }
        next.skills[skill.public_id] = { files }
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
  return { changed }
}
