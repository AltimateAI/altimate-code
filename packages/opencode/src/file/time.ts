import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { Flag } from "../flag/flag"
import { Filesystem } from "../util/filesystem"

export namespace FileTime {
  const log = Log.create({ service: "file.time" })
  // altimate_change start — track the file snapshot seen at read time so edit freshness checks compare against the observed mtime instead of Date.now(), avoiding false positives from clock skew or delayed mtime updates
  type ReadState = {
    at: Date
    mtime: Date | undefined
  }

  function snapshot(file: string): ReadState {
    const at = new Date()
    const mtime = Filesystem.stat(file)?.mtime
    return {
      at,
      mtime: mtime ? new Date(mtime.getTime()) : undefined,
    }
  }
  // altimate_change end
  // Per-session read times plus per-file write locks.
  // All tools that overwrite existing files should run their
  // assert/read/write/update sequence inside withLock(filepath, ...)
  // so concurrent writes to the same file are serialized.
  export const state = Instance.state(() => {
    const read: {
      [sessionID: string]: {
        [path: string]: ReadState | undefined
      }
    } = {}
    const locks = new Map<string, Promise<void>>()
    return {
      read,
      locks,
    }
  })

  export function read(sessionID: string, file: string) {
    log.info("read", { sessionID, file })
    const { read } = state()
    read[sessionID] = read[sessionID] || {}
    // altimate_change start — store both the wall-clock read time and the mtime seen for that read so later asserts can compare against the file version that was actually observed
    read[sessionID][file] = snapshot(file)
    // altimate_change end
  }

  export function get(sessionID: string, file: string) {
    // altimate_change start — preserve the existing public API by returning the read timestamp while keeping the richer snapshot internal
    return state().read[sessionID]?.[file]?.at
    // altimate_change end
  }

  export async function withLock<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
    const current = state()
    const currentLock = current.locks.get(filepath) ?? Promise.resolve()
    let release: () => void = () => {}
    const nextLock = new Promise<void>((resolve) => {
      release = resolve
    })
    const chained = currentLock.then(() => nextLock)
    current.locks.set(filepath, chained)
    await currentLock
    try {
      return await fn()
    } finally {
      release()
      if (current.locks.get(filepath) === chained) {
        current.locks.delete(filepath)
      }
    }
  }

  export async function assert(sessionID: string, filepath: string) {
    if (Flag.OPENCODE_DISABLE_FILETIME_CHECK === true) {
      return
    }

    // altimate_change start — compare the current mtime against the mtime captured when the file was last read, which avoids rejecting unchanged files when filesystem mtimes run slightly ahead of Date.now()
    const time = state().read[sessionID]?.[filepath]
    if (!time) throw new Error(`You must read file ${filepath} before overwriting it. Use the Read tool first`)
    const mtime = Filesystem.stat(filepath)?.mtime
    const baseline = time.mtime ?? time.at
    // Allow a 50ms tolerance for Windows NTFS timestamp fuzziness / async flushing
    if (mtime && mtime.getTime() > baseline.getTime() + 50) {
      throw new Error(
        `File ${filepath} has been modified since it was last read.\nLast modification: ${mtime.toISOString()}\nLast read: ${time.at.toISOString()}\n\nPlease read the file again before modifying it.`,
      )
    }
    // altimate_change end
  }
}
