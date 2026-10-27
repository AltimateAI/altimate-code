import fs from "fs"
import path from "path"
import { Global } from "../../global"
import { readExistingMachineId } from "@/altimate/util/machine-id"

/**
 * The marker that says this machine already sent its final ``telemetry_opted_out`` event.
 *
 * A machine that turns telemetry off goes silent, which on the dashboards looks exactly like a
 * client that stopped emitting. So the last event an opted-out machine sends is the opt-out
 * itself, once; the marker is what makes it once. It lives next to the machine id because both
 * describe the machine, not the user, and it is removed when telemetry is turned back on so a
 * later opt-out is recorded again. See ``recordOptOut`` in index.ts.
 *
 * Paths go through ``Global.Path.home`` so a test that sets ``OPENCODE_TEST_HOME`` never reads
 * or writes the real home directory; in a real session that is the same directory the machine
 * id lives in.
 */
function dir(): string {
  return path.join(Global.Path.home, ".altimate")
}

export function markerPath(): string {
  return path.join(dir(), "telemetry-opted-out")
}

/** The machine id minted by an earlier telemetry-enabled run, if any. Never mints one: a machine
 * that never sent telemetry has nothing to mark. Bounded and symlink-safe, like the minting read. */
export function readMachineId(): string | undefined {
  return readExistingMachineId(path.join(dir(), "machine-id")) || undefined
}

export function exists(): boolean {
  return fs.existsSync(markerPath())
}

export function write(): void {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  // Exclusive create: never follow a planted symlink; an existing entry fails the write.
  fs.writeFileSync(markerPath(), `${new Date().toISOString()}\n`, { mode: 0o600, flag: "wx" })
}

/** A send older than this is a process that died mid-send; its claim no longer holds. The send
 * itself is capped at 3 s. */
const CLAIM_STALE_MS = 30_000

function claimPath(): string {
  return path.join(dir(), "telemetry-opted-out.sending")
}

/**
 * Claim the one opt-out send, across threads and processes: an exclusive create of an in-flight
 * file next to the marker. The TUI's main thread and its worker both init telemetry, so without
 * this the first opted-out launch sent the event twice. False when another send holds a fresh
 * claim (or the file cannot be created); a claim left by a process that died is taken over.
 */
export function claim(): boolean {
  const create = () => fs.writeFileSync(claimPath(), `${process.pid}\n`, { mode: 0o600, flag: "wx" })
  try {
    create()
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return false
  }
  try {
    const age = Date.now() - fs.lstatSync(claimPath()).mtimeMs
    if (age < CLAIM_STALE_MS) return false
    fs.rmSync(claimPath(), { force: true })
    create()
    return true
  } catch {
    return false
  }
}

/** Give the claim back: after the marker is written, or when the send failed so a later launch tries. */
export function release(): void {
  try {
    fs.rmSync(claimPath(), { force: true })
  } catch {
    // a leftover claim goes stale and is taken over
  }
}

/** Best effort: an unremovable marker (read-only directory) must never fail an init. */
export function clear(): void {
  try {
    fs.rmSync(markerPath(), { force: true })
  } catch {
    // leave it; the next opt-out is then not recorded again, which is the lesser failure
  }
}

export * as OptOutMarker from "./opt-out"
