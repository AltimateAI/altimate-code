// altimate_change - new file
//
// What the last attach in a directory produced, on disk. The overlay settles
// an attach inside the server process; the TUI plugin (the `/workspace`
// menu, the sidebar tile) runs in another, so the memory the overlay keeps is
// invisible to it — the same reason the binding cache lives in a file. One
// small JSON under the state directory, keyed by project directory, latest
// attach per directory, bounded.
import path from "node:path"
import { chmodSync, existsSync, readFileSync } from "node:fs"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Log } from "@/altimate/util/log"
import type { Declared, Unfulfilled } from "./engine-types"

const log = Log.create({ service: "altimate-workspace-attach-snapshot" })

export interface AttachSnapshot {
  workspace: { id: string; name: string }
  engineVersion: string | null
  /** The allowlist the workspace declared, split like `Declared`; null when
   * the lookup failed and the engine was taken at its word. */
  declared: Declared | null
  /** Every key the engine served under the workspace key, allowlisted or not. */
  present: string[]
  /** The engine's full report; undefined when it sent none. */
  unfulfilled: Unfulfilled[] | undefined
  /** Extension-declared keys a live IDE bridge served. */
  extServed: number
  at: number
}

interface SnapshotFile {
  version: 1
  snapshots: Record<string, AttachSnapshot>
}

/** Enough for a machine's worth of projects; the oldest go first. */
const MAX_SNAPSHOTS = 64

export function snapshotPath(): string {
  return path.join(Global.Path.state, "altimate-attach-snapshots.json")
}

function readFile(): SnapshotFile | null {
  const p = snapshotPath()
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<SnapshotFile> | null
    if (!raw || raw.version !== 1 || typeof raw.snapshots !== "object" || raw.snapshots === null) return null
    return raw as SnapshotFile
  } catch (err) {
    log.warn("attach snapshot file is corrupt, discarding", { code: (err as NodeJS.ErrnoException)?.code })
    return null
  }
}

/** Best-effort, like every write to the state directory: a read-only home
 * must not turn a successful attach into a failure. */
export function writeAttachSnapshot(directory: string, snapshot: AttachSnapshot): void {
  try {
    const file = readFile() ?? { version: 1, snapshots: {} }
    file.snapshots[path.resolve(directory)] = snapshot
    const entries = Object.entries(file.snapshots)
    if (entries.length > MAX_SNAPSHOTS) {
      entries.sort((a, b) => a[1].at - b[1].at)
      file.snapshots = Object.fromEntries(entries.slice(entries.length - MAX_SNAPSHOTS))
    }
    const p = snapshotPath()
    Filesystem.writeJsonAtomic(p, file)
    try {
      chmodSync(p, 0o600)
    } catch {
      // Umask permissions until the next write; the file holds tool keys, not credentials.
    }
  } catch (err) {
    log.warn("could not write the attach snapshot", { err: String(err) })
  }
}

export function readAttachSnapshot(directory: string): AttachSnapshot | undefined {
  return readFile()?.snapshots[path.resolve(directory)]
}
