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
export namespace OptOutMarker {
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
    fs.mkdirSync(dir(), { recursive: true })
    fs.writeFileSync(markerPath(), `${new Date().toISOString()}\n`, { mode: 0o600 })
  }

  export function clear(): void {
    fs.rmSync(markerPath(), { force: true })
  }
}
