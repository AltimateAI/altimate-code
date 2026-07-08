/**
 * TUI e2e — error rendering.
 *
 * When the provider fails (network, rate limit, bad request, etc.) the TUI
 * should render the error clearly rather than silently swallow it or crash.
 * Verified path: point the model at a non-existent provider/model, send any
 * prompt, wait for an error banner to render in the transcript.
 *
 * This test is deterministic and cheap — the request fails at provider
 * resolution or immediately upstream, no tokens burned.
 */

import { describe, test } from "bun:test"
import path from "path"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { launchTui } from "../../fixture/pty-tui"

function makeProjectDirWithConfig(model: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "altimate-tui-error-"))
  writeFileSync(
    path.join(dir, "altimate-code.json"),
    JSON.stringify({
      $schema: "https://altimate.ai/config.json",
      model,
    }),
  )
  return dir
}

describe("TUI e2e — error rendering", () => {
  test("provider failure surfaces an error banner in the transcript", async () => {
    // Non-existent provider/model. The dispatcher will reject before any
    // network I/O, but the render path is the same one used for real
    // upstream failures — this asserts the "error → transcript banner" wire
    // is intact.
    const project = makeProjectDirWithConfig("anthropic/model-that-does-not-exist-9999")
    const tui = await launchTui({
      cwd: project,
      cols: 160,
      rows: 60,
      waitForReady: "Ask anything",
      env: {
        OPENCODE_CONFIG: path.join(project, "altimate-code.json"),
      },
    })
    try {
      tui.write("hello")
      await new Promise((r) => setTimeout(r, 200))
      tui.sendKey("Enter")
      // Match on any of the common error phrasings so we're stable across
      // provider-error variants. If none of these ever renders inside 30s
      // the send path is silently swallowing errors.
      await tui.waitForText(/error|failed|invalid|not found|unavailable/i, {
        timeoutMs: 30_000,
      })
    } finally {
      await tui.dispose()
      rmSync(project, { recursive: true, force: true })
    }
  }, 60_000)
})
