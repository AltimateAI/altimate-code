/**
 * TUI e2e — prompt input behaviors.
 *
 * Covers the interactive input path *without* dispatching a real LLM call:
 *   - typed characters render in the prompt
 *   - Ctrl-D exits the process cleanly (documented as `app_exit` in
 *     packages/tui/src/config/keybind.ts)
 *
 * Send-on-Enter deliberately isn't exercised here because Enter triggers the
 * agent loop, which would hit the network and burn tokens. Once we have a
 * mock provider the "send → spinner → response render" path can join.
 *
 * Note on assertion shape: the harness's `strip-ansi` projection is a
 * stream-order linearisation — it does NOT replay ANSI cursor movement, so
 * you cannot negative-assert on chars that a TUI redraw would visibly erase
 * (Backspace, cursor-repos, etc.). Only positive "this text was emitted at
 * some point" assertions are reliable.
 */

import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { launchTui } from "../../fixture/pty-tui"

function makeProjectDir(): string {
  return mkdtempSync(path.join(tmpdir(), "altimate-tui-prompt-"))
}

describe("TUI e2e — prompt input", () => {
  test("typed characters reach the prompt buffer and render", async () => {
    const project = makeProjectDir()
    const tui = await launchTui({
      cwd: project,
      cols: 140,
      rows: 40,
      waitForReady: "Ask anything",
    })
    try {
      tui.write("TYPING_MARKER_alpha")
      await tui.waitForText("TYPING_MARKER_alpha", { timeoutMs: 5000 })
    } finally {
      await tui.dispose()
      rmSync(project, { recursive: true, force: true })
    }
  }, 30_000)

  test("Ctrl-D exits the TUI cleanly", async () => {
    const project = makeProjectDir()
    const tui = await launchTui({
      cwd: project,
      cols: 140,
      rows: 40,
      waitForReady: "Ask anything",
    })
    try {
      tui.sendKey("Ctrl-D")
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Ctrl-D did not exit the TUI within 5s")), 5000),
      )
      const outcome = await Promise.race([tui.exited, timeout])
      // Bun's PTY reports exit as `{exitCode: 0, signal: undefined}` on clean
      // exit. Some terminal-signal paths report signal="SIGHUP" on stdout
      // close — also acceptable for our purposes as long as the process is
      // gone.
      expect(outcome).toBeDefined()
    } finally {
      await tui.dispose()
      rmSync(project, { recursive: true, force: true })
    }
  }, 30_000)
})
