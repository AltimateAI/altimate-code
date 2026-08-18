// altimate_change - new file
//
// Maps a memory block's logical identity to the id of the cloud record holding
// it, so a later save updates that record instead of creating a second one.
//
// Scoped to (tenant, apiUrl, credential) at the top level. The credential is
// included because records are per-user: two people sharing a machine and a
// tenant would otherwise share this map and update each other's records. Only a
// short digest of the API key is stored — never the key.
//
// Same file conventions as ./state.ts — Global.Path.state, 0o600, atomic write,
// discard on corrupt — so the two behave identically under the same failures.
import { createHash } from "node:crypto"
import { chmodSync, existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { AltimateApi } from "@/altimate/api/client"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Log } from "@/altimate/util/log"

const INDEX_VERSION = 1

const log = Log.create({ service: "altimate-workspace-memory-index" })

export interface IndexEntry {
  /** The cloud record's id. */
  memoryId: string
  /** Digest of the block's mirrored payload, used to skip a push when nothing
   * a reader would see has changed. Deliberately not part of the logical key —
   * a key that moves when content changes could never find the record it means
   * to update. */
  contentHash: string
  syncedAt: number
}

interface IndexFile {
  version: 1
  tenant: string
  apiUrl: string
  /** Digest of the API key. Identifies the account without storing a secret. */
  account: string
  records: Record<string, IndexEntry>
}

export function indexPath(): string {
  return path.join(Global.Path.state, "altimate-workspace-memory-index.json")
}

/** The logical identity of a mirrored block.
 *
 * Project blocks include the workspace AND the originating project: block ids
 * are only unique within a project directory, so two projects bound to one
 * workspace can each hold a ``warehouse/snowflake``. Global blocks carry
 * neither — they belong to the account and are the same block everywhere. */
export function indexKey(input: {
  scope: "global" | "project"
  blockId: string
  datamateId?: number
  projectKey?: string
}): string {
  if (input.scope === "global") return `global::${input.blockId}`
  return `project::${input.datamateId ?? "unbound"}::${input.projectKey ?? "unknown"}::${input.blockId}`
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function isValidIndexFile(raw: unknown): raw is IndexFile {
  if (!raw || typeof raw !== "object") return false
  const r = raw as Record<string, unknown>
  if (r.version !== INDEX_VERSION) return false
  for (const key of ["tenant", "apiUrl", "account"]) {
    if (typeof r[key] !== "string" || !r[key]) return false
  }
  if (!r.records || typeof r.records !== "object" || Array.isArray(r.records)) return false
  for (const v of Object.values(r.records as Record<string, unknown>)) {
    if (!v || typeof v !== "object") return false
    const e = v as Record<string, unknown>
    if (typeof e.memoryId !== "string" || !e.memoryId) return false
    if (typeof e.contentHash !== "string") return false
    if (typeof e.syncedAt !== "number") return false
  }
  return true
}

function readFile(): IndexFile | null {
  const p = indexPath()
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown
    if (!isValidIndexFile(raw)) return null
    return raw
  } catch (err) {
    log.warn("workspace memory index is corrupt, discarding", {
      code: (err as NodeJS.ErrnoException)?.code,
    })
    return null
  }
}

function writeFile(next: IndexFile): void {
  const p = indexPath()
  Filesystem.writeJsonAtomic(p, next)
  try {
    chmodSync(p, 0o600)
  } catch (err) {
    log.warn("could not chmod workspace memory index", {
      code: (err as NodeJS.ErrnoException)?.code,
    })
  }
}

interface Scope {
  tenant: string
  apiUrl: string
  account: string
}

async function currentScope(): Promise<Scope | null> {
  // Defensive for the same reason as state.ts::tenantKey — a corrupt
  // credentials file or schema drift must read as "no credentials", never as a
  // rejection into a fire-and-forget mirror call.
  try {
    if (!(await AltimateApi.isConfigured())) return null
    const c = await AltimateApi.getCredentials()
    return {
      tenant: c.altimateInstanceName,
      apiUrl: c.altimateUrl,
      account: digest(c.altimateApiKey),
    }
  } catch (err) {
    log.warn("could not resolve credentials for memory index scoping", { err: String(err) })
    return null
  }
}

function matches(file: IndexFile, scope: Scope): boolean {
  return file.tenant === scope.tenant && file.apiUrl === scope.apiUrl && file.account === scope.account
}

// Serializes read-modify-write within this process. Two mirror tasks finishing
// at once would otherwise both read the pre-write file and the second would
// drop the first's entry. Cross-process races remain — the same known gap as
// ./state.ts — and cost a duplicate record, which the next save repairs.
let writeChain: Promise<void> = Promise.resolve()

export async function readIndex(): Promise<Record<string, IndexEntry>> {
  const scope = await currentScope()
  if (!scope) return {}
  const file = readFile()
  if (!file || !matches(file, scope)) return {}
  return file.records
}

export async function readIndexEntry(key: string): Promise<IndexEntry | null> {
  return (await readIndex())[key] ?? null
}

/** Upsert one entry. Best-effort: losing the map costs a duplicate record on
 * the next save, never a failed local memory write. */
export async function recordIndexEntry(key: string, entry: IndexEntry): Promise<void> {
  const scope = await currentScope()
  if (!scope) return
  const task = writeChain.then(async () => {
    try {
      const existing = readFile()
      const file: IndexFile =
        existing && matches(existing, scope)
          ? existing
          : { version: INDEX_VERSION, ...scope, records: {} }
      file.records[key] = entry
      writeFile(file)
    } catch (err) {
      log.warn("could not persist workspace memory index", {
        code: (err as NodeJS.ErrnoException)?.code,
        err: String(err),
      })
    }
  })
  writeChain = task.catch(() => {})
  return task
}
