// altimate_change - new file
//
// What the last attach in a directory produced, on disk. The overlay settles
// an attach inside the server process; the TUI plugin (the `/workspace`
// menu, the sidebar tile, the boot box) runs in another, so the memory the
// overlay keeps is invisible to it — the same reason the binding cache lives
// in a file. One small JSON per project directory under the state directory,
// so two processes attaching in different projects never write the same file;
// the oldest files go once there are more than a machine's worth.
//
// Also the one place the attach numbers are counted (`snapshotCounts`) and
// worded (`statusHeadline`): the toast, the status view, the menu row, the
// sidebar and the boot box all read them from here, so they cannot disagree.
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { Global } from "@/global"
import { Log } from "@/altimate/util/log"
import { sanitize } from "@/mcp/catalog"
import type { Declared, Unfulfilled } from "./engine-types"

const log = Log.create({ service: "altimate-workspace-attach-snapshot" })

export interface AttachSnapshot {
  /** The workspace the attach was for. `key` is its identity across
   * credential scopes (`workspaceIdentity`): ids are tenant-local. */
  workspace: { id: string; name: string; key: string }
  engineVersion: string | null
  /** The allowlist the workspace declared at attach time, split like
   * `Declared`; null when the lookup failed and the engine was taken at its word. */
  declared: Declared | null
  /** Every key the engine served under the workspace key, allowlisted or not. */
  present: string[]
  /** The engine's full report; undefined when it sent none. */
  unfulfilled: Unfulfilled[] | undefined
  at: number
}

/** Identity of a workspace across credential scopes: `scope` is the account
 * scope `readLocalBindingScoped` returns (`scopeStringOf`: tenant, URL and
 * credential digest). */
export function workspaceIdentity(scope: string | null | undefined, id: number | string): string {
  return `${scope ?? ""}|${id}`
}

export interface AttachCounts {
  /** Declared tools the engine serves, counted per catalog entry. */
  served: number
  /** Declared keys; undefined when no allowlist could be read. */
  declared: number | undefined
  /** Gaps the engine reported, excluding the expected no-bridge case. */
  gaps: number
  /** Extension-declared tools a live IDE bridge serves. */
  extServed: number
  /** The catalog entries counted, sorted; the attach verdict is keyed on them. */
  callable: string[]
}

/** The attach numbers every surface shows. Compared in the catalog's key space
 * (`present` holds names as the MCP layer sanitised them, the declaration holds
 * raw keys); never a key the engine reports unfulfilled, since two raw keys can
 * sanitise to one name and the report says which of them the served tool is;
 * and counted per catalog entry, so declarations that sanitise to one name are
 * one tool. Ordinary keys are counted before extension keys, so an entry both
 * claim counts once, as ordinary. With no allowlist, everything served counts. */
export function snapshotCounts(s: Pick<AttachSnapshot, "declared" | "present" | "unfulfilled">): AttachCounts {
  const present = new Set(s.present)
  const reported = new Set((s.unfulfilled ?? []).map((u) => u.key))
  const consumed = new Set<string>()
  const count = (keys: string[]) => {
    let n = 0
    for (const k of keys) {
      const entry = sanitize(k)
      if (!present.has(entry) || reported.has(k) || consumed.has(entry)) continue
      consumed.add(entry)
      n += 1
    }
    return n
  }
  const served = s.declared ? count(s.declared.keys) : present.size
  const extServed = s.declared ? count(s.declared.extensionKeys) : 0
  return {
    served,
    declared: s.declared?.keys.length,
    gaps: (s.unfulfilled ?? []).filter((u) => u.reason !== "no-bridge").length,
    extServed,
    callable: [...consumed].sort(),
  }
}

/** The headline every surface shares: counts only, never a key or a reason. */
export function statusHeadline(counts: Pick<AttachCounts, "served" | "declared" | "gaps" | "extServed">): string {
  const parts = [
    counts.declared === undefined
      ? `${counts.served} integration tools available`
      : `${counts.served} of ${counts.declared} integration tools available`,
  ]
  if (counts.gaps > 0) parts.push(`${counts.gaps} need${counts.gaps === 1 ? "s" : ""} attention`)
  if (counts.extServed > 0) parts.push(`${counts.extServed} more via VS Code`)
  return parts.join(" · ")
}

/** Coarse relative age. Deliberately not a timestamp: the point is "is this
 * stale?", and a clock time makes the reader do the subtraction. Floored from
 * the raw elapsed time, so every label owns a full window ("1m ago" is 60–119s). */
export function describeAge(at: number, now = Date.now()): string {
  const ms = Math.max(0, now - at)
  if (ms < 60_000) return "just now"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

interface SnapshotFile {
  version: 2
  directory: string
  snapshot: AttachSnapshot
}

/** Enough for a machine's worth of projects; the oldest go first. */
const MAX_SNAPSHOTS = 64

/** A temp file this old is from a write that never finished, not one in flight. */
const STALE_TEMP_MS = 10 * 60_000

export function snapshotDir(): string {
  return path.join(Global.Path.state, "altimate-attach-snapshots")
}

export function snapshotFile(directory: string): string {
  const id = createHash("sha256").update(path.resolve(directory)).digest("hex").slice(0, 32)
  return path.join(snapshotDir(), `${id}.json`)
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string")

/** The shape this module writes; anything else (a future format, a hand edit)
 * is treated as absent rather than trusted into a TUI poll. */
function isSnapshot(v: unknown): v is AttachSnapshot {
  const s = v as Partial<AttachSnapshot> | null
  if (!s || typeof s !== "object") return false
  const w = s.workspace as Partial<AttachSnapshot["workspace"]> | undefined
  if (!w || typeof w.id !== "string" || typeof w.name !== "string" || typeof w.key !== "string") return false
  if (!isStringArray(s.present) || typeof s.at !== "number") return false
  if (s.engineVersion !== null && typeof s.engineVersion !== "string") return false
  if (s.declared !== null) {
    const d = s.declared as Partial<Declared> | undefined
    if (!d || !isStringArray(d.keys) || !isStringArray(d.extensionKeys)) return false
    if (d.partial !== undefined && d.partial !== true) return false
    // The optional groupings too: the status view iterates them.
    if (d.integrations !== undefined) {
      if (!Array.isArray(d.integrations)) return false
      const ok = d.integrations.every(
        (i) =>
          i &&
          typeof i.id === "string" &&
          (i.name === null || typeof i.name === "string") &&
          typeof i.extension === "boolean" &&
          isStringArray(i.keys),
      )
      if (!ok) return false
    }
    if (d.extensions !== undefined) {
      if (!Array.isArray(d.extensions)) return false
      if (!d.extensions.every((e) => e && typeof e.id === "string" && typeof e.name === "string" && isStringArray(e.keys)))
        return false
    }
  }
  if (s.unfulfilled !== undefined) {
    if (!Array.isArray(s.unfulfilled)) return false
    const entryOk = (u: Partial<Unfulfilled> | null) =>
      !!u &&
      typeof u.key === "string" &&
      typeof u.integrationId === "string" &&
      typeof u.reason === "string" &&
      (u.detail === undefined || typeof u.detail === "string")
    if (!s.unfulfilled.every(entryOk)) return false
  }
  return true
}

/** Best-effort, like every write to the state directory: a read-only home
 * must not turn a successful attach into a failure. Private from the first
 * byte: the engine's report details can carry connection error text, so the
 * temp file is created owner-only and restricted before it is renamed into
 * place, and a file that cannot be restricted is never published. */
export function writeAttachSnapshot(directory: string, snapshot: AttachSnapshot): void {
  try {
    mkdirSync(snapshotDir(), { recursive: true })
    const p = snapshotFile(directory)
    const file: SnapshotFile = { version: 2, directory: path.resolve(directory), snapshot }
    const tmp = `${p}.tmp-${randomBytes(6).toString("hex")}`
    writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 })
    try {
      chmodSync(tmp, 0o600)
      renameSync(tmp, p)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
    prune()
  } catch (err) {
    log.warn("could not write the attach snapshot", { err: String(err) })
  }
}

function prune(now = Date.now()): void {
  const dir = snapshotDir()
  const names = readdirSync(dir)
  // Temp files a write left behind when it was interrupted; a recent one may
  // still be another process's write in flight.
  for (const f of names.filter((n) => n.includes(".json.tmp-"))) {
    try {
      if (now - statSync(path.join(dir, f)).mtimeMs > STALE_TEMP_MS) rmSync(path.join(dir, f), { force: true })
    } catch {
      // Gone already, or not ours to read: nothing to clean.
    }
  }
  const files = names.filter((f) => f.endsWith(".json"))
  if (files.length <= MAX_SNAPSHOTS) return
  const aged = files
    .map((f) => {
      try {
        return { f, mtime: statSync(path.join(dir, f)).mtimeMs }
      } catch {
        return { f, mtime: 0 }
      }
    })
    .sort((a, b) => a.mtime - b.mtime)
  for (const { f } of aged.slice(0, aged.length - MAX_SNAPSHOTS)) rmSync(path.join(dir, f), { force: true })
}

export function readAttachSnapshot(directory: string): AttachSnapshot | undefined {
  const p = snapshotFile(directory)
  if (!existsSync(p)) return undefined
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<SnapshotFile> | null
    if (!raw || raw.version !== 2 || raw.directory !== path.resolve(directory)) return undefined
    return isSnapshot(raw.snapshot) ? raw.snapshot : undefined
  } catch (err) {
    log.warn("attach snapshot file is corrupt, ignoring it", { code: (err as NodeJS.ErrnoException)?.code })
    return undefined
  }
}

/** The last attach in `directory`, but only if it was for the workspace this
 * project is bound to now, under the current credentials. Every surface reads
 * through here, so none can show a snapshot from before a re-link, or from
 * another tenant's workspace that happens to share the id. */
export function currentAttachSnapshot(
  directory: string,
  bound: { scope: string | null | undefined; datamateId: number | string } | null,
): AttachSnapshot | undefined {
  if (!bound) return undefined
  const snapshot = readAttachSnapshot(directory)
  // The id as well as the key: a file whose two disagree is not trusted either way.
  const current =
    snapshot &&
    snapshot.workspace.key === workspaceIdentity(bound.scope, bound.datamateId) &&
    snapshot.workspace.id === String(bound.datamateId)
  return current ? snapshot : undefined
}
