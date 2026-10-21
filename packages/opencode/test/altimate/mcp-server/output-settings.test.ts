// altimate_change start — MCP output limits resolve like the agent's config loader
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { outputLimits } from "../../../src/altimate/mcp-server/output-settings"
import { MAX_BYTES, MAX_LINES } from "../../../src/tool/truncate-core"

const VARS = [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "ALTIMATE_CLI_CONFIG",
  "ALTIMATE_CLI_CONFIG_CONTENT",
  "ALTIMATE_CLI_CONFIG_DIR",
  "ALTIMATE_CLI_DISABLE_PROJECT_CONFIG",
]
let saved: Record<string, string | undefined>
let root: string
let repo: string
let cwd: string

const output = (tool_output: Record<string, number>) => JSON.stringify({ tool_output })

beforeEach(async () => {
  cwd = process.cwd()
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]))
  for (const name of VARS) delete process.env[name]
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-output-settings-")))
  repo = path.join(root, "repo")
  await mkdir(path.join(repo, "sub"), { recursive: true })
  const init = Bun.spawnSync(["git", "init", "-q", repo])
  expect(init.exitCode).toBe(0)
  process.chdir(path.join(repo, "sub"))
})

afterEach(async () => {
  process.chdir(cwd)
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(root, { recursive: true, force: true })
})

test("reads inline config through the documented ALTIMATE_CLI_CONFIG_CONTENT name", async () => {
  process.env.ALTIMATE_CLI_CONFIG_CONTENT = output({ max_lines: 3, max_bytes: 300 })
  expect(await outputLimits()).toEqual({ maxLines: 3, maxBytes: 300 })
})

test("reads ALTIMATE_CLI_CONFIG and ALTIMATE_CLI_CONFIG_DIR", async () => {
  const custom = path.join(root, "custom.json")
  await writeFile(custom, output({ max_lines: 4 }))
  const dir = path.join(root, "config-dir")
  await mkdir(dir)
  await writeFile(path.join(dir, "opencode.json"), output({ max_bytes: 400 }))
  process.env.ALTIMATE_CLI_CONFIG = custom
  process.env.ALTIMATE_CLI_CONFIG_DIR = dir
  expect(await outputLimits()).toEqual({ maxLines: 4, maxBytes: 400 })
})

test("stops at the git worktree and ignores altimate-code.* at the project root, as the agent does", async () => {
  await writeFile(path.join(root, "opencode.json"), output({ max_bytes: 999 }))
  await writeFile(path.join(repo, "altimate-code.json"), output({ max_lines: 9 }))
  await writeFile(path.join(repo, "opencode.json"), output({ max_lines: 5 }))
  expect(await outputLimits()).toEqual({ maxLines: 5, maxBytes: MAX_BYTES })
})

test("opencode.jsonc overrides opencode.json in the same directory; .opencode/ applies after", async () => {
  await writeFile(path.join(repo, "opencode.json"), output({ max_lines: 5, max_bytes: 500 }))
  await writeFile(path.join(repo, "opencode.jsonc"), output({ max_lines: 6, max_bytes: 600 }))
  await mkdir(path.join(repo, ".opencode"))
  await writeFile(path.join(repo, ".opencode", "opencode.json"), output({ max_bytes: 700 }))
  expect(await outputLimits()).toEqual({ maxLines: 6, maxBytes: 700 })
})

test("ALTIMATE_CLI_DISABLE_PROJECT_CONFIG skips project files", async () => {
  await writeFile(path.join(repo, "opencode.json"), output({ max_lines: 5 }))
  process.env.ALTIMATE_CLI_DISABLE_PROJECT_CONFIG = "1"
  expect(await outputLimits()).toEqual({ maxLines: MAX_LINES, maxBytes: MAX_BYTES })
})

test("an unreadable config path does not stop startup", async () => {
  await mkdir(path.join(repo, "sub", "opencode.json"))
  await writeFile(path.join(repo, "opencode.jsonc"), output({ max_lines: 8 }))
  expect(await outputLimits()).toEqual({ maxLines: 8, maxBytes: MAX_BYTES })
})
// altimate_change end
