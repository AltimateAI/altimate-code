// altimate_change — shared machine-id helper extracted from plugin/altimate.ts.
// All three call sites (telemetry/index.ts, plugin/altimate.ts, cli/welcome.ts)
// use this to guarantee they converge on the same file and the same UUID value.
import { randomUUID } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { Log } from "./log"

const log = Log.create({ service: "machine-id" })

// Max bytes to read from the machine-id file. A UUID is 36 chars; 512 bytes
// is generous enough for any valid value while capping pathological cases
// (multi-MB symlink targets, garbage-filled files).
const MAX_BYTES = 512

// RFC 4122 v4 UUID — the only format we mint, so the only format we accept.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Read the machine-id from `~/.altimate/machine-id`, minting a new random UUID
 * with `flag: "wx"` (exclusive create) if the file is absent.
 *
 * - **Race-safe**: two concurrent callers on a fresh install converge on the
 *   same UUID — the winner writes, the loser re-reads.
 * - **Size-capped**: reads at most 512 bytes to avoid multi-MB file attacks.
 * - **UUID-validated**: rejects content that does not match RFC 4122 v4 UUID
 *   format (corrupt file, symlink content, etc.) and returns `""` with a warn
 *   log so callers can omit the field rather than propagate garbage.
 *
 * @param machineIdPath Override path (for tests). Defaults to `~/.altimate/machine-id`.
 * @returns A v4 UUID string, or `""` if the value is invalid or unreadable.
 */
export function getOrCreateMachineId(machineIdPath?: string): string {
  const idPath = machineIdPath ?? path.join(os.homedir(), ".altimate", "machine-id")

  // --- Read path ---
  let raw: string | undefined
  try {
    // Cap read size to avoid multi-MB files (corrupt or malicious).
    const stat = fs.statSync(idPath)
    if (stat.size > MAX_BYTES) {
      log.warn("machine-id file exceeds size limit — omitting", { path: idPath, size: stat.size })
      return ""
    }
    raw = fs.readFileSync(idPath, "utf8").trim()
  } catch (readErr) {
    const code = (readErr as NodeJS.ErrnoException)?.code
    if (code !== "ENOENT") {
      // EACCES, EMFILE, etc. — log and bail; we cannot create either.
      log.warn("machine-id read failed", { code, path: idPath })
      return ""
    }
    // File absent — fall through to create path below.
    raw = undefined
  }

  if (raw !== undefined) {
    // Validate before returning: reject corrupt or symlink-injected content.
    if (!UUID_RE.test(raw)) {
      log.warn("machine-id file contains non-UUID content — omitting", { path: idPath })
      return ""
    }
    return raw
  }

  // --- Create path (ENOENT) ---
  // `flag: "wx"` is atomic exclusive-create: the OS guarantees only one writer
  // succeeds. The loser re-reads what the winner wrote.
  const candidate = randomUUID()
  fs.mkdirSync(path.dirname(idPath), { recursive: true })
  try {
    fs.writeFileSync(idPath, candidate, { encoding: "utf8", flag: "wx" })
    return candidate
  } catch (writeErr) {
    const code = (writeErr as NodeJS.ErrnoException)?.code
    if (code !== "EEXIST") {
      log.warn("machine-id create failed", { code, path: idPath })
      return ""
    }
    // Lost the race — read what the winner wrote.
    try {
      const winner = fs.readFileSync(idPath, "utf8").trim()
      if (!UUID_RE.test(winner)) {
        log.warn("machine-id written by race winner is non-UUID — omitting", { path: idPath })
        return ""
      }
      return winner
    } catch (rereadErr) {
      log.warn("machine-id re-read after race failed", {
        code: (rereadErr as NodeJS.ErrnoException)?.code,
        path: idPath,
      })
      return ""
    }
  }
}
