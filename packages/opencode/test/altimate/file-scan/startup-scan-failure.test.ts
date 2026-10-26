import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Each fixture runs in its own `bun test` process with a PATH holding only git and tar, so ripgrep is not found
// and the process's own data directory has no cached copy. The fixtures replace the ripgrep download, and
// a proxy that refuses connections (with no bypass list) keeps anything else offline. A child that exits 0
// means every fixture assertion held and nothing was left unhandled: bun fails a run on an unhandled
// rejection even when its tests pass.
async function runFixture(name: string) {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "no-rg-"))
  try {
    // git creates the fixture project; tar (and gzip, which GNU tar runs for `-z`) unpack the archive.
    for (const tool of ["git", "tar", "gzip"]) {
      const found = Bun.which(tool)
      if (found) await fs.symlink(found, path.join(bin, tool))
      else if (tool !== "gzip") throw new Error(`${tool} is required by the ripgrep fixtures`)
    }
    const proxy = "http://127.0.0.1:9"
    const child = Bun.spawn([process.execPath, "test", path.join(import.meta.dir, name)], {
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: { ...process.env, PATH: bin, HTTPS_PROXY: proxy, https_proxy: proxy, NO_PROXY: "", no_proxy: "" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, output: code === 0 ? "" : stdout + stderr }
  } finally {
    await fs.rm(bin, { recursive: true, force: true })
  }
}

// Instance startup scans the project's files in the background, and without ripgrep installed that scan
// downloads it first. A failed download used to be an unhandled rejection, which made bun fail a run whose
// tests had all passed (seen in CI when a nested test run lost its data directory mid-extract). The fixture
// also checks that a failed lookup is retried only after a cooldown, and that a search then recovers.
test.skipIf(process.platform === "win32")(
  "a startup file scan that cannot get ripgrep does not fail the run",
  async () => {
    expect(await runFixture("startup-scan-failure.fixture.ts")).toEqual({ code: 0, output: "" })
  },
  30_000,
)

// A retry is only safe if a failed install leaves nothing behind: a lookup accepts an existing `rg` as is.
test.skipIf(process.platform === "win32")(
  "an interrupted ripgrep extraction leaves nothing half-installed",
  async () => {
    expect(await runFixture("ripgrep-extract-failure.fixture.ts")).toEqual({ code: 0, output: "" })
  },
  30_000,
)
