import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Ripgrep } from "../../src/file/ripgrep"

// altimate_change start — upstream_fix: ripgrep exit 2 is PARTIAL, not fatal.
// `search()` discarded stdout on any non-zero exit, so one unreadable file made
// the whole search return [] even though ripgrep had already emitted matches for
// every readable file. Same "one bad thing kills the search" shape as the record
// bug this branch fixes. Drives the real binary, because the behaviour under
// test is ripgrep's exit code.
//
// POSIX-only: `chmod 000` is how the unreadable file is produced, and it does
// not deny access to root or on Windows.
const canDenyRead = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0

describe("legacy Ripgrep.search partial failures", () => {
  test.skipIf(!canDenyRead)(
    "returns matches from readable files when another file cannot be read",
    async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rg-partial-")))
      try {
        await fs.writeFile(path.join(dir, "readable.txt"), "needle here\n")
        const locked = path.join(dir, "locked.txt")
        await fs.writeFile(locked, "needle hidden\n")
        await fs.chmod(locked, 0o000)

        const matches = await Ripgrep.search({ cwd: dir, pattern: "needle", limit: 10 })

        // ripgrep exits 2 here; the readable file's match must survive it.
        expect(matches.map((m) => m.path.text.replace(/^\.\//, ""))).toContain("readable.txt")
      } finally {
        await fs.chmod(path.join(dir, "locked.txt"), 0o644).catch(() => {})
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    120_000,
  )

  // Exit 2 is overloaded: partial failure AND invalid pattern. Accepting every 2
  // as partial would answer a bad regex with an empty success and swallow the
  // real diagnostic.
  test("surfaces an invalid pattern rather than reporting an empty result", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rg-badpattern-")))
    try {
      await fs.writeFile(path.join(dir, "a.txt"), "needle here\n")
      // Asserted by catching rather than `.rejects`, which oxlint flags here as a
      // non-thenable await under this matcher setup.
      let thrown: unknown
      try {
        await Ripgrep.search({ cwd: dir, pattern: "needle[", limit: 10 })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeDefined()
      expect(String(thrown)).toMatch(/regex|pattern/i)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
// altimate_change end
