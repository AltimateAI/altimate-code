// Ctrl+C while `auth login` waits for a browser sign-in must exit 130, not 0.
//
// The wait used a clack spinner. In a terminal its raw-mode stdin turned Ctrl+C into
// `process.exit(0)`, so `auth login ... && altimate-code link` carried on after a canceled
// sign-in. Without a terminal its SIGINT listener swallowed the signal and the process kept
// waiting until the sign-in timed out.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn as ptySpawn } from "@opencode-ai/core/pty/pty.bun"

const cliEntry = path.resolve(import.meta.dir, "../../src/index.ts")
const argv = ["run", "--conditions=browser", cliEntry, "auth", "login", "-p", "fake-oauth"]
const WAITING = "Waiting for authorization"

// An OAuth "auto" method whose browser callback never completes.
const fakeAuthPlugin = `export const FakeAuth = async () => ({
  auth: {
    provider: "fake-oauth",
    methods: [
      {
        type: "oauth",
        label: "Fake browser sign-in",
        authorize: async () => ({
          url: "https://example.test/authorize",
          method: "auto",
          callback: () => new Promise(() => {}),
        }),
      },
    ],
  },
})
`

let root: string
let env: Record<string, string>

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "auth-login-cancel-"))
  const pluginPath = path.join(root, "fake-auth.ts")
  await fs.writeFile(pluginPath, fakeAuthPlugin)
  env = {
    ...(process.env as Record<string, string>),
    OPENCODE_TEST_HOME: root,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, ".config"),
    XDG_DATA_HOME: path.join(root, ".local/share"),
    XDG_STATE_HOME: path.join(root, ".local/state"),
    XDG_CACHE_HOME: path.join(root, ".cache"),
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_TELEMETRY: "1",
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [`file://${pluginPath}`] }),
  }
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

// Fails with `what()` evaluated at timeout, so the message carries the output captured so far.
async function waitFor(check: () => boolean, ms: number, what: () => string) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${what()} (after ${ms}ms)`)
    await Bun.sleep(50)
  }
}

async function exitWithin<T>(exited: Promise<T>, ms: number, what: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} after ${ms}ms`)), ms)
  })
  return Promise.race([exited, timeout]).finally(() => clearTimeout(timer))
}

// Spawns the real CLI, so like cliIt tests it runs only in CI's bounded subprocess pass.
// Windows has no POSIX signals or Ctrl+C-as-SIGINT through a PTY.
describe.skipIf(!!process.env.OPENCODE_SKIP_SUBPROCESS || process.platform === "win32")("auth login cancel", () => {
  test("Ctrl+C in a terminal exits 130", async () => {
    const child = ptySpawn(process.execPath, argv, { name: "xterm-256color", cols: 120, rows: 40, cwd: root, env })
    let output = ""
    child.onData((data) => {
      output += data.toString()
    })
    const exited = new Promise<{ exitCode: number }>((resolve) => child.onExit(resolve))
    try {
      await waitFor(
        () => output.includes(WAITING),
        60_000,
        () => `never printed "${WAITING}": ${output}`,
      )
      child.write("\x03")
      const { exitCode } = await exitWithin(exited, 10_000, "still running after Ctrl+C")
      expect(exitCode).toBe(130)
      expect(output).toContain("Sign-in canceled.")
    } finally {
      child.kill()
    }
  }, 90_000)

  test("SIGINT without a terminal exits 130 instead of waiting for the timeout", async () => {
    const proc = Bun.spawn([process.execPath, ...argv], {
      cwd: root,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    let output = ""
    const decoder = new TextDecoder()
    const drained = (async () => {
      const reader = proc.stdout.getReader()
      for (let next = await reader.read(); !next.done; next = await reader.read()) output += decoder.decode(next.value)
    })()
    try {
      await waitFor(
        () => output.includes(WAITING),
        60_000,
        () => `never printed "${WAITING}": ${output}`,
      )
      proc.kill("SIGINT")
      expect(await exitWithin(proc.exited, 10_000, "still running after SIGINT")).toBe(130)
      expect(await new Response(proc.stderr).text()).toContain("Sign-in canceled.")
    } finally {
      proc.kill("SIGKILL")
      await drained
    }
  }, 90_000)
})
