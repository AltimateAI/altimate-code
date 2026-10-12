import { describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"

// `altimate-code run --dir <x>` broke every DuckDB load in two evaluation runs
// (2026-08-31 and 2026-10-12): the duckdb package's node-pre-gyp loader parses the
// HOST process argv and treats `--dir` as its own `--directory`. The driver must not
// load the binding in the host process at all.
describe("duckdb driver with --dir in the host argv", () => {
  test("opens a store and answers a query when process.argv carries --dir <unrelated path>", () => {
    let duckdbAvailable = true
    try {
      require.resolve("duckdb")
    } catch {
      duckdbAvailable = false
    }
    if (!duckdbAvailable) return // optional native dependency absent: nothing to regress

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duckdb-argv-"))
    const unrelated = path.join(dir, "unrelated-run-dir")
    fs.mkdirSync(unrelated)
    const store = path.join(dir, "probe.duckdb")
    const fixture = path.join(import.meta.dir, "fixtures", "duckdb-argv-dir.ts")
    try {
      const out = spawnSync(process.execPath, ["run", fixture, "--dir", unrelated, store], {
        encoding: "utf8",
        timeout: 120_000,
        cwd: unrelated,
      })
      const stdout = out.stdout.trim().split("\n").pop() ?? ""
      expect(out.status, `stderr: ${out.stderr.slice(0, 2000)}`).toBe(0)
      const parsed = JSON.parse(stdout)
      expect(parsed.argv).toEqual(["--dir", unrelated])
      expect(parsed.rows).toHaveLength(1)
      expect(String(parsed.rows[0][0])).toMatch(/^[0-9a-f]{32}$/)
      expect(out.stderr).not.toContain("ENOENT")
      expect(out.stderr).not.toContain("failed to load")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 150_000)
})
