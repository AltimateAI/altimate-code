/**
 * TUI e2e — terminal resize handling.
 *
 * Boots the TUI at a modest terminal size, resizes the PTY to something
 * larger, and asserts the process:
 *   - stays alive across the resize (no crash / no exit)
 *   - continues to accept keystrokes (input pipe still wired)
 *   - re-renders the prompt string (renderer didn't wedge)
 *
 * The renderer typically re-emits the whole frame on SIGWINCH; we sample
 * that with a fresh typed marker after the resize so the assertion doesn't
 * depend on flushing the pre-resize buffer.
 */

import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { launchTui } from "../../fixture/pty-tui"

function makeProjectDir(): string {
  return mkdtempSync(path.join(tmpdir(), "altimate-tui-resize-"))
}

describe("TUI e2e — terminal resize", () => {
  test("resize from 80x25 to 200x60 keeps the TUI alive and responsive", async () => {
    const project = makeProjectDir()
    const tui = await launchTui({
      cwd: project,
      cols: 80,
      rows: 25,
      waitForReady: "Ask anything",
    })
    try {
      tui.resize(200, 60)
      // Give the renderer a beat to handle SIGWINCH and repaint.
      await new Promise((r) => setTimeout(r, 500))

      // Type a post-resize marker — proves the input pipe survived the
      // resize and the renderer is still emitting.
      tui.write("POST_RESIZE_MARKER")
      await tui.waitForText("POST_RESIZE_MARKER", { timeoutMs: 5000 })

      // Also verify the process itself is still alive (no crash on resize).
      // We race a tiny timeout against `exited`; if the process has died the
      // exit promise resolves immediately and we fail fast.
      const stillAlive = await Promise.race([
        tui.exited.then(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(true), 100)),
      ])
      expect(stillAlive).toBe(true)
    } finally {
      await tui.dispose()
      rmSync(project, { recursive: true, force: true })
    }
  }, 30_000)
})
