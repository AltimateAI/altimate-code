/**
 * TUI e2e test harness.
 *
 * Spawns the altimate-code TUI inside a pseudo-terminal so tests can drive it
 * via keystrokes and assert on rendered output. Built on `bun-pty` (already a
 * runtime dependency for the production PTY layer) and `strip-ansi` for
 * matching against the visible-text projection of the captured stream.
 *
 * Coverage goal: behaviors that depend on the actual rendered TUI — keystroke
 * bindings, dialog flows, dropdowns, focus management. For pure picker-data
 * questions (e.g. "is `claude-opus-4-7` in `Provider.list()`?") the cheaper
 * `Provider.list()` / `GET /config/providers` tests already exist.
 *
 * Typical shape:
 *   const tui = await launchTui({ cwd: tmp.path })
 *   try {
 *     await tui.waitForText("ready")
 *     tui.sendKey("Ctrl-X")
 *     tui.write("m")
 *     await tui.waitForText("Snowflake Cortex", { timeoutMs: 5000 })
 *     expect(tui.text()).toMatch(/claude-opus-4-7/)
 *   } finally {
 *     await tui.dispose()
 *   }
 */

import path from "path"
import { spawn as ptySpawn } from "bun-pty"
import stripAnsi from "strip-ansi"

const INDEX_TS = path.resolve(__dirname, "../../src/index.ts")
const PACKAGE_ROOT = path.resolve(__dirname, "../..")
const BUN = process.execPath

export const SPECIAL_KEYS = {
  Enter: "\r",
  Tab: "\t",
  Escape: "\x1b",
  Backspace: "\x7f",
  Up: "\x1b[A",
  Down: "\x1b[B",
  Right: "\x1b[C",
  Left: "\x1b[D",
  "Ctrl-C": "\x03",
  "Ctrl-D": "\x04",
  "Ctrl-X": "\x18",
  "Ctrl-A": "\x01",
  "Ctrl-M": "\r",
  "Ctrl-N": "\x0e",
  "Ctrl-P": "\x10",
} as const
export type KeyName = keyof typeof SPECIAL_KEYS

export type LaunchOptions = {
  /**
   * Project directory to pass to the TUI as its positional `[project]`
   * argument. This becomes the workspace the TUI operates against — not the
   * cwd of the child process. The child runs with cwd=`packages/opencode/`
   * so Bun resolves the OpenTUI/Solid JSX runtime via the package's tsconfig.
   */
  cwd: string
  /** Extra argv after the entry path. Default `[]`. The harness already passes the project dir. */
  args?: string[]
  /** Terminal columns. Default 120. */
  cols?: number
  /** Terminal rows. Default 40. */
  rows?: number
  /** Extra environment variables to merge into the spawned process. */
  env?: Record<string, string>
  /** Initial waitForText boot timeout in ms. Default 15_000. */
  bootTimeoutMs?: number
  /**
   * If set, harness waits for this text before returning. Default `undefined`
   * (caller is responsible for the first wait).
   */
  waitForReady?: string
}

export type TuiSession = {
  /** Process id of the PTY child. */
  pid: number
  /** Write raw text to stdin. */
  write(data: string): void
  /** Send a named key. Throws on unknown name. */
  sendKey(key: KeyName): void
  /** Captured stdout, ANSI escapes stripped. Includes the entire stream so far. */
  text(): string
  /** Captured stdout with ANSI preserved (useful for debugging on assertion failure). */
  rawText(): string
  /**
   * Resolve when `needle` (string or regex) appears in the stripped output.
   * Rejects with a descriptive error on timeout. Polls every ~50ms.
   */
  waitForText(needle: string | RegExp, opts?: { timeoutMs?: number }): Promise<void>
  /** Resize the pseudo-terminal. */
  resize(cols: number, rows: number): void
  /** Kill the child + remove listeners. Idempotent. */
  dispose(): Promise<void>
  /** Exit-code promise — resolves when child exits. */
  exited: Promise<{ exitCode: number; signal?: number | string }>
}

const DEFAULT_BOOT_TIMEOUT_MS = 15_000
const DEFAULT_WAIT_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 50

export async function launchTui(opts: LaunchOptions): Promise<TuiSession> {
  const cols = opts.cols ?? 120
  const rows = opts.rows ?? 40
  // Pass the project directory as the TUI's positional [project] argument.
  // Child cwd must remain inside the package so Bun resolves the OpenTUI/Solid
  // JSX import source via packages/opencode/tsconfig.json — without that, the
  // child crashes with `Cannot find module 'react/jsx-dev-runtime'`.
  const args = ["run", INDEX_TS, opts.cwd, ...(opts.args ?? [])]

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // Force TTY-shaped behavior + colorless rendering where possible to keep
    // ANSI noise low. The TUI still emits its own SGR escapes; strip-ansi
    // handles those.
    TERM: "xterm-256color",
    FORCE_COLOR: "0",
    // Disable analytics in tests.
    OPENCODE_DISABLE_TELEMETRY: "1",
    ...opts.env,
  }

  const child = ptySpawn(BUN, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: PACKAGE_ROOT,
    env,
  })

  let raw = ""
  let stripped = ""
  child.onData((data) => {
    const chunk = data.toString()
    raw += chunk
    stripped += stripAnsi(chunk)
  })

  const exited = new Promise<{ exitCode: number; signal?: number | string }>((resolve) => {
    child.onExit((event) => resolve(event))
  })

  let disposed = false

  const session: TuiSession = {
    pid: child.pid,
    write(data) {
      if (disposed) return
      child.write(data)
    },
    sendKey(key) {
      const seq = SPECIAL_KEYS[key]
      if (seq === undefined) throw new Error(`unknown key: ${key}`)
      if (disposed) return
      child.write(seq)
    },
    text() {
      return stripped
    },
    rawText() {
      return raw
    },
    resize(c, r) {
      if (disposed) return
      child.resize(c, r)
    },
    async waitForText(needle, waitOpts) {
      const timeoutMs = waitOpts?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
      const deadline = Date.now() + timeoutMs
      const matches = (s: string) => (typeof needle === "string" ? s.includes(needle) : needle.test(s))
      if (matches(stripped)) return
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
        if (matches(stripped)) return
      }
      throw new Error(
        `waitForText timed out after ${timeoutMs}ms waiting for ${
          typeof needle === "string" ? JSON.stringify(needle) : needle.toString()
        }\n\n--- captured (stripped, last 4000 chars) ---\n${stripped.slice(-4000)}\n--- end ---`,
      )
    },
    async dispose() {
      if (disposed) return
      disposed = true
      try {
        child.kill("SIGTERM")
      } catch {
        // already gone
      }
      // give the process a beat to exit cleanly before returning
      await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))])
    },
    exited,
  }

  if (opts.waitForReady !== undefined) {
    try {
      await session.waitForText(opts.waitForReady, {
        timeoutMs: opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS,
      })
    } catch (err) {
      await session.dispose()
      throw err
    }
  }

  return session
}
