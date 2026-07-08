/**
 * TUI e2e — cancel in-flight generation via Escape.
 *
 * Escape is the documented interrupt key while a generation is in flight
 * (the affordance `esc interrupt` renders on the input frame during
 * loading). Ctrl-C is bound to `app_exit`, not cancel, so this test uses
 * Escape.
 *
 * Assertion chain:
 *   1. Send a message → dispatch fires.
 *   2. Wait for the `esc interrupt` affordance to render — proves the
 *      TUI entered the "generating" state.
 *   3. Send Escape.
 *   4. Type a fresh marker and wait for it — proves the TUI is still
 *      responsive and the input pipe survived cancellation.
 */

import { describe, test } from "bun:test"
import path from "path"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { launchTui } from "../../fixture/pty-tui"

function makeProjectDir(): string {
  return mkdtempSync(path.join(tmpdir(), "altimate-tui-cancel-"))
}

describe("TUI e2e — cancel generation", () => {
  test("Escape during generation cancels and leaves the TUI responsive", async () => {
    const project = makeProjectDir()
    const tui = await launchTui({
      cwd: project,
      cols: 200,
      rows: 60,
      waitForReady: "Ask anything",
    })
    try {
      tui.write("please write a long numbered list about the history of shipping")
      await new Promise((r) => setTimeout(r, 200))
      tui.sendKey("Enter")

      // The TUI renders `esc interrupt` on the frame during generation.
      await tui.waitForText("esc interrupt", { timeoutMs: 15_000 })

      // Cancel.
      tui.sendKey("Escape")
      // Give the render loop a beat to process the cancel.
      await new Promise((r) => setTimeout(r, 500))

      // Prove the TUI is still responsive by typing a fresh marker and
      // watching it appear in the buffer.
      const marker = "POST_CANCEL_MARKER_zeta"
      tui.write(marker)
      await tui.waitForText(marker, { timeoutMs: 5_000 })
    } finally {
      await tui.dispose()
      rmSync(project, { recursive: true, force: true })
    }
  }, 60_000)
})
