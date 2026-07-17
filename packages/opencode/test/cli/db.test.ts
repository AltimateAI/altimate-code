import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { spawnSync } from "child_process"

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..")
const opencodeDir = path.join(repoRoot, "packages", "opencode")
const cliEntry = path.join(opencodeDir, "src", "index.ts")

function withIsolatedCli(fn: (run: (args: string[]) => ReturnType<typeof spawnSync>) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "altimate-db-cli-"))
  const home = path.join(root, "home")
  mkdirSync(home, { recursive: true })

  const run = (args: string[]) =>
    spawnSync("bun", ["run", "--cwd", opencodeDir, "--conditions=browser", cliEntry, ...args], {
      cwd: root,
      encoding: "utf-8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        XDG_STATE_HOME: path.join(home, "state"),
        OPENCODE_AUTH_CONTENT: "{}",
        OPENCODE_CONFIG_CONTENT: "{}",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_TELEMETRY: "1",
        OPENCODE_DISABLE_SHARE: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_AUTOCOMPACT: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_PURE: "1",
        TERM: "dumb",
        CI: "1",
      },
    })

  try {
    fn(run)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function expectExit(result: ReturnType<typeof spawnSync>, expected: number) {
  expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(expected)
}

describe("db command", () => {
  test("invalid one-shot query exits non-zero with a clean error", () =>
    withIsolatedCli((run) => {
      const result = run(["db", "SELECT * FROM definitely_not_a_table"])

      expectExit(result, 1)
      expect(result.stderr).toContain("Error:")
      expect(result.stderr).not.toContain("Unexpected error")
      expect(result.stderr).not.toContain("stack")
    }),
  )
})
