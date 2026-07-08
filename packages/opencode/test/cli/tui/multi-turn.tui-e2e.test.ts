/**
 * TUI e2e — multi-turn conversation.
 *
 * Verifies that the TUI can handle a SECOND message after the first one
 * completes: the input pipe resets, the transcript grows to hold a second
 * dispatch → response frame, and the session doesn't wedge.
 *
 * Assertion technique: each turn uses a unique typed marker embedded in
 * its own prompt. The marker is chosen so it can ONLY appear in the
 * buffer after the corresponding turn's characters are typed. We then
 * scan for the response envelope AFTER the marker's buffer position — so
 * turn 2's response can only satisfy if turn 2 actually dispatched (and
 * isn't just a re-match of turn 1's cumulative content).
 *
 * OR-envelope shape per turn: accepts either success-shaped text or a
 * documented provider-error banner, so the test doesn't flake when the
 * machine's default model provider is temporarily unreachable.
 */

import { describe, test, expect } from "bun:test"
import path from "path"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { launchTui } from "../../fixture/pty-tui"

function makeProjectDir(): string {
  return mkdtempSync(path.join(tmpdir(), "altimate-tui-multi-"))
}

const RESPONSE_FRAME_REGEX =
  /(?:1\.|1\)|First|Second|Sure|Here|Bad Request|Error from provider|Upstream|Unable to connect|rate limit|unavailable)/

async function waitForContentAfter(
  tui: { text: () => string },
  markerIndex: number,
  regex: RegExp,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const buf = tui.text()
    const suffix = buf.slice(markerIndex)
    if (regex.test(suffix)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  const tail = tui.text().slice(-2000)
  throw new Error(
    `Response envelope did not appear after marker within ${timeoutMs}ms.\n--- buffer tail (last 2000) ---\n${tail}`,
  )
}

describe("TUI e2e — multi-turn conversation", () => {
  test("two sequential sends both render distinct response frames", async () => {
    const project = makeProjectDir()
    const tui = await launchTui({
      cwd: project,
      cols: 200,
      rows: 60,
      waitForReady: "Ask anything",
    })
    try {
      // ---- Turn 1 ----
      const TURN1_MARKER = "TURN1MARKERalpha"
      // Prompt embeds a unique marker; envelope regex has no overlap with
      // the prompt tokens themselves, so any regex match is post-dispatch.
      tui.write(`please ${TURN1_MARKER} count from one to three`)
      await new Promise((r) => setTimeout(r, 200))
      tui.sendKey("Enter")
      // Wait for turn-1 marker to echo into the transcript so we know
      // where turn 1 begins in the cumulative buffer.
      await tui.waitForText(TURN1_MARKER, { timeoutMs: 15_000 })
      const turn1MarkerIdx = tui.text().indexOf(TURN1_MARKER)
      expect(turn1MarkerIdx).toBeGreaterThanOrEqual(0)
      // Wait for turn-1 response envelope somewhere after the marker.
      await waitForContentAfter(tui, turn1MarkerIdx, RESPONSE_FRAME_REGEX, 90_000)

      // Small settle for turn-1 response to finish rendering.
      await new Promise((r) => setTimeout(r, 1500))

      // ---- Turn 2 ----
      const TURN2_MARKER = "TURN2MARKERomega"
      tui.write(`ok now ${TURN2_MARKER} list four colors`)
      await new Promise((r) => setTimeout(r, 200))
      tui.sendKey("Enter")
      // Wait for turn-2 marker to appear — proves turn 2 was typed and
      // Enter fired without the prompt wedging.
      await tui.waitForText(TURN2_MARKER, { timeoutMs: 15_000 })
      const turn2MarkerIdx = tui.text().indexOf(TURN2_MARKER)
      expect(turn2MarkerIdx).toBeGreaterThan(turn1MarkerIdx)
      // Wait for turn-2 response envelope AFTER the turn-2 marker.
      // This can only match if turn 2 actually dispatched and produced
      // a rendered response frame; a match on turn-1's cumulative content
      // wouldn't satisfy because we're scanning the suffix after turn 2.
      await waitForContentAfter(tui, turn2MarkerIdx, RESPONSE_FRAME_REGEX, 90_000)
    } finally {
      await tui.dispose()
      rmSync(project, { recursive: true, force: true })
    }
  }, 240_000)
})
