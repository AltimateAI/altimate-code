/**
 * TUI e2e — send-message dispatch → response-frame envelope.
 *
 * The core TUI journey: user types a message, hits Enter, the dispatch
 * pipeline fires, and the transcript renders a response frame.
 *
 * Assertion shape — dispatch-completion signal, not response content: we
 * accept EITHER a success-shaped signal (numeric text a model would use in
 * a "count 1..3" reply) OR a documented error-shaped signal (`Bad Request`,
 * `Error from provider`, `Upstream failed`, etc.). Both prove the same
 * wire — Enter → provider call → response-frame render. Response content
 * is exercised more strictly at the CLI layer (`altimate-code run`); this
 * test is specifically about the TUI's send pipeline.
 *
 * Why the OR-envelope: the TUI's default model resolver picks from a
 * priority list and can land on a provider that's temporarily unreachable
 * on any given developer machine. Insisting on success content would make
 * this test flake on provider outages that aren't a TUI regression. The
 * error path is equally valid proof the send wire is intact.
 *
 * The prompt is deliberately chosen so its own tokens do NOT overlap with
 * the OR-regex — a positive match therefore proves post-dispatch content
 * was rendered, not just the typed-into-prompt characters echoing.
 */

import { describe, test } from "bun:test"
import path from "path"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { launchTui } from "../../fixture/pty-tui"

function makeProjectDir(): string {
  return mkdtempSync(path.join(tmpdir(), "altimate-tui-send-"))
}

describe("TUI e2e — send message", () => {
  test("Enter dispatches and the transcript renders a response frame", async () => {
    const project = makeProjectDir()
    const tui = await launchTui({
      cwd: project,
      cols: 200,
      rows: 60,
      waitForReady: "Ask anything",
    })
    try {
      // Prompt intentionally shares NO tokens with the response regex below,
      // so any regex match can only come from post-dispatch rendered content.
      tui.write("count from one to three")
      await new Promise((r) => setTimeout(r, 200))
      tui.sendKey("Enter")

      // Success-shaped OR error-shaped — either proves dispatch fired and
      // the render pipe delivered a response frame. Both are TUI-render
      // regressions if missing.
      await tui.waitForText(
        /(?:1\.|1\)|First|Sure|Here|Bad Request|Error from provider|Upstream|Unable to connect|rate limit|unavailable)/,
        { timeoutMs: 90_000 },
      )
    } finally {
      await tui.dispose()
      rmSync(project, { recursive: true, force: true })
    }
  }, 120_000)
})
