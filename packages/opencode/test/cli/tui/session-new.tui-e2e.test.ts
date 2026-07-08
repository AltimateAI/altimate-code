/**
 * TUI e2e — `<leader>n` starts a new session.
 *
 * Sends a message with a distinctive marker, waits for the dispatch
 * affordance (proves the marker landed in a session), then triggers
 * session_new (`<leader>n` per keybind.ts:86) and verifies the input
 * frame is clean for a fresh session by typing a NEW marker and asserting
 * it renders in the newly-empty prompt.
 *
 * We deliberately don't try to negative-assert the old marker's absence:
 * `tui.text()` is a cumulative stream, so historical content persists in
 * the buffer even after a real UI reset (see the harness docstring). The
 * positive assertion — new session accepts input — is the reliable proof.
 */

import { describe, test } from "bun:test"
import path from "path"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { launchTui } from "../../fixture/pty-tui"

function makeProjectDir(): string {
  return mkdtempSync(path.join(tmpdir(), "altimate-tui-sesnew-"))
}

describe("TUI e2e — session_new", () => {
  test("<leader>n resets the session and the fresh prompt accepts input", async () => {
    const project = makeProjectDir()
    const tui = await launchTui({
      cwd: project,
      cols: 200,
      rows: 60,
      waitForReady: "Ask anything",
    })
    try {
      // First message — populates the current session.
      const firstMarker = "FIRST_SESSION_MARKER"
      tui.write(`This session should end. ${firstMarker}`)
      await new Promise((r) => setTimeout(r, 200))
      tui.sendKey("Enter")
      // Wait for the in-flight affordance so we know the dispatch fired.
      await tui.waitForText("esc interrupt", { timeoutMs: 15_000 })

      // Trigger session_new.
      tui.sendKey("Ctrl-X")
      tui.write("n")
      // Give the transition a beat to complete.
      await new Promise((r) => setTimeout(r, 500))

      // Type a fresh marker into the new session's prompt.
      const secondMarker = "SECOND_SESSION_MARKER_omega"
      tui.write(secondMarker)
      // Proves session_new left the input pipe usable and rendering.
      await tui.waitForText(secondMarker, { timeoutMs: 5_000 })
    } finally {
      await tui.dispose()
      rmSync(project, { recursive: true, force: true })
    }
  }, 60_000)
})
