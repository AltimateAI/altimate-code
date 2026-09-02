// altimate_change - new file
//
// The engine probes against real processes: `versionOf` must settle on the
// engine's own exit, never wait on a descendant that inherited its stdout.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fingerprint, liveBridge, versionOf } from "../../../src/altimate/workspace/engine-probes"

const posix = process.platform !== "win32"

function fakeEngine(script: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "engine-probe-"))
  const bin = path.join(dir, "datamate")
  writeFileSync(bin, `#!/bin/sh\n${script}\n`)
  chmodSync(bin, 0o755)
  return bin
}

describe("fingerprint", () => {
  test("an in-place rewrite that keeps the length and restores the mtime still reads as a new file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "engine-fp-"))
    const bin = path.join(dir, "datamate")
    writeFileSync(bin, "#!/bin/sh\necho 0.6.3\n")
    // A whole-second mtime, as files extracted from a tarball carry, so a
    // later `utimes` can restore it exactly.
    const stamp = Math.floor(Date.now() / 1000) - 60
    utimesSync(bin, stamp, stamp)
    const before = statSync(bin)
    const first = fingerprint(bin)
    // ctime has whole-millisecond resolution on some filesystems; make sure
    // the rewrite lands in a later tick.
    await new Promise((resolve) => setTimeout(resolve, 20))
    writeFileSync(bin, "#!/bin/sh\necho 0.7.1\n") // same byte length
    utimesSync(bin, stamp, stamp) // "postinstall restores the timestamp"
    const after = statSync(bin)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(fingerprint(bin)).not.toBe(first)
  })
  test("null when the file cannot be stat'ed", () => {
    expect(fingerprint(path.join(os.tmpdir(), "engine-fp-missing", "datamate"))).toBeNull()
  })
})

describe("versionOf", () => {
  test.skipIf(!posix)("reads the version even when a descendant keeps stdout open", async () => {
    const bin = fakeEngine('echo "0.7.0"; sleep 5 & exit 0')
    const t0 = Date.now()
    expect(await versionOf(bin)).toBe("0.7.0")
    expect(Date.now() - t0).toBeLessThan(2_000)
  })
  test.skipIf(!posix)("a non-zero exit is unreadable", async () => {
    const bin = fakeEngine('echo "0.7.0"; exit 3')
    expect(await versionOf(bin)).toBeNull()
  })
  test("a binary that cannot be spawned is unreadable", async () => {
    expect(await versionOf(path.join(os.tmpdir(), "definitely-not-here-" + process.pid))).toBeNull()
  })
})

describe("liveBridge", () => {
  // A pid above any realistic pid_max, so the liveness check reports it dead —
  // the same trick the engine's own discovery tests use.
  const DEAD_PID = 2 ** 31 - 1

  function sidecars(entries: Record<string, object>): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "bridge-sidecar-"))
    for (const [name, data] of Object.entries(entries)) {
      writeFileSync(path.join(dir, name), JSON.stringify(data))
    }
    return dir
  }

  test("a live bridge recording this directory is found, from the folder or below it", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "bridge-ws-"))
    // A second live bridge keeps the single-bridge fallback out of play, so
    // these assertions exercise the cwd match alone.
    const dir = sidecars({
      "a.json": { socketPath: "/tmp/a.sock", workspaceFolders: [cwd], pid: process.pid },
      "b.json": { socketPath: "/tmp/b.sock", workspaceFolders: ["/somewhere/else"], pid: process.pid },
    })
    expect(liveBridge(cwd, dir)).toBe(true)
    expect(liveBridge(path.join(cwd, "models", "staging"), dir)).toBe(true)
    // A sibling directory that merely shares the prefix string is not within.
    expect(liveBridge(cwd + "-other", dir)).toBe(false)
  })

  test("a dead bridge is skipped and its sidecar is left for the engine to GC", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "bridge-ws-"))
    const dir = sidecars({
      "a.json": { socketPath: "/tmp/a.sock", workspaceFolders: [cwd], pid: DEAD_PID },
    })
    expect(liveBridge(cwd, dir)).toBe(false)
    expect(statSync(path.join(dir, "a.json")).isFile()).toBe(true)
  })

  test("the sole live bridge counts even for an unrelated directory; two decline to guess", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "bridge-ws-"))
    const one = sidecars({
      "a.json": { socketPath: "/tmp/a.sock", workspaceFolders: ["/somewhere/else"], pid: process.pid },
    })
    expect(liveBridge(cwd, one)).toBe(true)
    const two = sidecars({
      "a.json": { socketPath: "/tmp/a.sock", workspaceFolders: ["/somewhere/else"], pid: process.pid },
      "b.json": { socketPath: "/tmp/b.sock", workspaceFolders: ["/somewhere/third"], pid: process.pid },
    })
    expect(liveBridge(cwd, two)).toBe(false)
  })

  test("garbage is not a bridge: no dir, no socketPath, unparseable JSON", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "bridge-ws-"))
    expect(liveBridge(cwd, path.join(os.tmpdir(), "no-such-dir-" + process.pid))).toBe(false)
    const dir = sidecars({
      "no-sock.json": { workspaceFolders: [cwd], pid: process.pid },
    })
    writeFileSync(path.join(dir, "broken.json"), "{not json")
    writeFileSync(path.join(dir, "not-a-sidecar.txt"), "ignored")
    expect(liveBridge(cwd, dir)).toBe(false)
  })
})
