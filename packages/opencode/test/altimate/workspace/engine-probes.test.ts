// altimate_change - new file
//
// The engine probes against real processes: `versionOf` must settle on the
// engine's own exit, never wait on a descendant that inherited its stdout.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { versionOf } from "../../../src/altimate/workspace/engine-probes"

const posix = process.platform !== "win32"

function fakeEngine(script: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "engine-probe-"))
  const bin = path.join(dir, "datamate")
  writeFileSync(bin, `#!/bin/sh\n${script}\n`)
  chmodSync(bin, 0o755)
  return bin
}

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
