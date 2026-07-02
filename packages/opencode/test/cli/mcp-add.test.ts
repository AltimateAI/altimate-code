import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { spawnSync } from "child_process"

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..")
const opencodeDir = path.join(repoRoot, "packages", "opencode")
const cliEntry = path.join(opencodeDir, "src", "index.ts")

function withIsolatedCli(fn: (ctx: { configDir: string; run: (args: string[]) => ReturnType<typeof spawnSync> }) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "altimate-mcp-add-"))
  const home = path.join(root, "home")
  const configHome = path.join(root, "config")
  const dataHome = path.join(root, "data")
  const cacheHome = path.join(root, "cache")
  const stateHome = path.join(root, "state")
  mkdirSync(home, { recursive: true })

  const run = (args: string[]) =>
    spawnSync("bun", ["run", "--cwd", opencodeDir, "--conditions=browser", cliEntry, ...args], {
      cwd: root,
      encoding: "utf-8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_CACHE_HOME: cacheHome,
        XDG_STATE_HOME: stateHome,
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
    fn({ configDir: path.join(configHome, "altimate-code"), run })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function expectExit(result: ReturnType<typeof spawnSync>, expected: number) {
  expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(expected)
}

function readJson(filePath: string) {
  return JSON.parse(readFileSync(filePath, "utf-8"))
}

describe("opencode mcp add (non-interactive subprocess)", () => {
  test("adds a remote server with HTTP headers", () =>
    withIsolatedCli(({ configDir, run }) => {
      const result = run([
        "mcp",
        "add",
        "--name",
        "github",
        "--type",
        "remote",
        "--url",
        "https://example.com/mcp",
        "--header",
        "Authorization=Bearer {env:GITHUB_TOKEN}",
        "--header",
        "X-Option=one=two",
        "--global",
      ])
      expectExit(result, 0)

      // altimate_change — fork global config dir and primary config file are altimate-code.
      const config = readJson(path.join(configDir, "altimate-code.json"))
      expect(config.mcp.github).toEqual({
        type: "remote",
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer {env:GITHUB_TOKEN}",
          "X-Option": "one=two",
        },
      })
    }),
  )

  test("adds a local server while preserving argv and environment values", () =>
    withIsolatedCli(({ configDir, run }) => {
      const result = run([
        "mcp",
        "add",
        "--name",
        "local",
        "--type",
        "local",
        "--env",
        "API_KEY=secret",
        "--env",
        "VALUE=one=two",
        "--global",
        "--",
        "npx",
        "-y",
        "@example/server",
        "--label",
        "two words",
      ])
      expectExit(result, 0)

      // altimate_change — fork global config dir and primary config file are altimate-code.
      const config = readJson(path.join(configDir, "altimate-code.json"))
      expect(config.mcp.local).toEqual({
        type: "local",
        command: ["npx", "-y", "@example/server", "--label", "two words"],
        environment: {
          API_KEY: "secret",
          VALUE: "one=two",
        },
      })
    }),
  )

  test("keeps using an existing opencode.json config file", () =>
    withIsolatedCli(({ configDir, run }) => {
      mkdirSync(configDir, { recursive: true })
      const configPath = path.join(configDir, "opencode.json")
      writeFileSync(configPath, JSON.stringify({ mcp: { existing: { type: "local", command: ["node"] } } }))

      const result = run([
        "mcp",
        "add",
        "--name",
        "github",
        "--type",
        "remote",
        "--url",
        "https://example.com/mcp",
        "--global",
      ])
      expectExit(result, 0)

      const legacyConfig = readJson(configPath)
      expect(existsSync(path.join(configDir, "altimate-code.json"))).toBe(false)
      expect(legacyConfig.mcp.existing).toEqual({ type: "local", command: ["node"] })
      expect(legacyConfig.mcp.github).toEqual({
        type: "remote",
        url: "https://example.com/mcp",
      })
    }),
  )
})
