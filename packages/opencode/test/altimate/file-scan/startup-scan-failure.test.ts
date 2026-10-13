import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Instance startup scans the project's files in the background, and without ripgrep installed that
// scan downloads it first. A failed download or extraction used to be an unhandled rejection, which
// made bun fail a run whose tests had all passed (seen in CI when a nested test run lost its data
// directory mid-extract). The child gets a PATH holding only git and a proxy that refuses
// connections, so the download fails at once. A child that exits 0 means the failure was handled,
// and that a search recovered once ripgrep became available: neither the failed lookup nor the
// failed scan is kept.
test.skipIf(process.platform === "win32")("a startup file scan that cannot get ripgrep does not fail the run", async () => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "no-rg-"))
  try {
    const git = Bun.which("git")
    if (!git) throw new Error("git is required to create the fixture project")
    await fs.symlink(git, path.join(bin, "git"))
    const proxy = "http://127.0.0.1:9"
    const child = Bun.spawn([process.execPath, "test", path.join(import.meta.dir, "startup-scan-failure.fixture.ts")], {
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: { ...process.env, PATH: bin, HTTPS_PROXY: proxy, https_proxy: proxy },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" })
  } finally {
    await fs.rm(bin, { recursive: true, force: true })
  }
}, 30_000)
