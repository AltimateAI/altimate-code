import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

const fixture = path.join(import.meta.dir, "fixture", "open-database.ts")

async function launch(data: string) {
  const proc = Bun.spawn(["bun", "run", fixture], {
    cwd: path.join(import.meta.dir, "..", ".."),
    env: { ...process.env, XDG_DATA_HOME: data, OPENCODE_DB: "" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

describe("concurrent first-run database setup", () => {
  test("simultaneous fresh processes never fail with SQLITE_BUSY", async () => {
    // Fresh data directories exercise the WAL switch and migrations, where concurrent starts raced.
    for (let round = 0; round < 3; round++) {
      const data = await fs.mkdtemp(path.join(os.tmpdir(), "altimate-concurrent-db-"))
      try {
        const results = await Promise.all(Array.from({ length: 4 }, () => launch(data)))
        for (const result of results) {
          expect(result.stdout + result.stderr).not.toMatch(/database is locked|SQLITE_BUSY/i)
          expect(result.code).toBe(0)
          expect(result.stdout).toContain("opened")
        }
      } finally {
        await fs.rm(data, { recursive: true, force: true })
      }
    }
  }, 120_000)
})
